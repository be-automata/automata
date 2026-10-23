import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { createNewThread } from "./new-thread-shared";
import { getPostHogServer } from "@/lib/posthog-server";
import {
  getAutomation,
  incrementAutomationRunCount,
  getAutomationCount,
  getIssueAutomationRunStats,
  type IssueAutomationRunStats,
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
  AutomationAction,
  isCompanionAutomation,
  validateCompanionAutomation,
} from "@terragon/shared/automations";
import {
  AccessTier,
  CompanionLaneStamp,
  DBUserMessage,
  MentionLaneStamp,
  ThreadTrustContext,
} from "@terragon/shared";
import { getOrganizationInstallationMode } from "@terragon/shared/model/github-installation";
import { effectiveShadow } from "@/lib/github-side-effects";
import { automationLimitMessage } from "@/lib/automation-limit";
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
import { FINDING_LABELS, normalizeLabel } from "./audit/render-issue";
import { buildRepoOverrideFetcher } from "./review/repo-skill-override";
import { resolveReviewPromptMode } from "./review/resolve-review-prompt-mode";
import {
  renderPrDiffContext,
  renderPrEventLine,
} from "./review/pr-diff-context";
import {
  isAuditFixAction,
  CLASSIC_REVIEW_PROMPT,
  findReviewContextDirective,
  hasReviewModeSections,
  substituteReviewContext,
  type ReviewPromptMode,
} from "./review/review-skill";
import {
  NO_PR_REVIEW_CONTEXT,
  prefetchReviewContextForPr,
} from "./review/prefetch-review-context";
import type { RestPullRequestLike } from "@terragon/review/context/render";

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
    /**
     * The PR the caller already read (`pulls.get`), when it did: the
     * review-context prefetch renders its pr-view block from it rather than
     * reading the same PR again.
     */
    pullRequest?: RestPullRequestLike;
    issueNumber?: number;
    /**
     * Server-derived PR trust snapshot (ADR-005 §3a, #82) — captured by the
     * caller (runPullRequestAutomation) from `pulls.get`, threaded through
     * unconditionally so BOTH `source: "automated"` and `source: "manual"`
     * dispatch persist it (fail-closed if the lookup failed: undefined here
     * means "no snapshot", never "trusted").
     */
    trustContext?: ThreadTrustContext | null;
    /**
     * #127: the originating webhook's X-GitHub-Delivery id — threaded through
     * thread creation to the Hatchet dispatch as its idempotency identity.
     */
    deliveryId?: string;
    /** #125 C5: the PR head SHA the run reviews (stamped on the thread). */
    headSha?: string;
    /**
     * Phase 9 (RACE-01): extra fields merged into the automation-skill stamp
     * at thread creation, so the fix attempt travels with the thread. Applies
     * to skill_message automations only; ignored for user_message.
     * `mention` (the org-owned mention lane) also turns git checkpointing off
     * for the thread: the agent pushes its own fix to the PR head, and the
     * lane never auto-commits or opens a pull request.
     */
    stampExtra?: {
      selfHealAttemptId?: string;
      mention?: MentionLaneStamp;
      /**
       * The PR companion lane: the PR and head the run reports on. Like
       * `mention` it turns git checkpointing off: a companion never commits,
       * pushes or opens a pull request.
       */
      companion?: CompanionLaneStamp;
      /**
       * PR-event runs: the base ref the run was dispatched against. The
       * single writer keys "is this the same review?" on it, so a retarget
       * at an unchanged head is not read as a replay of the earlier review.
       */
      reviewBase?: string;
    };
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
          deliveryId: options?.deliveryId,
          reviewedSha: options?.headSha,
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
        const { skillName, version, model } = automation.action.config;
        // Review-mode sections (phase 6) are opt-in and github-ops only. A PR
        // review (the same predicate dispatch's isReviewThread uses) renders
        // the mode the Phase 4 resolver picks; anything else renders classic;
        // every other skill gets its body verbatim. The render happens per
        // thread creation (per push), so flipping a repo back to classic
        // restores today's prompt on the next push (ROADMAP Phase 6 SC3).
        // Independent of the skill body, so resolved alongside it.
        const [resolved, reviewPrompt] = await Promise.all([
          resolveReviewSkill({
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
          }),
          resolveRenderedReviewPrompt({
            automation,
            skillName,
            prNumber: options?.prNumber,
            trustContext: options?.trustContext ?? null,
          }),
        ]);
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
        const orchestratedApplied =
          reviewPrompt?.mode === "orchestrated" &&
          hasReviewModeSections(resolved.body);
        const renderedBody = renderSkillPlaceholders(resolved.body, {
          repoFullName: automation.repoFullName,
          baseBranch: reviewDiffBase,
          reviewPrompt,
        });
        // A skill's context directive is substituted LAST, after sections and
        // placeholders, so the fetched (untrusted) GitHub text is never itself
        // rendered. Read with the App token here; the agent never touches
        // GitHub (ADR-004).
        const contextFetchers = findReviewContextDirective(renderedBody);
        const text = contextFetchers
          ? substituteReviewContext(
              renderedBody,
              options?.prNumber !== undefined
                ? await prefetchReviewContextForPr({
                    repoFullName: automation.repoFullName,
                    prNumber: options.prNumber,
                    fetchers: contextFetchers,
                    pullRequest: options.pullRequest,
                  })
                : NO_PR_REVIEW_CONTEXT,
            )
          : renderedBody;
        const message: DBUserMessage = {
          type: "user",
          // A pinned model wins; absent keeps the owner's default (null).
          model: model ?? null,
          parts: [{ type: "text", text }],
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
            // Last, so a classic thread's object stays key-for-key today's.
            ...(orchestratedApplied
              ? { reviewPromptMode: "orchestrated" as const }
              : {}),
            ...(options?.stampExtra?.selfHealAttemptId
              ? { selfHealAttemptId: options.stampExtra.selfHealAttemptId }
              : {}),
            ...(options?.stampExtra?.mention
              ? { mention: options.stampExtra.mention }
              : {}),
            ...(options?.stampExtra?.companion
              ? { companion: options.stampExtra.companion }
              : {}),
            ...(options?.stampExtra?.reviewBase
              ? { reviewBase: options.stampExtra.reviewBase }
              : {}),
          },
          automation: automation,
          trustContext: options?.trustContext,
          githubPRNumber: options?.prNumber,
          githubIssueNumber: options?.issueNumber,
          disableGitCheckpointing:
            options?.stampExtra?.mention !== undefined ||
            options?.stampExtra?.companion !== undefined ||
            (automation.disableGitCheckpointing ?? false),
          deliveryId: options?.deliveryId,
          reviewedSha: options?.headSha,
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

