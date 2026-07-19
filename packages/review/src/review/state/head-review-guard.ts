/**
 * head-review-guard — the authoritative "has the bot already reviewed THIS
 * commit?" check (ADR-036). Ported from orch-agents; the only adaptation is that
 * `botLogin` is a REQUIRED param here (the orch-agents original defaulted it to
 * getBotLogin() from kernel/agent-identity — an env/identity dependency the pure
 * package must not carry; the www caller passes the resolved bot login, exactly
 * as reconcile-pr-reviews.ts already does).
 *
 * Unlike `findAllOutstandingBotChangesRequested` (which filters
 * `state === 'CHANGES_REQUESTED'`) and `findAnyBotReviewAtHead` (which omits the
 * `dismissedAt` filter), this guard matches a bot review at HEAD in ANY state —
 * APPROVED, CHANGES_REQUESTED, COMMENTED — that has not been dismissed. COMMENTED
 * is the verdict type that escaped every prior dedup layer and cannot be cleaned
 * up after the fact, so prevention at HEAD across all states is the only real fix.
 *
 * A bot review whose `commitId` matches the current HEAD SHA means a bot verdict
 * already exists for the exact commit under review. This is the primitive the
 * review-intent executor uses for idempotency; the executor compares the found
 * review's STATE against the new verdict and suppresses only a true same-verdict
 * redelivery — a different (stronger) verdict on the same commit is a legitimate
 * change and is posted, superseding the prior one (see `review-intent-executor`).
 */

import type { GitHubReview, ReviewGitHubClient } from "./review-github-client";

export interface FindBotReviewAtHeadOpts {
  github: Pick<ReviewGitHubClient, "listReviews">;
  repo: string;
  prNumber: number;
  /** Current HEAD SHA of the PR (GitHub `commit_id` / `headRefOid`). */
  headSha: string;
  /** The bot's review-author login (the GitHub `[bot]` login). */
  botLogin: string;
}

/**
 * Return the first non-dismissed bot review whose `commitId` matches `headSha`,
 * across all review states. Returns null when no such review exists (the agent
 * has not yet reviewed this commit).
 *
 * Filtering rules:
 *   • review.user.login === botLogin
 *   • review.commitId === headSha
 *   • review.dismissedAt === null  (a dismissed review is no longer in force)
 *   • any state (APPROVED / CHANGES_REQUESTED / COMMENTED)
 */
export async function findBotReviewAtHead(
  opts: FindBotReviewAtHeadOpts,
): Promise<GitHubReview | null> {
  if (!opts.headSha) return null;
  const reviews = await opts.github.listReviews(opts.repo, opts.prNumber);
  const match = reviews.find(
    (r) =>
      r.user?.login === opts.botLogin &&
      r.commitId === opts.headSha &&
      r.dismissedAt === null,
  );
  return match ?? null;
}
