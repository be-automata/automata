import { describe, it, expect, vi, beforeEach } from "vitest";
import { unwrapResult } from "@/lib/server-actions";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import {
  getThread,
  getThreadChat,
  getThreads,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import {
  newThread as newThreadAction,
  NewThreadArgs,
} from "@/server-actions/new-thread";
import {
  followUp as followUpAction,
  FollowUpArgs,
  queueFollowUp as queueFollowUpAction,
  QueueFollowUpArgs,
} from "@/server-actions/follow-up";
import {
  mockLoggedInUser,
  mockWaitUntil,
  waitUntilResolved,
} from "@/test-helpers/mock-next";
import { sendDaemonMessage } from "@/agent/daemon";
import {
  getClaudeResultMessage,
  getClaudeRateLimitMessage,
  saveClaudeTokensForTest,
} from "@/test-helpers/agent";
import { handleDaemonEvent } from "./handle-daemon-event";
import { internalPOST } from "./internal-request";
import { maybeStartQueuedThreadChat } from "./process-queued-thread";
import { maxConcurrentTasksPerUser } from "@/lib/subscription-tiers";
import { stopThread } from "@/server-actions/stop-thread";
import { retryThread as retryThreadAction } from "@/server-actions/retry-thread";
import { retryGitCheckpoint } from "@/server-actions/retry-git-checkpoint";
import {
  runScheduledThread as runScheduledThreadAction,
  cancelScheduledThread as cancelScheduledThreadAction,
} from "@/server-actions/scheduled-thread";
import { gitCommitAndPushBranch } from "@terragon/sandbox/commands";

const newThread = async (args: NewThreadArgs) => {
  return unwrapResult(await newThreadAction(args));
};

const runScheduledThread = async ({
  threadId,
  threadChatId,
}: {
  threadId: string;
  threadChatId: string;
}) => {
  return unwrapResult(
    await runScheduledThreadAction({ threadId, threadChatId }),
  );
};

const cancelScheduledThread = async ({
  threadId,
  threadChatId,
}: {
  threadId: string;
  threadChatId: string;
}) => {
  return unwrapResult(
    await cancelScheduledThreadAction({ threadId, threadChatId }),
  );
};

const retryThread = async ({
  threadId,
  threadChatId,
}: {
  threadId: string;
  threadChatId: string;
}) => {
  return unwrapResult(await retryThreadAction({ threadId, threadChatId }));
};

const followUp = async ({ threadId, threadChatId, message }: FollowUpArgs) => {
  return unwrapResult(
    await followUpAction({ threadId, threadChatId, message }),
  );
};

const queueFollowUp = async ({
  threadId,
  threadChatId,
  messages,
}: QueueFollowUpArgs) => {
  return unwrapResult(
    await queueFollowUpAction({ threadId, threadChatId, messages }),
  );
};

describe("end-to-end", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Ensure all threads are complete so we don't mess other tests.
    await db.update(schema.thread).set({
      status: "complete",
      reattemptQueueAt: null,
    });
    await db.update(schema.threadChat).set({
      status: "complete",
      reattemptQueueAt: null,
    });
  });

  it("new thread -> done -> follow up ", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    const thread = await getThread({ db, userId: user.id, threadId });
    expect(thread).toBeDefined();
    expect(thread!.name).toBe("test-thread-name");
    expect(thread!.repoBaseBranchName).toBe("main");
    expect(thread!.githubRepoFullName).toBe("terragon/test-repo");
    expect(thread!.gitDiff).toBeNull();

    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat).toBeDefined();
    expect(threadChat!.status).toBe("booting");
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId: thread!.id,
      threadChatId: threadChat!.id,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: "Hello, world!",
        sessionId: threadChat!.sessionId,
        type: "claude",
        permissionMode: threadChat!.permissionMode,
        agent: threadChat!.agent,
        agentVersion: threadChat!.agentVersion,
      },
    });

    await handleDaemonEvent({
      threadId: thread!.id,
      threadChatId: threadChat!.id,
      userId: user.id,
      timezone: "America/New_York",
      contextUsage: null,
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, world!" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
      ],
    });
    await waitUntilResolved();
    let threadUpdated = await getThread({ db, userId: user.id, threadId });
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");

    await handleDaemonEvent({
      threadId: thread!.id,
      threadChatId: threadChat!.id,
      userId: user.id,
      timezone: "America/New_York",
      contextUsage: null,
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.errorMessage).toBeNull();
    expect(threadUpdated!.gitDiff).toMatchInlineSnapshot(`
      "
      diff --git a/test.txt b/test.txt
      index 1234567..89abcdef 100644
      --- a/test.txt
      +++ b/test.txt
      @@ -1 +1 @@
      -Hello, world!
      +Hello, world!
      "
    `);

    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, again" }],
      },
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: threadUpdated!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: "Hello, again",
        sessionId: threadChatUpdated!.sessionId,
        type: "claude",
        permissionMode: threadChatUpdated!.permissionMode,
        agent: threadChatUpdated!.agent,
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });

    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, again" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-2",
        },
      ],
      contextUsage: null,
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");

    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      contextUsage: null,
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.errorMessage).toBeNull();
  });

  it("new thread -> queue-concurrency-limit -> queued", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    // Create maxConcurrentTasksPerUser threads
    const activeThreadsChatIds: { threadId: string; threadChatId: string }[] =
      [];
    for (let i = 0; i < maxConcurrentTasksPerUser; i++) {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          codesandboxId: "mock-sandbox-id",
          sandboxProvider: "mock",
        },
        chatOverrides: {
          status: "working",
        },
      });
      activeThreadsChatIds.push({ threadId, threadChatId });
    }

    await mockWaitUntil();
    await mockLoggedInUser(session);

    const { threadId, threadChatId } = await newThread({
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
      message: {
        type: "user",
        model: "sonnet",
        parts: [
          {
            type: "text",
            text: "Hello! This thread should be queued because of the concurrency limit.",
          },
        ],
      },
    });
    await waitUntilResolved();
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("queued-tasks-concurrency");

    // Update the first active thread to be done.
    await handleDaemonEvent({
      threadId: activeThreadsChatIds[0]!.threadId,
      threadChatId: activeThreadsChatIds[0]!.threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      contextUsage: null,
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();
    // The concurrency-queued thread is promoted IN-PROCESS on finish (no more
    // internalPOST self-fetch) — proven end-to-end by the booting status +
    // sendDaemonMessage below.

    const threadUpdated = await getThread({ db, userId: user.id, threadId });
    const threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: threadUpdated!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt:
          "Hello! This thread should be queued because of the concurrency limit.",
        sessionId: threadChatUpdated!.sessionId,
        type: "claude",
        permissionMode: threadChatUpdated!.permissionMode,
        agent: threadChatUpdated!.agent,
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });
  });

  it("new thread -> stop -> follow up ", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    const thread = await getThread({ db, userId: user.id, threadId });
    expect(thread).toBeDefined();
    expect(thread!.name).toBe("test-thread-name");
    expect(thread!.repoBaseBranchName).toBe("main");
    expect(thread!.githubRepoFullName).toBe("terragon/test-repo");
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");

    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: "Hello, world!",
        sessionId: threadChat!.sessionId,
        type: "claude",
        permissionMode: threadChat!.permissionMode,
        agent: threadChat!.agent,
        agentVersion: threadChat!.agentVersion,
      },
    });

    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, world!" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
      ],
      contextUsage: null,
    });
    await waitUntilResolved();
    let threadUpdated = await getThread({ db, userId: user.id, threadId });
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");

    await stopThread({ threadId, threadChatId });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("stopping");
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: { type: "stop" },
    });

    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [{ type: "custom-stop", session_id: null, duration_ms: 1000 }],
      contextUsage: null,
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.errorMessage).toBeNull();

    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, again" }],
      },
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: threadUpdated!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: "Hello, again",
        sessionId: threadChatUpdated!.sessionId,
        type: "claude",
        permissionMode: threadChatUpdated!.permissionMode,
        agent: threadChatUpdated!.agent,
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });
  });

  it("new thread -> agent rate limit -> queued", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });

    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    const thread = await getThread({ db, userId: user.id, threadId });
    expect(thread).toBeDefined();
    expect(thread!.name).toBe("test-thread-name");

    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: "Hello, world!",
        sessionId: threadChat!.sessionId,
        type: "claude",
        permissionMode: threadChat!.permissionMode,
        agent: threadChat!.agent,
        agentVersion: threadChat!.agentVersion,
      },
    });

    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, world!" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
      ],
      contextUsage: null,
    });
    await waitUntilResolved();
    let threadUpdated = await getThread({ db, userId: user.id, threadId });
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");

    const oneHourFromNow = Date.now() + 1000 * 60 * 60;
    const resetTime = Math.floor(oneHourFromNow / 1000) * 1000;
    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        getClaudeRateLimitMessage(resetTime / 1000),
        { type: "custom-error", session_id: null, duration_ms: 1000 },
      ],
      contextUsage: null,
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("queued-agent-rate-limit");
    expect(threadChatUpdated!.reattemptQueueAt).toEqual(new Date(resetTime));
    expect(threadUpdated!.gitDiff).toMatchInlineSnapshot(`
      "
      diff --git a/test.txt b/test.txt
      index 1234567..89abcdef 100644
      --- a/test.txt
      +++ b/test.txt
      @@ -1 +1 @@
      -Hello, world!
      +Hello, world!
      "
    `);

    await updateThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
      updates: {
        // Update the reattemptQueueAt to be in the past so the thread is eligible
        reattemptQueueAt: new Date(Date.now() - 60 * 1000),
      },
    });

    // Process the queued thread.
    await maybeStartQueuedThreadChat({ userId: user.id });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(threadChatUpdated!.reattemptQueueAt).toBeNull();
  });

  it("new thread -> error -> retry ", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    const thread = await getThread({ db, userId: user.id, threadId });
    expect(thread).toBeDefined();
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");
    expect(thread!.name).toBe("test-thread-name");
    expect(thread!.repoBaseBranchName).toBe("main");
    expect(thread!.githubRepoFullName).toBe("terragon/test-repo");
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: "Hello, world!",
        sessionId: null,
        type: "claude",
        permissionMode: "allowAll",
        agent: "claudeCode",
        agentVersion: threadChat!.agentVersion,
      },
    });

    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, world!" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
      ],
      contextUsage: null,
    });
    await waitUntilResolved();
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");

    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [{ type: "custom-error", session_id: null, duration_ms: 1000 }],
      contextUsage: null,
    });
    await waitUntilResolved();
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.errorMessage).toBe("agent-generic-error");

    await retryThread({ threadId, threadChatId });
    await waitUntilResolved();
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(threadChatUpdated!.errorMessage).toBeNull();
  });

  it("new thread -> checkpoint error -> retry git checkpoint", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    const thread = await getThread({ db, userId: user.id, threadId });
    expect(thread).toBeDefined();
    expect(thread!.name).toBe("test-thread-name");
    expect(thread!.repoBaseBranchName).toBe("main");
    expect(thread!.githubRepoFullName).toBe("terragon/test-repo");

    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: "Hello, world!",
        sessionId: null,
        type: "claude",
        permissionMode: "allowAll",
        agent: "claudeCode",
        agentVersion: threadChat!.agentVersion,
      },
    });

    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, world!" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
      ],
      contextUsage: null,
    });
    await waitUntilResolved();
    let threadUpdated = await getThread({ db, userId: user.id, threadId });
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadUpdated!.branchName).toBeNull();
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");

    // Mock agent response complete & checkpoint error
    vi.mocked(gitCommitAndPushBranch).mockResolvedValue({
      errorMessage: "git push rejected",
    });
    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      contextUsage: null,
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });

    // Will retry git checkpoint once
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.errorMessage).toBe(null);
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        sessionId: threadChatUpdated!.sessionId,
        type: "claude",
        model: "sonnet",
        prompt:
          "Failed to commit and push changes with the following error: ThreadError: Thread error: git-checkpoint-push-failed: git push rejected. Can you please try again?",
        permissionMode: threadChatUpdated!.permissionMode,
        agent: threadChatUpdated!.agent,
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });

    // Auto fix completed
    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      contextUsage: null,
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();

    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.errorMessage).toBe("git-checkpoint-push-failed");
    expect(threadChatUpdated!.errorMessageInfo).toBe("git push rejected");
    expect(threadUpdated!.branchName).toBeNull();

    await retryGitCheckpoint({ threadId, threadChatId });
    vi.mocked(gitCommitAndPushBranch).mockResolvedValue({
      branchName: "test-branch",
    });
    await waitUntilResolved();
    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadUpdated!.branchName).toBe("test-branch");
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.errorMessage).toBeNull();
    expect(threadChatUpdated!.errorMessageInfo).toBeNull();
  });

  it("new thread -> queue message -> done -> processed", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    const thread = await getThread({ db, userId: user.id, threadId });
    expect(thread).toBeDefined();
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");

    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello, world!" }],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
      ],
      contextUsage: null,
    });
    await waitUntilResolved();
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");

    await queueFollowUp({
      threadId,
      threadChatId,
      messages: [
        {
          type: "user",
          model: "sonnet",
          parts: [{ type: "text", text: "Hello, again" }],
        },
      ],
    });
    await waitUntilResolved();
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.queuedMessages).toHaveLength(1);
    expect(threadChatUpdated!.queuedMessages).toEqual([
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, again" }],
      },
    ]);
    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [getClaudeResultMessage()],
      contextUsage: null,
    });
    await waitUntilResolved();
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.errorMessage).toBeNull();
    expect(threadChatUpdated!.queuedMessages).toHaveLength(0);
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: "Hello, again",
        sessionId: threadChatUpdated!.sessionId,
        type: "claude",
        permissionMode: threadChatUpdated!.permissionMode,
        agent: threadChatUpdated!.agent,
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });
  });

  it("/clear -> done -> processed", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: {
        status: "complete",
        sessionId: "test-session-id-1",
      },
    });
    const thread = await getThread({ db, userId: user.id, threadId });
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    expect(thread).toBeDefined();
    expect(threadChat!.sessionId).toBe("test-session-id-1");
    expect(threadChat!.status).toBe("complete");

    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "/clear" }],
      },
    });
    await waitUntilResolved();
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.sessionId).toBeNull();
    expect(threadChatUpdated!.errorMessage).toBeNull();
    expect(threadChatUpdated!.errorMessageInfo).toBeNull();
    expect(threadChatUpdated!.contextLength).toBeNull();
    const clearMessages = threadChatUpdated!.messages ?? [];
    expect(clearMessages[clearMessages.length - 1]).toEqual({
      type: "system",
      message_type: "clear-context",
      timestamp: expect.any(String),
      parts: [],
    });
    expect(sendDaemonMessage).not.toHaveBeenCalled();
  });

  it("/compact -> done", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: {
        status: "complete",
        sessionId: "test-session-id-1",
        appendMessages: [
          {
            type: "user",
            model: "sonnet",
            parts: [{ type: "text", text: "Hello, world!" }],
          },
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Hello! How can I help you?" }],
          },
        ],
      },
    });
    const thread = await getThread({ db, userId: user.id, threadId });
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });

    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    expect(thread).toBeDefined();
    expect(threadChat!.sessionId).toBe("test-session-id-1");
    expect(threadChat!.status).toBe("complete");

    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "/compact" }],
      },
    });
    await waitUntilResolved();
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.sessionId).toBeNull();
    expect(threadChatUpdated!.errorMessage).toBeNull();
    expect(threadChatUpdated!.errorMessageInfo).toBeNull();
    expect(threadChatUpdated!.contextLength).toBeNull();
    const compactMessages = threadChatUpdated!.messages ?? [];
    expect(compactMessages[compactMessages.length - 1]).toEqual({
      type: "system",
      message_type: "compact-result",
      timestamp: expect.any(String),
      parts: [{ type: "text", text: "test-summary" }],
    });
    expect(sendDaemonMessage).not.toHaveBeenCalled();
  });

  it("/compact -> queue message", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);

    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: {
        status: "complete",
        sessionId: "test-session-id-1",
        appendMessages: [
          {
            type: "user",
            model: "sonnet",
            parts: [{ type: "text", text: "Hello, world!" }],
          },
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Hello! How can I help you?" }],
          },
        ],
      },
    });
    const thread = await getThread({ db, userId: user.id, threadId });
    await waitUntilResolved();
    expect(await getThreads({ db, userId: user.id })).toHaveLength(1);
    expect(thread).toBeDefined();

    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "/compact" }],
      },
    });
    await queueFollowUp({
      threadId,
      threadChatId,
      messages: [
        {
          type: "user",
          model: "sonnet",
          parts: [{ type: "text", text: "Hello, again" }],
        },
      ],
    });
    await waitUntilResolved();
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(threadChatUpdated!.queuedMessages).toHaveLength(0);
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: `The user has run out of context. This is a summary of what has been done: <summary>\ntest-summary\n</summary>\n\nHello, again`,
        sessionId: null,
        type: "claude",
        permissionMode: "allowAll",
        agent: "claudeCode",
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });
  });

  it("new thread with plan mode -> follow up with approval", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Create thread with plan mode
    const { threadId, threadChatId } = await newThread({
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello in plan mode" }],
        permissionMode: "plan",
      },
    });
    await waitUntilResolved();

    let threadUpdated = await getThread({ db, userId: user.id, threadId });
    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(threadChatUpdated!.permissionMode).toBe("plan");

    // Verify daemon receives plan mode
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: threadUpdated!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: "Hello in plan mode",
        sessionId: null,
        type: "claude",
        permissionMode: "plan",
        agent: "claudeCode",
        agentVersion: threadChatUpdated!.agentVersion,
      },
    });

    // Mock agent response and complete
    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      contextUsage: null,
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();

    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("complete");

    // Follow up with approval (switching to allowAll)
    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Proceed" }],
        permissionMode: "allowAll",
      },
    });
    await waitUntilResolved();

    threadUpdated = await getThread({ db, userId: user.id, threadId });
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("booting");
    expect(threadChatUpdated!.permissionMode).toBe("allowAll");

    // Verify daemon receives allowAll mode after approval
    const lastCall = (sendDaemonMessage as any).mock.calls[
      (sendDaemonMessage as any).mock.calls.length - 1
    ][0];
    expect(lastCall.userId).toBe(user.id);
    expect(lastCall.threadId).toBe(threadId);
    expect(lastCall.threadChatId).toBe(threadChatId);
    expect(lastCall.message.type).toBe("claude");
    expect(lastCall.message.permissionMode).toBe("allowAll");
    // The prompt will include context from the previous message
    expect(lastCall.message.prompt).toContain("Proceed");
  });

  it("queueFollowUp preserves permissionMode", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });

    // Create active thread
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: {
        status: "working",
        permissionMode: "plan",
      },
    });
    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Queue follow-up with plan mode
    await queueFollowUp({
      threadId,
      threadChatId,
      messages: [
        {
          type: "user",
          model: "sonnet",
          parts: [{ type: "text", text: "Queued message in plan mode" }],
          permissionMode: "plan",
        },
      ],
    });
    await waitUntilResolved();

    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.queuedMessages).toHaveLength(1);
    expect(threadChatUpdated!.queuedMessages![0]).toMatchObject({
      type: "user",
      parts: [{ type: "text", text: "Queued message in plan mode" }],
      permissionMode: "plan",
    });

    // Complete the thread
    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      contextUsage: null,
      messages: [getClaudeResultMessage()],
    });
    await waitUntilResolved();

    // Process the queue
    await maybeStartQueuedThreadChat({ userId: user.id });
    await waitUntilResolved();

    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.permissionMode).toBe("plan");
    expect(threadChatUpdated!.queuedMessages).toHaveLength(0);

    // Verify daemon receives the queued message with plan mode
    const lastCall = (sendDaemonMessage as any).mock.calls[
      (sendDaemonMessage as any).mock.calls.length - 1
    ][0];
    expect(lastCall.userId).toBe(user.id);
    expect(lastCall.threadId).toBe(threadId);
    expect(lastCall.threadChatId).toBe(threadChatId);
    expect(lastCall.message.type).toBe("claude");
    expect(lastCall.message.prompt).toContain("Queued message in plan mode");
    expect(lastCall.message.permissionMode).toBe("plan");
  });

  it("scheduled thread -> runs when scheduled time arrives", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Schedule a thread for 1 hour from now
    const oneHourFromNow = Date.now() + 60 * 60 * 1000;
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Scheduled task message" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
      scheduleAt: oneHourFromNow,
    });
    await waitUntilResolved();

    // Verify thread is created with scheduled status
    let thread = await getThread({ db, userId: user.id, threadId });
    let threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(thread).toBeDefined();
    expect(threadChat!.status).toBe("scheduled");
    expect(threadChat!.scheduleAt).toEqual(new Date(oneHourFromNow));
    expect(threadChat!.messages).toHaveLength(1);
    expect(threadChat!.messages![0]).toMatchObject({
      type: "user",
      model: "sonnet",
      parts: [{ type: "text", text: "Scheduled task message" }],
    });

    // Daemon should not be called for scheduled threads
    expect(sendDaemonMessage).not.toHaveBeenCalled();

    await updateThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
      updates: {
        // Simulate time passing and run the scheduled thread
        scheduleAt: new Date(Date.now() - 1000),
      },
    });

    // The cron route now runs scheduled threads IN-PROCESS (runScheduledTasksCron →
    // runScheduledThread) with no nested internalPOST self-fetch — the booting status
    // and sendDaemonMessage assertions below prove the scheduled thread ran.
    await internalPOST("cron/scheduled-tasks");
    await waitUntilResolved();
    await waitUntilResolved();

    // Verify thread is now running
    thread = await getThread({ db, userId: user.id, threadId });
    threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");
    expect(threadChat!.scheduleAt).toBeNull();
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: "Scheduled task message",
        sessionId: null,
        type: "claude",
        permissionMode: "allowAll",
        agent: "claudeCode",
        agentVersion: threadChat!.agentVersion,
      },
    });
  });

  it("scheduled thread -> run now", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });

    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Create a scheduled thread
    const futureTime = Date.now() + 3 * 60 * 60 * 1000; // 3 hours from now
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Scheduled but will run now" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
      scheduleAt: futureTime,
    });
    await waitUntilResolved();

    // Verify scheduled state
    let thread = await getThread({ db, userId: user.id, threadId });
    let threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("scheduled");
    expect(threadChat!.scheduleAt).toEqual(new Date(futureTime));

    // Run now
    await runScheduledThread({ threadId, threadChatId });
    await waitUntilResolved();

    // Thread should now be running
    thread = await getThread({ db, userId: user.id, threadId });
    threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");
    expect(threadChat!.scheduleAt).toBeNull();
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: "Scheduled but will run now",
        sessionId: null,
        type: "claude",
        permissionMode: "allowAll",
        agent: "claudeCode",
        agentVersion: threadChat!.agentVersion,
      },
    });
  });

  it("scheduled thread -> cancel schedule -> follow up", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });

    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Create a scheduled thread
    const futureTime = Date.now() + 3 * 60 * 60 * 1000; // 3 hours from now
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Scheduled but will cancel schedule" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
      scheduleAt: futureTime,
    });

    await waitUntilResolved();
    let thread = await getThread({ db, userId: user.id, threadId });
    let threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("scheduled");
    expect(threadChat!.scheduleAt).toEqual(new Date(futureTime));

    // Cancel schedule
    await cancelScheduledThread({ threadId, threadChatId });
    await waitUntilResolved();

    // Thread should now be complete
    thread = await getThread({ db, userId: user.id, threadId });
    threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("complete");
    expect(threadChat!.scheduleAt).toBeNull();
    expect(sendDaemonMessage).not.toHaveBeenCalled();

    // Follow up
    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Follow up" }],
      },
    });
    await waitUntilResolved();
    thread = await getThread({ db, userId: user.id, threadId });
    threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");
    expect(threadChat!.messages).toHaveLength(3);
    expect(threadChat!.messages).toMatchObject([
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Scheduled but will cancel schedule" }],
      },
      {
        type: "system",
        message_type: "cancel-schedule",
        parts: [],
      },
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Follow up" }],
      },
    ]);
    expect(sendDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId: thread!.codesandboxId!,
      session: expect.any(Object),
      message: {
        model: "sonnet",
        prompt: "Scheduled but will cancel schedule\n\n---\n\nFollow up",
        sessionId: null,
        type: "claude",
        permissionMode: "allowAll",
        agent: "claudeCode",
        agentVersion: threadChat!.agentVersion,
      },
    });
  });

  it("scheduled thread -> follow up", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });

    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Create a scheduled thread
    const futureTime = Date.now() + 3 * 60 * 60 * 1000; // 3 hours from now
    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Scheduled but will follow up" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
      scheduleAt: futureTime,
    });
    await waitUntilResolved();
    let threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("scheduled");
    expect(threadChat!.scheduleAt).toEqual(new Date(futureTime));

    // Follow up
    await followUp({
      threadId,
      threadChatId,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Follow up" }],
      },
    });
    await waitUntilResolved();

    threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    // Still scheduled
    expect(threadChat!.status).toBe("scheduled");
    expect(threadChat!.scheduleAt).toEqual(new Date(futureTime));
    expect(threadChat!.messages).toMatchObject([
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Scheduled but will follow up" }],
      },
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Follow up" }],
      },
    ]);
    expect(sendDaemonMessage).not.toHaveBeenCalledWith();
  });

  it("/compact in queued messages", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });
    expect(await getThreads({ db, userId: user.id })).toEqual([]);

    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Create a thread with some history
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        codesandboxId: "mock-sandbox-id",
        sandboxProvider: "mock",
      },
      chatOverrides: {
        status: "working",
        sessionId: "test-session-id-1",
        appendMessages: [
          {
            type: "user",
            model: "sonnet",
            parts: [{ type: "text", text: "Initial request" }],
          },
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Working on your request..." }],
          },
        ],
      },
    });
    let threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    await waitUntilResolved();
    expect(threadChat!.status).toBe("working");
    expect(threadChat!.messages).toHaveLength(2);

    // Queue follow up
    await queueFollowUp({
      threadId,
      threadChatId,
      messages: [
        {
          type: "user",
          model: "sonnet",
          parts: [{ type: "text", text: "/compact" }],
        },
      ],
    });
    await waitUntilResolved();

    let threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("working");
    expect(threadChatUpdated!.queuedMessages).toHaveLength(1);
    expect(threadChatUpdated!.queuedMessages).toEqual([
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "/compact" }],
      },
    ]);

    // Complete the current task
    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "America/New_York",
      messages: [getClaudeResultMessage()],
      contextUsage: null,
    });
    await waitUntilResolved();
    threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });

    expect(threadChatUpdated!.status).toBe("complete");
    expect(threadChatUpdated!.queuedMessages).toHaveLength(0);
    expect(threadChatUpdated!.messages).toHaveLength(5);
    expect(threadChatUpdated!.messages).toMatchObject([
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Initial request" }],
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "Working on your request..." }],
      },
      expect.objectContaining({
        type: "meta",
        subtype: "result-success",
      }),
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "/compact" }],
      },
      {
        type: "system",
        message_type: "compact-result",
        parts: [{ type: "text", text: "test-summary" }],
      },
    ]);
  });

  it("handles batch with init and rate limit error", async () => {
    const testUserAndAccount = await createTestUser({ db });
    const user = testUserAndAccount.user;
    const session = testUserAndAccount.session;
    await saveClaudeTokensForTest({ userId: user.id });

    await mockWaitUntil();
    await mockLoggedInUser(session);

    const { threadId, threadChatId } = await newThread({
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
      githubRepoFullName: "terragon/test-repo",
      branchName: "main",
    });
    await waitUntilResolved();
    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");

    // Simulate batch of messages from daemon with rate limit error
    await handleDaemonEvent({
      threadId,
      threadChatId,
      userId: user.id,
      timezone: "UTC",
      contextUsage: null,
      messages: [
        {
          type: "system",
          subtype: "init",
          session_id: "test-session-id-1",
          tools: [],
          mcp_servers: [],
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Weekly limit reached ∙ resets 6pm",
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "test-session-id-1",
        },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          duration_ms: 581,
          duration_api_ms: 0,
          num_turns: 1,
          result: "Weekly limit reached ∙ resets 6pm",
          session_id: "test-session-id-1",
          total_cost_usd: 0,
        },
      ],
    });
    await waitUntilResolved();

    const threadChatUpdated = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChatUpdated!.status).toBe("queued-agent-rate-limit");
    expect(threadChatUpdated!.sessionId).toBe("test-session-id-1");
    expect(threadChatUpdated!.errorMessage).toBe("agent-generic-error");
  });
});
