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
import {
  parseReviewIntent,
  toExecutorIntent,
  type EmittedReviewIntent,
} from "./parse-review-intent";
import {
  publishReviewNotice,
  retireReviewNotices,
  type NoVerdictCause,
  type ReviewWriterClient,
} from "./review-notice";

/**
 * The control-plane single writer for a review thread's effect (ADR-036 phase-2).
 * Given the agent's terminal output (which under the flag is emit-only — no
 * gh-write) this parses the fenced-JSON intent and posts EXACTLY ONE review via
 * the injected App-scoped client, with verdict-aware idempotency + the never-
 * silent-drop guarantees. Pure orchestration over `ReviewGitHubClient` + the
 * provided current HEAD sha, so it is fully unit-testable.
 *
 * Guarantees:
 *  - A NON-VERDICT IS NEVER A REVIEW (ADR-009): a run with no verdict — an
 *    unparseable intent, an agent that reports it could not review, or a bare
 *    `comment` on a ready PR — is reported as a marked notice in the PR
 *    conversation + a workFailed signal. The PR's review state stays empty, so
 *    nobody waiting on a verdict mistakes the bot's silence for one.
 *  - POSTED-ZERO IMPOSSIBLE: that notice is the floor — never a silent no-review.
 *  - STALE-INTENT NEVER SILENT-DROP: an intent for an older commit is posted at
 *    that commit (GitHub records it truthfully) UNLESS a newer bot review already
 *    sits at the live HEAD (then skip as superseded, logged).
 *  - IDEMPOTENT: delegates to executeReviewIntent's (headSha,verdict) HEAD-guard,
 *    so a finish-hook/sweep double-fire converges to skipped_existing.
 *  - AT MOST ONE VERDICT PER COMMIT: a redelivered run whose intent names a commit
 *    we have already delivered a verdict for posts nothing (#213 — a worker restart
 *    re-posted 12 stale verdicts onto PR #208 in 63 seconds). A legacy DEGRADED
 *    review is silence, not a verdict, and does not suppress a later real one.
 *  - AT MOST ONE NOTICE PER COMMIT: a thread re-driven through the state
 *    machine (a redelivered run that restarts the agent, a resume, a follow-up)
 *    re-reads the SAME silent terminal text and would report it again at the
 *    same sha (#220). One notice per commit, whatever the reason; the message
 *    already says the only actionable thing, so a second adds noise, not
 *    information. The key is deliberately the COMMIT, not (commit, reason) — see
 *    #107, which must relax it if it ever wants two reasons to coexist at one sha.
 */

/**
 * The body prefix of the degraded COMMENT review this module posted before
 * ADR-009. NO LONGER EMITTED — a no-verdict run is a conversation notice now —
 * but PRs reviewed before that change still carry these reviews, and every
 * guard must keep reading them as silence. Do not remove while such PRs can
 * still be open.
 */
export const DEGRADED_INTENT_MARKER =
  "⚠️ Review intent could not be parsed — verdict NOT applied. This is NOT a clean pass.";

export type ReviewFromIntentOutcome =
  | { outcome: "posted"; verdict: string }
  | { outcome: "posted_stale_comment"; intendedVerdict: string }
  | { outcome: "skipped_existing" }
  | { outcome: "skipped_superseded" }
  | { outcome: "skipped_duplicate_at_commit"; commit: string }
  | {
      outcome: "skipped_stale_degrade";
      cause: NoVerdictCause;
      reason: string;
      workFailed: true;
    }
  | {
      outcome: "skipped_duplicate_degrade_at_commit";
      cause: NoVerdictCause;
      commit: string;
      reason: string;
      workFailed: true;
    }
  | {
      outcome: "degraded_comment";
      cause: NoVerdictCause;
      reason: string;
      workFailed: true;
    }
  | { outcome: "post_failed"; failureReason: string; workFailed: true };

