/**
 * outstanding-review-finder (ADR-036). Ported from orch-agents; the only
 * adaptation is that `botLogin` is REQUIRED (the original defaulted it to
 * getBotLogin() — an env/identity dependency the pure package must not carry).
 *
 * Returns the bot's non-dismissed `CHANGES_REQUESTED` reviews on a PR — used by
 * the approve-unblock path (dismiss every outstanding bot CR AFTER an APPROVE
 * posts) and the supersede path.
 *
 * Filtering rules:
 *   • review.user.login === botLogin
 *   • review.state === 'CHANGES_REQUESTED'
 *   • review.dismissedAt === null
 *   • Tie-break by `submittedAt` descending; at most one outstanding bot
 *     CHANGES_REQUESTED per PR is expected, but multiples are handled defensively.
 */

import type { GitHubReview, ReviewGitHubClient } from "./review-github-client";

export interface FindOutstandingBotChangesRequestedOpts {
  github: Pick<ReviewGitHubClient, "listReviews">;
  repo: string;
  prNumber: number;
  /** The bot's review-author login (the GitHub `[bot]` login). */
  botLogin: string;
}

export async function findOutstandingBotChangesRequested(
  opts: FindOutstandingBotChangesRequestedOpts,
): Promise<GitHubReview | null> {
  const all = await findAllOutstandingBotChangesRequested(opts);
  // `?? null` (not `all.length > 0 ? all[0] : null`) so this stays valid under the
  // chassis' noUncheckedIndexedAccess:true — www compiles this source directly.
  return all[0] ?? null;
}

/**
 * Like findOutstandingBotChangesRequested but returns ALL outstanding bot
 * CHANGES_REQUESTED reviews (most-recent first). Used by the dismiss-before-post
 * / approve-unblock path to clear every stacked review.
 */
export async function findAllOutstandingBotChangesRequested(
  opts: FindOutstandingBotChangesRequestedOpts,
): Promise<GitHubReview[]> {
  const reviews = await opts.github.listReviews(opts.repo, opts.prNumber);

  const candidates = reviews.filter(
    (r) =>
      r.user?.login === opts.botLogin &&
      r.state === "CHANGES_REQUESTED" &&
      r.dismissedAt === null,
  );
  if (candidates.length === 0) return [];

  // Most-recent first.
  candidates.sort((a, b) => {
    const ta = a.submittedAt ?? "";
    const tb = b.submittedAt ?? "";
    if (ta < tb) return 1;
    if (ta > tb) return -1;
    return 0;
  });
  return candidates;
}
