import { db } from "@/lib/db";
import { createNewThread } from "./new-thread-shared";
import { getPostHogServer } from "@/lib/posthog-server";
import {
  getAutomation,
  incrementAutomationRunCount,
  getAutomationCount,
} from "@terragon/shared/model/automations";
import { assertNever } from "@terragon/shared/utils";
import { Automation, AutomationInsert } from "@terragon/shared/db/types";
import { validateCronExpression } from "@terragon/shared/automations/cron";
import { convertToPlainText } from "@/lib/db-message-helpers";
import {
  PullRequestTriggerConfig,
  ScheduleTriggerConfig,
  IssueTriggerConfig,
  GitHubMentionTriggerConfig,
  AutomationTriggerType,
} from "@terragon/shared/automations";
import { AccessTier, DBUserMessage } from "@terragon/shared";
import {
  PullRequestEvent,
  IssueEvent,
} from "@/app/api/webhooks/github/handlers";
import { addEyesReactionToPullRequest } from "@/app/api/webhooks/github/utils";
import {
  getOctokitForUserOrThrow,
  parseRepoFullName,
  getIsPRAuthor,
} from "@/lib/github";
import { getThreads } from "@terragon/shared/model/threads";
import { archiveAndStopThread } from "./archive-thread";
import {
  createGitHubCheckRunForAutomation,
  updateGitHubCheckRunForAutomation,
} from "./github";
import { getAccessInfoForUser } from "@/lib/subscription";
import { SUBSCRIPTION_MESSAGES } from "@/lib/subscription-msgs";
import { getMaxAutomationsForUser } from "@/lib/subscription-tiers";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { UserFacingError } from "@/lib/server-actions";

