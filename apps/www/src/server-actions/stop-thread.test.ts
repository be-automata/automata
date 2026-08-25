import { describe, it, vi, beforeEach, expect } from "vitest";
import { stopThread as stopThreadAction } from "./stop-thread";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
  createTestOrg,
  createTestRemoteRun,
} from "@terragon/shared/model/test-helpers";
import { cancelAgentRun } from "@/agent/hatchet/transport";
import {
  mockLoggedInUser,
  mockLoggedOutUser,
  mockWaitUntil,
  waitUntilResolved,
} from "@/test-helpers/mock-next";
import { User, Session } from "@terragon/shared";
import { getThreadChat } from "@terragon/shared/model/threads";
import { unwrapResult } from "@/lib/server-actions";

const stopThread = async ({
  threadId,
  threadChatId,
}: {
  threadId: string;
  threadChatId: string;
}) => {
  return unwrapResult(await stopThreadAction({ threadId, threadChatId }));
};

// #125: a Stop on a remote-plane thread must cancel the engine run too.
vi.mock("@/agent/hatchet/transport", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cancelAgentRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/agent/hatchet/dispatch", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hatchetConfig: vi.fn(() => ({
    apiUrl: "http://hatchet.test",
    tenantId: "t",
    apiToken: "x",
  })),
}));

describe("stopThread", () => {
  let user: User;
  let session: Session;
  let threadId: string;
  let threadChatId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const testUserResult = await createTestUser({ db });
    user = testUserResult.user;
    session = testUserResult.session;
    const createTestThreadResult = await createTestThread({
      db,
      userId: testUserResult.user.id,
      chatOverrides: {
        status: "working",
      },
    });
    threadId = createTestThreadResult.threadId;
    threadChatId = createTestThreadResult.threadChatId;
  });

  it("should successfully stop a thread", async () => {
    await mockWaitUntil();
    await mockLoggedInUser(session);
    await stopThread({ threadId, threadChatId });
    await waitUntilResolved();

    const updatedThreadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(updatedThreadChat).toBeDefined();
    expect(updatedThreadChat!.status).toBe("stopping");
  });

  it("a remote-plane thread's Stop cancels its in-flight engine run (the worker must not wait for the step timeout)", async () => {
    await mockWaitUntil();
    await mockLoggedInUser(session);
    const orgId = await createTestOrg({ db });
    const remote = await createTestRemoteRun({
      db,
      userId: user.id,
      organizationId: orgId,
      prNumber: 7,
      externalId: "wfrun-stop-me",
    });
    await stopThread({
      threadId: remote.threadId,
      threadChatId: remote.threadChatId,
    });
    await waitUntilResolved();
    expect(cancelAgentRun).toHaveBeenCalledWith(
      ["wfrun-stop-me"],
      expect.objectContaining({ apiUrl: "http://hatchet.test" }),
    );
  });

  it("a local-sandbox thread's Stop never touches the engine", async () => {
    await mockWaitUntil();
    await mockLoggedInUser(session);
    await stopThread({ threadId, threadChatId });
    await waitUntilResolved();
    expect(cancelAgentRun).not.toHaveBeenCalled();
  });

  it("should throw error when user is not authenticated", async () => {
    await mockWaitUntil();
    await mockLoggedOutUser();
    await expect(stopThread({ threadId, threadChatId })).rejects.toThrow(
      "Unauthorized",
    );
    await waitUntilResolved();
  });

  it("should not change status if thread is already complete", async () => {
    await mockWaitUntil();
    await mockLoggedInUser(session);
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      chatOverrides: {
        status: "complete",
      },
    });
    await stopThread({ threadId, threadChatId });
    await waitUntilResolved();
    const updatedThreadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(updatedThreadChat!.status).toBe("complete");
  });

  it("should handle thread owned by another user", async () => {
    await mockWaitUntil();
    await mockLoggedInUser(session);

    // Create another user and thread
    const otherUser = await createTestUser({ db });
    const { threadId: otherUserThreadId, threadChatId: otherUserThreadChatId } =
      await createTestThread({
        db,
        userId: otherUser.user.id,
        chatOverrides: {
          status: "working",
        },
      });

    await expect(async () => {
      await stopThread({
        threadId: otherUserThreadId,
        threadChatId: otherUserThreadChatId,
      });
      await waitUntilResolved();
    }).rejects.toThrow("Thread chat not found");
    const ownerThreadChat = await getThreadChat({
      db,
      userId: otherUser.user.id,
      threadId: otherUserThreadId,
      threadChatId: otherUserThreadChatId,
    });
    expect(ownerThreadChat!.status).toBe("working");
  });

  it("should handle non-existent thread", async () => {
    await mockWaitUntil();
    await mockLoggedInUser(session);
    await expect(async () => {
      await stopThread({ threadId: "non-existent-thread-id", threadChatId });
      await waitUntilResolved();
    }).rejects.toThrow("Thread chat not found");
  });
});
