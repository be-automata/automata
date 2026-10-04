import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import type { DBMessage } from "@terragon/shared/db/db-message";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { getAutomation } from "@terragon/shared/model/automations";
import { isAbandonedTerminalCause } from "@terragon/shared/model/terminal-cause";
import { promoteLastKnownGood } from "@terragon/shared/model/repo-skills";
import type { ThreadSourceMetadata } from "@terragon/shared";
import { getPostHogServer } from "@/lib/posthog-server";
import { getOctokitForApp } from "@/lib/github";
import { reconcilePrReviews } from "@/server-lib/reconcile-pr-reviews";
import { runMergeAuditAtFinish } from "@/server-lib/tracker/merge-audit-finish";
import {
  createOctokitReviewClient,
  getPrHeadState,
} from "./octokit-review-client";
import {
  executeReviewFromIntent,
  type ReviewFromIntentOutcome,
} from "./execute-review-from-intent";
import { hasTaggedReviewIntentOpener } from "./parse-review-intent";
import { resolveApproveFloor } from "./resolve-approve-floor";
import { PR_MERGED_SKILL_NAME } from "./review-skill";

/**
 * Review-effect dispatch at thread-finish (ADR-036). One entry the daemon-event
 * finish hook calls for a terminal PR thread:
 *   - a review thread (pull_request automation) → the control-plane executor posts
 *     exactly once from the agent's emitted intent (the agent has no gh-write
 *     outlet), with the per-repo tolerance floor applied — unconditional
 *     single-writer (the retired REVIEW_SINGLE_WRITER flag no longer gates this),
 *   - any PR thread → the post-run reconciler runs at the end as the backstop.
 * GITHUB_SIDE_EFFECTS_ENABLED gates all of it (a shadow thread never boots, but
 * this guards the global switch regardless).
 */

/** The App bot's review-author login (mirrors reconcile-pr-reviews.resolveBotLogin). */
function resolveBotLogin(): string {
  const explicit = env.GITHUB_BOT_LOGIN.trim();
  return explicit || `${env.NEXT_PUBLIC_GITHUB_APP_NAME}[bot]`;
}

/**
 * A review thread = one dispatched from a `pull_request`-triggered automation
 * (the PR-review path). Mention threads are `github_mention`; those keep the
 * mention-reply path and must NOT run the review executor.
 */
export async function isReviewThread({
  db,
  userId,
  automationId,
  organizationId,
}: {
  db: DB;
  userId: string;
  automationId: string | null;
  organizationId?: string | null;
}): Promise<boolean> {
  if (!automationId) return false;
  const automation = await getAutomation({
    db,
    userId,
    automationId,
    organizationId,
  });
  return automation?.triggerType === "pull_request";
}

type WorkFailedByOutcome = Record<ReviewFromIntentOutcome["outcome"], boolean> &
  // The union carries its OWN `workFailed: true` literal on the failing
  // variants, so this map is a second source of truth and the two could
  // silently disagree. Intersecting with the `true`-valued projection of that
  // literal makes the union the floor: a variant that declares
  // `workFailed: true` cannot be mapped to `false` here. The map may still add
  // failures the union does not mark — a deliberate decision, not drift.
  Record<
    Extract<ReviewFromIntentOutcome, { workFailed: true }>["outcome"],
    true
  >;

/**
 * The outcomes that page an operator: a run that reached a terminal state without
 * cleanly applying a review. Exported so the membership is pinnable by a unit
 * test rather than buried in an `if` inside a DB/octokit-bound function.
 *
 * Membership rationale, per entry:
 *  - `degraded_comment` / `post_failed` — the original two: no verdict applied.
 *    Since ADR-009 `degraded_comment` means a no-verdict NOTICE went to the PR
 *    conversation (never a review); its `cause` says why there was no verdict.
 *  - `skipped_stale_degrade` — withheld-warning is still a failed run: nothing
 *    reached GitHub, so telemetry is the ONLY signal an operator gets that an
 *    agent never emitted a verdict. Silent here would re-open the gap #107 is about.
 *  - `skipped_duplicate_degrade_at_commit` (#220) — DELIBERATELY INCLUDED. The
 *    per-sha dedup suppresses the duplicate COMMENT, not the fact that ANOTHER
 *    run emitted no verdict. The damage #220 fixes is PR noise a human reads; this
 *    signal is a PostHog event plus a console line, which no human reads one by
 *    one, and the repeat count at one sha is exactly what #107 needs to size a
 *    bounded auto-requeue. Suppressing it would trade a cheap duplicate event for
 *    a blind spot in the only channel that sees a serially-failing agent. The
 *    `outcome` property distinguishes it from a first degrade for anyone counting.
 *
 * EXHAUSTIVE BY CONSTRUCTION, and that is the point. A `||` chain over a widened
 * `string` would let a new `ReviewFromIntentOutcome` variant land tomorrow and
 * silently never page — this repo has been bitten by that exact shape of silent
 * inertness more than once. The Record forces a compile error instead: add a
 * variant to the union and this map stops type-checking until someone decides,
 * in writing, whether it is a failure.
 */