export async function runAutomation({
  userId,
  automationId,
  options,
  source,
}: {
  userId: string;
  automationId: string;
  options?: {
    branchName?: string;
    transformMessage?: (message: DBUserMessage) => DBUserMessage;
    prNumber?: number;
    issueNumber?: number;
  };
  source: "automated" | "manual";
}): Promise<{ threadId: string; threadChatId: string } | undefined> {
  const { automation, tier } = await validateCanRunAutomation({
    userId,
    automationId,
    triggerTypes: null,
    throwOnError: true,
  });
  console.log(`Running automation ${automation.id}`, {
    userId,
    source,
    triggerType: automation.triggerType,
    prNumber: options?.prNumber,
  });
  try {
    let threadId: string | undefined;
    let threadChatId: string | undefined;
    switch (automation.action.type) {
      case "user_message": {
        const newThreadResult = await createNewThread({
          userId: automation.userId,
          // Derivation: an automation is org-owned, so its threads inherit the
          // automation's org (WI-5 batch 1). Unambiguous. Nullable-safe.
          organizationId: automation.organizationId,
          message: options?.transformMessage
            ? options.transformMessage(automation.action.config.message)
            : automation.action.config.message,
          githubRepoFullName: automation.repoFullName,
          baseBranchName: options?.branchName ?? automation.branchName,
          headBranchName: null,
          sourceType: "automation",
          automation: automation,
          githubPRNumber: options?.prNumber,
          githubIssueNumber: options?.issueNumber,
          disableGitCheckpointing: automation.disableGitCheckpointing ?? false,
        });
        threadId = newThreadResult.threadId;
        threadChatId = newThreadResult.threadChatId;
        break;
      }
      default: {
        assertNever(automation.action.type);
      }
    }
    const updatedAutomation = await incrementAutomationRunCount({
      db,
      automationId: automation.id,
      userId: automation.userId,
      accessTier: tier,
    });
    getPostHogServer().capture({
      distinctId: automation.userId,
      event: "automation_executed",
      properties: {
        automationId: automation.id,
        automationName: automation.name,
        triggerType: automation.triggerType,
        actionType: automation.action.type,
        runCount: updatedAutomation.runCount,
        threadId,
        threadChatId,
      },
    });
    return { threadId, threadChatId };
  } catch (error) {
    console.error(`Error running automation ${automation.id}:`, error);
    // Log error metrics
    getPostHogServer().capture({
      distinctId: automation.userId,
      event: "automation_execution_error",
      properties: {
        automationId: automation.id,
        automationName: automation.name,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}

export async function validateCanRunAutomation({
  userId,
  automationId,
  triggerTypes,
  throwOnError = true,
}: {
  userId: string;
  automationId: string;
  triggerTypes: AutomationTriggerType[] | null;
  throwOnError: boolean;
}): Promise<{ automation: Automation; tier: AccessTier; canRun: boolean }> {
  const automation = await getAutomation({ db, automationId, userId });
  if (!automation) {
    throw new UserFacingError("Automation not found");
  }
  const { tier } = await getAccessInfoForUser(userId);
  if (tier === "none") {
    if (throwOnError) {
      throw new UserFacingError(SUBSCRIPTION_MESSAGES.RUN_AUTOMATION);
    }
    return { automation, tier, canRun: false };
  }
  if (triggerTypes && !triggerTypes.includes(automation.triggerType)) {
    if (throwOnError) {
      throw new UserFacingError(
        `Invalid trigger type. This ${automation.triggerType} is not a valid trigger type for this action.`,
      );
    }
    return { automation, tier, canRun: false };
  }
  return { automation, tier, canRun: true };
}

export async function hasReachedLimitOfAutomations({
  userId,
  tier,
}: {
  userId: string;
  tier: AccessTier;
}) {
  if (tier === "pro" || tier === "none") {
    return false;
  }
  const [currentCount, maxAutomations] = await Promise.all([
    getAutomationCount({ db, userId }),
    getMaxAutomationsForUser(userId),
  ]);
  if (maxAutomations === null) {
    return false;
  }
  return currentCount >= maxAutomations;
}

export async function validateAutomationCreationOrUpdate({
  userId,
  automationId,
  updates,
}: {
  userId: string;
  automationId: string | null;
  updates: Partial<
    Omit<
      AutomationInsert,
      "userId" | "createdAt" | "updatedAt" | "lastRunAt" | "runCount"
    >
  >;
}): Promise<{ tier: AccessTier }> {
  const { tier } = await getAccessInfoForUser(userId);
  if (automationId === null) {
    if (tier === "none") {
      throw new UserFacingError(SUBSCRIPTION_MESSAGES.CREATE_AUTOMATION);
    }
  }
  const automationOrNull = automationId
    ? await getAutomation({ db, automationId, userId })
    : null;
  const triggerType = updates.triggerType ?? automationOrNull?.triggerType;
  const triggerConfig =
    updates.triggerConfig ?? automationOrNull?.triggerConfig;
  if (
    // Creating a new automation
    !automationId ||
    // Enabling an existing disabled automation
    (automationOrNull && !automationOrNull.enabled && updates.enabled)
  ) {
    if (triggerType !== "manual") {
      const hasReachedLimit = await hasReachedLimitOfAutomations({
        userId,
        tier,
      });
      if (hasReachedLimit) {
        if (automationId === null) {
          throw new UserFacingError(
            "You have reached the limit of active automations. Disable or delete an existing active automation to create a new one.",
          );
        }
        throw new UserFacingError(
          "You have reached the limit of active automations. Disable or delete an existing active automation to continue.",
        );
      }
    }
  }
  const repoFullName = updates.repoFullName ?? automationOrNull?.repoFullName;
  if (!repoFullName) {
    throw new UserFacingError("Repo full name is required");
  }
  if (triggerType) {
    switch (triggerType) {
      case "schedule": {
        const config = triggerConfig as ScheduleTriggerConfig;
        const accessInfo = await getAccessInfoForUser(userId);

        const { isValid, error } = validateCronExpression(config.cron, {
          accessTier: accessInfo.tier,
        });
        if (!isValid) {
          if (error === "invalid-syntax") {
            throw new UserFacingError("Invalid schedule.");
          }
          if (error === "unsupported-pattern") {
            throw new UserFacingError("This schedule is not supported.");
          }
          if (error === "pro-only") {
            throw new UserFacingError(
              "This schedule is only supported on the Pro tier.",
            );
          }
          throw new UserFacingError("Invalid or unsupported schedule.");
        }
        break;
      }
      case "pull_request": {
        const config = triggerConfig as PullRequestTriggerConfig;
        const onTriggers = Object.values(config.on).filter(Boolean);
        if (onTriggers.length === 0) {
          throw new UserFacingError("At least one trigger must be enabled");
        }
        break;
      }
      case "issue": {
        const config = triggerConfig as IssueTriggerConfig;
        const onTriggers = Object.values(config.on).filter(Boolean);
        if (onTriggers.length === 0) {
          throw new UserFacingError("At least one trigger must be enabled");
        }
        break;
      }
      case "github_mention": {
        const config = triggerConfig as GitHubMentionTriggerConfig;
        if (config.filter.includeBotMentions) {
          // Check if user has Pro tier for bot mentions
          const accessInfo = await getAccessInfoForUser(userId);
          if (accessInfo.tier !== "pro") {
            throw new UserFacingError(
              "The 'Include mentions from bot users' feature is only available on the Pro tier. Upgrade to the Pro tier to enable this feature.",
            );
          }
          if (!config.filter.botUsernames) {
            throw new UserFacingError(
              "At least one bot username must be specified",
            );
          }
          const botUsernames = config.filter.botUsernames
            .split(",")
            .map((username) => username.trim().toLowerCase());
          if (botUsernames.some((username) => !username.endsWith("[bot]"))) {
            throw new UserFacingError("Bot usernames must end with [bot]");
          }
        }
        break;
      }
      case "manual": {
        break;
      }
      default: {
        assertNever(triggerType);
      }
    }
  }
  const action = updates.action ?? automationOrNull?.action;
  if (action) {
    switch (action.type) {
      case "user_message": {
        if (triggerType === "github_mention") {
          break;
        }
        const plainText = convertToPlainText({
          message: action.config.message,
        });
        if (plainText.trim().length === 0) {
          throw new UserFacingError("Automation message cannot be empty");
        }
        break;
      }
      default: {
        assertNever(action.type);
      }
    }
  }
  return { tier };
}

export async function runPullRequestAutomation({
  userId,
  automationId,
  repoFullName,
  prEventAction,
  prNumber,
  source,
}: {
  userId: string;
  automationId: string;
  repoFullName: string;
  prEventAction: PullRequestEvent["action"];
  prNumber: number;
  source: "automated" | "manual";
}) {
  const { automation, canRun } = await validateCanRunAutomation({
    userId,
    automationId,
    triggerTypes: ["pull_request"],
    throwOnError: false,
  });
  if (!canRun) {
    return;
  }
  if (automation.repoFullName !== repoFullName) {
    throw new Error("Automation is not configured for this repository");
  }
  // Add eyes reaction to the PR
  const [owner, repo] = parseRepoFullName(repoFullName);
  await addEyesReactionToPullRequest({
    owner,
    repo,
    issueNumber: prNumber,
  });

  // Check if GitHub checks should be created for automations
  // Only create checks if the feature flag is enabled AND the automation owner is the PR author
  const [shouldCreateGitHubChecks, isPRAuthor] = await Promise.all([
    getFeatureFlagForUser({
      db,
      userId,
      flagName: "createGitHubChecksForAutomations",
    }),
    getIsPRAuthor({
      userId,
      repoFullName,
      prNumber,
    }),
  ]);

  let checkRunId: number | null = null;
  if (shouldCreateGitHubChecks && isPRAuthor) {
    checkRunId = await createGitHubCheckRunForAutomation({
      userId,
      automationId,
      prNumber,
    });
  }

  try {
    const octokit = await getOctokitForUserOrThrow({ userId });
    const pr = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    const branchName = pr.data.head.ref;

    if (source !== "manual") {
      const unarchivedThreadsForAutomation = await getThreads({
        db,
        userId,
        automationId,
        archived: false,
        githubRepoFullName: repoFullName,
        githubPRNumber: prNumber,
      });
      console.log(
        `Found ${unarchivedThreadsForAutomation.length} active threads for automation ${automationId} and PR #${prNumber} in ${repoFullName}`,
      );
      const results = await Promise.allSettled(
        unarchivedThreadsForAutomation.map((thread) =>
          archiveAndStopThread({ userId, threadId: thread.id }),
        ),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(`Error archiving thread:`, result.reason);
        }
      }
    }
    const runAutomationResult = await runAutomation({
      userId,
      automationId,
      source,
      options: {
        branchName,
        prNumber,
        transformMessage: (message: DBUserMessage) => {
          return {
            ...message,
            parts: [
              {
                type: "text" as const,
                text: `The "pull_request.${prEventAction}" event was triggered for PR #${prNumber}.`,
              },
              ...message.parts,
            ],
          };
        },
      },
    });
    if (!runAutomationResult) {
      throw new Error("Failed to create thread");
    }
    const { threadId, threadChatId } = runAutomationResult;
    if (checkRunId !== null) {
      await updateGitHubCheckRunForAutomation({
        userId,
        automationId,
        checkRunId,
        threadIdOrNull: threadId,
        threadChatIdOrNull: threadChatId,
        status: "in_progress",
        summary: `Automation started: ${threadId}`,
      });
    }
  } catch (error) {
    console.error(`Error running automation ${automationId}:`, error);
    if (checkRunId !== null) {
      await updateGitHubCheckRunForAutomation({
        userId,
        automationId,
        checkRunId,
        status: "completed",
        summary: `Error running automation`,
        conclusion: "failure",
        threadIdOrNull: null,
        threadChatIdOrNull: null,
      });
    }
  }
}

export async function runIssueAutomation({
  userId,
  automationId,
  repoFullName,
  issueEventAction,
  issueNumber,
  source,
}: {
  userId: string;
  automationId: string;
  repoFullName: string;
  issueEventAction: IssueEvent["action"];
  issueNumber: number;
  source: "automated" | "manual";
}) {
  const { automation, canRun } = await validateCanRunAutomation({
    userId,
    automationId,
    triggerTypes: ["issue"],
    throwOnError: false,
  });
  if (!canRun) {
    return;
  }
  if (automation.repoFullName !== repoFullName) {
    throw new Error("Automation is not configured for this repository");
  }
  // Add eyes reaction to the issue
  const [owner, repo] = parseRepoFullName(repoFullName);
  await addEyesReactionToPullRequest({
    owner,
    repo,
    issueNumber,
  });
  const octokit = await getOctokitForUserOrThrow({ userId });
  // Use the default branch for issues
  const defaultBranch = await octokit.rest.repos.get({ owner, repo });
  const branchName = defaultBranch.data.default_branch;
  await runAutomation({
    userId,
    automationId,
    source,
    options: {
      branchName,
      issueNumber,
      transformMessage: (message: DBUserMessage) => {
        return {
          ...message,
          parts: [
            {
              type: "text" as const,
              text: `The "issues.${issueEventAction}" event was triggered for issue #${issueNumber}.`,
            },
            ...message.parts,
          ],
        };
      },
    },
  });
}
