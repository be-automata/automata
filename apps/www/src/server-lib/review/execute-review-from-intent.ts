import type {
  ReviewGitHubClient,
  ReviewLogger,
} from "@terragon/review/state/review-github-client";
import {
  executeReviewIntent,
  type ReviewIntentOutcome,
} from "@terragon/review/state/review-intent-executor";
import { findBotReviewAtHead } from "@terragon/review/state/head-review-guard";
import {
  applyApproveSeverityFloor,
  DEFAULT_APPROVE_SEVERITY_POLICY,
  type ApproveSeverityPolicy,
} from "@terragon/review/severity-policy";
import { parseReviewIntent, toExecutorIntent } from "./parse-review-intent";

/**
 * The control-plane single writer for a review thread's effect (ADR-036 phase-2).
 * Given the agent's terminal output (which under the flag is emit-only — no
 * gh-write) this parses the fenced-JSON intent and posts EXACTLY ONE review via
 * the injected App-scoped client, with verdict-aware idempotency + the never-
 * silent-drop guarantees. Pure orchestration over `ReviewGitHubClient` + the
 * provided current HEAD sha, so it is fully unit-testable.
 *
 * Guarantees:
 *  - POSTED-ZERO IMPOSSIBLE: a missing/malformed intent degrades to a visibly
 *    marked COMMENT review + a workFailed signal — never a silent no-review.
 *  - STALE-INTENT NEVER SILENT-DROP: an intent for an older commit is posted at
 *    that commit (GitHub records it truthfully) UNLESS a newer bot review already
 *    sits at the live HEAD (then skip as superseded, logged).
 *  - IDEMPOTENT: delegates to executeReviewIntent's (headSha,verdict) HEAD-guard,
 *    so a finish-hook/sweep double-fire converges to skipped_existing.
 */

export const DEGRADED_INTENT_MARKER =
  "⚠️ Review intent could not be parsed — verdict NOT applied. This is NOT a clean pass.";

export type ReviewFromIntentOutcome =
  | { outcome: "posted"; verdict: string }
  | { outcome: "posted_stale_comment"; intendedVerdict: string }
  | { outcome: "skipped_existing" }
  | { outcome: "skipped_superseded" }
  | { outcome: "degraded_comment"; reason: string; workFailed: true }
  | { outcome: "post_failed"; failureReason: string; workFailed: true };

export interface ExecuteReviewFromIntentOpts {
  github: ReviewGitHubClient;
  repoFullName: string;
  prNumber: number;
  botLogin: string;
  /** Live PR HEAD sha at execution time (fetched by the caller). */
  currentHeadSha: string;
  /** The agent's terminal output (from the persisted thread messages). */
  terminalText: string;
  postInlineComments?: boolean;
  /**
   * The ONE per-repo approve-severity-floor snapshot for this run (ADR-036
   * review floor). Downgrades a too-generous `approve` to `request_changes` /
   * `comment` server-side per the repo's tolerance. Defaults to the locked
   * `warning` floor when the caller does not resolve one, so the floor is
   * enforced even absent a per-repo override — never a verbatim pass-through.
   */
  approveFloorPolicy?: ApproveSeverityPolicy;
  /** Draft PR → the floor caps at `comment` (never a formal request_changes). */
  isDraft?: boolean;
  logger?: ReviewLogger;
}

