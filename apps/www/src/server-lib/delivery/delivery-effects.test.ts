import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Octokit } from "octokit";
import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  enrollDeliveryPr,
  getDeliveryPr,
  transitionDeliveryPr,
} from "@terragon/shared/model/delivery-loop";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { deliveryMarker, renderMergeReady } from "./delivery-effects";
import {
  evaluateDeliveryPr,
  type EvaluateDeliveryDeps,
} from "./evaluate-delivery-pr";
import type { DeliveryHeadCi } from "./head-ci";

const BOT = "automata-ai-bot[bot]";
const NOW = new Date("2026-10-26T12:00:00Z");
const GREEN: DeliveryHeadCi = {
  state: "success",
  gateSource: "all-checks",
  failing: [],
  noCi: false,
};

interface FakeGithub {
  octokit: Octokit;
  graphql: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
  comments: FakeComment[];
}

interface FakeComment {
  id: number;
  body: string;
  user: { login: string };
}

function fakeGithub({
  draft,
  reviews = [],
  author = "User",
  comments = [],
}: {
  draft: boolean;
  reviews?: unknown[];
  author?: string;
  comments?: FakeComment[];
}): FakeGithub {
  const store = [...comments];
  const graphql = vi.fn(async () => ({}));
  // Comments the loop posts are the App's, as on GitHub.
  const createComment = vi.fn(async ({ body }: { body: string }) => {
    const id = 1000 + store.length;
    store.push({ id, body, user: { login: BOT } });
    return { data: { id } };
  });
  const listComments = vi.fn();
  const octokit = {
    graphql,
    paginate: {
      iterator: (fn: unknown) => {
        if (fn !== listComments) throw new Error("unexpected paginate target");
        return (async function* () {
          yield { data: [...store] };
        })();
      },
    },
    rest: {
      pulls: {
        get: async () => ({
          data: {
            node_id: "PR_node",
            state: "open",
            merged_at: null,
            draft,
            head: { sha: "H1" },
            base: { ref: "main" },
            user: { type: author },
          },
        }),
        listReviews: async () => ({ data: reviews }),
      },
      issues: { listComments, createComment },
    },
  } as unknown as Octokit;
  return { octokit, graphql, createComment, comments: store };
}

