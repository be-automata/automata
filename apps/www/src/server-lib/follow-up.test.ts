import { describe, it, vi, beforeEach, expect } from "vitest";
import { queueFollowUpInternal } from "./follow-up";
import { maybeProcessFollowUpQueue } from "./process-follow-up-queue";
import { db } from "@/lib/db";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { User, DBUserMessage } from "@terragon/shared";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";

vi.mock("./process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: vi.fn(() => Promise.resolve()),
}));

const message: DBUserMessage = {
  type: "user",
  parts: [{ type: "text", text: "follow up" }],
  model: "sonnet",
};

describe("queueFollowUpInternal shadow gate (Somnio pilot)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ user } = await createTestUser({ db }));
  });

  it("shadow thread: queues the message but does NOT drain the queue (no boot)", async () => {
    await mockWaitUntil();
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      enableThreadChatCreation: true,
      overrides: { shadow: true },
      chatOverrides: { status: "complete" },
    });

    await queueFollowUpInternal({
      userId: user.id,
      threadId,
      threadChatId,
      messages: [message],
      appendOrReplace: "append",
      source: "github",
    });
    await waitUntilResolved();

    expect(maybeProcessFollowUpQueue).not.toHaveBeenCalled();
  });

  it("active thread: drains the queue (boots) as today", async () => {
    await mockWaitUntil();
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      enableThreadChatCreation: true,
      overrides: { shadow: false },
      chatOverrides: { status: "complete" },
    });

    await queueFollowUpInternal({
      userId: user.id,
      threadId,
      threadChatId,
      messages: [message],
      appendOrReplace: "append",
      source: "github",
    });
    await waitUntilResolved();

    expect(maybeProcessFollowUpQueue).toHaveBeenCalledTimes(1);
  });
});
