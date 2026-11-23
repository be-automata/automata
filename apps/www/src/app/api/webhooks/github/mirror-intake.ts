import { db } from "@/lib/db";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { getRepoInstallationId } from "@terragon/shared/github-app";
import { getRepoOrgAndMode } from "@terragon/shared/model/github-installation";
import { getOrganizationOwnerUserId } from "@terragon/shared/model/organizations";
import { DBUserMessage } from "@terragon/shared/db/db-message";
import { getRepoSkill } from "@terragon/shared/model/repo-skills";
import type { ThreadSourceMetadata } from "@terragon/shared";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { effectiveShadow } from "@/lib/github-side-effects";
import { TRACKER_SETUP_KEYS_TEXT } from "@/lib/tracker-env-keys";
import { buildRepoOverrideFetcher } from "@/server-lib/review/repo-skill-override";
import {
  renderSkillPlaceholders,
  resolveReviewSkill,
} from "@/server-lib/review/resolve-review-skill";
import { PR_MERGED_SKILL_NAME } from "@/server-lib/review/review-skill";
import { resolveBotLogin } from "@/server-lib/review/bot-login";
import {
  extractTicketKeys,
  type TicketKeyExtraction,
} from "@/server-lib/tracker/extract-ticket-keys";
import {
  mergeAuditMarker,
  renderNoTicketNotice,
  renderNoticeComment,
} from "@/server-lib/tracker/merge-audit";
import { createAuditCommentClient } from "@/server-lib/tracker/merge-audit-finish";
import { createTrackerClient } from "@/server-lib/tracker/tracker-client";
import { resolveTrackerConfig } from "@/server-lib/tracker/tracker-config";
import {
  buildTrackerContextBlock,
  buildTriggerBlock,
  type MergedPrTrigger,
  trackerContextNotice,
} from "@/server-lib/tracker/tracker-context";
import { describeTrackerError } from "@/server-lib/tracker/tracker-types";
import { WebhookSkip } from "./webhook-skip";

/**
 * Mirror-intake (pilot). Prod orch-agents' WORKFLOW.md routes marketplace
 * events to skills UNCONDITIONALLY per repo; the chassis only routes PR/issue
 * events through opt-in user automations and mention events natively. This module
 * closes the gap for the event classes the chassis has no task-creation path for:
 *
 *   - pull_request.review_requested        -> "Review PR #N (review requested)"
 *   - pull_request.closed (merged=true)    -> "Post-merge follow-up for PR #N"
 *   - pull_request_review.changes_requested-> "Address changes requested on PR #N"
 *   - workflow_run (conclusion=failure)    -> "Fix CI: run '<name>' failed"
 *   - issues.labeled [bug|enhancement]     -> "Handle issue #N (labeled <label>)"
 *
 * (opened/synchronize/issues.opened are mirrored via seeded automations, not here,
 * to avoid double-firing — see deploy/PILOT-RUNBOOK.md.)
 *
 * The merged-PR class is the one exception to "the prompt is a fixed string":
 * when the repo has a live `github-pr-merged` skill, that skill body IS the
 * task (ADR-008 post-merge audit) — rendered here with the trigger and the
 * tickets the PR names, fetched by the control plane. A repo without the skill
 * keeps the fixed prompt, so onboarding is one `deploy/skill-push.ts` per repo.
 *
 * Each event produces one task in the bound org, attributed to the org owner (a
 * PR opening has no "commenter"), created SHADOW when the installation is in
 * shadow mode (row created + dashboard-visible, no boot, zero GitHub side
 * effects). Business rejections raise WebhookSkip so the route fast-acks 2xx
 * (WI-8) — GitHub must never retry an unbound/owner-less installation.
 */
export type MirrorIntent =
  | {
      kind: "pr-review-requested";
      prNumber: number;
      headBranch?: string | null;
      baseBranch?: string | null;
    }
  // Carries the PR fields the post-merge audit reads (ADR-008).
  | ({ kind: "pr-merged"; baseBranch?: string | null } & MergedPrTrigger)
  | {
      kind: "pr-changes-requested";
      prNumber: number;
      headBranch?: string | null;
      baseBranch?: string | null;
    }
  | {
      kind: "ci-failure";
      runName: string;
      runId: number;
      headBranch?: string | null;
    }
  | { kind: "issue-labeled"; issueNumber: number; label: string };