/** Post the emitted review intent as the single writer. Never silent-drops. */
export async function executeReviewFromIntent(
  opts: ExecuteReviewFromIntentOpts,
): Promise<ReviewFromIntentOutcome> {
  const {
    github,
    repoFullName,
    prNumber,
    botLogin,
    currentHeadSha,
    terminalText,
    logger,
  } = opts;

  const parsed = parseReviewIntent(terminalText);
  if (!parsed.ok) {
    // Zero-effects / malformed → degraded COMMENT + loud workFailed. The COMMENT
    // is visibly marked so a lost request_changes can't masquerade as a clean pass.
    return await postDegradedComment({
      github,
      repoFullName,
      prNumber,
      currentHeadSha,
      reason: parsed.reason,
      logger,
    });
  }

  const emitted = parsed.intent;
  // Apply the per-repo approve-severity floor server-side BEFORE anything is
  // posted — the load-bearing guarantee. `applyApproveSeverityFloor` only ever
  // downgrades a too-generous `approve` (comment/request_changes pass through),
  // recomputing the verdict from the findings' severities under this repo's
  // tolerance. This runs identically for the fresh and stale paths so the
  // effective verdict is consistent regardless of HEAD movement.
  const execIntent = applyApproveSeverityFloor(
    toExecutorIntent(emitted),
    opts.approveFloorPolicy ?? DEFAULT_APPROVE_SEVERITY_POLICY,
    { isDraft: opts.isDraft },
  );
  const effectiveVerdict = execIntent.verdict;
  const isStale = emitted.commit !== currentHeadSha;

  if (isStale) {
    // The PR moved since the agent reviewed. Never silent-drop: post the verdict
    // as a COMMENT review AT the reviewed commit (GitHub records commit_id
    // truthfully via submitReviewWithComments), UNLESS a newer bot review already
    // sits at live HEAD (then skip as superseded). We post a COMMENT rather than a
    // formal APPROVE/REQUEST_CHANGES because the octokit createReview verdict path
    // posts at the LATEST commit (no commit_id), which would mis-attribute a stale
    // verdict to code the agent never saw — team-lead's blessed minimum-acceptable
    // path (a marked COMMENT "reviewed at <sha>, PR has moved" + telemetry).
    let newerAtHead = null;
    try {
      newerAtHead = await findBotReviewAtHead({
        github,
        repo: repoFullName,
        prNumber,
        headSha: currentHeadSha,
        botLogin,
      });
    } catch {
      // read failure → fall through and post (missed verdict worse than rare dup).
    }
    if (newerAtHead) {
      logger?.info(
        "review-from-intent: stale intent superseded by review at HEAD",
        {
          repoFullName,
          prNumber,
          intentCommit: emitted.commit,
          currentHeadSha,
        },
      );
      return { outcome: "skipped_superseded" };
    }
    const staleBody = `_Intended verdict: **${effectiveVerdict}**, reviewed at \`${emitted.commit}\`; the PR has since advanced to \`${currentHeadSha}\`, so this is posted as a COMMENT rather than a formal verdict._\n\n${execIntent.body}`;
    try {
      await github.submitReviewWithComments(
        repoFullName,
        prNumber,
        emitted.commit,
        "COMMENT",
        staleBody,
        [],
      );
      logger?.info(
        "review-from-intent: posted stale intent as a COMMENT at reviewed commit",
        {
          repoFullName,
          prNumber,
          intentCommit: emitted.commit,
          currentHeadSha,
          intendedVerdict: emitted.verdict,
        },
      );
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : String(err);
      logger?.error("review-from-intent: stale COMMENT post failed", {
        repoFullName,
        prNumber,
        reason: failureReason,
      });
      return { outcome: "post_failed", failureReason, workFailed: true };
    }
    return {
      outcome: "posted_stale_comment",
      intendedVerdict: effectiveVerdict,
    };
  }

  const outcome = await runExecutor({
    github,
    repoFullName,
    prNumber,
    botLogin,
    headSha: currentHeadSha,
    execIntent,
    postInlineComments: opts.postInlineComments,
    logger,
  });
  return mapOutcome(outcome);
}

async function runExecutor(args: {
  github: ReviewGitHubClient;
  repoFullName: string;
  prNumber: number;
  botLogin: string;
  headSha: string;
  execIntent: ReturnType<typeof toExecutorIntent>;
  postInlineComments?: boolean;
  logger?: ReviewLogger;
}): Promise<ReviewIntentOutcome> {
  return await executeReviewIntent({
    github: args.github,
    repo: args.repoFullName,
    prNumber: args.prNumber,
    headSha: args.headSha,
    botLogin: args.botLogin,
    intent: args.execIntent,
    postInlineComments: args.postInlineComments,
    logger: args.logger,
  });
}

function mapOutcome(o: ReviewIntentOutcome): ReviewFromIntentOutcome {
  if (o.outcome === "posted") return { outcome: "posted", verdict: o.verdict };
  if (o.outcome === "skipped_existing") return { outcome: "skipped_existing" };
  return {
    outcome: "post_failed",
    failureReason: o.failureReason,
    workFailed: true,
  };
}

async function postDegradedComment(args: {
  github: ReviewGitHubClient;
  repoFullName: string;
  prNumber: number;
  currentHeadSha: string;
  reason: string;
  logger?: ReviewLogger;
}): Promise<ReviewFromIntentOutcome> {
  const body = `${DEGRADED_INTENT_MARKER}\n\n_Reason: ${args.reason}. The review agent produced no parseable verdict; a human should review this PR._`;
  try {
    await args.github.submitReviewWithComments(
      args.repoFullName,
      args.prNumber,
      args.currentHeadSha,
      "COMMENT",
      body,
      [],
    );
    args.logger?.error(
      "review-from-intent: DEGRADED — no parseable intent, posted marked COMMENT",
      {
        repoFullName: args.repoFullName,
        prNumber: args.prNumber,
        reason: args.reason,
      },
    );
  } catch (err) {
    args.logger?.error(
      "review-from-intent: degraded COMMENT post ALSO failed",
      {
        repoFullName: args.repoFullName,
        prNumber: args.prNumber,
        reason: args.reason,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
  return { outcome: "degraded_comment", reason: args.reason, workFailed: true };
}
