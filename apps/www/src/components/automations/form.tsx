import * as z from "zod/v4";
import {
  AutomationActionSchema,
  AutomationTriggerSchema,
  ScheduleTriggerConfig,
  triggerTypeLabels,
  triggerTypeDescriptions,
  AutomationTriggerType,
  AutomationTrigger,
  AutomationAction,
  PullRequestTriggerConfig,
  IssueTriggerConfig,
  GitHubMentionTriggerConfig,
  AutomationTriggerConfig,
  isRepoBranchRelevant,
  isSkipSetupRelevant,
} from "@terragon/shared/automations";
import { AIModel } from "@terragon/agent/types";
import { AccessTier, Automation } from "@terragon/shared";
import { useAtomValue } from "jotai";
import {
  selectedRepoAtom,
  selectedBranchAtom,
  selectedModelAtom,
} from "@/atoms/user-flags";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { GenericPromptBox } from "@/components/promptbox/generic-promptbox";
import { RepoBranchSelector } from "@/components/repo-branch-selector";
import { Button } from "@/components/ui/button";
import { ScheduleTriggerForm } from "./schedule-frequency";
import { PullRequestTriggerForm } from "./pull-request-trigger-form";
import { IssueTriggerForm } from "./issue-trigger-form";
import { GitHubMentionTriggerForm } from "./github-mention-trigger-form";
import { validateCronExpression } from "@terragon/shared/automations/cron";
import { convertToPlainText } from "@/lib/db-message-helpers";
import { cn } from "@/lib/utils";
import { PromptBoxToolBelt } from "@/components/promptbox/prompt-box-tool-belt";
import { useAccessInfo } from "@/queries/subscription";

function createAutomationFormSchema({
  accessTier,
}: {
  accessTier: AccessTier;
}) {
  return z
    .object({
      name: z.string().min(1),
      repoFullName: z.string().min(1),
      branchName: z.string().min(1),
      disableGitCheckpointing: z.boolean().optional(),
      skipSetup: z.boolean().optional(),
      action: AutomationActionSchema,
      trigger: AutomationTriggerSchema.refine(
        (trigger) => {
          if (trigger.type === "schedule") {
            return validateCronExpression(trigger.config.cron, {
              accessTier,
            }).isValid;
          }
          return true;
        },
        {
          message: "This schedule is not supported.",
          path: ["config", "cron"],
        },
      )
        .refine(
          (trigger) => {
            if (trigger.type === "pull_request") {
              const config = trigger.config as PullRequestTriggerConfig;
              const onKeys = Object.keys(config.on).filter(
                (key) => config.on[key as keyof typeof config.on],
              );
              return onKeys.length > 0;
            }
            if (trigger.type === "issue") {
              const config = trigger.config as IssueTriggerConfig;
              const onKeys = Object.keys(config.on).filter(
                (key) => config.on[key as keyof typeof config.on],
              );
              return onKeys.length > 0;
            }
            return true;
          },
          {
            message: "Please select at least one trigger event.",
            path: ["config"],
          },
        )
        .refine(
          (trigger) => {
            if (trigger.type === "github_mention") {
              const config = trigger.config as GitHubMentionTriggerConfig;
              if (config.filter.includeBotMentions && accessTier !== "pro") {
                return false;
              }
            }
            return true;
          },
          {
            message:
              "Including mentions from bot users is only available on the Pro tier.",
            path: ["config"],
          },
        )
        .refine(
          (trigger) => {
            if (trigger.type === "github_mention") {
              const config = trigger.config as GitHubMentionTriggerConfig;
              if (
                config.filter.includeBotMentions &&
                !config.filter.botUsernames
              ) {
                return false;
              }
            }
            return true;
          },
          {
            message: "At least one bot username must be specified",
            path: ["config"],
          },
        )
        .refine(
          (trigger) => {
            if (trigger.type === "github_mention") {
              const config = trigger.config as GitHubMentionTriggerConfig;
              if (
                config.filter.includeBotMentions &&
                config.filter.botUsernames
              ) {
                return config.filter.botUsernames
                  .split(",")
                  .every((bot) => bot.trim().endsWith("[bot]"));
              }
            }
            return true;
          },
          {
            message:
              "Bot usernames must end with [bot]. Eg. sentry-io[bot], copilot[bot]",
            path: ["config"],
          },
        ),
    })
    .refine(
      (values) => {
        if (isUserMessageOptional(values.trigger.type)) {
          return true;
        }
        if (values.action.type === "user_message") {
          const plainText = convertToPlainText({
            message: values.action.config.message,
          });
          return plainText.trim().length > 0;
        }
        return true;
      },
      {
        message: "Message cannot be empty",
        path: ["action"],
      },
    );
}

