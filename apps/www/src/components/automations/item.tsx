import React from "react";
import { AccessTier, Automation } from "@terragon/shared";
import {
  getCronDescription,
  validateCronExpression,
} from "@terragon/shared/automations/cron";
import { cn } from "@/lib/utils";
import { SUBSCRIPTION_MESSAGES } from "@/lib/subscription-msgs";
import { usePathname, useRouter } from "next/navigation";
import { convertToPlainText } from "@/lib/db-message-helpers";
import Link from "next/link";
import {
  ScheduleTriggerConfig,
  PullRequestTriggerConfig,
  IssueTriggerConfig,
  GitHubMentionTriggerConfig,
  AutomationTriggerType,
  isRepoBranchRelevant,
} from "@terragon/shared/automations";
import { Button } from "@/components/ui/button";
import {
  useDeleteAutomationMutation,
  useRunAutomationMutation,
  useEnableOrDisableAutomationMutation,
  useRunPullRequestAutomationMutation,
  useRunIssueAutomationMutation,
} from "@/queries/automation-mutations";
import { AutomationDeleteConfirmationModal } from "@/components/delete-confirmation-dialog";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Calendar,
  MoreHorizontalIcon,
  GitPullRequest,
  CircleDot,
  Bookmark,
  Loader2,
  AtSign,
} from "lucide-react";
import { formatRelativeTime } from "@/lib/format-relative-time";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useAccessInfo } from "@/queries/subscription";

