import { describe, it, beforeEach, vi, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { User } from "@terragon/shared";
import { buildRemoteDaemonMessage } from "./remote-daemon-message";

describe("buildRemoteDaemonMessage", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
  });

  it("returns null when the threadChat has no pending user message", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });
    const message = await buildRemoteDaemonMessage({
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(message).toBeNull();
  });

  it("returns null for an unknown thread", async () => {
    const message = await buildRemoteDaemonMessage({
      userId: user.id,
      threadId: "does-not-exist",
      threadChatId: "nope",
    });
    expect(message).toBeNull();
  });
});
