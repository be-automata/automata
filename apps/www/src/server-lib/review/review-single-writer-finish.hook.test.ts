import { describe, it, vi, beforeEach, expect } from "vitest";

import {
  F1,
  F2,
  FIXTURE_HEAD_SHA,
  LEAD_RESUMED_TEXT,
  STAMPED_METADATA,
  UNSTAMPED_METADATA,
} from "./__fixtures__/orchestrated-terminal-messages";

/**
 * Phase 6: the finish hook reads the terminal text through the ONE shared
 * selector (selectReviewTerminalText). Assertions are on the executor's CALL
 * ARGUMENTS only: an orchestrated-prompt thread hands it the lead's tagged
 * message with the tag preference on; a classic thread hands it exactly
 * today's terminal text.
 */

const threadRow: { value: Record<string, unknown> | null } = { value: null };
const chatMessages: { value: unknown[] } = { value: [] };

vi.mock("@/lib/db", () => ({ db: {} }));
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
  getPrHeadState: vi.fn(async () => ({
    headSha: "head-sha",
    isDraft: false,
  })),
}));
vi.mock("@terragon/shared/model/threads", () => ({
  getThreadMinimal: vi.fn(async () => threadRow.value),
  getThreadChat: vi.fn(async () => ({ messages: chatMessages.value })),
}));
vi.mock("@terragon/shared/model/automations", () => ({
  getAutomation: vi.fn(async () => ({ triggerType: "pull_request" })),
}));
vi.mock("@terragon/shared/model/repo-skills", () => ({
  promoteLastKnownGood: vi.fn(async () => {}),
}));
vi.mock("./resolve-approve-floor", () => ({
  resolveApproveFloor: vi.fn(async () => undefined),
}));
vi.mock("@/server-lib/reconcile-pr-reviews", () => ({
  reconcilePrReviews: vi.fn(async () => {}),
}));
vi.mock("@/server-lib/tracker/merge-audit-finish", () => ({
  runMergeAuditAtFinish: vi.fn(async () => ({ outcome: "posted" })),
}));
vi.mock("./execute-review-from-intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execute-review-from-intent")>()),
  executeReviewFromIntent: vi.fn(async () => ({
    outcome: "posted",
    verdict: "REQUEST_CHANGES",
  })),
}));

// The global test setup imports route handlers that already loaded the finish
// module (and the REAL threads model) before this file's mocks were
// registered; reset the registry so the imports below see the mocks.
vi.resetModules();
const { executeReviewFromIntent } = await import(
  "./execute-review-from-intent"
);
const { handleReviewEffectAtFinish } = await import(
  "./review-single-writer-finish"
);
const { getPrHeadState } = await import("./octokit-review-client");

function thread(sourceMetadata: unknown) {
  return {
    automationId: "auto_1",
    organizationId: "org_1",
    sourceMetadata,
    reviewedSha: FIXTURE_HEAD_SHA,
    terminalCause: null,
  };
}

async function runHook() {
  await handleReviewEffectAtFinish({
    db: {} as never,
    userId: "user_1",
    threadId: "thread_1",
    threadChatId: "chat_1",
    repoFullName: "o/r",
    prNumber: 7,
  });
}

describe("handleReviewEffectAtFinish — terminal-text selection (phase 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("orchestrated-prompt thread → the lead's tagged message, tag preferred", async () => {
    threadRow.value = thread(STAMPED_METADATA);
    chatMessages.value = F1;
    await runHook();
    expect(executeReviewFromIntent).toHaveBeenCalledTimes(1);
    const args = vi.mocked(executeReviewFromIntent).mock.calls[0]![0];
    expect(args.preferTaggedIntent).toBe(true);
    expect(args.terminalText).toContain("```json review-intent");
    expect(args.terminalText).not.toContain("nothing to add");
  });

  it("classic thread → exactly today's terminal text, no tag preference", async () => {
    threadRow.value = thread(UNSTAMPED_METADATA);
    chatMessages.value = F2;
    await runHook();
    expect(executeReviewFromIntent).toHaveBeenCalledTimes(1);
    const args = vi.mocked(executeReviewFromIntent).mock.calls[0]![0];
    expect(args.preferTaggedIntent).toBeFalsy();
    expect(args.terminalText).toBe(LEAD_RESUMED_TEXT);
  });
});

describe("handleReviewEffectAtFinish — a PR the bot opened itself", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadRow.value = thread(UNSTAMPED_METADATA);
    chatMessages.value = F2;
  });

  it("tells the writer the bot opened the PR (self-heal fix PR)", async () => {
    vi.mocked(getPrHeadState).mockResolvedValueOnce({
      headSha: "head-sha",
      isDraft: false,
      authorLogin: "automata-ai-bot[bot]",
    });
    await runHook();
    const args = vi.mocked(executeReviewFromIntent).mock.calls[0]![0];
    expect(args.prAuthoredByBot).toBe(true);
    expect(args.botLogin).toBe("automata-ai-bot[bot]");
  });

  it("a PR a person opened stays a formal-verdict PR", async () => {
    vi.mocked(getPrHeadState).mockResolvedValueOnce({
      headSha: "head-sha",
      isDraft: false,
      authorLogin: "octocat",
    });
    await runHook();
    const args = vi.mocked(executeReviewFromIntent).mock.calls[0]![0];
    expect(args.prAuthoredByBot).toBe(false);
  });
});
