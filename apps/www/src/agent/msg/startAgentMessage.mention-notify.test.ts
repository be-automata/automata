import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { User } from "@terragon/shared";
import { getOctokitForApp } from "@/lib/github";
import { getThreadChat } from "@terragon/shared/model/threads";
import { withThreadChat } from "@/agent/thread-resource";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { startAgentMessage } from "./startAgentMessage";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";

/**
 * #163 integration: the wiring in startAgentMessage.ts (`onError` passed to
 * `withThreadChat` at the boot catch path) is the ONLY place
 * notifyMentionSourceOfFailure is invoked. These drive the real boot-failure
 * path end-to-end (a "hatchet-remote" thread with a 500'd dispatch fetch,
 * exactly as the sibling "flag-on (remote) dispatch seam" suite does) and
 * assert what actually reaches GitHub — not just that the helper was wired.
 */
describe("startAgentMessage — mention-notify wiring (#163)", () => {
  let user: User;
  let mockOctokit: {
    rest: {
      pulls: { createReplyForReviewComment: ReturnType<typeof vi.fn> };
      issues: { createComment: ReturnType<typeof vi.fn> };
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    mockOctokit = {
      rest: {
        pulls: {
          createReplyForReviewComment: vi.fn().mockResolvedValue({ data: {} }),
        },
        issues: {
          createComment: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    };
    vi.mocked(getOctokitForApp).mockResolvedValue(mockOctokit as never);
    await mockWaitUntil();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    );
  });

  it("posts exactly one reply when a github-mention thread's boot fails", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sandboxProvider: "hatchet-remote",
        githubRepoFullName: "be-automata/rcm-runbook",
        repoBaseBranchName: "main",
        sourceType: "github-mention",
        sourceMetadata: {
          type: "github-mention",
          repoFullName: "be-automata/rcm-runbook",
          issueOrPrNumber: 13,
        },
      },
    });

    await startAgentMessage({
      db,
      userId: user.id,
      message: null,
      threadId,
      threadChatId,
      isNewThread: true,
    });
    await waitUntilResolved();

    const threadChat = await getThreadChat({
      db,
      threadId,
      threadChatId,
      userId: user.id,
    });
    expect(threadChat!.errorMessage).toBe("sandbox-creation-failed");
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "be-automata",
        repo: "rcm-runbook",
        issue_number: 13,
        body: expect.stringContaining("sandbox-creation-failed"),
      }),
    );
  });

  it("posts on the follow-up path too — keyed on sourceType, not on isNewThread", async () => {
    // A mention-born thread re-mentioned goes through queueFollowUpInternal
    // (isNewThread: false), not thread creation. The notifier must fire
    // identically because it only reads the thread row's sourceType.
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sandboxProvider: "hatchet-remote",
        githubRepoFullName: "be-automata/rcm-runbook",
        repoBaseBranchName: "main",
        sourceType: "github-mention",
        sourceMetadata: {
          type: "github-mention",
          repoFullName: "be-automata/rcm-runbook",
          issueOrPrNumber: 21,
        },
      },
    });

    await startAgentMessage({
      db,
      userId: user.id,
      message: null,
      threadId,
      threadChatId,
      isNewThread: false,
    });
    await waitUntilResolved();

    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 21 }),
    );
  });

  it("never posts for a non-mention thread's boot failure, nor for a post-boot withThreadChat failure", async () => {
    // (a) Same boot failure, but sourceType is NOT github-mention.
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sandboxProvider: "hatchet-remote",
        githubRepoFullName: "be-automata/rcm-runbook",
        repoBaseBranchName: "main",
        sourceType: "automation",
      },
    });

    await startAgentMessage({
      db,
      userId: user.id,
      message: null,
      threadId,
      threadChatId,
      isNewThread: true,
    });
    await waitUntilResolved();

    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();

    // (b) A mention-born thread, but reached through a `withThreadChat` caller
    // that (like slash commands / checkpoint paths) passes no `onError` — the
    // notifier is scoped to boot failures BY CONSTRUCTION, so a post-boot
    // caller can never invoke it even for a mention thread.
    const { threadId: mentionThreadId, threadChatId: mentionThreadChatId } =
      await createTestThread({
        db,
        userId: user.id,
        overrides: {
          sourceType: "github-mention",
          sourceMetadata: {
            type: "github-mention",
            repoFullName: "be-automata/rcm-runbook",
            issueOrPrNumber: 99,
          },
        },
        enableThreadChatCreation: false,
      });
    expect(mentionThreadChatId).toBe(LEGACY_THREAD_CHAT_ID);

    await withThreadChat({
      threadId: mentionThreadId,
      threadChatId: mentionThreadChatId,
      userId: user.id,
      execOrThrow: async () => {
        throw new Error("post-boot failure, no onError wired");
      },
      // No onError — this is the shape every OTHER withThreadChat caller uses.
    });
    await waitUntilResolved();

    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });
});
