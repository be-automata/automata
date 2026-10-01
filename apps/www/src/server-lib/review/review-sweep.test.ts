import { describe, it, vi, beforeEach, expect } from "vitest";

/**
 * The GAP-1 sweep's blast radius: it is the ONE entry that speaks for a thread
 * the finish-hook never reached, so what it refuses to speak for matters as much
 * as what it posts. Regression for #140 (2026-08-25): a review run killed with
 * the worker box was reaped here and posted
 * "⚠️ Review intent could not be parsed — a human should review this PR"
 * at a commit pushed 73 seconds earlier, whose own review was still running.
 */

const selected: { rows: unknown[] } = { rows: [] };
/** #224: the PR's existing reviews, as the sweep's one fetch sees them. */
const prReviews: { rows: unknown[] } = { rows: [] };

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => selected.rows,
      }),
    }),
  },
}));
vi.mock("@/lib/github", () => ({
  getOctokitForApp: vi.fn(async () => ({}) as never),
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));
vi.mock("@terragon/env/apps-www", () => ({
  env: {
    GITHUB_SIDE_EFFECTS_ENABLED: true,
    GITHUB_BOT_LOGIN: "automata-ai-bot[bot]",
    NEXT_PUBLIC_GITHUB_APP_NAME: "automata-ai-bot",
  },
}));
vi.mock("./octokit-review-client", () => ({
  // #224: the sweep now fetches the PR's reviews ONCE and hands the guard a
  // filtered view, so the client must actually serve them.
  createOctokitReviewClient: () => ({
    listReviews: async () => prReviews.rows,
  }),
  getPrHeadSha: vi.fn(async () => HEAD),
}));
// #224: the REAL guard, wrapped in a spy. The thing under test is the
// composition — "does the filtered snapshot reach the primitive" — so a mock
// that returns a canned answer would assert nothing. `vi.fn(actual)` keeps the
// call tracking the quota test at the bottom of this file depends on.
vi.mock("@terragon/review/state/head-review-guard", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@terragon/review/state/head-review-guard")
    >();
  return { ...actual, findBotReviewAtHead: vi.fn(actual.findBotReviewAtHead) };
});
vi.mock("@terragon/shared/model/threads", () => ({
  getThreadChat: vi.fn(async () => ({ messages: [] })),
}));
vi.mock("./review-single-writer-finish", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review-single-writer-finish")>()),
  isReviewThread: vi.fn(async () => true),
}));
// #224: spread the original so the REAL `isDegradedComment` / `snapshotOf` the
// sweep now imports come through; only the executor itself is stubbed.
vi.mock("./execute-review-from-intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execute-review-from-intent")>()),
  executeReviewFromIntent: vi.fn(async () => ({ outcome: "degraded_comment" })),
}));

import { getThreadChat } from "@terragon/shared/model/threads";
import { getOctokitForApp } from "@/lib/github";
import { getPrHeadSha } from "./octokit-review-client";
import { findBotReviewAtHead } from "@terragon/review/state/head-review-guard";
import { runReviewSweep } from "./review-sweep";
import {
  executeReviewFromIntent,
  DEGRADED_INTENT_MARKER,
} from "./execute-review-from-intent";

const HEAD = "head-sha";
const OLD = "old-sha";

function candidate(over: Record<string, unknown> = {}) {
  return {
    id: "thread_1",
    userId: "user_1",
    repoFullName: "o/r",
    prNumber: 140,
    automationId: "auto_1",
    organizationId: "org_1",
    terminalCause: null,
    reviewedSha: HEAD,
    version: 0,
    ...over,
  };
}