function describeIntent(
  intent: MirrorIntent,
  repoFullName: string,
): {
  prompt: string;
  githubPRNumber?: number;
  githubIssueNumber?: number;
  headBranch?: string | null;
  baseBranch?: string | null;
} {
  switch (intent.kind) {
    case "pr-review-requested":
      return {
        prompt: `Review requested on PR #${intent.prNumber} in ${repoFullName}. Perform a PR review (prod skill: github-ops).`,
        githubPRNumber: intent.prNumber,
        headBranch: intent.headBranch,
        baseBranch: intent.baseBranch,
      };
    case "pr-merged":
      return {
        prompt: `PR #${intent.prNumber} in ${repoFullName} was merged. Run the post-merge follow-up (no 'github-pr-merged' skill is configured for this repository).`,
        githubPRNumber: intent.prNumber,
        baseBranch: intent.baseBranch,
      };
    case "pr-changes-requested":
      return {
        prompt: `Changes were requested on PR #${intent.prNumber} in ${repoFullName}. Address the review and re-request (prod skill: github-ops).`,
        githubPRNumber: intent.prNumber,
        headBranch: intent.headBranch,
        baseBranch: intent.baseBranch,
      };
    case "ci-failure":
      return {
        prompt: `CI failed: workflow run '${intent.runName}' (run ${intent.runId}) in ${repoFullName} concluded in failure. Investigate and fix (prod skill: gh-fix-ci).`,
        headBranch: intent.headBranch,
      };
    case "issue-labeled":
      return {
        prompt: `Issue #${intent.issueNumber} in ${repoFullName} was labeled '${intent.label}'. Handle it (prod skill: github-ops).`,
        githubIssueNumber: intent.issueNumber,
      };
    default: {
      const _exhaustive: never = intent;
      throw new Error(
        `Unhandled mirror intent: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

type MergedPrIntent = Extract<MirrorIntent, { kind: "pr-merged" }>;

type MergedPrSkillResult =
  | {
      kind: "message";
      text: string;
      sourceMetadata: ThreadSourceMetadata;
    }
  // The PR delivers no ticket: the notice is on the PR, no thread is needed (#761).
  | { kind: "no_ticket"; referencedCount: number };

/**
 * The post-merge audit message for a repo that has the `github-pr-merged`
 * skill, or null to fall back to the fixed prompt.
 *
 * Opt-in is a DB skill row, checked BEFORE the resolver: most repos have no
 * such skill, and the resolver logs a missing skill as an error and would
 * spend a GitHub contents request on the repo-file override for every merged
 * PR. A repo-file override therefore refines a pushed skill; it cannot enable
 * the lane by itself.
 */
async function buildMergedPrSkillMessage({
  organizationId,
  ownerUserId,
  repoFullName,
  intent,
  shadow,
}: {
  organizationId: string;
  ownerUserId: string;
  repoFullName: string;
  intent: MergedPrIntent;
  shadow: boolean;
}): Promise<MergedPrSkillResult | null> {
  const configured = await getRepoSkill({
    db,
    organizationId,
    repoFullName,
    skillName: PR_MERGED_SKILL_NAME,
  });
  if (!configured) return null;

  const resolved = await resolveReviewSkill({
    db,
    organizationId,
    repoFullName,
    skillName: PR_MERGED_SKILL_NAME,
    version: "latest",
    fetchRepoOverride: buildRepoOverrideFetcher({
      userId: ownerUserId,
      repoFullName,
      skillName: PR_MERGED_SKILL_NAME,
    }),
  });
  // Every version failed validation: the resolver already logged it loudly.
  if (!resolved) return null;

  let trackerBlock: string;
  if (shadow) {
    trackerBlock = trackerContextNotice(
      "Omitted: this installation is in shadow mode.",
    );
  } else {
    const built = await buildTrackerBlockSafely({
      organizationId,
      ownerUserId,
      repoFullName,
      intent,
    });
    trackerBlock = built.block;
    // Decided from the PR's own fields and the project list, so no agent run
    // is needed. Only a resolved config and a completed extraction decide it.
    if (built.decision && built.decision.extraction.auditKeys.length === 0) {
      const posted = await postNoTicketNoticeSafely({
        repoFullName,
        intent,
        referencedKeys: built.decision.extraction.referencedKeys,
        projects: built.decision.projects,
      });
      if (posted) {
        return {
          kind: "no_ticket",
          referencedCount: built.decision.extraction.referencedKeys.length,
        };
      }
    }
  }

  return {
    kind: "message",
    text: [
      renderSkillPlaceholders(resolved.body, {
        repoFullName,
        baseBranch: intent.baseBranch ?? "the default branch",
      }),
      buildTriggerBlock(repoFullName, intent),
      trackerBlock,
    ].join("\n\n"),
    sourceMetadata: {
      type: "automation-skill",
      skillName: PR_MERGED_SKILL_NAME,
      contentSha: resolved.contentSha,
      source: resolved.source,
      ...(resolved.versionId ? { versionId: resolved.versionId } : {}),
    },
  };
}

/**
 * GitHub gives a webhook delivery ten seconds. A tracker that hangs must cost
 * the audit its context, never the delivery — a timed-out delivery is retried
 * and would create a second thread.
 */
const INTAKE_TRACKER_TIMEOUT_MS = 4_000;

/**
 * Posts the "no delivered ticket" notice on the PR, bounded by the intake
 * timeout. Returns true when the notice is on the PR (written now, or already
 * there from a redelivery); false on a failure or timeout, so the caller
 * creates the thread and the finish posts the notice instead.
 */
async function postNoTicketNoticeSafely({
  repoFullName,
  intent,
  referencedKeys,
  projects,
}: {
  repoFullName: string;
  intent: MergedPrIntent;
  referencedKeys: readonly string[];
  projects: readonly string[];
}): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const write = (async () => {
      const [owner, repo] = parseRepoFullName(repoFullName);
      const octokit = await getOctokitForApp({ owner, repo });
      return await createAuditCommentClient({
        octokit,
        owner,
        repo,
        prNumber: intent.prNumber,
        botLogin: resolveBotLogin(),
        since: intent.mergedAt ?? undefined,
      }).upsertMarkerComment(
        mergeAuditMarker(intent.prNumber),
        renderNoticeComment(
          intent.prNumber,
          renderNoTicketNotice({ referencedKeys, projects }),
        ),
        "create-only",
      );
    })();
    // A write that loses the race may still reject later; never unhandled.
    write.catch(() => undefined);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("no-ticket notice timed out")),
        INTAKE_TRACKER_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([write, timeout]);
    return result === "created" || result === "kept_existing";
  } catch (error) {
    console.warn("[mirror-intake] no-ticket notice not posted", {
      repoFullName,
      prNumber: intent.prNumber,
      error: describeTrackerError(error),
    });
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface TrackerBlockResult {
  block: string;
  /** Non-null only when the config resolved and the extraction ran. */
  decision: {
    extraction: TicketKeyExtraction;
    projects: readonly string[];
  } | null;
}

/**
 * A misconfigured or unreachable tracker must not lose the task: the thread is
 * still created and the finish executor reports the problem on the PR.
 */
async function buildTrackerBlockSafely({
  organizationId,
  ownerUserId,
  repoFullName,
  intent,
}: {
  organizationId: string;
  ownerUserId: string;
  repoFullName: string;
  intent: MergedPrIntent;
}): Promise<TrackerBlockResult> {
  try {
    const config = await resolveTrackerConfig({
      db,
      userId: ownerUserId,
      organizationId,
      repoFullName,
    });
    if (!config) {
      return {
        block: trackerContextNotice(
          `No tracker is configured for this repository. Set ${TRACKER_SETUP_KEYS_TEXT} on the organization environment or on this repository's environment.`,
        ),
        decision: null,
      };
    }
    const extraction = extractTicketKeys({
      title: intent.title,
      body: intent.body,
      headBranch: intent.headBranch,
      projects: config.projects,
    });
    return {
      block: await buildTrackerContextBlock({
        tracker: createTrackerClient(config, {
          timeoutMs: INTAKE_TRACKER_TIMEOUT_MS,
        }),
        extraction,
      }),
      decision: { extraction, projects: config.projects },
    };
  } catch (error) {
    console.error("[mirror-intake] tracker context unavailable", {
      repoFullName,
      error: describeTrackerError(error),
    });
    return {
      block: trackerContextNotice("Tracker unavailable."),
      decision: null,
    };
  }
}