export function AutomationItem({
  automation,
  onEdit,
  onDuplicate,
  verbose = true,
}: {
  automation: Automation;
  onEdit: (automation: Automation) => void;
  onDuplicate?: (automation: Automation) => void;
  verbose?: boolean;
}) {
  const deleteMutation = useDeleteAutomationMutation();
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const pathname = usePathname();
  const isAutomationPage = pathname === `/automations/${automation.id}`;
  const router = useRouter();

  const getIconForTriggerType = (triggerType: AutomationTriggerType) => {
    const iconClassName = cn("size-4", !automation.enabled && "opacity-60");
    switch (triggerType) {
      case "manual":
        return <Bookmark className={iconClassName} />;
      case "schedule":
        return <Calendar className={iconClassName} />;
      case "pull_request":
        return <GitPullRequest className={iconClassName} />;
      case "issue":
        return <CircleDot className={iconClassName} />;
      case "github_mention":
        return <AtSign className={iconClassName} />;
      default:
        const _exhaustiveCheck: never = triggerType;
        console.error("Unknown trigger type", _exhaustiveCheck);
        return null;
    }
  };

  return (
    <>
      <Link
        href={`/automations/${automation.id}`}
        onClick={(e) => {
          if (verbose || isAutomationPage) {
            e.preventDefault();
          }
        }}
        className={cn(
          "group flex flex-col border rounded-lg transition-all py-2",
          verbose && "!cursor-default",
        )}
      >
        <div className="grid grid-cols-[auto_1fr] px-2.5 items-center justify-between gap-x-2">
          <div className="contents">
            {getIconForTriggerType(automation.triggerType)}
            <div className="flex items-center justify-between gap-2 min-w-0">
              <div className="flex flex-col gap-1 truncate min-w-0">
                <h3
                  className={cn(
                    "text-sm font-semibold truncate",
                    !automation.enabled && "opacity-60",
                  )}
                >
                  {automation.name}
                </h3>
              </div>
              <div className="flex-shrink-0 flex items-center gap-2">
                <div
                  onClick={(e) => {
                    e.preventDefault();
                  }}
                >
                  <AutomationRunButton automation={automation} />
                </div>
                <div
                  onClick={(e) => {
                    e.preventDefault();
                  }}
                >
                  <AutomationItemDropdownMenu
                    automation={automation}
                    onEdit={onEdit}
                    onDuplicate={onDuplicate}
                    setShowDeleteConfirmation={setShowDeleteConfirmation}
                  />
                </div>
              </div>
            </div>
          </div>
          <div className="contents">
            <div />
            <AutomationItemContents automation={automation} verbose={verbose} />
          </div>
        </div>
      </Link>
      <AutomationDeleteConfirmationModal
        open={showDeleteConfirmation}
        onOpenChange={setShowDeleteConfirmation}
        onConfirm={async () => {
          await deleteMutation.mutateAsync(automation.id);
          if (pathname === `/automations/${automation.id}`) {
            router.push("/automations");
          }
          setShowDeleteConfirmation(false);
        }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
}

function AutomationItemContents({
  automation,
  verbose,
}: {
  automation: Automation;
  verbose: boolean;
}) {
  const { tier } = useAccessInfo();
  const triggerDescriptionParts = [];
  switch (automation.triggerType) {
    case "manual": {
      break;
    }
    case "schedule": {
      const config = automation.triggerConfig as ScheduleTriggerConfig;
      triggerDescriptionParts.push(
        getCronDescription(config.cron, config.timezone),
      );
      break;
    }
    case "pull_request": {
      const config = automation.triggerConfig as PullRequestTriggerConfig;
      triggerDescriptionParts.push(
        `Pull Request in ${automation.repoFullName}`,
      );
      const triggerOnParts = [];
      if (config.on.open) {
        triggerOnParts.push("open");
      }
      if (config.on.update) {
        triggerOnParts.push("update");
      }
      triggerDescriptionParts.push(`Trigger on ${triggerOnParts.join(", ")}`);

      const filterParts = [];
      if (config.filter.includeDraftPRs) {
        filterParts.push("PRs & draft PRs");
      }
      if (config.filter.includeOtherAuthors) {
        filterParts.push(`from other authors: ${config.filter.otherAuthors}`);
      }
      if (filterParts.length > 0) {
        triggerDescriptionParts.push(`Include ${filterParts.join(", ")}`);
      }
      if (!config.autoArchiveOnComplete) {
        triggerDescriptionParts.push("No auto-archive");
      }
      break;
    }
    case "issue": {
      const config = automation.triggerConfig as IssueTriggerConfig;
      triggerDescriptionParts.push(`Issue in ${automation.repoFullName}`);
      const triggerOnParts = [];
      if (config.on.open) {
        triggerOnParts.push("open");
      }
      triggerDescriptionParts.push(`Trigger on ${triggerOnParts.join(", ")}`);
      const filterParts = [];
      if (config.filter.includeOtherAuthors) {
        filterParts.push(`from other authors: ${config.filter.otherAuthors}`);
      }
      if (filterParts.length > 0) {
        triggerDescriptionParts.push(`Include ${filterParts.join(", ")}`);
      }
      if (!config.autoArchiveOnComplete) {
        triggerDescriptionParts.push("No auto-archive");
      }
      break;
    }
    case "github_mention": {
      const config = automation.triggerConfig as GitHubMentionTriggerConfig;
      triggerDescriptionParts.push(
        `GitHub Mention in ${automation.repoFullName}`,
      );
      const filterParts = [];
      if (config.filter.includeBotMentions) {
        filterParts.push(`bot mentions by ${config.filter.botUsernames}`);
      }
      if (config.filter.includeOtherAuthors) {
        filterParts.push(
          `on PRs/Issues from other authors: ${config.filter.otherAuthors}`,
        );
      }
      if (filterParts.length > 0) {
        triggerDescriptionParts.push(`Include ${filterParts.join(", ")}`);
      }
      break;
    }
    default: {
      const _exhaustiveCheck: never = automation.triggerType;
      console.error("Unknown trigger type", _exhaustiveCheck);
      break;
    }
  }

  // skill_message actions carry a REFERENCE, not a message — the resolved body
  // lives in the skill store. Full skill UI (chip + panel) ships in #54 C4;
  // until then render the reference itself.
  const promptText =
    automation.action.type === "user_message"
      ? convertToPlainText({
          message: automation.action.config.message,
        })
      : `Skill: ${automation.action.config.skillName} (${automation.action.config.version})`;

  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground pr-2 min-w-0">
      <div className="flex items-center gap-0.5 truncate min-w-0">
        <span className="flex-shrink-0">
          {automation.enabled ? "Enabled" : "Disabled"}
        </span>
        {automation.lastRunAt && (
          <>
            <span className="mx-1 flex-shrink-0">·</span>
            <span className="truncate">
              Last run {formatRelativeTime(new Date(automation.lastRunAt))}
            </span>
          </>
        )}
        {!verbose && (
          <AutomationNextRunLabel
            prefix={<span className="mx-1 flex-shrink-0">·</span>}
            automation={automation}
          />
        )}
        <AutomationErrorLabel
          prefix={<span className="mx-1 flex-shrink-0">·</span>}
          automation={automation}
          accessTier={tier}
        />
      </div>
      {verbose && (
        <>
          {triggerDescriptionParts.length > 0 ? (
            <div className="line-clamp-3 w-full">
              {triggerDescriptionParts.map((part, index) => (
                <React.Fragment key={index}>
                  <span>{part}</span>
                  {index < triggerDescriptionParts.length - 1 && (
                    <span className="mx-1 flex-shrink-0">·</span>
                  )}
                </React.Fragment>
              ))}
            </div>
          ) : null}
          <AutomationNextRunLabel automation={automation} />
          {isRepoBranchRelevant(automation.triggerType) && (
            <div className="mt-2">
              <span title={automation.repoFullName}>
                {automation.repoFullName}
              </span>
              <span className="mx-1">·</span>
              <span>{automation.branchName}</span>
            </div>
          )}
          {promptText.length > 0 && (
            <div className="rounded-md bg-muted/50 p-2.5">
              <pre className="text-xs text-muted-foreground line-clamp-3 whitespace-pre-wrap">
                {promptText}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AutomationErrorLabel({
  prefix,
  automation,
  accessTier,
}: {
  prefix?: React.ReactNode;
  automation: Automation;
  accessTier: AccessTier;
}) {
  if (!automation.enabled) {
    return null;
  }
  if (automation.triggerType === "github_mention") {
    const config = automation.triggerConfig as GitHubMentionTriggerConfig;
    if (config.filter.includeBotMentions && accessTier !== "pro") {
      return (
        <>
          {prefix}
          <span className="truncate text-destructive">
            Invalid configuration
          </span>
        </>
      );
    }
  }
  if (automation.triggerType === "schedule") {
    const config = automation.triggerConfig as ScheduleTriggerConfig;
    const { isValid } = validateCronExpression(config.cron, { accessTier });
    if (!isValid) {
      return (
        <>
          {prefix}
          <span className="truncate text-destructive">Invalid schedule</span>
        </>
      );
    }
  }
  return null;
}

function AutomationNextRunLabel({
  prefix,
  automation,
}: {
  prefix?: React.ReactNode;
  automation: Automation;
}) {
  if (automation.triggerType !== "schedule" || !automation.enabled) {
    return null;
  }
  if (!automation.nextRunAt) {
    return null;
  }
  return (
    <>
      {prefix}
      <span className="truncate">
        Next run:{" "}
        {automation.nextRunAt.toLocaleString(undefined, {
          dateStyle: "short",
          timeStyle: "short",
        })}
      </span>
    </>
  );
}

function AutomationItemDropdownMenu({
  automation,
  setShowDeleteConfirmation,
  onEdit,
  onDuplicate,
}: {
  automation: Automation;
  setShowDeleteConfirmation: (show: boolean) => void;
  onEdit: (automation: Automation) => void;
  onDuplicate?: (automation: Automation) => void;
}) {
  const isManual = automation.triggerType === "manual";
  const enableOrDisableMutation = useEnableOrDisableAutomationMutation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0"
          aria-label="More options"
        >
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!isManual && (
          <DropdownMenuItem
            onClick={() =>
              enableOrDisableMutation.mutateAsync({
                automationId: automation.id,
                enabled: !automation.enabled,
              })
            }
          >
            {automation.enabled ? "Disable" : "Enable"}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => onEdit(automation)}>
          Edit
        </DropdownMenuItem>
        {onDuplicate && (
          <DropdownMenuItem onClick={() => onDuplicate(automation)}>
            Duplicate
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => setShowDeleteConfirmation(true)}
          variant="destructive"
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AutomationRunButton({ automation }: { automation: Automation }) {
  const { isActive } = useAccessInfo();
  const runMutation = useRunAutomationMutation();
  const runPullRequestMutation = useRunPullRequestAutomationMutation();
  const runIssueMutation = useRunIssueAutomationMutation();
  const [prPopoverOpen, setPrPopoverOpen] = useState(false);
  const [prNumber, setPrNumber] = useState("");
  const [issuePopoverOpen, setIssuePopoverOpen] = useState(false);
  const [issueNumber, setIssueNumber] = useState("");
  if (automation.triggerType === "github_mention") {
    return null;
  }
  if (automation.triggerType === "pull_request") {
    return (
      <Popover open={prPopoverOpen} onOpenChange={setPrPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-fit py-1 text-xs"
            onClick={() => {
              if (!isActive) {
                toast.error(SUBSCRIPTION_MESSAGES.RUN_AUTOMATION);
                return;
              }
              setPrPopoverOpen(true);
            }}
            disabled={!isActive}
          >
            Run now
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64">
          <div className="flex flex-col gap-2">
            <div className="space-y-1">
              <p className="text-sm font-medium">
                <span className="font-mono">{automation.repoFullName}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                Enter the pull request number to test the automation
              </p>
            </div>
            <Input
              placeholder="Enter pull request number"
              value={prNumber}
              onChange={(e) => setPrNumber(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const prNumberInt = parseInt(prNumber);
                if (!prNumberInt) {
                  toast.error("Please enter a valid pull request number");
                  return;
                }
                await runPullRequestMutation.mutateAsync({
                  automationId: automation.id,
                  prNumber: prNumberInt,
                });
                setPrPopoverOpen(false);
              }}
              disabled={
                !prNumber || runPullRequestMutation.isPending || !isActive
              }
            >
              {runPullRequestMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Run now"
              )}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  }
  if (automation.triggerType === "issue") {
    return (
      <Popover open={issuePopoverOpen} onOpenChange={setIssuePopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-fit py-1 text-xs"
            onClick={() => {
              if (!isActive) {
                toast.error(SUBSCRIPTION_MESSAGES.RUN_AUTOMATION);
                return;
              }
              setIssuePopoverOpen(true);
            }}
            disabled={!isActive}
          >
            Run now
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64">
          <div className="flex flex-col gap-2">
            <div className="space-y-1">
              <p className="text-sm font-medium">
                <span className="font-mono">{automation.repoFullName}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                Enter the issue number to test the automation
              </p>
            </div>
            <Input
              placeholder="Enter issue number"
              value={issueNumber}
              onChange={(e) => setIssueNumber(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const issueNumberInt = parseInt(issueNumber);
                if (!issueNumberInt) {
                  toast.error("Please enter a valid issue number");
                  return;
                }
                await runIssueMutation.mutateAsync({
                  automationId: automation.id,
                  issueNumber: issueNumberInt,
                });
                setIssuePopoverOpen(false);
              }}
              disabled={!issueNumber || runIssueMutation.isPending || !isActive}
            >
              {runIssueMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Run now"
              )}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        if (!isActive) {
          toast.error(SUBSCRIPTION_MESSAGES.RUN_AUTOMATION);
          return;
        }
        await runMutation.mutateAsync(automation.id);
      }}
      aria-label="Run automation"
      className="h-fit py-1 text-xs"
      disabled={runMutation.isPending || !isActive}
    >
      Run now
    </Button>
  );
}