const WORK_FAILED_BY_OUTCOME: WorkFailedByOutcome = {
  posted: false,
  posted_stale_comment: false,
  skipped_existing: false,
  skipped_superseded: false,
  skipped_duplicate_at_commit: false,
  skipped_stale_degrade: true,
  degraded_comment: true,
  post_failed: true,
  skipped_duplicate_degrade_at_commit: true,
};

export function isWorkFailedOutcome(
  outcome: ReviewFromIntentOutcome["outcome"],
): boolean {
  return WORK_FAILED_BY_OUTCOME[outcome];
}

/**
 * Concatenate the text parts of the LAST lead (parent_tool_use_id null) agent
 * message — where the emitted intent lives. Sub-agent messages are never the
 * review (02-FINDINGS Q7; D2 single-writer): one can arrive after the lead's
 * final text. A legacy row without the field counts as a lead message.
 */
export function extractTerminalAgentText(messages: DBMessage[] | null): string {
  return findLastLeadAgentText(messages, () => true) ?? "";
}

/**
 * The joined text parts of the LAST lead agent message whose text `accept`s,
 * or null when none does. The one walk behind both extractTerminalAgentText
 * and selectReviewTerminalText.
 */
function findLastLeadAgentText(
  messages: DBMessage[] | null,
  accept: (text: string) => boolean,
): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type !== "agent" || m.parent_tool_use_id != null) continue;
    const text = m.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (accept(text)) return text;
  }
  return null;
}

/**
 * THE terminal-text decision for a review thread — one pure function used by
 * BOTH the finish hook and the hourly sweep, so the two paths cannot diverge
 * (the #213/#221/#224 lesson).
 *
 * A thread stamped `reviewPromptMode: "orchestrated"` at render time (phase 6)
 * was told to tag its final block `json review-intent`. In -p mode a
 * background sub-agent can resume the lead AFTER it emitted that block, so
 * the lead's LAST message may carry no fence (Phase 2 Q2/Q7). For those
 * threads the terminal text is the last LEAD message containing a tagged
 * opener (sub-agent messages are never candidates, as in 05-03's
 * extractTerminalAgentText), falling back to today's text; the parser then
 * prefers the tagged block. Every other thread gets exactly today's text.
 */
export function selectReviewTerminalText({
  thread,
  messages,
}: {
  thread: { sourceMetadata?: ThreadSourceMetadata | null } | null | undefined;
  messages: DBMessage[] | null;
}): { terminalText: string; preferTaggedIntent: boolean } {
  const metadata = thread?.sourceMetadata;
  const preferTaggedIntent =
    metadata?.type === "automation-skill" &&
    metadata.reviewPromptMode === "orchestrated";
  if (!preferTaggedIntent) {
    return {
      terminalText: extractTerminalAgentText(messages),
      preferTaggedIntent: false,
    };
  }
  return {
    terminalText:
      findLastLeadAgentText(messages, hasTaggedReviewIntentOpener) ??
      extractTerminalAgentText(messages),
    preferTaggedIntent: true,
  };
}

/**
 * Promote the skill version a thread ran with to `lastKnownGoodVersionId` —
 * but ONLY after a demonstrably healthy run: outcome "posted" (a clean review
 * from a parsed intent). This is what keeps the resolver's fallback tier
 * (issue #54) pointing at a body that has actually worked in production.
 * Stale/degraded/skipped outcomes prove nothing about the skill body, so they
 * promote nothing. Best-effort by design: a promotion failure must never
 * disturb the finish hook (the review already posted), so errors are logged
 * and swallowed.
 */
