/**
 * Minimal GitHub-review client seam for the ported review-state logic
 * (ADR-036 single-writer channel, phase-2).
 *
 * The pure decision modules (head-review-guard, outstanding-review-finder,
 * review-intent-executor) are dependency-injected on this narrow interface —
 * the SUBSET of orch-agents' GitHubClient that the review-post path needs — so
 * they carry NO transport, NO auth, NO env dependency. The control plane (www)
 * implements it with an App-scoped octokit client (getOctokitForApp), keeping
 * dismiss/submit rights off the customer box (ADR-002). This mirrors the
 * pure-decision / control-plane-I/O split already used by the interim
 * reconciler (`review-reconciler.ts` + `reconcile-pr-reviews.ts`).
 */

/** A PR review as the review-state logic needs to see it (subset of the GitHub API shape). */
export interface GitHubReview {
  id: number;
  /** review.user — matched against the bot login. */
  user: { login: string } | null;
  state:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "COMMENTED"
    | "DISMISSED"
    | "PENDING";
  /** review.submitted_at (ISO). Ordering key for most-recent. */
  submittedAt: string | null;
  /** review.dismissed_at (ISO) — a dismissed review is no longer in force. */
  dismissedAt: string | null;
  /** Commit SHA the review was submitted against (GitHub `commit_id`). */
  commitId: string | null;
  body: string;
}

/**
 * The narrow write/read surface the review executor + finders require. www
 * implements each method via octokit; a review run's AGENT never holds this
 * (no gh-write outlet — that is the single-writer guarantee).
 */
export interface ReviewGitHubClient {
  listReviews(repo: string, prNumber: number): Promise<GitHubReview[]>;
  submitReview(
    repo: string,
    prNumber: number,
    verdict: "APPROVE" | "REQUEST_CHANGES",
    body: string,
  ): Promise<void>;
  submitReviewWithComments(
    repo: string,
    prNumber: number,
    commitSha: string,
    verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body: string,
    comments: Array<{ path: string; line: number; body: string }>,
  ): Promise<void>;
  dismissReview(
    repo: string,
    prNumber: number,
    reviewId: number,
    message: string,
  ): Promise<void>;
  postInlineComment(
    repo: string,
    prNumber: number,
    path: string,
    line: number,
    body: string,
    commitSha: string,
  ): Promise<void>;
}

/** Optional structured logger — injected by the caller; pure by default (no-op absent). */
export interface ReviewLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Uniform error-message extraction (local — the port has no shared/errors dep). */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