describe("runReviewSweep — which terminal runs it may speak for", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selected.rows = [];
    prReviews.rows = [];
  });

  it.each([
    "superseded",
    "discarded",
    "stale-skipped",
    "user-cancelled",
    "plane-offline",
  ])(
    "flags an abandoned run so its silence posts no warning (cause=%s)",
    async (terminalCause) => {
      selected.rows = [candidate({ terminalCause })];
      await runReviewSweep();
      expect(
        vi.mocked(executeReviewFromIntent).mock.calls[0]![0].runAbandoned,
      ).toBe(true);
    },
  );

  it.each([
    "superseded",
    "discarded",
    "stale-skipped",
    "user-cancelled",
    "plane-offline",
  ])(
    "still READS an abandoned run — a persisted verdict must survive (cause=%s)",
    async (terminalCause) => {
      // The supersede race: a run can persist a real verdict and be stamped
      // terminal before its finish hook posts, with the generation fence
      // rejecting the late write. Skipping the candidate outright would
      // discard that verdict permanently.
      selected.rows = [candidate({ terminalCause })];
      await runReviewSweep();
      expect(executeReviewFromIntent).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["timeout", "daemon-failed", "publish-failed", null])(
    "lets a run that owned the PR speak for HEAD (cause=%s)",
    async (terminalCause) => {
      selected.rows = [candidate({ terminalCause })];
      await runReviewSweep();
      expect(executeReviewFromIntent).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(executeReviewFromIntent).mock.calls[0]![0].runAbandoned,
      ).toBe(false);
    },
  );

  it("hands the executor the head the run was dispatched against", async () => {
    selected.rows = [candidate({ terminalCause: "timeout", reviewedSha: OLD })];
    await runReviewSweep();
    expect(vi.mocked(executeReviewFromIntent).mock.calls[0]![0]).toMatchObject({
      currentHeadSha: HEAD,
      reviewedSha: OLD,
    });
  });
});

describe("runReviewSweep — addressing chat state across thread versions", () => {
  // #155: the sweep hardcoded LEGACY_THREAD_CHAT_ID, which addresses the THREAD
  // row. That is correct only while every thread is v0. A v1 thread keeps its
  // messages on a threadChat row, so the hardcoded read finds nothing and —
  // since #150 made the degraded warning conditional — withholds SILENTLY.
  beforeEach(() => {
    vi.clearAllMocks();
    selected.rows = [];
    prReviews.rows = [];
  });

  it("v0: reads via the legacy sentinel and serves the thread", async () => {
    selected.rows = [candidate({ version: 0 })];
    await runReviewSweep();
    expect(vi.mocked(getThreadChat).mock.calls[0]![0]).toMatchObject({
      threadChatId: "legacy-thread-chat-id",
    });
    expect(executeReviewFromIntent).toHaveBeenCalledTimes(1);
  });

  it("v1: refuses to guess — never reaches the executor", async () => {
    selected.rows = [candidate({ version: 1 })];
    await runReviewSweep();
    expect(executeReviewFromIntent).not.toHaveBeenCalled();
    expect(getThreadChat).not.toHaveBeenCalled();
  });

  it("v1: pages loudly with the identifying fields", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    selected.rows = [candidate({ version: 1 })];
    await runReviewSweep();
    expect(spy).toHaveBeenCalledWith(
      "[review-sweep] cannot address chat state for a v1 thread — skipped",
      expect.objectContaining({
        threadId: "thread_1",
        version: 1,
        repoFullName: "o/r",
        prNumber: 140,
      }),
    );
    spy.mockRestore();
  });

  it("v1: costs zero GitHub API quota — skips before every octokit call", async () => {
    selected.rows = [candidate({ version: 1 })];
    await runReviewSweep();
    expect(getOctokitForApp).not.toHaveBeenCalled();
    expect(getPrHeadSha).not.toHaveBeenCalled();
    expect(findBotReviewAtHead).not.toHaveBeenCalled();
  });

  it("a v1 candidate never aborts the loop — the v0 sibling is still served", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    selected.rows = [
      candidate({ id: "thread_v1", version: 1 }),
      candidate({ id: "thread_v0", version: 0 }),
    ];
    await runReviewSweep();
    expect(executeReviewFromIntent).toHaveBeenCalledTimes(1);
  });

  it("any future non-legacy version also skips, not just 1", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    selected.rows = [candidate({ version: 2 })];
    await runReviewSweep();
    expect(executeReviewFromIntent).not.toHaveBeenCalled();
  });
});

