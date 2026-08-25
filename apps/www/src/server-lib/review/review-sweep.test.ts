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
  createOctokitReviewClient: () => ({}),
  getPrHeadSha: vi.fn(async () => HEAD),
}));
vi.mock("@terragon/review/state/head-review-guard", () => ({
  findBotReviewAtHead: vi.fn(async () => null),
}));
vi.mock("@terragon/shared/model/threads", () => ({
  getThreadChat: vi.fn(async () => ({ messages: [] })),
}));
vi.mock("./review-single-writer-finish", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review-single-writer-finish")>()),
  isReviewThread: vi.fn(async () => true),
}));
vi.mock("./execute-review-from-intent", () => ({
  executeReviewFromIntent: vi.fn(async () => ({ outcome: "degraded_comment" })),
}));

import { runReviewSweep } from "./review-sweep";
import { executeReviewFromIntent } from "./execute-review-from-intent";

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
    ...over,
  };
}

describe("runReviewSweep — which terminal runs it may speak for", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selected.rows = [];
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
