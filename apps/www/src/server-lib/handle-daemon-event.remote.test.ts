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
import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";

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

describe("handleDaemonEvent — #153 read-tear closed: the fence decides from ONE row", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    await mockWaitUntil();
  });

  async function chatModeThread() {
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { sandboxProvider: "hatchet-remote" },
      chatOverrides: { status: "working" },
      enableThreadChatCreation: true,
    });
    expect(t.threadChatId).not.toBe(LEGACY_THREAD_CHAT_ID);
    return t;
  }

  it("REGRESSION (the tear itself): a terminal chat row refuses even when the thread row's cause reads as the pre-commit NULL", async () => {
    // The exact combination a straddling reader used to assemble: the chat
    // read lands AFTER the terminal commit, the thread read landed BEFORE it.
    // Old fence: terminalCause came from the thread read — present-but-null
    // short-circuits to "not terminal" and the event was ADMITTED. New fence:
    // every input comes from the chat read, which carries the typed cause.
    const { threadId, threadChatId } = await chatModeThread();
    await markThreadsSuperseded({ db, threadIds: [threadId] });
    // Reconstruct the stale thread-row snapshot the tear depended on.
    await db
      .update(schema.thread)
      .set({ terminalCause: null })
      .where(eq(schema.thread.id, threadId));

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

  it("REGRESSION: the stale-generation arm reads the chat row's stamp, not the thread row's", async () => {
    // Old fence: activeRunExternalId came from the thread read — a pre-stamp
    // snapshot (NULL) failed OPEN and let a stale writer through. The chat row
    // now carries the stamp (setThreadActiveRun writes both in one
    // transaction), so the stale writer is refused from the single chat read.
    const { threadId, threadChatId } = await chatModeThread();
    await setThreadActiveRun({ db, threadId, externalId: "run-new" });
    await db
      .update(schema.thread)
      .set({ activeRunExternalId: null })
      .where(eq(schema.thread.id, threadId));

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
  });

  it("legacy thread: the single thread-row read still carries all four fence inputs", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { sandboxProvider: "hatchet-remote" },
      chatOverrides: { status: "working" },
    });
    expect(threadChatId).toBe(LEGACY_THREAD_CHAT_ID);
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
});
