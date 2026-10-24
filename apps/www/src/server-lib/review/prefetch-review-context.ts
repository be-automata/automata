import {
  priorReviewFromRest,
  prViewFromRest,
  renderPrView,
  renderPriorReviews,
  renderReviewContext,
  renderReviewThreads,
  type RestPullRequestLike,
  type ReviewContextBlock,
  type ReviewThreadData,
} from "@terragon/review/context/render";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import {
  buildReviewTicketContext,
  type ReviewTicketScope,
} from "@/server-lib/tracker/review-ticket-context";
import type { ReviewContextFetcher } from "./review-skill";
import { fetchReviewThreads } from "./octokit-review-client";

export { REVIEW_THREAD_PAGE_LIMIT } from "./octokit-review-client";

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
  return renderPrView(prViewFromRest(data));
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
  return renderPriorReviews(reviews.map(priorReviewFromRest));
}

/** Comments shown per thread in the `<review_threads>` block. */
const THREAD_COMMENTS_SHOWN = 10;

async function fetchThreadsBlock(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const { threads, truncated } = await fetchReviewThreads(
    octokit,
    `${owner}/${repo}`,
    prNumber,
  );
  return renderReviewThreads(
    threads.map(
      (thread): ReviewThreadData => ({
        isResolved: thread.isResolved,
        path: thread.path,
        line: thread.line,
        comments: thread.comments.slice(0, THREAD_COMMENTS_SHOWN),
        commentsTruncated: thread.commentCount > THREAD_COMMENTS_SHOWN,
      }),
    ),
    { truncated },
  );
}

/**
 * The ticket block's cap: a hardened ticket runs to ~25k characters and its
 * acceptance criteria sit in the middle, which the shared head + tail cap
 * would drop. Matches the post-merge lane's description cap.
 */
const TICKET_BLOCK_MAX_CHARS = 60_000;

/**
 * The `ticket` block reads the tracker, not GitHub: the PR's title, body and
 * head branch name the ticket. The caller's PR is used when it has one (the
 * PR-event path); the mention lane passes none, so it is read here.
 */
async function fetchTicketBlock(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  ticket: ReviewTicketScope | undefined,
  pullRequest: RestPullRequestLike | undefined,
): Promise<string> {
  if (!ticket) {
    throw new Error("this run has no tracker scope");
  }
  const pr =
    pullRequest ??
    (await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })).data;
  return buildReviewTicketContext({
    scope: ticket,
    repoFullName: `${owner}/${repo}`,
    pullRequest: { title: pr.title, body: pr.body, headBranch: pr.head.ref },
  });
}

const FETCHERS: Record<
  Exclude<ReviewContextFetcher, "ticket">,
  (
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<string>
> = {
  "pr-view": fetchPrView,
  "prior-reviews": fetchPriorReviews,
  "review-threads": fetchThreadsBlock,
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
  pullRequest,
  ticket,
}: {
  octokit: Octokit;
  repoFullName: string;
  prNumber: number;
  fetchers: readonly ReviewContextFetcher[];
  /** The PR the caller already read: pr-view renders from it, no fetch. */
  pullRequest?: RestPullRequestLike;
  /** Whose tracker the `ticket` block reads; without it that block is unavailable. */
  ticket?: ReviewTicketScope;
}): Promise<string> {
  const [owner, repo] = parseRepoFullName(repoFullName);
  const blocks = await Promise.all(
    fetchers.map(async (name): Promise<ReviewContextBlock> => {
      try {
        if (name === "ticket") {
          return {
            name,
            content: await fetchTicketBlock(
              octokit,
              owner,
              repo,
              prNumber,
              ticket,
              pullRequest,
            ),
            maxChars: TICKET_BLOCK_MAX_CHARS,
          };
        }
        return {
          name,
          content:
            name === "pr-view" && pullRequest
              ? renderPrView(prViewFromRest(pullRequest))
              : await FETCHERS[name](octokit, owner, repo, prNumber),
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
  pullRequest,
  ticket,
}: {
  repoFullName: string;
  prNumber: number;
  fetchers: readonly ReviewContextFetcher[];
  /** The PR the caller already read: pr-view renders from it, no fetch. */
  pullRequest?: RestPullRequestLike;
  /** Whose tracker the `ticket` block reads; without it that block is unavailable. */
  ticket?: ReviewTicketScope;
}): Promise<string> {
  let octokit: Octokit;
  try {
    const [owner, repo] = parseRepoFullName(repoFullName);
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
  return prefetchReviewContext({
    octokit,
    repoFullName,
    prNumber,
    fetchers,
    pullRequest,
    ticket,
  });
}

/** What a context directive becomes in a run that no pull request started. */
export const NO_PR_REVIEW_CONTEXT =
  "(No pull-request context: this run was not started by a pull request event.)";
