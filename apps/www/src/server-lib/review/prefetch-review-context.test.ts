import { describe, it, expect, vi } from "vitest";
import {
  prefetchReviewContext,
  REVIEW_THREAD_PAGE_LIMIT,
} from "./prefetch-review-context";

/**
 * The control-plane prefetch behind `<!-- automata:context … -->`.
 *
 * protects: GitHub's REST/GraphQL shapes map onto the legacy blocks (gh casing,
 *   `comment_id`, DISMISSED standing), threads paginate up to the cap, and a
 *   failed block renders as unavailable instead of failing the run.
 * fails_when: a block throws through, the order differs from the directive, or
 *   a dismissed review reads as outstanding.
 * no_claim: real GitHub responses (a fake Octokit stands in).
 */

type FakeOctokit = Parameters<typeof prefetchReviewContext>[0]["octokit"];

function threadsPage(
  nodes: Array<{ isResolved: boolean; id: number }>,
  hasNextPage: boolean,
) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage, endCursor: hasNextPage ? "c" : null },
          nodes: nodes.map((n) => ({
            isResolved: n.isResolved,
            path: "src/a.ts",
            line: 3,
            comments: {
              totalCount: 1,
              nodes: [
                {
                  databaseId: n.id,
                  author: { login: "bot[bot]" },
                  body: "fix it",
                },
              ],
            },
          })),
        },
      },
    },
  };
}

function makeOctokit(overrides: {
  pullsGet?: () => Promise<unknown>;
  reviews?: unknown[] | Error;
  graphql?: (query: string, vars: Record<string, unknown>) => Promise<unknown>;
}) {
  const listReviews = vi.fn();
  const octokit = {
    rest: {
      pulls: {
        get: vi.fn(
          overrides.pullsGet ??
            (async () => ({
              data: {
                number: 7,
                title: "Add widgets",
                state: "open",
                merged: false,
                draft: true,
                user: { login: "octo" },
                labels: [{ name: "backend" }],
                html_url: "https://github.com/acme/widgets/pull/7",
                head: { ref: "feat/w" },
                base: { ref: "develop" },
                additions: 1,
                deletions: 2,
                changed_files: 3,
                mergeable: false,
                mergeable_state: "dirty",
                body: "Body",
              },
            })),
        ),
        listReviews,
      },
    },
    paginate: vi.fn(async () => {
      if (overrides.reviews instanceof Error) throw overrides.reviews;
      return overrides.reviews ?? [];
    }),
    graphql: vi.fn(overrides.graphql ?? (async () => threadsPage([], false))),
  };
  return octokit as unknown as FakeOctokit & typeof octokit;
}

describe("prefetchReviewContext", () => {
  it("renders the requested blocks in directive order, in gh casing", async () => {
    const octokit = makeOctokit({
      reviews: [
        {
          user: { login: "bot[bot]" },
          state: "CHANGES_REQUESTED",
          commit_id: "abcdef123",
          body: "- fix a",
        },
        {
          user: { login: "human" },
          state: "DISMISSED",
          commit_id: "1234567890",
          body: "",
        },
      ],
      graphql: async () => threadsPage([{ isResolved: false, id: 111 }], false),
    });
    const out = await prefetchReviewContext({
      octokit,
      repoFullName: "acme/widgets",
      prNumber: 7,
      fetchers: ["review-threads", "pr-view", "prior-reviews"],
    });
    const parts = out.split("\n\n---\n\n");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain('<user_content source="review-threads">');
    expect(parts[0]).toContain(
      "  - thread: src/a.ts:3 | unresolved | comment_id: 111",
    );
    expect(parts[1]).toContain("state:\tOPEN");
    expect(parts[1]).toContain("draft:\ttrue");
    expect(parts[1]).toContain("mergeable:\tCONFLICTING");
    expect(parts[1]).toContain("mergeStateStatus:\tDIRTY");
    expect(parts[2]).toContain(
      "state: CHANGES_REQUESTED | commit: abcdef12 | outstanding",
    );
    expect(parts[2]).toContain(
      "state: DISMISSED | commit: 12345678 | dismissed",
    );
  });

  it("a failed block renders as unavailable; the others still render", async () => {
    const octokit = makeOctokit({ reviews: new Error("HTTP 502") });
    const out = await prefetchReviewContext({
      octokit,
      repoFullName: "acme/widgets",
      prNumber: 7,
      fetchers: ["pr-view", "prior-reviews"],
    });
    expect(out).toContain("title:\tAdd widgets");
    expect(out).toContain(
      '<prior-reviews unavailable="true" reason="HTTP 502" />',
    );
  });

  it('paginates threads and stops at the page limit with truncated="true"', async () => {
    const graphql = vi.fn(async () =>
      threadsPage([{ isResolved: false, id: 1 }], true),
    );
    const octokit = makeOctokit({ graphql });
    const out = await prefetchReviewContext({
      octokit,
      repoFullName: "acme/widgets",
      prNumber: 7,
      fetchers: ["review-threads"],
    });
    expect(graphql).toHaveBeenCalledTimes(REVIEW_THREAD_PAGE_LIMIT);
    expect(out).toContain(
      `unresolved="${REVIEW_THREAD_PAGE_LIMIT}" scope="line-level-only" truncated="true"`,
    );
  });

  it("a merged PR reads MERGED", async () => {
    const octokit = makeOctokit({
      pullsGet: async () => ({
        data: {
          number: 7,
          title: "t",
          state: "closed",
          merged: true,
          draft: false,
          user: null,
          labels: [],
          html_url: "u",
          head: { ref: "h" },
          base: { ref: "b" },
          additions: 0,
          deletions: 0,
          changed_files: 0,
          mergeable: null,
          mergeable_state: "unknown",
          body: null,
        },
      }),
    });
    const out = await prefetchReviewContext({
      octokit,
      repoFullName: "acme/widgets",
      prNumber: 7,
      fetchers: ["pr-view"],
    });
    expect(out).toContain("state:\tMERGED");
    expect(out).toContain("mergeable:\tUNKNOWN");
  });
});