describe("#509 delivery effects (mode on)", () => {
  let deliveryPrId: string;

  beforeEach(async () => {
    const userId = (await createTestUser({ db })).user.id;
    const organizationId = await createTestOrg({ db });
    const threadId = (await createTestThread({ db, userId })).threadId;
    deliveryPrId = (
      await enrollDeliveryPr(db, {
        organizationId,
        repoFullName: `acme/widgets-${nanoid(6)}`,
        prNumber: 12,
        issueNumber: 4,
        headRef: "automata/task-abcd1234",
        baseRef: "main",
        headSha: null,
        deliveryThreadId: threadId,
        automationId: "auto-1",
        now: NOW,
      })
    ).row.id;
  });

  function deps(
    github: FakeGithub,
    ci: DeliveryHeadCi = GREEN,
    mode: "on" | "shadow" = "on",
  ): Partial<EvaluateDeliveryDeps> {
    return {
      octokitFor: async () => github.octokit,
      loadMode: async () => mode,
      readHeadCi: async () => ci,
      botLogin: () => BOT,
      now: () => NOW,
    };
  }

  const evaluate = (d: Partial<EvaluateDeliveryDeps>) =>
    evaluateDeliveryPr({ deliveryPrId, deps: d });

  it("a green draft is marked ready once, as the App, and the evaluation stops there", async () => {
    const github = fakeGithub({ draft: true });
    const outcome = await evaluate(deps(github));
    expect(outcome).toMatchObject({
      steps: [{ kind: "observe_head" }, { kind: "mark_ready" }],
    });
    expect(github.graphql).toHaveBeenCalledTimes(1);
    expect(github.graphql.mock.calls[0]?.[1]).toMatchObject({
      pullRequestId: "PR_node",
    });
    expect(github.createComment).not.toHaveBeenCalled();
    expect(await getDeliveryPr(db, deliveryPrId)).toMatchObject({
      phase: "awaiting_review",
      readyMarkedHeadSha: "H1",
      readyMarkedAt: NOW,
    });
  });

  it("a green draft without repo CI gets the no-CI note with its mark", async () => {
    const github = fakeGithub({ draft: true });
    await evaluate(
      deps(github, { ...GREEN, gateSource: "finding-check-only", noCi: true }),
    );
    expect(github.graphql).toHaveBeenCalledTimes(1);
    expect(github.comments.map((c) => c.body)).toEqual([
      expect.stringContaining(deliveryMarker("no-ci", "H1")),
    ]);
  });

  it("the bot's approval at a green head posts one merge-ready comment, never twice", async () => {
    await transitionDeliveryPr(db, {
      id: deliveryPrId,
      expectedPhase: "awaiting_ci",
      expectedHeadSha: null,
      patch: {
        phase: "awaiting_review",
        headSha: "H1",
        headSeenAt: NOW,
        readyMarkedHeadSha: "H1",
        readyMarkedAt: NOW,
      },
    });
    const github = fakeGithub({
      draft: false,
      reviews: [
        { id: 9, state: "APPROVED", commit_id: "H1", user: { login: BOT } },
      ],
    });
    await evaluate(deps(github));
    await evaluate(deps(github));
    expect(github.createComment).toHaveBeenCalledTimes(1);
    const body = github.comments[0]?.body ?? "";
    expect(body).toContain("gh pr merge 12 --squash");
    expect(body).toContain(deliveryMarker("merge-ready", "H1"));
    expect(await getDeliveryPr(db, deliveryPrId)).toMatchObject({
      phase: "merge_ready",
      mergeReadyHeadSha: "H1",
      mergeReadyCommentId: 1000,
    });
    expect(github.graphql).not.toHaveBeenCalled();
  });

  it("needs_human posts one stop comment; the loop's own comment that survived a crash is adopted, not re-posted", async () => {
    const marker = deliveryMarker("needs-human", "H1");
    const github = fakeGithub({
      draft: true,
      author: "Bot",
      comments: [
        { id: 77, body: `earlier text\n\n${marker}`, user: { login: BOT } },
      ],
    });
    await evaluate(deps(github));
    expect(github.createComment).not.toHaveBeenCalled();
    expect(await getDeliveryPr(db, deliveryPrId)).toMatchObject({
      phase: "needs_human",
      stopCommentId: 77,
      lastReason: "app_authored_pr",
    });
  });

  it("a person's comment that quotes or pastes the marker is never adopted: the loop posts its own", async () => {
    const marker = deliveryMarker("needs-human", "H1");
    const github = fakeGithub({
      draft: true,
      author: "Bot",
      comments: [
        {
          id: 55,
          body: `> quoting the bot\n> ${marker}`,
          user: { login: "alice" },
        },
      ],
    });
    await evaluate(deps(github));
    expect(github.createComment).toHaveBeenCalledTimes(1);
    expect((await getDeliveryPr(db, deliveryPrId))?.stopCommentId).toBe(1001);
  });

  it("a fresh needs_human posts its stop comment with the reason", async () => {
    const github = fakeGithub({ draft: true, author: "Bot" });
    await evaluate(deps(github));
    expect(github.createComment).toHaveBeenCalledTimes(1);
    expect(github.comments[0]?.body).toMatch(
      /cannot approve or request changes on its own App's pull request/,
    );
  });

  it("shadow never writes to GitHub", async () => {
    const github = fakeGithub({ draft: true, author: "Bot" });
    await evaluate(deps(github, GREEN, "shadow"));
    const green = fakeGithub({ draft: true });
    await evaluate(deps(green, GREEN, "shadow"));
    for (const g of [github, green]) {
      expect(g.graphql).not.toHaveBeenCalled();
      expect(g.createComment).not.toHaveBeenCalled();
    }
  });

  it("renders the merge command for the person, with the short sha", () => {
    expect(
      renderMergeReady({ prNumber: 5, headSha: "abcdef1234", approver: BOT }),
    ).toContain("`abcdef1`");
  });
});

// The loop marks ready and comments at most; a person merges.
describe("delivery lane never merges", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const MERGE_API =
    /pulls\.merge|enablePullRequestAutoMerge|merge_method|mergePullRequest|auto_merge|\.merge\(\{|\/pulls\/[^"'\s]*\/merge\b|\/merges\b/;

  it("no source file in server-lib/delivery calls a merge API", () => {
    const files = readdirSync(HERE).filter(
      (n) => /\.ts$/.test(n) && !/\.test\.ts$/.test(n),
    );
    expect(files).toEqual(
      expect.arrayContaining([
        "delivery-effects.ts",
        "evaluate-delivery-pr.ts",
      ]),
    );
    const hits = files.flatMap((name) =>
      readFileSync(join(HERE, name), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .filter((line) => MERGE_API.test(line))
        .map((line) => `${name}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });
});
