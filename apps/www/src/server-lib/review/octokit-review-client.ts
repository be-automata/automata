import type { FileAtCommit } from "@terragon/review/finding-verifier";
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

    async updateConversationComment(repo, commentId, body) {
      const [owner, name] = parseRepoFullName(repo);
      await octokit.rest.issues.updateComment({
        owner,
        repo: name,
        comment_id: commentId,
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

/** What the review writer needs to know about a PR, read in one call. */
export interface PrHeadState {
  headSha: string;
  isDraft: boolean;
  /**
   * The PR author's login (`<slug>[bot]` for an App), or null when GitHub
   * reports no user (a deleted account). Compared against the review bot's
   * login: GitHub refuses a formal verdict from a PR's own author.
   */
  authorLogin: string | null;
  /** GitHub reports a merged PR as closed. */
  isClosed: boolean;
  /**
   * The PR's base ref now (raw, untrusted). Optional so a caller that never
   * read it stays valid; the review writer treats absent as unknown.
   */
  baseRef?: string | null;
}

/**
 * HEAD sha (the idempotency + stale-intent key), draft state, open/closed AND author of a
 * PR in one call. The draft flag feeds the approve-floor draft cap (a draft PR
 * must never receive a formal `request_changes`) and the no-verdict rule (a
 * bare `comment` is a verdict only on a draft); the author decides whether the
 * bot may submit a formal verdict at all (it may not on a PR it opened). All
 * three come from the same response, so there is no second API round trip.
 */
export async function getPrHeadState(
  octokit: Octokit,
  repoFullName: string,
  prNumber: number,
): Promise<PrHeadState> {
  const [owner, repo] = parseRepoFullName(repoFullName);
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  return {
    headSha: data.head.sha,
    isDraft: data.draft === true,
    authorLogin: data.user?.login ?? null,
    isClosed: data.state === "closed",
    baseRef: data.base?.ref ?? null,
  };
}

/**
 * One retry for a transient read (a 5xx or a network error with no status):
 * the verifier must not flip on a blip. A 4xx is an answer, not a blip — a
 * retry would only repeat it.
 */
async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const status = statusOf(err);
    if (status !== undefined && status < 500) throw err;
    return await fn();
  }
}

function statusOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/**
 * verify-before-block's reader (packages/review finding-verifier): a file AT
 * the commit the agent reviewed, read raw through the contents API with the
 * App token. 404 = the file is not there (the finding is unverified); any other
 * failure after one retry, or binary content, = could not check (the finding
 * keeps gating — an outage never changes a verdict).
 */
export function createFileAtCommitReader(
  octokit: Octokit,
  repoFullName: string,
): (path: string, sha: string) => Promise<FileAtCommit> {
  const [owner, repo] = parseRepoFullName(repoFullName);
  return async (path, sha) => {
    try {
      const response = await withOneRetry(() =>
        octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
          owner,
          repo,
          path,
          ref: sha,
          mediaType: { format: "raw" },
        }),
      );
      // The raw media type returns the file body as a string; Octokit's types
      // only model the JSON shape, so narrow from unknown.
      const data: unknown = response.data;
      if (typeof data !== "string") {
        return { kind: "unchecked", reason: "not a file" };
      }
      if (data.includes("\u0000")) {
        return { kind: "unchecked", reason: "binary file" };
      }
      return { kind: "content", text: data };
    } catch (err) {
      if (statusOf(err) === 404) return { kind: "missing" };
      return {
        kind: "unchecked",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/** At most this many 100-thread pages are read per PR (500 threads). */
export const REVIEW_THREAD_PAGE_LIMIT = 5;

/** Comments read per thread (a thread's reply chain rarely nears it). */
const REVIEW_THREAD_COMMENT_LIMIT = 100;

const REVIEW_THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            path
            line
            comments(first: ${REVIEW_THREAD_COMMENT_LIMIT}) {
              totalCount
              nodes { databaseId author { login } body }
            }
          }
        }
      }
    }
  }
