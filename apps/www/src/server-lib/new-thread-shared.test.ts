import { describe, it, vi, beforeEach, expect } from "vitest";
import { createNewThread } from "./new-thread-shared";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User, DBUserMessage } from "@terragon/shared";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";
import { getThread } from "@terragon/shared/model/threads";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";

vi.mock("@/agent/msg/startAgentMessage", () => ({
  startAgentMessage: vi.fn(() => Promise.resolve()),
}));

const repoFullName = "terragon/test-repo";
const mockMessage: DBUserMessage = {
  type: "user",
  parts: [{ type: "text", text: "Test task message" }],
  model: "sonnet",
};

describe("createNewThread", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    const testUserResult = await createTestUser({ db });
    user = testUserResult.user;
  });

  describe("branch handling", () => {
    it("should create thread with baseBranchName when provided", async () => {
      await mockWaitUntil();
      const { threadId } = await createNewThread({
        userId: user.id,
        message: mockMessage,
        githubRepoFullName: repoFullName,
        baseBranchName: "develop",
        headBranchName: null,
        sourceType: "www",
      });
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.repoBaseBranchName).toBe("develop");
      expect(thread!.branchName).toBeNull();
    });

    it("should create thread with headBranchName when provided", async () => {
      await mockWaitUntil();
      const { threadId } = await createNewThread({
        userId: user.id,
        message: mockMessage,
        githubRepoFullName: repoFullName,
        baseBranchName: "main",
        headBranchName: "feature/test-branch",
        sourceType: "www",
      });
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.repoBaseBranchName).toBe("main");
      expect(thread!.branchName).toBe("feature/test-branch");
    });
  });

  describe("shadow mode (Somnio pilot)", () => {
    it("shadow: creates the thread row but does NOT boot the agent", async () => {
      await mockWaitUntil();
      const { threadId } = await createNewThread({
        userId: user.id,
        message: mockMessage,
        githubRepoFullName: repoFullName,
        baseBranchName: "main",
        headBranchName: null,
        sourceType: "www",
        shadow: true,
      });
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.shadow).toBe(true);
      expect(startAgentMessage).not.toHaveBeenCalled();
    });

    it("active (default): creates the thread row AND boots the agent", async () => {
      await mockWaitUntil();
      const { threadId } = await createNewThread({
        userId: user.id,
        message: mockMessage,
        githubRepoFullName: repoFullName,
        baseBranchName: "main",
        headBranchName: null,
        sourceType: "www",
      });
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.shadow).toBe(false);
      expect(startAgentMessage).toHaveBeenCalledTimes(1);
    });
  });
});
