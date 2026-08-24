import { describe, it, beforeEach, vi, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { User, Session } from "@terragon/shared";
import {
  getThread,
  getThreadChat,
  markThreadsSuperseded,
  setThreadActiveRun,
} from "@terragon/shared/model/threads";
import { handleDaemonEvent } from "./handle-daemon-event";
import { checkpointThread } from "@/server-lib/checkpoint-thread";
import { extendSandboxLife } from "@terragon/sandbox";
import { getClaudeResultMessage } from "@/test-helpers/agent";
import {
  mockLoggedInUser,
  mockWaitUntil,
  waitUntilResolved,
} from "@/test-helpers/mock-next";
import { openPullRequest } from "@/server-actions/pull-request";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";

vi.mock("@/server-lib/checkpoint-thread", () => ({
  checkpointThread: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@terragon/sandbox", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    extendSandboxLife: vi.fn().mockResolvedValue(undefined),
  };
});

// ADR-003 remote-plane threads (sandboxProvider "hatchet-remote") never get a
// control-plane sandbox: codesandboxId stays NULL. The daemon "done" event must
// not run the local checkpoint (it can only fail with "sandbox-not-found") nor
// touch sandbox lifetime APIs.
describe("handleDaemonEvent for sandbox-less remote threads", () => {
  let user: User;
  let session: Session;

  beforeEach(async () => {
    vi.clearAllMocks();
    const testUserResult = await createTestUser({ db });
    user = testUserResult.user;
    session = testUserResult.session;
    await mockWaitUntil();
  });

  const finishThread = async ({
    threadId,
    threadChatId,
  }: {
    threadId: string;
    threadChatId: string;
  }) => {
    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      contextUsage: null,
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();
  };

  it("completes a remote thread without checkpointing or stamping sandbox-not-found", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { sandboxProvider: "hatchet-remote" },
      chatOverrides: { status: "working" },
    });

    await finishThread({ threadId, threadChatId });

    const thread = await getThread({ db, userId: user.id, threadId });
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(thread!.codesandboxId).toBeNull();
    expect(threadChat!.status).toBe("complete");
    expect(threadChat!.errorMessage).toBeNull();
    expect(checkpointThread).not.toHaveBeenCalled();
    expect(extendSandboxLife).not.toHaveBeenCalled();
  });

  it("still checkpoints local-sandbox threads", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sandboxProvider: "mock",
        codesandboxId: "mock-sandbox-id",
      },
      chatOverrides: { status: "working" },
    });

    await finishThread({ threadId, threadChatId });

    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    // With checkpointing due, the chat parks at working-done until
    // checkpointThread (mocked here) performs the final complete transition.
    expect(threadChat!.status).toBe("working-done");
    expect(threadChat!.errorMessage).toBeNull();
    expect(checkpointThread).toHaveBeenCalledTimes(1);
    expect(extendSandboxLife).toHaveBeenCalledWith({
      sandboxId: "mock-sandbox-id",
      sandboxProvider: "mock",
    });
  });

  it("openPullRequest degrades cleanly for sandbox-less threads", async () => {
    await mockLoggedInUser(session);

    // No PR yet: user-facing guidance, not "sandbox-not-found".
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { sandboxProvider: "hatchet-remote" },
    });
    const result = await openPullRequest({ threadId });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/remote infrastructure/);

    // PR already open: no-op success.
    const withPR = await createTestThread({
      db,
      userId: user.id,
      overrides: { sandboxProvider: "hatchet-remote", githubPRNumber: 7 },
    });
    const okResult = await openPullRequest({ threadId: withPR.threadId });
    expect(okResult.success).toBe(true);
  });
});

describe("handleDaemonEvent — #125 C1 generation fence (no extra read)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    await mockWaitUntil();
  });

  async function remoteThread() {
    return createTestThread({
      db,
      userId: user.id,
      overrides: { sandboxProvider: "hatchet-remote" },
      chatOverrides: { status: "working" },
    });
  }

  it("409 once the thread is terminal-superseded — a stale verdict never lands", async () => {
    const { threadId, threadChatId } = await remoteThread();
    await markThreadsSuperseded({ db, threadIds: [threadId] });
    const r = await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "UTC",
      contextUsage: null,
      messages: [getClaudeResultMessage()],
      runExternalId: null,
    });
    expect(r).toMatchObject({ success: false, status: 409 });
  });

  it("409 for a NON-legacy threadChat row too — the terminal is stamped on the EFFECTIVE (chat) row and the fence reads it back", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { sandboxProvider: "hatchet-remote" },
      chatOverrides: { status: "working" },
      enableThreadChatCreation: true,
    });
    expect(threadChatId).not.toBe(LEGACY_THREAD_CHAT_ID);
    expect(await markThreadsSuperseded({ db, threadIds: [threadId] })).toBe(1);
    // The live chat row carries the terminal…
    const chat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(chat).toMatchObject({
      status: "complete",
      errorMessage: "superseded",
    });
    // …and the fence closes on it.
    const r = await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "UTC",
      contextUsage: null,
      messages: [getClaudeResultMessage()],
      runExternalId: null,
    });
    expect(r).toMatchObject({ success: false, status: 409 });
  });

  it("409 when the writer names an older generation; the active one lands", async () => {
    const { threadId, threadChatId } = await remoteThread();
    await setThreadActiveRun({ db, threadId, externalId: "run-new" });
    const stale = await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "UTC",
      contextUsage: null,
      messages: [getClaudeResultMessage()],
      runExternalId: "run-old",
    });
    expect(stale).toMatchObject({ success: false, status: 409 });
    const live = await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "UTC",
      contextUsage: null,
      messages: [getClaudeResultMessage()],
      runExternalId: "run-new",
    });
    expect(live.success).toBe(true);
    await waitUntilResolved();
  });
});
