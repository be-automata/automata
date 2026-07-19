/**
 * Review-intent executor (ADR-036 single-writer channel).
 *
 * The low-level review poster: a converted review skill has NO gh-write outlet,
 * so it cannot post to GitHub itself — it emits a verdict (structured intent).
 * After the agent exits, the control plane (www) posts it exactly ONCE via this
 * function. Ported from orch-agents; adaptations: dependency-injected on the
 * narrow ReviewGitHubClient (was the full GitHubClient), ReviewLogger (was
 * shared/logger), local getErrorMessage, Severity from the local state/types.
 *
 * This module is a DUMB IDEMPOTENT PIPE — and must stay one (ADR-036). It:
 *   1. takes the (already shape-validated) intent,
 *   2. checks GitHub state for an existing bot review at HEAD (idempotency),
 *   3. posts once.
 * It deliberately contains NO policy / "should I write" reasoning. Idempotency is
 * a property of GitHub state (the source of truth), not a local mapping table.
 * "Posted twice" / "posted zero" are structurally impossible when there is
 * exactly one writer (this executor) that checks before posting — provided the
 * agent has no competing gh-write outlet (the tool-policy + credential-withhold).
 */

import type { Severity } from "./types";
import {
  getErrorMessage,
  type GitHubReview,
  type ReviewGitHubClient,
  type ReviewLogger,
} from "./review-github-client";
import { findBotReviewAtHead } from "./head-review-guard";
import { findAllOutstandingBotChangesRequested } from "./outstanding-review-finder";

export type ReviewVerdict = "approve" | "request_changes" | "comment";

/** A line-level finding carried on a review verdict. `severity` absent ⇒ `info`. */
export interface ReviewIntentComment {
  path: string;
  line: number;
  body: string;
  severity?: Severity;
  /** Verbatim source line(s) at `path:line` (verify-before-block). */
  quote?: string;
}

export interface ReviewIntent {
  verdict: ReviewVerdict;
  body: string;
  /**
   * Optional line-level inline findings. When present + inline posting is ON,
   * posted as inline review comments (one GitHub thread each); when OFF, folded
   * into the verdict body so they are never lost.
   */
  comments?: ReviewIntentComment[];
}

export type ReviewIntentOutcome =
  | { outcome: "posted"; verdict: ReviewVerdict }
  | { outcome: "skipped_existing" }
  | { outcome: "post_failed"; failureReason: string };

export interface ExecuteReviewIntentOpts {
  github: ReviewGitHubClient;
  repo: string;
  prNumber: number;
  /** Current PR HEAD SHA — the idempotency key for "already reviewed this commit". */
  headSha: string;
  /** The bot's review-author login (the GitHub `[bot]` login). */
  botLogin: string;
  intent: ReviewIntent;
  logger?: ReviewLogger;
  /**
   * Whether to post line-level findings as STANDALONE inline review comments.
   * Default `false`: each standalone comment makes GitHub mint a separate
   * empty-body `COMMENTED` review, so with the flag OFF we FOLD the findings into
   * the verdict body — exactly ONE review object per cycle.
   */
  postInlineComments?: boolean;
}

const SUPERSEDE_AT_HEAD_REASON =
  "Superseded — bot verdict updated for this commit.";

/**
 * Best-effort dismissal of every outstanding bot CHANGES_REQUESTED (the
 * approve-unblock guarantee — called AFTER an APPROVE posts, so a dismiss failure
 * can never lose the approval).
 */
export async function dismissOutstandingBotChangeRequests(opts: {
  github: Pick<ReviewGitHubClient, "listReviews" | "dismissReview">;
  repo: string;
  prNumber: number;
  botLogin: string;
  reason: string;
  logger?: ReviewLogger;
}): Promise<void> {
  const { github, repo, prNumber, botLogin, reason, logger } = opts;
  try {
    const outstanding = await findAllOutstandingBotChangesRequested({
      github,
      repo,
      prNumber,
      botLogin,
    });
    for (const review of outstanding) {
      try {
        await github.dismissReview(repo, prNumber, review.id, reason);
        logger?.info("review-executor: dismissed outstanding bot CR on approve", {
          repo,
          prNumber,
          reviewId: review.id,
        });
      } catch (err) {
        logger?.warn(
          "review-executor: dismiss outstanding bot CR failed (best-effort)",
          { repo, prNumber, reviewId: review.id, error: getErrorMessage(err) },
        );
      }
    }
  } catch (err) {
    logger?.warn(
      "review-executor: list outstanding bot CRs failed (best-effort)",
      { repo, prNumber, error: getErrorMessage(err) },
    );
  }
}

/** The GitHub review state a given verdict produces. */
function reviewStateForVerdict(
  verdict: ReviewVerdict,
): "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" {
  if (verdict === "approve") return "APPROVED";
  if (verdict === "request_changes") return "CHANGES_REQUESTED";
  return "COMMENTED";
}

/**
 * Append line-level findings to the verdict body as a `Findings` list when
 * inline-comment posting is off. Each finding renders as
 * `` - **[severity]** `path:line` — message ``, preserving location + severity
 * without a separate inline thread (and without the empty `COMMENTED` review that
 * standalone inline comments create). No severity renders as `info`.
 */