`;

interface ReviewThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path: string | null;
          line: number | null;
          comments: {
            totalCount: number;
            nodes: Array<{
              databaseId: number | null;
              author: { login: string } | null;
              body: string | null;
            }>;
          };
        }>;
      };
    } | null;
  } | null;
}

/** One review thread as {@link fetchReviewThreads} returns it. */
export interface FetchedReviewThread {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  comments: Array<{
    databaseId: number | null;
    authorLogin: string | null;
    body: string | null;
  }>;
  /** How many comments the thread has (may exceed `comments.length`). */
  commentCount: number;
}

/**
 * Every review thread on a PR (up to {@link REVIEW_THREAD_PAGE_LIMIT} pages),
 * read with the App token. `truncated` = more threads exist than were read.
 * The one thread read both the prompt prefetch and the terminal writer's
 * thread resolutions go through.
 */
export async function fetchReviewThreads(
  octokit: Octokit,
  repoFullName: string,
  prNumber: number,
): Promise<{ threads: FetchedReviewThread[]; truncated: boolean }> {
  const [owner, repo] = parseRepoFullName(repoFullName);
  const threads: FetchedReviewThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < REVIEW_THREAD_PAGE_LIMIT; page++) {
    const result: ReviewThreadsPage = await octokit.graphql(
      REVIEW_THREADS_QUERY,
      { owner, repo, number: prNumber, cursor },
    );
    const connection = result.repository?.pullRequest?.reviewThreads;
    if (!connection) break;
    for (const node of connection.nodes) {
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        path: node.path,
        line: node.line,
        comments: node.comments.nodes.map((comment) => ({
          databaseId: comment.databaseId,
          authorLogin: comment.author?.login ?? null,
          body: comment.body,
        })),
        commentCount: node.comments.totalCount,
      });
    }
    if (!connection.pageInfo.hasNextPage) break;
    if (page === REVIEW_THREAD_PAGE_LIMIT - 1) {
      return { threads, truncated: true };
    }
    cursor = connection.pageInfo.endCursor;
  }
  return { threads, truncated: false };
}

/** The review-thread surface the terminal writer resolves threads through. */
export interface ReviewThreadClient {
  /** The PR's thread containing the comment `commentId`, or null. */
  findThreadByCommentId(
    prNumber: number,
    commentId: number,
  ): Promise<{
    threadId: string;
    isResolved: boolean;
    commentBodies: string[];
    /** The same comments with their authors (null for a deleted account). */
    comments: Array<{ body: string; authorLogin: string | null }>;
  } | null>;
  replyToReviewComment(
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
}

/**
 * The App-scoped implementation of {@link ReviewThreadClient}.
 *
 * One client serves one terminal execution, so a PR's threads are read ONCE
 * ({@link fetchReviewThreads}) and every lookup is answered from that read —
 * not one full scan per resolution. The client's own replies and resolves are
 * applied to it, so a repeat lookup sees them exactly as a fresh read would.
 * A failed read is not cached: the next lookup reads again.
 */
export function createOctokitThreadClient(
  octokit: Octokit,
  repoFullName: string,
): ReviewThreadClient {
  const [owner, repo] = parseRepoFullName(repoFullName);
  const reads = new Map<number, Promise<FetchedReviewThread[]>>();

  function threadsOf(prNumber: number): Promise<FetchedReviewThread[]> {
    let read = reads.get(prNumber);
    if (!read) {
      read = fetchReviewThreads(octokit, repoFullName, prNumber).then(
        ({ threads }) => threads,
      );
      read.catch(() => reads.delete(prNumber));
      reads.set(prNumber, read);
    }
    return read;
  }

  const hasComment = (thread: FetchedReviewThread, commentId: number) =>
    thread.comments.some((c) => c.databaseId === commentId);

  return {
    async findThreadByCommentId(prNumber, commentId) {
      const thread = (await threadsOf(prNumber)).find((t) =>
        hasComment(t, commentId),
      );
      return thread
        ? {
            threadId: thread.id,
            isResolved: thread.isResolved,
            commentBodies: thread.comments.map((c) => c.body ?? ""),
            comments: thread.comments.map((c) => ({
              body: c.body ?? "",
              authorLogin: c.authorLogin,
            })),
          }
        : null;
    },

    async replyToReviewComment(prNumber, commentId, body) {
      await octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        comment_id: commentId,
        body,
      });
      const thread = (await reads.get(prNumber)?.catch(() => []))?.find((t) =>
        hasComment(t, commentId),
      );
      thread?.comments.push({ databaseId: null, authorLogin: null, body });
    },

    async resolveThread(threadId) {
      await octokit.graphql(
        `mutation ($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }`,
        { threadId },
      );
      for (const read of reads.values()) {
        const thread = (await read.catch(() => [])).find(
          (t) => t.id === threadId,
        );
        if (thread) thread.isResolved = true;
      }
    },
  };
}
