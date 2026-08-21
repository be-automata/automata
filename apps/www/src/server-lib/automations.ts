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
import {
  AccessTier,
  DBUserMessage,
  ThreadTrustContext,
} from "@terragon/shared";
import { getOrganizationInstallationMode } from "@terragon/shared/model/github-installation";
import { effectiveShadow } from "@/lib/github-side-effects";
import {
  PullRequestEvent,
  IssueEvent,
} from "@/app/api/webhooks/github/handlers";
import { addEyesReactionToPullRequest } from "@/app/api/webhooks/github/utils";
import {
  getOctokitForBackground,
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
import {
  resolveReviewSkill,
  renderSkillPlaceholders,
} from "./review/resolve-review-skill";
import { buildRepoOverrideFetcher } from "./review/repo-skill-override";

/**
 * Effective shadow state for an automation's org: the org's installation mode
 * folded with the deployment-level side-effects kill-switch. When true, the
 * automation must produce ZERO GitHub side effects (no eyes reaction, no check
 * runs, no boot) — the same suppression the mention + mirror-intake paths honor.
 */
async function isAutomationShadow(
  organizationId: string | null | undefined,
): Promise<boolean> {
  return effectiveShadow(
    await getOrganizationInstallationMode({ db, organizationId }),
  );
}

export async function runAutomation({
  userId,
  automationId,
  options,
  source,
}: {
  userId: string;
  automationId: string;
  options?: {
    /**
     * The branch the thread WORKS ON (the sandbox checkout) — for PR events
     * this is the PR's HEAD ref. NOT the review-diff base; see
     * prBaseBranchName.
     */
    branchName?: string;
    /**
     * The PR's BASE ref — what a review skill's `{{baseBranch}}` renders to
     * (`git diff origin/<base>...HEAD`). Distinct from branchName: rendering
     * the HEAD ref there makes the delta provably empty (caught live on
     * PR #59's review). Falls back to automation.branchName when absent.
     */
    prBaseBranchName?: string;
    transformMessage?: (message: DBUserMessage) => DBUserMessage;
    prNumber?: number;
    issueNumber?: number;
    /**
     * Server-derived PR trust snapshot (ADR-005 §3a, #82) — captured by the
     * caller (runPullRequestAutomation) from `pulls.get`, threaded through
     * unconditionally so BOTH `source: "automated"` and `source: "manual"`
     * dispatch persist it (fail-closed if the lookup failed: undefined here
     * means "no snapshot", never "trusted").
     */
    trustContext?: ThreadTrustContext | null;
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
    // Shadow mode (pilot): if the automation's org is in shadow, its
    // seeded automations create dashboard-visible tasks but never boot the agent
    // — so they light up on flip-to-active without acting during observation.
    // Folded with the deployment-level side-effects kill-switch.
    const shadow = await isAutomationShadow(automation.organizationId);
    switch (automation.action.type) {
      case "user_message": {
        const newThreadResult = await createNewThread({
          userId: automation.userId,
          // Derivation: an automation is org-owned, so its threads inherit the
          // automation's org (WI-5 batch 1). Unambiguous. Nullable-safe.
          organizationId: automation.organizationId,
          shadow,
          message: options?.transformMessage
            ? options.transformMessage(automation.action.config.message)
            : automation.action.config.message,
          githubRepoFullName: automation.repoFullName,
          baseBranchName: options?.branchName ?? automation.branchName,
          headBranchName: null,
          sourceType: "automation",
          trustContext: options?.trustContext,
          automation: automation,
          githubPRNumber: options?.prNumber,
          githubIssueNumber: options?.issueNumber,
          disableGitCheckpointing: automation.disableGitCheckpointing ?? false,
        });
        threadId = newThreadResult.threadId;
        threadChatId = newThreadResult.threadChatId;
        break;
      }
      case "skill_message": {
        // Live-skill reference (issue #54): resolve the skill body NOW, at the
        // single seam where a stored instruction becomes a thread's first
        // message — so an accepted edit is live on the next run and in-flight
        // threads are untouched by construction.
        const { skillName, version } = automation.action.config;
        const resolved = await resolveReviewSkill({
          db,
          organizationId: automation.organizationId,
          repoFullName: automation.repoFullName,
          skillName,
          version,
          // Tier 0 (#54 C5): the repo's committed override, DEFAULT branch
          // only (fetchRepoSkillOverride passes no ref by construction). Any
          // failure degrades to the DB tiers — see buildRepoOverrideFetcher.
          fetchRepoOverride: buildRepoOverrideFetcher({
            userId: automation.userId,
            repoFullName: automation.repoFullName,
            skillName,
          }),
        });
        if (!resolved) {
          // Defaultless skill with no usable version: skipping the run loudly
          // beats dispatching an agent with an empty instruction.
          console.error(
            `Automation ${automation.id}: skill '${skillName}' has no usable ` +
              `body — skipping thread creation.`,
          );
          return undefined;
        }
        // Two DIFFERENT branches: the thread works on options.branchName (the
        // PR head for PR events), while the skill's {{baseBranch}} must be
        // the review-diff base — the PR's base ref, falling back to the
        // automation's configured branch.
        const baseBranchName = options?.branchName ?? automation.branchName;
        const reviewDiffBase =
          options?.prBaseBranchName ?? automation.branchName;
        const message: DBUserMessage = {
          type: "user",
          model: null,
          parts: [
            {
              type: "text",
              text: renderSkillPlaceholders(resolved.body, {
                repoFullName: automation.repoFullName,
                baseBranch: reviewDiffBase,
              }),
            },
          ],
          timestamp: new Date().toISOString(),
        };
        const newThreadResult = await createNewThread({
          userId: automation.userId,
          organizationId: automation.organizationId,
          shadow,
          message: options?.transformMessage
            ? options.transformMessage(message)
            : message,
          githubRepoFullName: automation.repoFullName,
          baseBranchName,
          headBranchName: null,
          sourceType: "automation",
          // Traceability: any thread can be traced to the exact skill text it
          // ran with (contentSha) and which resolver tier served it.
          sourceMetadata: {
            type: "automation-skill",
            skillName,
            contentSha: resolved.contentSha,
            source: resolved.source,
            // Absent for a repo-file override (no version row; provenance is
            // contentSha + the repo's git history).
            ...(resolved.versionId ? { versionId: resolved.versionId } : {}),
          },
          automation: automation,
          trustContext: options?.trustContext,
          githubPRNumber: options?.prNumber,
          githubIssueNumber: options?.issueNumber,
          disableGitCheckpointing: automation.disableGitCheckpointing ?? false,
        });
        threadId = newThreadResult.threadId;
        threadChatId = newThreadResult.threadChatId;
        break;
      }
      default: {
        assertNever(automation.action);
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
      case "skill_message": {
        if (action.config.skillName.trim().length === 0) {
          throw new UserFacingError("Skill name cannot be empty");
        }
        if (action.config.version.trim().length === 0) {
          throw new UserFacingError(
            `Skill version cannot be empty — use 'latest' or a version id`,
          );
        }
        break;
      }
      default: {
        assertNever(action);
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
  // Shadow mode / kill-switch: an automation in a shadow org must produce ZERO
  // GitHub side effects. Suppress the eyes reaction + check runs here (the boot
  // is suppressed downstream in runAutomation → createNewThread).
  const shadow = await isAutomationShadow(automation.organizationId);
  const [owner, repo] = parseRepoFullName(repoFullName);
  if (!shadow) {
    // Add eyes reaction to the PR
    await addEyesReactionToPullRequest({
      owner,
      repo,
      issueNumber: prNumber,
    });
  }

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
  if (!shadow && shouldCreateGitHubChecks && isPRAuthor) {
    checkRunId = await createGitHubCheckRunForAutomation({
      userId,
      automationId,
      prNumber,
    });
  }

  try {
    // Background-capable token: falls back to the App installation token when the
    // automation owner has no GitHub identity (e.g. an email/password org owner).
    const octokit = await getOctokitForBackground({ userId, repoFullName });
    const pr = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    const branchName = pr.data.head.ref;
    // Server-derived trust snapshot (ADR-005 §3a, #82): captured HERE, from the
    // EXISTING pulls.get read (no new webhook/API call, no extra round trip),
    // for BOTH source: "automated" and "manual" — runs unconditionally, not
    // gated behind `source !== "manual"` like the thread-archival block below.
    // Unforgeable by construction: nothing in the request path lets a caller
    // set isFork/authorAssociation — this is the ONLY writer.
    const trustContext: ThreadTrustContext = {
      source: "github-pr",
      isFork: pr.data.head?.repo?.fork ?? true,
      authorAssociation: pr.data.author_association ?? "NONE",
      capturedAt: new Date().toISOString(),
    };

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
        // The review-diff base for {{baseBranch}} — the PR's BASE ref, never
        // its head (rendering head made `git diff origin/<base>...HEAD` empty).
        // Optional-chained defensively: a malformed payload must degrade to
        // the automation's configured branch (the resolver's fallback), not
        // throw inside this try and silently skip the whole run — exactly
        // what a base-less test fixture did to the shadow suite.
        prBaseBranchName: pr.data.base?.ref,
        prNumber,
        trustContext,
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
  // Shadow mode / kill-switch: suppress the eyes reaction in a shadow org (zero
  // GitHub side effects); the boot is suppressed downstream in runAutomation.
  const shadow = await isAutomationShadow(automation.organizationId);
  const [owner, repo] = parseRepoFullName(repoFullName);
  if (!shadow) {
    // Add eyes reaction to the issue
    await addEyesReactionToPullRequest({
      owner,
      repo,
      issueNumber,
    });
  }
  // Background-capable token: falls back to the App installation token when the
  // automation owner has no GitHub identity.
  const octokit = await getOctokitForBackground({ userId, repoFullName });
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
