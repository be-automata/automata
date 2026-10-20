import {
  renderPrView,
  renderPriorReviews,
  renderReviewContext,
  renderReviewThreads,
  type PrViewData,
  type ReviewContextBlock,
  type ReviewThreadData,
} from "@terragon/review/context/render";
import { getOctokitForApp } from "@/lib/github";
import type { ReviewContextFetcher } from "./review-skill";

/**
 * The control-plane half of a skill's `<!-- automata:context … -->` directive
 * (review-skill.ts): read what the review agent cannot — it holds no GitHub
 * credential (ADR-004) — with the App token, once, when the thread is created,
 * and render it in the legacy orchestrator's shapes. Only the terminal writes
 * to GitHub; this only reads.
 *
 * A block that cannot be fetched renders as an `unavailable` note: a review
 * with less context still runs, exactly as the legacy fetchers degraded to an
 * empty block.
 */

type Octokit = Awaited<ReturnType<typeof getOctokitForApp>>;

/** At most this many 100-thread pages are read (500 threads). */
export const REVIEW_THREAD_PAGE_LIMIT = 5;

const REVIEW_THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            path
            line
            comments(first: 10) {
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

/** REST `mergeable` (true/false/null) in gh's casing. */
function ghMergeable(mergeable: boolean | null | undefined): string {
  if (mergeable === true) return "MERGEABLE";
  if (mergeable === false) return "CONFLICTING";
  return "UNKNOWN";
}

async function fetchPrView(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  const pr: PrViewData = {
    number: data.number,
    title: data.title,
    state: data.merged ? "MERGED" : data.state.toUpperCase(),
    isDraft: data.draft === true,
    authorLogin: data.user?.login ?? null,
    labels: data.labels.map((label) => label.name ?? "").filter(Boolean),
    url: data.html_url,
    headRefName: data.head.ref,
    baseRefName: data.base.ref,
    additions: data.additions ?? null,
    deletions: data.deletions ?? null,
    changedFiles: data.changed_files ?? null,
    mergeable: ghMergeable(data.mergeable),
    mergeStateStatus: (data.mergeable_state ?? "unknown").toUpperCase(),
    body: data.body ?? null,
  };
  return renderPrView(pr);
}

async function fetchPriorReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return renderPriorReviews(
    reviews.map((review) => ({
      authorLogin: review.user?.login ?? null,
      state: review.state,
      commitId: review.commit_id ?? null,
      body: review.body ?? null,
    })),
  );
}

async function fetchReviewThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const threads: ReviewThreadData[] = [];
  let cursor: string | null = null;
  let truncated = false;
  for (let page = 0; page < REVIEW_THREAD_PAGE_LIMIT; page++) {
    const result: ReviewThreadsPage = await octokit.graphql(
      REVIEW_THREADS_QUERY,
      { owner, repo, number: prNumber, cursor },
    );
    const connection = result.repository?.pullRequest?.reviewThreads;
    if (!connection) break;
    for (const node of connection.nodes) {
      threads.push({
        isResolved: node.isResolved,
        path: node.path,
        line: node.line,
        comments: node.comments.nodes.map((comment) => ({
          databaseId: comment.databaseId,
          authorLogin: comment.author?.login ?? null,
          body: comment.body,
        })),
        commentsTruncated:
          node.comments.totalCount > node.comments.nodes.length,
      });
    }
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
    truncated = page === REVIEW_THREAD_PAGE_LIMIT - 1;
  }
  return renderReviewThreads(threads, { truncated });
}

const FETCHERS: Record<
  ReviewContextFetcher,
  (
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<string>
> = {
  "pr-view": fetchPrView,
  "prior-reviews": fetchPriorReviews,
  "review-threads": fetchReviewThreads,
};

/**
 * Fetch and render the requested blocks, in the order the directive names
 * them. Never throws for a single block: a failed one renders as unavailable.
 */
export async function prefetchReviewContext({
  octokit,
  repoFullName,
  prNumber,
  fetchers,
}: {
  octokit: Octokit;
  repoFullName: string;
  prNumber: number;
  fetchers: readonly ReviewContextFetcher[];
}): Promise<string> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository full name: ${repoFullName}`);
  }
  const blocks = await Promise.all(
    fetchers.map(async (name): Promise<ReviewContextBlock> => {
      try {
        return {
          name,
          content: await FETCHERS[name](octokit, owner, repo, prNumber),
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn("[review-context] fetch failed; rendering unavailable", {
          repoFullName,
          prNumber,
          fetcher: name,
          reason,
        });
        return { name, unavailable: reason.slice(0, 200) };
      }
    }),
  );
  return renderReviewContext(blocks);
}

/**
 * The thread-creation entry point: App octokit for the PR's repo, then
 * {@link prefetchReviewContext}. If the App cannot even be reached for this
 * repo, every requested block renders as unavailable — the review still runs.
 */
export async function prefetchReviewContextForPr({
  repoFullName,
  prNumber,
  fetchers,
}: {
  repoFullName: string;
  prNumber: number;
  fetchers: readonly ReviewContextFetcher[];
}): Promise<string> {
  const [owner, repo] = repoFullName.split("/");
  let octokit: Octokit;
  try {
    if (!owner || !repo) {
      throw new Error(`Invalid repository full name: ${repoFullName}`);
    }
    octokit = await getOctokitForApp({ owner, repo });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn("[review-context] no App client; every block unavailable", {
      repoFullName,
      prNumber,
      reason,
    });
    return renderReviewContext(
      fetchers.map((name) => ({ name, unavailable: reason.slice(0, 200) })),
    );
  }
  return prefetchReviewContext({ octokit, repoFullName, prNumber, fetchers });
}

/** What a context directive becomes in a run that no pull request started. */
export const NO_PR_REVIEW_CONTEXT =
  "(No pull-request context: this run was not started by a pull request event.)";