/**
 * The review-prompt mode a skill_message thread renders: undefined for any
 * skill but github-ops (its body stays verbatim), the resolved mode for an
 * org's PR review, classic otherwise.
 */
async function resolveRenderedReviewPrompt({
  automation,
  skillName,
  prNumber,
  trustContext,
}: {
  automation: Automation;
  skillName: string;
  prNumber: number | undefined;
  trustContext: ThreadTrustContext | null;
}): Promise<ReviewPromptMode | undefined> {
  if (skillName !== "github-ops") {
    return undefined;
  }
  if (
    automation.triggerType !== "pull_request" ||
    !automation.organizationId ||
    prNumber === undefined
  ) {
    return CLASSIC_REVIEW_PROMPT;
  }
  return resolveReviewPromptMode({
    db,
    organizationId: automation.organizationId,
    repoFullName: automation.repoFullName,
    trustContext,
  });
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

export interface AutomationLimitStatus {
  reached: boolean;
  /** Active, non-manual automations across ALL the user's orgs. */
  count: number;
  /** The plan's cap, or null when the plan has none. */
  max: number | null;
}

/**
 * The plan's active-automation cap is account-wide (a billing decision), so
 * the count is NOT fenced by the active org — unlike the automations list.
 * The UI must say "across all your organizations" for that reason.
 */
export async function getAutomationLimitStatus({
  userId,
  tier,
}: {
  userId: string;
  tier: AccessTier;
}): Promise<AutomationLimitStatus> {
  if (tier === "pro" || tier === "none") {
    return { reached: false, count: 0, max: null };
  }
  const [rawCount, max] = await Promise.all([
    getAutomationCount({ db, userId }),
    getMaxAutomationsForUser(userId),
  ]);
  const count = Number(rawCount);
  return { reached: max !== null && count >= max, count, max };
}

/**
 * ROLL-01: a self-heal fix automation (action = the audit-fix skill) may only
 * trigger on the `automata:auto-fix` label — `on.labeled` true, `on.open` not
 * true, and `filter.labels` naming that label. An older www strips the
 * `labeled`/`labels` keys and fires only on `opened` + `on.open`, so a config
 * of this shape has no trigger a rolled-back www can ever fire.
 */
function assertSelfHealFixAutomationIsLabeledOnly({
  triggerType,
  triggerConfig,
  action,
}: {
  triggerType: AutomationTriggerType | undefined;
  triggerConfig: Automation["triggerConfig"] | undefined;
  action: AutomationAction | undefined;
}): void {
  if (!isAuditFixAction(action)) return;
  const error = new UserFacingError(
    `Self-heal fix automations must trigger only on the ${FINDING_LABELS.autoFix} label`,
  );
  if (triggerType !== "issue" || !triggerConfig) {
    throw error;
  }
  const config = triggerConfig as IssueTriggerConfig;
  const labels = (config.filter?.labels ?? []).map(normalizeLabel);
  if (
    config.on?.labeled !== true ||
    config.on?.open === true ||
    !labels.includes(FINDING_LABELS.autoFix)
  ) {
    throw error;
  }
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
      const limit = await getAutomationLimitStatus({ userId, tier });
      if (limit.reached) {
        throw new UserFacingError(
          automationLimitMessage({
            ...limit,
            next: automationId === null ? "create" : "enable",
          }),
        );
      }
    }
  }
  const repoFullName = updates.repoFullName ?? automationOrNull?.repoFullName;
  if (!repoFullName) {
    throw new UserFacingError("Repo full name is required");
  }
  assertSelfHealFixAutomationIsLabeledOnly({
    triggerType,
    triggerConfig,
    action: updates.action ?? automationOrNull?.action,
  });
  const companionError = validateCompanionAutomation({
    triggerType,
    triggerConfig,
    action: updates.action ?? automationOrNull?.action,
  });
  if (companionError !== null) {
    throw new UserFacingError(companionError);
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
        if (config.on.labeled && (config.filter.labels ?? []).length === 0) {
          throw new UserFacingError(
            "Trigger on label requires at least one label in the filter",
          );
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
  deliveryId,
  expectedHeadSha,
  baseChangedFrom,
}: {
  userId: string;
  automationId: string;
  repoFullName: string;
  prEventAction: PullRequestEvent["action"];
  prNumber: number;
  source: "automated" | "manual";
  /** #127: originating webhook delivery id (absent for manual runs). */
  deliveryId?: string;
  /**
   * #107: a re-run of a failed review is for ONE head. When set, the run is
   * not started (returns false) unless the PR is open and its head is still
   * this sha, read from the same pulls.get the run derives everything from.
   */
  expectedHeadSha?: string;
  /**
   * A retarget (`pull_request.edited` with `changes.base`): the base ref
   * before the change. Only named in the prompt; the run itself always
   * diffs against the base it reads from pulls.get below.
   */
  baseChangedFrom?: string | null;
}): Promise<boolean> {
  const { automation, canRun } = await validateCanRunAutomation({
    userId,
    automationId,
    triggerTypes: ["pull_request"],
    throwOnError: false,
  });
  if (!canRun) {
    return false;
  }
  if (automation.repoFullName !== repoFullName) {
    throw new Error("Automation is not configured for this repository");
  }
  // Shadow mode / kill-switch: an automation in a shadow org must produce ZERO
  // GitHub side effects. Suppress the eyes reaction + check runs here (the boot
  // is suppressed downstream in runAutomation → createNewThread).
  const shadow = await isAutomationShadow(automation.organizationId);
  const [owner, repo] = parseRepoFullName(repoFullName);
  // #107: a re-run for one head reads the PR FIRST and refuses before any PR
  // side effect — no eyes reaction, no check run — when the PR closed or its
  // head moved. A refused re-run must leave nothing on the PR. A failed read
  // is not a refusal: it falls through to the normal error handling below.
  const earlyPrRead =
    expectedHeadSha !== undefined
      ? await readPullRequest({ userId, repoFullName, prNumber })
      : undefined;
  if (
    earlyPrRead?.ok &&
    (earlyPrRead.data.state !== "open" ||
      earlyPrRead.data.head.sha !== expectedHeadSha)
  ) {
    console.warn(
      `[automations] re-run refused: ${repoFullName}#${prNumber} is no longer open at ${expectedHeadSha}`,
      { state: earlyPrRead.data.state, headSha: earlyPrRead.data.head.sha },
    );
    return false;
  }
  // Independent, so concurrent: the eyes reaction (never throws), the checks
  // flag, and the PR read everything below is derived from.
  const [shouldCreateGitHubChecks, prRead] = await Promise.all([
    getFeatureFlagForUser({
      db,
      userId,
      flagName: "createGitHubChecksForAutomations",
    }),
    earlyPrRead ?? readPullRequest({ userId, repoFullName, prNumber }),
    shadow
      ? undefined
      : addEyesReactionToPullRequest({ owner, repo, issueNumber: prNumber }),
  ]);

  // Only create checks if the feature flag is enabled AND the automation owner
  // is the PR author. The author lookup costs GitHub round trips, so it runs
  // only when its answer can matter.
  let checkRunId: number | null = null;
  if (
    !shadow &&
    shouldCreateGitHubChecks &&
    (await getIsPRAuthor({ userId, repoFullName, prNumber }))
  ) {
    checkRunId = await createGitHubCheckRunForAutomation({
      userId,
      automationId,
      prNumber,
    });
  }

  try {
    if (!prRead.ok) {
      throw prRead.error;
    }
    const pr = prRead.data;
    const branchName = pr.head.ref;
    // #125 C5: the SHA this run reviews, from the SAME read — stamped on the
    // thread (reviewedSha) so the recheck reconciliation never re-reads GitHub.
    const headSha = pr.head.sha;
    // Server-derived trust snapshot (ADR-005 §3a, #82): captured HERE, from the
    // EXISTING pulls.get read (no new webhook/API call, no extra round trip),
    // for BOTH source: "automated" and "manual" — runs unconditionally.
    // Unforgeable by construction: nothing in the request path lets a caller
    // set isFork/authorAssociation — this is the ONLY writer.
    // Phase 4: isCrossRepo comes from the SAME read and covers a same-owner,
    // non-fork head in another repo that `fork` alone misses. Missing head or
    // base repo data fails closed (true).
    const trustContext: ThreadTrustContext = {
      source: "github-pr",
      isFork: pr.head?.repo?.fork ?? true,
      authorAssociation: pr.author_association ?? "NONE",
      capturedAt: new Date().toISOString(),
      isCrossRepo: isCrossRepoPull(pr),
    };

    // #165 (ADR-007): www owns NO supersession path. Prior review threads of
    // this automation+PR are left entirely to the engine's per-PR concurrency
    // (the policy variant superseded/queued/discarded them at dispatch) and to
    // the C4 sweep's typed terminals. The pre-#165 archival block lived here.
    // A PR companion touches no other thread either: it is not on the review
    // plan (no prKey), so the engine never supersedes it or by it, and its
    // terminal writer only ever edits its own marked comment.

    // The PR companion lane: stamp the PR + head the report describes, so the
    // finish writer posts ONE comment and never mistakes the run for a review.
    let companion: CompanionLaneStamp | undefined;
    if (isCompanionAutomation(automation)) {
      if (automation.action.type !== "skill_message") {
        // Unreachable through the write boundary (validateCompanionAutomation):
        // a hand-written row must not dispatch a run that could never report.
        throw new Error(
          `Companion automation ${automationId} has no skill_message action`,
        );
      }
      companion = {
        repoFullName,
        prNumber,
        headSha,
        skillName: automation.action.config.skillName,
      };
    }

    const runAutomationResult = await runAutomation({
      userId,
      automationId,
      source,
      options: {
        branchName,
        deliveryId,
        headSha,
        // The review-diff base for {{baseBranch}} — the PR's BASE ref, never
        // its head (rendering head made `git diff origin/<base>...HEAD` empty).
        // Optional-chained defensively: a malformed payload must degrade to
        // the automation's configured branch (the resolver's fallback), not
        // throw inside this try and silently skip the whole run — exactly
        // what a base-less test fixture did to the shadow suite.
        prBaseBranchName: pr.base?.ref,
        prNumber,
        // The review-context prefetch renders its pr-view block from this
        // read instead of fetching the same PR again.
        pullRequest: pr,
        trustContext,
        stampExtra: {
          ...(companion ? { companion } : {}),
          ...(pr.base?.ref ? { reviewBase: pr.base.ref } : {}),
        },
        // The control plane names the base in EVERY PR-event prompt, whatever
        // the skill body says: a skill without {{baseBranch}} left the agent
        // to guess the default branch, which is wrong on a stacked PR. Branch
        // names are untrusted and rendered through safeGitRef.
        transformMessage: (message: DBUserMessage) => {
          return {
            ...message,
            parts: [
              {
                type: "text" as const,
                text: `${renderPrEventLine({
                  action: prEventAction,
                  prNumber,
                  ...(baseChangedFrom !== undefined ? { baseChangedFrom } : {}),
                })}\n${renderPrDiffContext({
                  prNumber,
                  baseRef: pr.base?.ref,
                  baseSha: pr.base?.sha,
                  headRef: branchName,
                  headSha,
                })}`,
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
    return true;
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
    return false;
  }
}

type PullRequestData = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof getOctokitForBackground>>["rest"]["pulls"]["get"]
  >
>["data"];

/**
 * The PR read a pull-request run derives its branch, head SHA and trust
 * snapshot from. Settled rather than thrown, so it can run concurrently with
 * the eyes reaction and the checks flag and still fail inside the caller's
 * try, where a check run is closed out.
 */
async function readPullRequest({
  userId,
  repoFullName,
  prNumber,
}: {
  userId: string;
  repoFullName: string;
  prNumber: number;
}): Promise<
  { ok: true; data: PullRequestData } | { ok: false; error: unknown }
> {
  try {
    const [owner, repo] = parseRepoFullName(repoFullName);
    // Background-capable token: falls back to the App installation token when the
    // automation owner has no GitHub identity (e.g. an email/password org owner).
    const octokit = await getOctokitForBackground({ userId, repoFullName });
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * True when a PR's head lives in another repository than its base (a fork, or
 * a same-owner repo) — compared case-insensitively. Missing head or base repo
 * data (e.g. a deleted fork) fails closed: true.
 */
export function isCrossRepoPull(pull: {
  head?: { repo?: { full_name?: string | null } | null } | null;
  base?: { repo?: { full_name?: string | null } | null } | null;
}): boolean {
  const head = pull.head?.repo?.full_name?.toLowerCase();
  const base = pull.base?.repo?.full_name?.toLowerCase();
  return head && base ? head !== base : true;
}

/**
 * The most runs one issue automation starts for a single issue from webhooks.
 * Each run opens its own PR, so without a bound an operator re-labeling an
 * issue chains partial-delivery PRs indefinitely (#277 collected five).
 */
export const MAX_ISSUE_RUNS_PER_ISSUE = 3;

/**
 * How long a webhook-triggered run holds its per-issue claim. Covers the
 * GitHub round trips between the run check and the thread insert, so an
 * `opened` + `labeled` pair delivered milliseconds apart starts one run. Left
 * to expire: once the thread row exists the stats query takes over.
 */
const ISSUE_RUN_CLAIM_TTL_SECONDS = 120;

type IssueRunSkipReason = "run-in-flight" | "run-cap-reached";

function issueRunClaimKey(
  automationId: string,
  repoFullName: string,
  issueNumber: number,
): string {
  return `issue-automation-run:${automationId}:${repoFullName}#${issueNumber}`;
}

/**
 * Why a webhook-triggered issue run must not start (null when it may), with
 * the counts behind the decision.
 */
async function getIssueRunSkipReason({
  automation,
  repoFullName,
  issueNumber,
}: {
  automation: Automation;
  repoFullName: string;
  issueNumber: number;
}): Promise<{
  reason: IssueRunSkipReason | null;
  stats: IssueAutomationRunStats | null;
}> {
  const claim = await redis.set(
    issueRunClaimKey(automation.id, repoFullName, issueNumber),
    "1",
    { nx: true, ex: ISSUE_RUN_CLAIM_TTL_SECONDS },
  );
  if (claim !== "OK") {
    return { reason: "run-in-flight", stats: null };
  }
  const stats = await getIssueAutomationRunStats({
    db,
    userId: automation.userId,
    automationId: automation.id,
    repoFullName,
    issueNumber,
  });
  if (stats.active > 0) {
    return { reason: "run-in-flight", stats };
  }
  if (stats.total >= MAX_ISSUE_RUNS_PER_ISSUE) {
    return { reason: "run-cap-reached", stats };
  }
  return { reason: null, stats };
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
  // A manual run is an explicit operator request, so only webhook-triggered
  // runs are bounded (a closed issue is filtered earlier, in the webhook
  // handler). Checked before the eyes reaction: a skipped event leaves no
  // trace on the issue.
  if (source === "automated") {
    const { reason, stats } = await getIssueRunSkipReason({
      automation,
      repoFullName,
      issueNumber,
    });
    if (reason) {
      const counts = stats
        ? `runs=${stats.total}, inFlight=${stats.active}`
        : "claim held by a concurrent event";
      console.log(
        `Skipping issue automation ${automationId} for ${repoFullName}#${issueNumber}: ${reason} (${counts}, cap=${MAX_ISSUE_RUNS_PER_ISSUE}); archive a stuck run or start a manual run from the UI`,
      );
      getPostHogServer().capture({
        distinctId: automation.userId,
        event: "automation_skipped",
        properties: {
          automationId,
          repoFullName,
          issueNumber,
          reason,
          ...(stats ? { runs: stats.total, inFlight: stats.active } : {}),
        },
      });
      return;
    }
  }
  try {
    await startIssueAutomationRun({
      userId,
      automation,
      repoFullName,
      issueEventAction,
      issueNumber,
      source,
    });
  } catch (error) {
    // A run that failed before its thread row existed would otherwise hold the
    // claim for its full TTL and silently skip a retry. Once the row exists the
    // stats query covers it, so releasing here never admits a duplicate.
    if (source === "automated") {
      await redis
        .del(issueRunClaimKey(automation.id, repoFullName, issueNumber))
        .catch(() => {});
    }
    throw error;
  }
}

async function startIssueAutomationRun({
  userId,
  automation,
  repoFullName,
  issueEventAction,
  issueNumber,
  source,
}: {
  userId: string;
  automation: Automation;
  repoFullName: string;
  issueEventAction: IssueEvent["action"];
  issueNumber: number;
  source: "automated" | "manual";
}) {
  const automationId = automation.id;
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