export async function maybePromoteSkillLastKnownGood({
  db,
  organizationId,
  repoFullName,
  sourceMetadata,
  outcome,
}: {
  db: DB;
  organizationId: string | null | undefined;
  repoFullName: string;
  sourceMetadata: ThreadSourceMetadata | null | undefined;
  outcome: string;
}): Promise<void> {
  if (outcome !== "posted") return;
  if (sourceMetadata?.type !== "automation-skill") return;
  // Every resolver tier now serves a version row, but legacy stamps (and
  // org-less threads) may lack one — nothing to promote then.
  if (!sourceMetadata.versionId || !organizationId) return;
  try {
    await promoteLastKnownGood({
      db,
      organizationId,
      repoFullName,
      skillName: sourceMetadata.skillName,
      versionId: sourceMetadata.versionId,
    });
  } catch (err) {
    console.error(
      "[review-single-writer] promoteLastKnownGood failed (non-fatal)",
      {
        repoFullName,
        skillName: sourceMetadata.skillName,
        versionId: sourceMetadata.versionId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

type MergeAuditStamp = Extract<
  ThreadSourceMetadata,
  { type: "automation-skill" }
>;

/**
 * The merged-PR skill stamp of a thread the audit executor should act on, or
 * null. Null for a thread without the stamp, and for an ABANDONED run
 * (superseded / reclaimed): it never finished its audit, so a "no usable
 * result" notice for it would be noise.
 */
export function getMergeAuditStamp(
  thread:
    | {
        sourceMetadata?: ThreadSourceMetadata | null;
        terminalCause?: Parameters<typeof isAbandonedTerminalCause>[0];
      }
    | null
    | undefined,
): MergeAuditStamp | null {
  const metadata = thread?.sourceMetadata;
  if (
    metadata?.type !== "automation-skill" ||
    metadata.skillName !== PR_MERGED_SKILL_NAME
  ) {
    return null;
  }
  if (isAbandonedTerminalCause(thread?.terminalCause ?? null)) return null;
  return metadata;
}

/** The post-merge audit lane's finish effect: execute, record, promote. */
async function handleMergeAuditAtFinish({
  db,
  userId,
  threadId,
  threadChatId,
  repoFullName,
  prNumber,
  organizationId,
  stamp,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
  repoFullName: string;
  prNumber: number;
  organizationId: string | null;
  stamp: MergeAuditStamp;
}): Promise<void> {
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });
  const outcome = await runMergeAuditAtFinish({
    db,
    userId,
    organizationId,
    repoFullName,
    prNumber,
    terminalText: extractTerminalAgentText(threadChat?.messages ?? null),
    botLogin: resolveBotLogin(),
  });
  getPostHogServer().capture({
    distinctId: userId,
    event: "merge_audit_outcome",
    properties: { threadId, repoFullName, prNumber, ...outcome },
  });
  // The health signal for this skill body is an audit the agent actually
  // produced — a posted comment where every ticket was unreadable, or the
  // agent emitted no tickets, proves nothing about the skill.
  await maybePromoteSkillLastKnownGood({
    db,
    organizationId,
    repoFullName,
    sourceMetadata: stamp,
    outcome:
      outcome.outcome === "posted" && outcome.audited > 0
        ? "posted"
        : "no_health_signal",
  });
  if (outcome.outcome === "degraded_comment") {
    console.error("[merge-audit] WorkFailed — audit not applied", {
      threadId,
      repoFullName,
      prNumber,
      reason: outcome.reason,
    });
  }
}

export async function handleReviewEffectAtFinish({
  db,
  userId,
  threadId,
  threadChatId,
  repoFullName,
  prNumber,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
  repoFullName: string;
  prNumber: number;
}): Promise<void> {
  if (!env.GITHUB_SIDE_EFFECTS_ENABLED) return;

  // The review channel is UNCONDITIONALLY single-writer (ADR-036): the review
  // agent emits its verdict as a fenced-JSON intent (the deployed skill is
  // emit-only in every mode) and the control plane posts it here, exactly once,
  // with the per-repo tolerance floor applied. The old REVIEW_SINGLE_WRITER=false
  // path (agent posts directly via gh + reconciler dedup) is retired: it was
  // unwired once the skill went emit-only — the agent emitted but nothing parsed
  // or posted the intent, so no review landed. Making this unconditional is a
  // no-op in prod (already single-writer) and makes the tolerance reach GitHub
  // regardless of the vestigial flag. The reconciler still runs at the end as the
  // straddle-backstop (and the converging fallback for a non-review thread or a
  // mid-fetch throw).
  //
  // The ENTIRE path — thread lookups + review determination + intent parse + post
  // — is wrapped so ANY unexpected throw (db/octokit/HEAD) degrades to the
  // reconciler rather than propagating.
  // This runs in the finish hook alongside the BUG-EXEC-01 queue-drain — a phase-2
  // bug must never regress it. The reconciler ALWAYS runs at the end: the executor's
  // straddle-backstop audit on success, AND the converging fallback for a non-review
  // thread or a mid-fetch throw (nit: the lookups used to sit OUTSIDE the try, so a
  // db blip there skipped the reconciler too).
  try {
    // automationId/organizationId live on the thread; terminal messages on the chat.
    const thread = await getThreadMinimal({ db, userId, threadId });
    const review = thread
      ? await isReviewThread({
          db,
          userId,
          automationId: thread.automationId ?? null,
          organizationId: thread.organizationId ?? null,
        })
      : false;

    // A post-merge audit thread (ADR-008): mirror-intake stamped it with the
    // merged-PR skill. Same emit-only shape as a review — the agent's final
    // message carries an intent and the control plane does every write — but
    // it has no automation row, so it is recognised by its stamp, not `review`.
    // The two lanes are exclusive: one thread has one emit-only effect.
    const mergeAuditStamp = getMergeAuditStamp(thread);
    if (mergeAuditStamp) {
      await handleMergeAuditAtFinish({
        db,
        userId,
        threadId,
        threadChatId,
        repoFullName,
        prNumber,
        organizationId: thread?.organizationId ?? null,
        stamp: mergeAuditStamp,
      });
    }
    // A PR thread that isn't a review (e.g. a mention) → reconciler only (below).
    else if (review) {
      const threadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId,
      });
      const octokit = await getOctokitForApp({
        owner: repoFullName.split("/")[0]!,
        repo: repoFullName.split("/")[1]!,
      });
      const github = createOctokitReviewClient(octokit);
      const { headSha: currentHeadSha, isDraft } = await getPrHeadState(
        octokit,
        repoFullName,
        prNumber,
      );
      // One selector for hook and sweep (phase 6): orchestrated-prompt threads
      // read the lead's tagged verdict even when a background sub-agent
      // resumed the lead afterwards (Phase 2 Q2/Q7; 05-03 drops sub-agents).
      const { terminalText, preferTaggedIntent } = selectReviewTerminalText({
        thread,
        messages: threadChat?.messages ?? null,
      });

      // Resolve ONE approve-floor snapshot for this run, fenced to the thread's
      // org (ADR-036 review floor). Read live from Neon — a dashboard change
      // takes effect on the next review with no restart.
      const approveFloorPolicy = await resolveApproveFloor({
        db,
        organizationId: thread?.organizationId ?? null,
        repoFullName,
      });

      const outcome = await executeReviewFromIntent({
        github,
        repoFullName,
        prNumber,
        botLogin: resolveBotLogin(),
        currentHeadSha,
        terminalText,
        preferTaggedIntent,
        approveFloorPolicy,
        isDraft,
        // Same two degraded-path gates as the sweep: a run that produced no
        // parseable intent must not stamp a warning onto a head it was never
        // dispatched against, nor speak at all if it was abandoned before it
        // could. Neither gate can withhold a parsed verdict.
        reviewedSha: thread?.reviewedSha ?? null,
        runAbandoned: isAbandonedTerminalCause(thread?.terminalCause ?? null),
        logger: {
          info: (message, meta) =>
            console.log(`[review-single-writer] ${message}`, meta),
          warn: (message, meta) =>
            console.warn(`[review-single-writer] ${message}`, meta),
          error: (message, meta) =>
            console.error(`[review-single-writer] ${message}`, meta),
        },
      });

      // Loud telemetry; WorkFailed (degraded/post_failed) pages so a human doesn't
      // mistake a lost verdict for a clean pass.
      getPostHogServer().capture({
        distinctId: userId,
        event: "review_single_writer_outcome",
        properties: {
          threadId,
          repoFullName,
          prNumber,
          outcome: outcome.outcome,
        },
      });
      // A clean post is THE health signal for the skill body the thread ran
      // with (issue #54): promote it to last-known-good so the resolver's
      // fallback tier only ever serves text that has worked in production.
      await maybePromoteSkillLastKnownGood({
        db,
        organizationId: thread?.organizationId ?? null,
        repoFullName,
        sourceMetadata: thread?.sourceMetadata ?? null,
        outcome: outcome.outcome,
      });

      if (isWorkFailedOutcome(outcome.outcome)) {
        console.error(
          "[review-single-writer] WorkFailed — review not cleanly applied",
          { threadId, repoFullName, prNumber, outcome },
        );
        getPostHogServer().capture({
          distinctId: userId,
          event: "review_single_writer_work_failed",
          properties: { threadId, repoFullName, prNumber, ...outcome },
        });
      }
    }
  } catch (err) {
    console.error(
      "[review-single-writer] path threw — falling back to reconciler",
      {
        threadId,
        repoFullName,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  // Fail-safe audit BEHIND the executor: converge any residue (e.g. a straddling
  // run that agent-posted during a flag-flip skew, or an executor throw above).
  // Idempotent no-op when clean.
  await reconcilePrReviews({ repoFullName, prNumber });
}
