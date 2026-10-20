import { describe, it, expect, vi } from "vitest";
import {
  createFileAtCommitReader,
  createOctokitThreadClient,
} from "./octokit-review-client";
import { applyThreadResolutions } from "./review-thread-resolutions";

/**
 * The App-scoped GitHub reads behind the terminal writer: the thread client
 * (applyThreadResolutions) and the file-at-commit reader (verify-before-block).
 *
 * protects: a PR's review threads are scanned ONCE per client (lazily, only
 *   as far as a lookup needs), and the client's own reply/resolve are visible
 *   to a repeat lookup.
 * fails_when: every resolution re-scans every page, or a repeat lookup of the
 *   same thread replies twice.
 * no_claim: GitHub's GraphQL pagination semantics (a fake stands in).
 */

type Node = {
  id: string;
  isResolved: boolean;
  comments: { nodes: { databaseId: number | null; body: string | null }[] };
};

function page(nodes: Node[], next: string | null) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: next !== null, endCursor: next },
          nodes,
        },
      },
    },
  };
}

function node(id: string, commentId: number): Node {
  return {
    id,
    isResolved: false,
    comments: { nodes: [{ databaseId: commentId, body: "ask" }] },
  };
}

function makeOctokit(pages: ReturnType<typeof page>[]) {
  const graphql = vi.fn(
    async (query: string, vars: { cursor?: string | null }) => {
      if (query.includes("resolveReviewThread")) return {};
      const index = vars.cursor ? Number(vars.cursor) : 0;
      return pages[index];
    },
  );
  const createReplyForReviewComment = vi.fn(async () => ({}));
  const octokit = {
    graphql,
    rest: { pulls: { createReplyForReviewComment } },
  };
  return {
    // Only the members the thread client touches are faked.
    octokit: octokit as unknown as Parameters<
      typeof createOctokitThreadClient
    >[0],
    graphql,
    createReplyForReviewComment,
  };
}

const pageReads = (graphql: ReturnType<typeof vi.fn>) =>
  graphql.mock.calls.filter(([q]) => !String(q).includes("resolveReviewThread"))
    .length;

describe("createFileAtCommitReader", () => {
  const httpError = (status: number) =>
    Object.assign(new Error(`HTTP ${status}`), { status });
  const readerWith = (request: ReturnType<typeof vi.fn>) =>
    createFileAtCommitReader(
      { request } as unknown as Parameters<typeof createFileAtCommitReader>[0],
      "o/r",
    );

  it("retries a 5xx once", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(httpError(502))
      .mockResolvedValueOnce({ data: "text" });
    expect(await readerWith(request)("a.ts", "sha")).toEqual({
      kind: "content",
      text: "text",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx: 403 is unchecked, 404 is missing", async () => {
    const forbidden = vi.fn().mockRejectedValue(httpError(403));
    expect((await readerWith(forbidden)("a.ts", "sha")).kind).toBe("unchecked");
    expect(forbidden).toHaveBeenCalledTimes(1);
    const missing = vi.fn().mockRejectedValue(httpError(404));
    expect(await readerWith(missing)("a.ts", "sha")).toEqual({
      kind: "missing",
    });
    expect(missing).toHaveBeenCalledTimes(1);
  });
});

describe("createOctokitThreadClient", () => {
  it("reads the PR's threads once (every page) across many lookups", async () => {
    const { octokit, graphql } = makeOctokit([
      page([node("T1", 1), node("T2", 2)], "1"),
      page([node("T3", 3)], null),
    ]);
    const client = createOctokitThreadClient(octokit, "o/r");

    expect((await client.findThreadByCommentId(5, 1))?.threadId).toBe("T1");
    expect((await client.findThreadByCommentId(5, 2))?.threadId).toBe("T2");
    expect((await client.findThreadByCommentId(5, 3))?.threadId).toBe("T3");
    expect(await client.findThreadByCommentId(5, 999)).toBeNull();
    expect(pageReads(graphql)).toBe(2);
  });

  it("a failed read is not cached: the next lookup reads again", async () => {
    const { octokit, graphql } = makeOctokit([page([node("T1", 1)], null)]);
    graphql.mockRejectedValueOnce(new Error("502"));
    const client = createOctokitThreadClient(octokit, "o/r");

    await expect(client.findThreadByCommentId(5, 1)).rejects.toThrow("502");
    expect((await client.findThreadByCommentId(5, 1))?.threadId).toBe("T1");
  });

  it("a repeat lookup sees the client's own reply and resolve (one reply in total)", async () => {
    const { octokit, graphql, createReplyForReviewComment } = makeOctokit([
      page([node("T1", 1)], null),
    ]);
    const client = createOctokitThreadClient(octokit, "o/r");

    const tally = await applyThreadResolutions({
      client,
      claim: async () => true,
      prNumber: 5,
      commit: "sha",
      resolutions: [
        { inlineCommentId: 1, reply: "Verified: fixed" },
        { inlineCommentId: 1, reply: "Verified: fixed" },
      ],
    });

    expect(createReplyForReviewComment).toHaveBeenCalledTimes(1);
    expect(tally).toMatchObject({ replied: 1, resolved: 1, skipped: 1 });
    expect(pageReads(graphql)).toBe(1);
  });
});
