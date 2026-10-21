import { describe, it, beforeEach, vi, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import type { User } from "@terragon/shared";
import type { ClaudeMessage } from "@terragon/daemon/shared";
import { getThreadChat } from "@terragon/shared/model/threads";
import { handleDaemonEvent } from "./handle-daemon-event";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";
import { parseProviderUnavailableInfo } from "@/agent/msg/classify-provider-result";
import { checkpointThread } from "@/server-lib/checkpoint-thread";

vi.mock("@/server-lib/checkpoint-thread", () => ({
  checkpointThread: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server-lib/task/remote-task-pr", () => ({
  openRemoteTaskPullRequest: vi
    .fn()
    .mockResolvedValue({ status: "skipped", reason: "no_branch" }),
}));
vi.mock("@/server-lib/audit/audit-finish", () => ({
  handleAuditFindingsAtFinish: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./review/review-single-writer-finish", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  handleReviewEffectAtFinish: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@terragon/sandbox", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    extendSandboxLife: vi.fn().mockResolvedValue(undefined),
  };
});

const SESSION = "session-synthetic-provider";

function result(
  text: string,
  overrides: Partial<{
    is_error: boolean;
    num_turns: number;
    total_cost_usd: number;
  }> = {},
): ClaudeMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: 300,
    duration_api_ms: 0,
    result: text,
    session_id: SESSION,
    ...overrides,
  };
}

/**
 * Terminal here means the generic-error path's own transition: the chat
 * leaves `working` for `working-error` and the finish path (checkpoint,
 * mocked here; its remote-plane branch completes the thread) runs once.
 *
 * #441: a worker-plane run the provider refused ends TERMINAL with
 * `provider-unavailable` and its classification, never in the legacy
 * `queued-agent-rate-limit` state (which keeps a worker-plane run "working"
 * until its timeout), and a run that only TALKS about limits is untouched.
 */
describe("handleDaemonEvent — provider-unavailable (#441)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    await mockWaitUntil();
  });

  async function finish(messages: ClaudeMessage[]) {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { sandboxProvider: "hatchet-remote" },
      chatOverrides: { status: "working" },
    });
    const response = await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      contextUsage: null,
      messages,
    });
    await waitUntilResolved();
    const chat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    return { response, chat: chat! };
  }

  // Card: protects=a classified result is stored as provider-unavailable with
  // its JSON classification and the chat is terminal; fails_when=it stays
  // agent-generic-error, the info is not the classification, or the chat
  // keeps working; no_claim=the PR notice (notice suites).
  it("a refused run ends terminal as provider-unavailable with the classification", async () => {
    const { response, chat } = await finish([
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "seven_day",
          resetsAt: 1761152400,
        },
        session_id: SESSION,
      },
      result("You've hit your weekly limit · resets 5pm (UTC)"),
    ]);
    expect(response.success).toBe(true);
    expect(chat.status).toBe("working-error");
    expect(checkpointThread).toHaveBeenCalledTimes(1);
    expect(chat.errorMessage).toBe("provider-unavailable");
    expect(parseProviderUnavailableInfo(chat.errorMessageInfo)).toEqual({
      kind: "usage_limit",
      window: "weekly",
      resetsAt: 1761152400 * 1000,
    });
    // The structured event is kept on the thread as a meta row.
    expect(chat.messages).toContainEqual(
      expect.objectContaining({
        type: "meta",
        subtype: "rate-limit",
        status: "rejected",
      }),
    );
  });

  // Card: protects=decision 4 / AC7, a worker-plane run whose banner the
  // legacy parser ALSO knows is never routed to queued-agent-rate-limit;
  // fails_when=status becomes queued-agent-rate-limit (the run would hang
  // until its timeout); no_claim=the legacy sandbox plane (e2e.test.ts keeps
  // that route).
  it("a legacy banner on a worker-plane run stays terminal, never queued-agent-rate-limit", async () => {
    const { chat } = await finish([
      result("Weekly limit reached ∙ resets 6pm (UTC)"),
    ]);
    expect(chat.status).not.toBe("queued-agent-rate-limit");
    expect(chat.status).toBe("working-error");
    expect(checkpointThread).toHaveBeenCalledTimes(1);
    expect(chat.errorMessage).toBe("provider-unavailable");
    expect(parseProviderUnavailableInfo(chat.errorMessageInfo)).toMatchObject({
      kind: "usage_limit",
      window: "weekly",
    });
  });

  // Card: protects=decision 3, prose that mentions a limit changes nothing;
  // fails_when=an ordinary failed run is labelled provider-unavailable;
  // no_claim=other generic-error causes.
  it("a run that only mentions a limit in prose keeps today's generic error", async () => {
    const { chat } = await finish([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: "You've hit your weekly limit · resets 5pm (UTC)",
        },
        parent_tool_use_id: null,
        session_id: SESSION,
      },
      result("API Error: 500 upstream", {
        num_turns: 3,
        total_cost_usd: 0.12,
      }),
    ]);
    expect(chat.status).toBe("working-error");
    expect(checkpointThread).toHaveBeenCalledTimes(1);
    expect(chat.errorMessage).toBe("agent-generic-error");
    expect(chat.errorMessageInfo).not.toContain("usage_limit");
  });

  // Card: protects=AC7 holds even where the classifier declines: a
  // worker-plane run whose banner only the legacy parser reads (here a
  // multi-turn, billed run, which the text path refuses to classify) ends
  // terminal, never in queued-agent-rate-limit; fails_when=the legacy
  // `system.agent-rate-limit` route parks a thread that has no control-plane
  // sandbox; no_claim=the sandbox plane, which keeps the route (e2e.test.ts
  // "handles batch with init and rate limit error").
  it("a worker-plane run the classifier declines still never enters queued-agent-rate-limit", async () => {
    const { chat } = await finish([
      result("Weekly limit reached ∙ resets 6pm (UTC)", {
        num_turns: 7,
        total_cost_usd: 0.9,
      }),
    ]);
    expect(chat.status).not.toBe("queued-agent-rate-limit");
    expect(chat.status).toBe("working-error");
    expect(chat.errorMessage).toBe("agent-generic-error");
    expect(chat.reattemptQueueAt ?? null).toBeNull();
  });
});