function isUserMessageOptional(triggerType: AutomationTriggerType) {
  switch (triggerType) {
    case "github_mention":
      return true;
    default:
      return false;
  }
}

function getUserMessagePlaceholder(triggerType: AutomationTriggerType) {
  switch (triggerType) {
    case "github_mention":
      return "Additional Instructions (Optional, if specified, will be appended to the prompt)";
    default:
      return "What do you want to do?";
  }
}

function getDefaultTriggerForType({
  type,
}: {
  type: AutomationTriggerType;
}): AutomationTrigger {
  switch (type) {
    case "schedule":
      return {
        type: "schedule",
        config: {
          cron: "0 9 * * *",
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      };
    case "pull_request":
      return {
        type: "pull_request",
        config: {
          filter: {
            includeDraftPRs: false,
            includeOtherAuthors: false,
            otherAuthors: "",
          },
          on: {
            open: true,
            update: true,
          },
          autoArchiveOnComplete: true,
        },
      };
    case "issue":
      return {
        type: "issue",
        config: {
          filter: {
            includeOtherAuthors: false,
            otherAuthors: "",
          },
          on: {
            open: true,
          },
          autoArchiveOnComplete: true,
        },
      };
    case "github_mention":
      return {
        type: "github_mention",
        config: {
          filter: {
            includeOtherAuthors: false,
            otherAuthors: "",
            includeBotMentions: false,
            botUsernames: "",
          },
        },
      };
    case "manual":
      return {
        type: "manual",
        config: {},
      };
    default:
      const _exhaustiveCheck: never = type;
      console.error("Unknown trigger type", _exhaustiveCheck);
      return {
        type,
        config: {},
      };
  }
}

function getDefaultConfigForType({
  type,
}: {
  type: AutomationTriggerType;
}): AutomationTriggerConfig {
  return getDefaultTriggerForType({ type }).config;
}

const defaultTriggerType = "schedule";

function getDefaultValues({
  selectedRepo,
  selectedBranch,
  selectedModel,
}: {
  selectedRepo: string | null;
  selectedBranch: string | null;
  selectedModel: AIModel;
}): {
  repoFullName: string;
  branchName: string;
  disableGitCheckpointing: boolean;
  trigger: AutomationTrigger;
  action: AutomationAction;
} {
  const defaultAction: AutomationAction = {
    type: "user_message",
    config: {
      message: {
        type: "user",
        model: selectedModel,
        parts: [],
      },
    },
  };
  return {
    trigger: getDefaultTriggerForType({
      type: defaultTriggerType,
    }),
    repoFullName: selectedRepo ?? "",
    branchName: selectedBranch ?? "",
    disableGitCheckpointing: false,
    action: defaultAction,
  };
}

export function AutomationEditorDialogContent({
  automation,
  title,
  ctaLabel,
  onSubmit,
  initialValues,
}: {
  automation: Automation | null;
  title: string;
  ctaLabel: string;
  onSubmit: (
    values: z.infer<ReturnType<typeof createAutomationFormSchema>>,
  ) => Promise<void>;
  initialValues: Partial<
    z.infer<ReturnType<typeof createAutomationFormSchema>>
  > | null;
}) {
  "use no memo";
  const { tier } = useAccessInfo();
  const AutomationFormSchema = createAutomationFormSchema({ accessTier: tier });
  const selectedRepo = useAtomValue(selectedRepoAtom);
  const selectedBranch = useAtomValue(selectedBranchAtom);
  const selectedModel = useAtomValue(selectedModelAtom);
  const defaultValues = getDefaultValues({
    selectedRepo,
    selectedBranch,
    selectedModel,
  });
  const values: z.infer<typeof AutomationFormSchema> = {
    name: automation?.name ?? initialValues?.name ?? "",
    repoFullName:
      automation?.repoFullName ??
      initialValues?.repoFullName ??
      defaultValues.repoFullName,
    branchName:
      automation?.branchName ??
      initialValues?.branchName ??
      defaultValues.branchName,
    disableGitCheckpointing:
      automation?.disableGitCheckpointing ??
      initialValues?.disableGitCheckpointing ??
      defaultValues.disableGitCheckpointing,
    skipSetup: automation?.skipSetup ?? initialValues?.skipSetup ?? false,
    trigger: {
      type:
        automation?.triggerType ??
        initialValues?.trigger?.type ??
        defaultValues.trigger.type,
      config:
        automation?.triggerConfig ??
        initialValues?.trigger?.config ??
        defaultValues.trigger.config,
    } as AutomationTrigger,
    action: {
      type:
        automation?.action.type ??
        initialValues?.action?.type ??
        defaultValues.action.type,
      config:
        automation?.action.config ??
        initialValues?.action?.config ??
        defaultValues.action.config,
    } as AutomationAction,
  };
  const form = useForm<z.infer<typeof AutomationFormSchema>>({
    resolver: zodResolver(AutomationFormSchema as unknown as any),
    values,
  });
  async function handleSubmit(values: z.infer<typeof AutomationFormSchema>) {
    try {
      await onSubmit(values);
      form.reset();
    } catch (error) {
      console.error(error);
    }
  }
  const triggerType = form.watch("trigger.type");
  const showRepoBranchSelector = isRepoBranchRelevant(triggerType);
  const showCheckpointingToggle = showRepoBranchSelector;
  const showSkipSetupToggle = isSkipSetupRelevant(triggerType);

  const repoFullNameValue = form.watch("repoFullName") as string;
  return (
    <DialogContent className="sm:max-w-2xl px-0 max-h-[95dvh] flex flex-col">
      <DialogHeader className="px-4">
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(handleSubmit)}
          className="flex-1 flex flex-col overflow-y-auto"
        >
          <div className="space-y-4 px-4 pb-4 flex-1 overflow-y-auto">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="My Automation" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="trigger.type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Trigger</FormLabel>
                  <FormControl>
                    <TriggerTypeSelector
                      value={field.value}
                      onChange={(value) => {
                        field.onChange(value);
                        if (field.value !== value) {
                          form.setValue(
                            "trigger.config",
                            getDefaultConfigForType({
                              type: value,
                            }),
                            { shouldValidate: true },
                          );
                        }
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {triggerType === "schedule" ? (
              <ScheduleTriggerForm
                value={form.watch("trigger.config") as ScheduleTriggerConfig}
                onChange={(value) => {
                  form.setValue("trigger.config", value);
                }}
              />
            ) : triggerType === "pull_request" ? (
              <PullRequestTriggerForm
                value={form.watch("trigger.config") as PullRequestTriggerConfig}
                repoFullName={form.watch("repoFullName") as string}
                setRepoFullName={(repoFullName) => {
                  form.setValue("repoFullName", repoFullName);
                }}
                onChange={(value) => {
                  form.setValue("trigger.config", value);
                  form.trigger("trigger.config");
                }}
                errorMessage={
                  (form.formState.errors.trigger?.config as any)?.message as
                    | string
                    | undefined
                }
              />
            ) : triggerType === "issue" ? (
              <IssueTriggerForm
                value={form.watch("trigger.config") as IssueTriggerConfig}
                repoFullName={form.watch("repoFullName") as string}
                setRepoFullName={(repoFullName) => {
                  form.setValue("repoFullName", repoFullName);
                }}
                onChange={(value) => {
                  form.setValue("trigger.config", value);
                  form.trigger("trigger.config");
                }}
                errorMessage={
                  (form.formState.errors.trigger?.config as any)?.message as
                    | string
                    | undefined
                }
              />
            ) : triggerType === "github_mention" ? (
              <GitHubMentionTriggerForm
                value={
                  form.watch("trigger.config") as GitHubMentionTriggerConfig
                }
                repoFullName={form.watch("repoFullName") as string}
                setRepoFullName={(repoFullName) => {
                  form.setValue("repoFullName", repoFullName);
                }}
                onChange={(value) => {
                  form.setValue("trigger.config", value);
                }}
                errorMessage={
                  (form.formState.errors.trigger?.config as any)?.message as
                    | string
                    | undefined
                }
              />
            ) : null}
            <FormField
              control={form.control}
              name="action"
              render={({ field }) => (
                <FormItem>
                  <div className="flex flex-col gap-2 overflow-x-hidden">
                    <GenericPromptBox
                      // skill_message actions carry a REFERENCE, not a message
                      // — the editor for those ships with #54 C4. Feed the box
                      // an empty message so the form stays type-safe meanwhile.
                      message={
                        field.value.type === "user_message"
                          ? field.value.config.message
                          : { type: "user", model: null, parts: [] }
                      }
                      repoFullName={form.watch("repoFullName")}
                      branchName={form.watch("branchName")}
                      placeholder={getUserMessagePlaceholder(triggerType)}
                      className="min-h-[150px] max-h-[50dvh]"
                      forcedAgent={null}
                      forcedAgentVersion={null}
                      autoFocus={false}
                      hideSubmitButton={true}
                      clearContentOnSubmit={false}
                      borderClassName={cn({
                        "border-destructive": form.formState.errors.action,
                      })}
                      onUpdate={async ({ userMessage }) => {
                        form.setValue("action.config.message", userMessage);
                      }}
                      onSubmit={async ({ userMessage }) => {
                        form.setValue("action.config.message", userMessage);
                      }}
                    />
                    <FormMessage className="px-4" />
                    <div className="flex items-center justify-between">
                      {showRepoBranchSelector ? (
                        <RepoBranchSelector
                          selectedRepoFullName={form.watch("repoFullName")}
                          selectedBranch={form.watch("branchName")}
                          onChange={(repoFullName, branchName) => {
                            if (repoFullName) {
                              form.setValue("repoFullName", repoFullName);
                            }
                            if (branchName) {
                              form.setValue("branchName", branchName);
                            }
                          }}
                        />
                      ) : (
                        <div />
                      )}
                      <PromptBoxToolBelt
                        showSkipSetup={showSkipSetupToggle}
                        skipSetupValue={form.watch("skipSetup") ?? false}
                        onSkipSetupChange={(v) => {
                          form.setValue("skipSetup", v);
                        }}
                        skipSetupDisabled={!repoFullNameValue}
                        skipSetupDisableToast={true}
                        showCheckpoint={showCheckpointingToggle}
                        checkpointValue={
                          form.watch("disableGitCheckpointing") ?? false
                        }
                        onCheckpointChange={(v) => {
                          form.setValue("disableGitCheckpointing", v);
                        }}
                        checkpointDisabled={!repoFullNameValue}
                        checkpointShowDialog={false}
                      />
                    </div>
                  </div>
                </FormItem>
              )}
            />
          </div>
          <DialogFooter className="px-4 pt-4 border-t border-border">
            <Button type="submit">{ctaLabel}</Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  );
}

function TriggerTypeSelector({
  value,
  onChange,
}: {
  value: AutomationTriggerType;
  onChange: (value: AutomationTriggerType) => void;
}) {
  const items = Object.entries(triggerTypeLabels).map(([type, label]) => {
    return {
      value: type,
      label,
      item: (
        <div className="flex flex-col gap-1">
          <span className="font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">
            {triggerTypeDescriptions[type as AutomationTriggerType]}
          </span>
        </div>
      ),
    };
  });
  return (
    <Combobox
      items={items}
      value={value}
      setValue={(updatedValue) => {
        if (!updatedValue) {
          return;
        }
        onChange(updatedValue as AutomationTriggerType);
      }}
      disabled={false}
      placeholder="Select a trigger"
      searchPlaceholder="Search for a trigger"
      emptyText="No triggers found"
      disableSearch={true}
    />
  );
}