function foldFindingsIntoBody(
  body: string,
  comments: ReadonlyArray<ReviewIntentComment>,
): string {
  const lines = comments.map(
    (c) => `- **[${c.severity ?? "info"}]** \`${c.path}:${c.line}\` — ${c.body}`,
  );
  const heading = `**Findings (${comments.length}):**`;
  const base = body.trim();
  return base.length > 0
    ? `${base}\n\n${heading}\n${lines.join("\n")}`
    : `${heading}\n${lines.join("\n")}`;
}

/**
 * Post the review described by `intent` exactly once, with verdict-aware
 * idempotency.
 *
 * Idempotency is keyed on `(headSha, verdict)`, NOT merely `headSha`:
 *   - A non-dismissed bot review at HEAD with the SAME verdict → skip (the true
 *     webhook-redelivery / concurrent-run case).
 *   - A non-dismissed bot review at HEAD with a DIFFERENT verdict → a legitimate
 *     verdict CHANGE. Post the new verdict, then dismiss the prior one so exactly
 *     ONE active bot review remains at HEAD (no-duplicate invariant preserved
 *     while the verdict moves).
 *
 * A failed idempotency read does NOT drop a real review — post anyway (a rare
 * duplicate is reconciled by the reconciler; a missed verdict is not).
 */
export async function executeReviewIntent(
  opts: ExecuteReviewIntentOpts,
): Promise<ReviewIntentOutcome> {
  const { github, repo, prNumber, headSha, botLogin, intent, logger } = opts;

  let existing: GitHubReview | null = null;
  try {
    existing = await findBotReviewAtHead({
      github,
      repo,
      prNumber,
      headSha,
      botLogin,
    });
    if (existing && existing.state === reviewStateForVerdict(intent.verdict)) {
      logger?.info(
        "review-executor: same-verdict bot review already at HEAD; skipping (idempotent)",
        { repo, prNumber, headSha, verdict: intent.verdict },
      );
      return { outcome: "skipped_existing" };
    }
  } catch (err) {
    logger?.warn(
      "review-executor: HEAD idempotency check failed; attempting post",
      { repo, prNumber, error: getErrorMessage(err) },
    );
  }

  const event =
    intent.verdict === "approve"
      ? "APPROVE"
      : intent.verdict === "request_changes"
        ? "REQUEST_CHANGES"
        : "COMMENT";

  const comments = intent.comments ?? [];
  const postInline = opts.postInlineComments ?? false;

  // When inline posting is OFF (default), fold findings into the verdict body so
  // they are never lost — and so the cycle produces exactly ONE review object.
  const effectiveBody =
    !postInline && comments.length > 0
      ? foldFindingsIntoBody(intent.body, comments)
      : intent.body;

  const postPlain = async (): Promise<void> => {
    if (intent.verdict === "comment") {
      await github.submitReviewWithComments(
        repo,
        prNumber,
        headSha,
        "COMMENT",
        effectiveBody,
        [],
      );
    } else {
      await github.submitReview(
        repo,
        prNumber,
        event as "APPROVE" | "REQUEST_CHANGES",
        effectiveBody,
      );
    }
  };

  try {
    await postPlain();
    logger?.info("review-executor: posted review from intent", {
      repo,
      prNumber,
      headSha,
      verdict: intent.verdict,
      findings: comments.length,
      inlineMode: postInline ? "inline" : "body",
    });
  } catch (err) {
    const failureReason = getErrorMessage(err);
    logger?.error("review-executor: review post failed", {
      repo,
      prNumber,
      headSha,
      verdict: intent.verdict,
      reason: failureReason,
    });
    return { outcome: "post_failed", failureReason };
  }

  // Inline threads (flag-gated): post each finding as a standalone inline review
  // comment. Best-effort + independent: a bad position drops only that comment,
  // never the verdict (already posted) and never its siblings.
  if (postInline && comments.length > 0 && headSha) {
    let posted = 0;
    for (const c of comments) {
      try {
        await github.postInlineComment(
          repo,
          prNumber,
          c.path,
          c.line,
          c.body,
          headSha,
        );
        posted++;
      } catch (err) {
        logger?.warn("review-executor: inline comment failed (best-effort)", {
          repo,
          prNumber,
          headSha,
          path: c.path,
          line: c.line,
          error: getErrorMessage(err),
        });
      }
    }
    logger?.info("review-executor: posted inline review threads", {
      repo,
      prNumber,
      headSha,
      requested: comments.length,
      posted,
    });
  }

  // Verdict change at the same commit: supersede the prior bot review at HEAD so
  // exactly one active bot review remains. Best-effort — a dismiss failure never
  // undoes the freshly-posted verdict.
  if (existing && existing.state !== reviewStateForVerdict(intent.verdict)) {
    try {
      await github.dismissReview(
        repo,
        prNumber,
        existing.id,
        SUPERSEDE_AT_HEAD_REASON,
      );
      logger?.info("review-executor: superseded prior bot review at HEAD", {
        repo,
        prNumber,
        headSha,
        dismissedReviewId: existing.id,
        from: existing.state,
        to: reviewStateForVerdict(intent.verdict),
      });
    } catch (err) {
      logger?.warn("review-executor: supersede dismiss failed (best-effort)", {
        repo,
        prNumber,
        headSha,
        reviewId: existing.id,
        error: getErrorMessage(err),
      });
    }
  }

  return { outcome: "posted", verdict: intent.verdict };
}