export interface ExecuteReviewFromIntentOpts {
  github: ReviewWriterClient;
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
  /**
   * Draft PR → the floor caps at `comment` (never a formal request_changes),
   * and an agent's bare `comment` is its legitimate draft verdict. Absent is
   * treated as READY: the stricter reading, so a caller that forgets the flag
   * cannot post a non-verdict as a review.
   */
  isDraft?: boolean;
  /**
   * The head SHA this run was dispatched to review (thread.reviewedSha, #125 C5).
   * Consulted ONLY on the NO-VERDICT path: a run that produced no verdict
   * has nothing to anchor its notice to except the commit it was pointed at, so
   * when that commit is no longer HEAD the notice is not about live HEAD and is
   * skipped — a newer run owns the PR. Omit (or NULL for a legacy/in-process
   * thread) to keep the pre-existing behaviour of degrading at live HEAD.
   */
  reviewedSha?: string | null;
  /**
   * This run was abandoned by policy or by a user (see ABANDONED_TERMINAL_CAUSES).
   * Also NO-VERDICT-path only, and deliberately NOT a reason to skip the candidate
   * outright: a superseded run can still have persisted a real verdict that the
   * generation fence stopped its finish hook from posting, and discarding that is
   * the worst outcome this module has. An abandoned run's SILENCE proves nothing,
   * so only the no-verdict notice is withheld; a parsed verdict posts
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
    return await reportNoVerdict(opts, {
      cause: parsed.source === "agent" ? "agent_unable" : "unparseable",
      reason: parsed.reason,
      commit: parsed.source === "agent" ? parsed.commit : undefined,
    });
  }

  const emitted = parsed.intent;
  if (isBareCommentOnReadyPr(emitted, opts.isDraft)) {
    return await reportNoVerdict(opts, {
      cause: "agent_comment_without_findings",
      reason: emitted.summary,
      commit: emitted.commit,
    });
  }
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
    // #221: ONE filtered list feeds BOTH guards, and that is the whole point.
    // A degraded comment is a run's confession that it produced NOTHING — it is
    // evidence of silence at a commit, never a verdict. Counting it as a prior
    // DELIVERY ate a real first-and-only finding (found in #213's refinement and
    // fixed at the replay guard); counting it as a NEWER verdict here drops a real
    // verdict that merely arrived late. Same defect, two guards, and only one was
    // fixed. They share a single `const` now so they cannot drift apart again —
    // do not re-inline either filter.
    const verdicts = reviews.filter((r) => !isDegradedComment(r));

    const alreadyAtIntentCommit = await findBotReviewAtHead({
      github: snapshotOf(verdicts),
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
      github: snapshotOf(verdicts),
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
  if (outcome.outcome === "posted") {
    // A verdict now sits at HEAD, so a notice saying there is none is false.
    await retireReviewNotices({
      github,
      repoFullName,
      prNumber,
      botLogin,
      logger,
    });
  }
  return mapOutcome(outcome);
}

/**
 * An agent-chosen `comment` that carries no findings, on a PR that is ready for
 * review. The skill reserves `comment` for drafts and for findings surfaced
 * below the block floor; with neither, it can only mean "I could not reach a
 * verdict" — the review #228 received when the agent had no git access. That
 * is a non-verdict and must not be posted as a review.
 *
 * Keyed on the EMITTED verdict, before the approve floor: a server-side
 * downgrade of `approve` to `comment` always carries the findings that caused
 * it, and stays a review.
 */
function isBareCommentOnReadyPr(
  emitted: EmittedReviewIntent,
  isDraft: boolean | undefined,
): boolean {
  return (
    emitted.verdict === "comment" &&
    isDraft !== true &&
    (emitted.findings?.length ?? 0) === 0
  );
}

/**
 * Report a run that produced no verdict: a notice in the PR conversation, never
 * a review, and always a workFailed outcome so an operator hears about it.
 */
async function reportNoVerdict(
  opts: ExecuteReviewFromIntentOpts,
  noVerdict: { cause: NoVerdictCause; reason: string; commit?: string },
): Promise<ReviewFromIntentOutcome> {
  const { github, repoFullName, prNumber, botLogin, currentHeadSha, logger } =
    opts;
  const { cause, reason } = noVerdict;

  // A NOTICE IS A CLAIM ABOUT LIVE HEAD: "this commit has no verdict". Three
  // cases make that claim false, and in ALL of them the run's silence is
  // evidence of nothing about the code at HEAD:
  //   - the run was dispatched against an older commit (a newer run owns HEAD);
  //   - the run itself names an older commit as the one it looked at;
  //   - the run was abandoned by policy or by a user before it could speak.
  // Observed on #140 (2026-08-25): the hourly sweep reaped a run killed with
  // the worker box and stamped "no parseable verdict — a human should review
  // this PR" onto a commit pushed 73 seconds earlier, whose own review was
  // still running.
  //
  // This withholds ONLY the notice, never a verdict — a real verdict never
  // reaches this function. And it stays loud where it matters: workFailed still
  // fires, so an agent that failed to emit pages an operator instead of
  // shouting at the PR author (see #107).
  const canSpeakForHead =
    !opts.runAbandoned &&
    !(opts.reviewedSha && opts.reviewedSha !== currentHeadSha) &&
    !(noVerdict.commit && noVerdict.commit !== currentHeadSha);
  if (!canSpeakForHead) {
    logger?.warn(
      "review-from-intent: no verdict from a run that cannot speak for HEAD — notice withheld",
      {
        repoFullName,
        prNumber,
        reviewedSha: opts.reviewedSha ?? null,
        intentCommit: noVerdict.commit ?? null,
        currentHeadSha,
        runAbandoned: opts.runAbandoned ?? false,
        cause,
        reason,
      },
    );
    return {
      outcome: "skipped_stale_degrade",
      cause,
      reason,
      workFailed: true,
    };
  }

  const published = await publishReviewNotice({
    github,
    repoFullName,
    prNumber,
    botLogin,
    sha: currentHeadSha,
    cause,
    reason,
    logger,
  });
  if (published.result === "duplicate_at_commit") {
    logger?.info(
      "review-from-intent: a no-verdict notice already exists at this commit; skipping the duplicate",
      {
        repoFullName,
        prNumber,
        currentHeadSha,
        cause,
        reason,
        existingCommentId: published.commentId,
      },
    );
    return {
      outcome: "skipped_duplicate_degrade_at_commit",
      cause,
      commit: currentHeadSha,
      reason,
      workFailed: true,
    };
  }
  if (published.result === "post_failed") {
    logger?.error("review-from-intent: no-verdict notice post ALSO failed", {
      repoFullName,
      prNumber,
      cause,
      reason,
      error: published.failureReason,
    });
  } else {
    logger?.error(
      "review-from-intent: NO VERDICT — posted a notice in the PR conversation",
      { repoFullName, prNumber, cause, reason },
    );
  }
  return { outcome: "degraded_comment", cause, reason, workFailed: true };
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
 * LEGACY (pre-ADR-009) reviews only — see `DEGRADED_INTENT_MARKER`.
 *
 * A degraded COMMENT is a run's CONFESSION that it produced no parseable verdict —
 * it is evidence of silence at that commit, never of a delivered verdict. It must
 * therefore not satisfy the #213 replay guard: a later run that DID produce a real
 * finding at the same commit would otherwise be dropped by the earlier run's
 * silence, which is exactly the lost-verdict failure #213's fix exists to avoid.
 * It cannot re-open the 12x storm either — a degraded comment was only ever emitted
 * by the no-verdict branch, which returns long before this guard.
 *
 * NO AUTHOR CHECK: this is a bare body match, so a HUMAN quoting the marker in a
 * review satisfies it. Every consumer must layer an author filter of its own —
 * in practice `findBotReviewAtHead`'s `r.user?.login === botLogin`, applied AFTER
 * this one.
 */
export function isDegradedComment(review: GitHubReview): boolean {
  // STRUCTURAL, NOT A SUBSTRING SEARCH. The retired emission site always built
  // the body as `${MARKER}\n\n_Reason: …`, so the marker is a PREFIX by
  // construction. `includes` was wider than the thing it meant to recognise:
  // one of our own REAL verdicts that merely QUOTES the
  // marker — and reviews of this very code plausibly do — was read as silence,
  // which made the sweep run its backstop on a PR that already had a verdict.
  // Matching the prefix closes that without any author heuristic, and because
  // it lives in the one shared helper, all three guards stay identical.
  return review.body.startsWith(DEGRADED_INTENT_MARKER);
}

/**
 * Freeze an already-fetched review list into the `Pick<ReviewGitHubClient,
 * "listReviews">` seam `findBotReviewAtHead` takes. Every guard in this module
 * fetches ONCE and then re-asks the primitive over filtered views of that one
 * snapshot, so two guards reading the same PR can never see different states.
 */
export function snapshotOf(reviews: GitHubReview[]) {
  return { listReviews: async () => reviews };
}