/**
 * #224 — the sweep is the THIRD guard that counted silence as a verdict.
 *
 * #213 fixed the replay guard, #221 the supersession guard; both live inside
 * `execute-review-from-intent.ts`. This one is the other entry to the single
 * writer and it held the bug longest. Because the sweep iterates PER THREAD,
 * the verdict it lost belonged to a DIFFERENT thread than the one that went
 * silent, which is why it never showed up in those investigations.
 */
describe("runReviewSweep — a degraded comment is silence, not a verdict (#224)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selected.rows = [];
    prReviews.rows = [];
  });

  const BOT = "automata-ai-bot[bot]";

  function review(over: Record<string, unknown> = {}) {
    return {
      id: 1,
      user: { login: BOT },
      state: "COMMENTED",
      submittedAt: "2026-10-01T00:00:00Z",
      dismissedAt: null,
      commitId: HEAD,
      body: "a real verdict",
      ...over,
    };
  }

  it("a DEGRADED comment at HEAD does NOT skip the candidate — the backstop runs", async () => {
    // Run A degraded at HEAD and left the marker. Run B — this candidate —
    // carries a real verdict whose finish hook never fired. Before the fix the
    // sweep matched A's silence and skipped, and B's verdict was lost forever.
    prReviews.rows = [
      review({ body: `${DEGRADED_INTENT_MARKER}\n\n_Reason: x._` }),
    ];
    selected.rows = [candidate({ terminalCause: "timeout" })];

    await runReviewSweep();

    expect(executeReviewFromIntent).toHaveBeenCalledTimes(1);
  });

  it("a REAL bot verdict at HEAD still skips the candidate", async () => {
    // The other direction: this must not become a double-poster. A genuine
    // verdict at HEAD means the finish-hook did its job.
    prReviews.rows = [review()];
    selected.rows = [candidate({ terminalCause: "timeout" })];

    await runReviewSweep();

    expect(executeReviewFromIntent).not.toHaveBeenCalled();
  });

  it("our own verdict that QUOTES the marker is still a verdict — the sweep skips", async () => {
    // `isDegradedComment` used to be `body.includes(MARKER)`, which was wider
    // than the thing it meant to recognise. A real verdict of ours that merely
    // QUOTES the marker was read as silence, so the sweep stopped seeing a
    // verdict at HEAD and ran its backstop on a PR that already had one — and
    // that is self-referential, because reviews OF THIS REPO'S CODE plausibly
    // quote it.
    //
    // The single emission site builds the body as `${MARKER}\n\n_Reason: …`,
    // so the marker is a PREFIX by construction and `startsWith` recognises
    // exactly what we emit — no author heuristic, no second shape. The fix
    // lives in the one shared helper, so all three guards keep matching
    // identically; there is no residual left to accept.
    prReviews.rows = [
      review({
        body: `We should rename ${DEGRADED_INTENT_MARKER} in this PR.`,
      }),
    ];
    selected.rows = [candidate({ terminalCause: "timeout" })];

    await runReviewSweep();

    expect(executeReviewFromIntent).not.toHaveBeenCalled();
  });

  it("hands the writer the candidate at HEAD — the writer, not the sweep, decides whether to post", async () => {
    // The risk this fix creates and #220 closes: filtering means the sweep RUNS
    // the writer for a thread whose only review at HEAD is a degraded comment,
    // and before #220's per-sha dedup a still-unparseable thread would have
    // re-posted that comment every hour. The executor is stubbed here, so this
    // cannot assert "nothing is posted" — #220's own tests own that. What it
    // pins is the division of labour: the sweep delivers the work at the right
    // head and does not decide the outcome itself.
    prReviews.rows = [
      review({ body: `${DEGRADED_INTENT_MARKER}\n\n_Reason: x._` }),
    ];
    selected.rows = [candidate({ terminalCause: "timeout" })];

    await runReviewSweep();

    expect(executeReviewFromIntent).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(executeReviewFromIntent).mock.calls[0]![0].currentHeadSha,
    ).toBe(HEAD);
  });
});