export async function createMirrorTask({
  repoFullName,
  installationId,
  accountLogin,
  intent,
}: {
  repoFullName: string;
  installationId: number | string | null | undefined;
  accountLogin?: string | null;
  intent: MirrorIntent;
}): Promise<void> {
  // A repo-level webhook delivery carries no installation, so a repo wired that
  // way could never reach this lane. Resolve it from the App for a merged PR
  // only, and only to run a configured audit (see the skip below): every other
  // mirror row stays off for such deliveries, as it always was.
  //
  // A lookup failure other than "not installed" propagates on purpose: the
  // delivery then shows as failed in GitHub and can be redelivered. Turning an
  // outage into a skip would lose the audit for that merge without a trace.
  const viaRepoLookup =
    (installationId === null || installationId === undefined) &&
    intent.kind === "pr-merged";
  const [owner, repo] = repoFullName.split("/");
  const resolvedInstallationId =
    viaRepoLookup && owner && repo
      ? await getRepoInstallationId(owner, repo)
      : installationId;
  const { organizationId, mode } = await getRepoOrgAndMode({
    db,
    installationId: resolvedInstallationId,
    repoFullName,
  });
  if (!organizationId) {
    // WI-8: unbound installation is a business rejection, not an error. Fast-ack
    // 2xx with a log naming the id + account so an operator can bind it.
    throw new WebhookSkip(
      "unmapped_installation",
      `No org bound to installation for ${repoFullName}`,
      { installationId, accountLogin, repoFullName, intent: intent.kind },
    );
  }
  const ownerUserId = await getOrganizationOwnerUserId({
    db,
    organizationId,
  });
  if (!ownerUserId) {
    throw new WebhookSkip(
      "no_mapped_users",
      `Bound org ${organizationId} has no member to attribute the task to`,
      { installationId, accountLogin, repoFullName, organizationId },
    );
  }

  const { prompt, githubPRNumber, githubIssueNumber, headBranch, baseBranch } =
    describeIntent(intent, repoFullName);

  // Per-installation mode, folded with the deployment-level side-effects switch.
  const shadow = effectiveShadow(mode);

  const skillMessage =
    intent.kind === "pr-merged"
      ? await buildMergedPrSkillMessage({
          organizationId,
          ownerUserId,
          repoFullName,
          intent,
          shadow,
        })
      : null;
  if (skillMessage?.kind === "no_ticket") {
    console.log(
      "[mirror-intake] no delivered ticket; notice posted, no thread",
      {
        repoFullName,
        prNumber: githubPRNumber,
        outcome: "no_ticket",
        referencedCount: skillMessage.referencedCount,
      },
    );
    return;
  }
  if (viaRepoLookup && !skillMessage) {
    throw new WebhookSkip(
      "unconfigured_repo",
      `No '${PR_MERGED_SKILL_NAME}' skill for ${repoFullName}`,
      { installationId, accountLogin, repoFullName, intent: intent.kind },
    );
  }

  const message: DBUserMessage = {
    type: "user",
    model: null,
    parts: [{ type: "text", text: skillMessage ? skillMessage.text : prompt }],
    timestamp: new Date().toISOString(),
  };
  console.log("[mirror-intake] creating task", {
    repoFullName,
    organizationId,
    mode,
    intent: intent.kind,
  });

  await newThreadInternal({
    userId: ownerUserId,
    organizationId,
    shadow,
    message,
    githubRepoFullName: repoFullName,
    baseBranchName: baseBranch ?? undefined,
    headBranchName: headBranch ?? undefined,
    githubPRNumber,
    githubIssueNumber,
    sourceType: "automation",
    // Traceability + the finish hook's routing key: a thread stamped with the
    // merged-PR skill is the one the audit executor acts on.
    ...(skillMessage ? { sourceMetadata: skillMessage.sourceMetadata } : {}),
  });
}
