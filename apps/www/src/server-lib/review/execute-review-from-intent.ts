import type {
  GitHubReview,
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
 *  - AT MOST ONE VERDICT PER COMMIT: a redelivered run whose intent names a commit
 *    we have already delivered a verdict for posts nothing (#213 — a worker restart
 *    re-posted 12 stale verdicts onto PR #208 in 63 seconds). A prior DEGRADED
 *    comment is silence, not a verdict, and does not suppress a later real one.
 */

export const DEGRADED_INTENT_MARKER =
  "⚠️ Review intent could not be parsed — verdict NOT applied. This is NOT a clean pass.";

export type ReviewFromIntentOutcome =
  | { outcome: "posted"; verdict: string }
  | { outcome: "posted_stale_comment"; intendedVerdict: string }
  | { outcome: "skipped_existing" }
  | { outcome: "skipped_superseded" }
  | { outcome: "skipped_duplicate_at_commit"; commit: string }
  | { outcome: "skipped_stale_degrade"; reason: string; workFailed: true }
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
  /**
   * The head SHA this run was dispatched to review (thread.reviewedSha, #125 C5).
   * Consulted ONLY on the DEGRADED path: a run that produced no parseable intent
   * has nothing to anchor its warning to except the commit it was pointed at, so
   * when that commit is no longer HEAD the warning is not about live HEAD and is
   * skipped — a newer run owns the PR. Omit (or NULL for a legacy/in-process
   * thread) to keep the pre-existing behaviour of degrading at live HEAD.
   */
  reviewedSha?: string | null;
  /**
   * This run was abandoned by policy or by a user (see ABANDONED_TERMINAL_CAUSES).
   * Also DEGRADED-path only, and deliberately NOT a reason to skip the candidate
   * outright: a superseded run can still have persisted a real verdict that the
   * generation fence stopped its finish hook from posting, and discarding that is
   * the worst outcome this module has. An abandoned run's SILENCE proves nothing,
   * so only the "could not be parsed" warning is withheld; a parsed verdict posts
   * through the normal (or stale) path exactly as it would otherwise.
   */
  runAbandoned?: boolean;
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
    // A DEGRADED COMMENT IS A CLAIM ABOUT LIVE HEAD. There is no emitted commit
    // to anchor it to, so it can only be posted at whatever HEAD is now. Two
    // cases make that claim false, and in BOTH the run's silence is evidence of
    // nothing about the code at HEAD:
    //   - the run was dispatched against an older commit (a newer run owns HEAD);
    //   - the run was abandoned by policy or by a user before it could speak.
    // Observed on #140 (2026-08-25): the hourly sweep reaped a run killed with
    // the worker box and stamped "no parseable verdict — a human should review
    // this PR" onto a commit pushed 73 seconds earlier, whose own review was
    // still running.
    //
    // This withholds ONLY the warning, never a verdict — a parsed intent has
    // already taken the branch below by the time we reach here. And it stays
    // loud where it matters: workFailed still fires, so an agent that failed to
    // emit pages an operator instead of shouting at the PR author (see #107).
    const canSpeakForHead =
      !opts.runAbandoned &&
      !(opts.reviewedSha && opts.reviewedSha !== currentHeadSha);
    if (!canSpeakForHead) {
      logger?.warn(
        "review-from-intent: unparseable intent from a run that cannot speak for HEAD — warning withheld",
        {
          repoFullName,
          prNumber,
          reviewedSha: opts.reviewedSha ?? null,
          currentHeadSha,
          runAbandoned: opts.runAbandoned ?? false,
          reason: parsed.reason,
        },
      );
      return {
        outcome: "skipped_stale_degrade",
        reason: parsed.reason,
        workFailed: true,
      };
    }
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
    // #213 REPLAY GUARD. The worker's lease can end without a clean ack, and the
    // redelivered task re-parses the SAME persisted terminal text — same intent,
    // same `emitted.commit`. The probe below only asks whether something sits at
    // LIVE head, which is false for a replay *and* for a late first delivery, so
    // it cannot tell them apart; on 2026-09-29 one restart therefore re-posted
    // twelve already-delivered verdicts onto PR #208 in 63 seconds, each at its
    // own original sha.
    //
    // The signal that DOES separate them is whether a non-dismissed review by us
    // already exists AT `emitted.commit`:
    //   - present  → we already said this; the reader has it. Drop the replay.
    //   - absent   → never delivered. Post it (the marked COMMENT below), because
    //                losing a first-and-only finding is worse than this bug.
    // A degraded "could not be parsed" COMMENT does NOT count as present — see
    // `isDegradedComment`. Derived from GitHub's own state — the PR's reviews carry `commit_id` and an
    // author — deliberately NOT from a new DB column (prod schema migration here
    // is manual and the prod DATABASE_URL is a write-only Worker secret).
    //
    // `findBotReviewAtHead` is named for its usual caller but is parameterised by
    // an arbitrary sha, so passing `emitted.commit` asks exactly "has the bot
    // already reviewed THIS commit?" across all states including COMMENTED.
    //
    // ONE round trip serves BOTH guards: the primitive's only I/O is listReviews,
    // so a single snapshot answers "already reviewed `emitted.commit`?" and
    // "superseded at live HEAD?" without the two answers being able to disagree.
    //
    // LOOKUP FAILED → EMPTY SNAPSHOT → BOTH GUARDS OPEN → POST ANYWAY. Deliberate,
    // and the posture this module already took at the supersession probe: a rare
    // duplicate is recoverable by a reader, a permanently lost first-and-only
    // finding is not. A transient listReviews failure is independent of replay, so
    // post-anyway bounds the damage to the rare-failure window instead of
    // re-opening the deterministic 12x storm.
    let reviews: GitHubReview[] = [];
    try {
      reviews = await github.listReviews(repoFullName, prNumber);
    } catch (err) {
      logger?.warn(
        "review-from-intent: review lookup failed (replay + supersession guards); posting the stale COMMENT anyway",
        {
          repoFullName,
          prNumber,
          intentCommit: emitted.commit,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    const snapshotOf = (rs: GitHubReview[]) => ({
      listReviews: async () => rs,
    });

    const alreadyAtIntentCommit = await findBotReviewAtHead({
      github: snapshotOf(reviews.filter((r) => !isDegradedComment(r))),
      repo: repoFullName,
      prNumber,
      headSha: emitted.commit,
      botLogin,
    });
    if (alreadyAtIntentCommit) {
      logger?.info(
        "review-from-intent: replay of an already-delivered verdict at this commit; skipping",
        {
          repoFullName,
          prNumber,
          intentCommit: emitted.commit,
          currentHeadSha,
          existingReviewId: alreadyAtIntentCommit.id,
          existingReviewState: alreadyAtIntentCommit.state,
        },
      );
      return {
        outcome: "skipped_duplicate_at_commit",
        commit: emitted.commit,
      };
    }

    const newerAtHead = await findBotReviewAtHead({
      github: snapshotOf(reviews),
      repo: repoFullName,
      prNumber,
      headSha: currentHeadSha,
      botLogin,
    });
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

/**
 * A degraded COMMENT is a run's CONFESSION that it produced no parseable verdict —
 * it is evidence of silence at that commit, never of a delivered verdict. It must
 * therefore not satisfy the #213 replay guard: a later run that DID produce a real
 * finding at the same commit would otherwise be dropped by the earlier run's
 * silence, which is exactly the lost-verdict failure #213's fix exists to avoid.
 * It cannot re-open the 12x storm either — a degraded comment is only ever emitted
 * by the unparseable branch above, which returns long before this guard.
 */
function isDegradedComment(review: GitHubReview): boolean {
  return review.body.includes(DEGRADED_INTENT_MARKER);
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
