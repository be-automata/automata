import type { GitHubReview } from "@terragon/review/state/review-github-client";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import type { ReviewWriterClient } from "./review-notice";

/**
 * Control-plane implementation of the pure `ReviewGitHubClient` (ADR-036
 * single-writer channel), plus the PR-conversation surface the no-verdict
 * notice uses (ADR-009). The review executor + finders are dependency-injected
 * on this — the App-scoped octokit client. Posting/dismissing with APP creds keeps
 * write rights off the customer box (ADR-002), the same posture as the interim
 * reconciler (`reconcile-pr-reviews.ts`).
 *
 * GitHub's "list reviews" response has no `dismissed_at` field — a dismissed
 * review is represented by `state === "DISMISSED"`. We map that back to a non-null
 * `dismissedAt` so the finders' `dismissedAt === null` filter behaves as the pure
 * logic expects (a DISMISSED review is not in force).
 */

type Octokit = Awaited<ReturnType<typeof getOctokitForApp>>;

function mapReview(r: {
  id: number;
  user: { login: string } | null;
  state: string;
  submitted_at?: string | null;
  commit_id?: string | null;
  body?: string | null;
}): GitHubReview {
  const dismissed = r.state === "DISMISSED";
  return {
    id: r.id,
    user: r.user ? { login: r.user.login } : null,
    state: r.state as GitHubReview["state"],
    submittedAt: r.submitted_at ?? null,
    // GitHub collapses dismissal into `state`; synthesize dismissedAt so the pure
    // finders exclude it (they check dismissedAt === null across all states).
    dismissedAt: dismissed ? (r.submitted_at ?? "dismissed") : null,
    commitId: r.commit_id ?? null,
    body: r.body ?? "",
  };
}

/** Build the single writer's client, bound to an App-scoped octokit instance. */
export function createOctokitReviewClient(
  octokit: Octokit,
): ReviewWriterClient {
  return {
    async listReviews(repo, prNumber) {
      const [owner, name] = parseRepoFullName(repo);
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo: name,
        pull_number: prNumber,
        per_page: 100,
      });
      return reviews.map(mapReview);
    },

    async submitReview(repo, prNumber, verdict, body) {
      const [owner, name] = parseRepoFullName(repo);
      await octokit.rest.pulls.createReview({
        owner,
        repo: name,
        pull_number: prNumber,
        event: verdict,
        body,
      });
    },

    async submitReviewWithComments(
      repo,
      prNumber,
      commitSha,
      verdict,
      body,
      comments,
    ) {
      const [owner, name] = parseRepoFullName(repo);
      await octokit.rest.pulls.createReview({
        owner,
        repo: name,
        pull_number: prNumber,
        commit_id: commitSha,
        event: verdict,
        body,
        comments: comments.map((c) => ({
          path: c.path,
          line: c.line,
          body: c.body,
        })),
      });
    },

    async dismissReview(repo, prNumber, reviewId, message) {
      const [owner, name] = parseRepoFullName(repo);
      await octokit.rest.pulls.dismissReview({
        owner,
        repo: name,
        pull_number: prNumber,
        review_id: reviewId,
        message,
      });
    },

    async postInlineComment(repo, prNumber, path, line, body, commitSha) {
      const [owner, name] = parseRepoFullName(repo);
      await octokit.rest.pulls.createReviewComment({
        owner,
        repo: name,
        pull_number: prNumber,
        commit_id: commitSha,
        path,
        line,
        body,
      });
    },

    async listConversationComments(repo, prNumber) {
      const [owner, name] = parseRepoFullName(repo);
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        { owner, repo: name, issue_number: prNumber, per_page: 100 },
      );
      return comments.map((comment) => ({
        id: comment.id,
        user: comment.user ? { login: comment.user.login } : null,
        body: comment.body ?? "",
      }));
    },

    async createConversationComment(repo, prNumber, body) {
      const [owner, name] = parseRepoFullName(repo);
      await octokit.rest.issues.createComment({
        owner,
        repo: name,
        issue_number: prNumber,
        body,
      });
    },

    async deleteConversationComment(repo, commentId) {
      const [owner, name] = parseRepoFullName(repo);
      await octokit.rest.issues.deleteComment({
        owner,
        repo: name,
        comment_id: commentId,
      });
    },
  };
}

/**
 * HEAD sha (the idempotency + stale-intent key) AND draft state of a PR in one
 * call. The draft flag feeds the approve-floor draft cap (a draft PR must never
 * receive a formal `request_changes`) and the no-verdict rule (a bare `comment`
 * is a verdict only on a draft), fetched alongside the head sha to avoid a
 * second API round trip.
 */
export async function getPrHeadState(
  octokit: Octokit,
  repoFullName: string,
  prNumber: number,
): Promise<{ headSha: string; isDraft: boolean }> {
  const [owner, repo] = parseRepoFullName(repoFullName);
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  return { headSha: data.head.sha, isDraft: data.draft === true };
}
