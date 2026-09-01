import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { User } from "@terragon/shared";
import { getOctokitForApp } from "@/lib/github";
import { isAppMentioned } from "@/app/api/webhooks/github/utils";
import { notifyMentionSourceOfFailure } from "./mention-notify";

/**
 * #163: notifyMentionSourceOfFailure is the ONLY thing standing between a
 * silently-failed mention boot and a person waiting forever on GitHub. These
 * pin its four load-bearing behaviors: it only ever fires for
 * sourceType "github-mention" threads, it falls back to a top-level comment
 * ONLY on a definitive "wrong comment type" (404/422) response, its reply
 * text can never itself re-trigger the mention gate, and a GitHub-side
 * failure is logged and swallowed rather than thrown.
 */
describe("notifyMentionSourceOfFailure", () => {
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
  });

  it("gates on sourceType === 'github-mention' — a non-mention thread never posts", async () => {
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sourceType: "automation",
      },
    });

    await notifyMentionSourceOfFailure({
      db,
      threadId,
      errorType: "unknown-error",
    });

    expect(getOctokitForApp).not.toHaveBeenCalled();
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("falls back to an issue comment ONLY on a definitive 404/422 review-comment error, never on an ambiguous one", async () => {
    const { threadId: threadWithFallback } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sourceType: "github-mention",
        sourceMetadata: {
          type: "github-mention",
          repoFullName: "be-automata/rcm-runbook",
          issueOrPrNumber: 13,
          commentId: 999,
        },
      },
    });
    mockOctokit.rest.pulls.createReplyForReviewComment.mockRejectedValueOnce({
      status: 404,
    });

    await notifyMentionSourceOfFailure({
      db,
      threadId: threadWithFallback,
      errorType: "sandbox-creation-failed",
    });

    expect(
      mockOctokit.rest.pulls.createReplyForReviewComment,
    ).toHaveBeenCalledTimes(1);
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 13 }),
    );

    // A non-404/422 failure (e.g. network/5xx) is ambiguous about whether the
    // reply actually posted — it must NOT fall back and risk a double post.
    vi.clearAllMocks();
    vi.mocked(getOctokitForApp).mockResolvedValue(mockOctokit as never);
    const { threadId: threadNoFallback } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sourceType: "github-mention",
        sourceMetadata: {
          type: "github-mention",
          repoFullName: "be-automata/rcm-runbook",
          issueOrPrNumber: 14,
          commentId: 1000,
        },
      },
    });
    mockOctokit.rest.pulls.createReplyForReviewComment.mockRejectedValueOnce({
      status: 500,
    });

    await notifyMentionSourceOfFailure({
      db,
      threadId: threadNoFallback,
      errorType: "sandbox-creation-failed",
    });

    expect(
      mockOctokit.rest.pulls.createReplyForReviewComment,
    ).toHaveBeenCalledTimes(1);
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("never posts a body containing the app's own @handle (can't self-retrigger isAppMentioned)", async () => {
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sourceType: "github-mention",
        sourceMetadata: {
          type: "github-mention",
          repoFullName: "be-automata/rcm-runbook",
          issueOrPrNumber: 13,
        },
      },
    });

    await notifyMentionSourceOfFailure({
      db,
      threadId,
      errorType: "sandbox-creation-failed",
    });

    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const postedBody = mockOctokit.rest.issues.createComment.mock.calls[0]![0]
      .body as string;
    expect(postedBody).toContain("sandbox-creation-failed");
    expect(isAppMentioned(postedBody)).toBe(false);
  });

  it("swallows an octokit failure — logs it, never throws", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sourceType: "github-mention",
        sourceMetadata: {
          type: "github-mention",
          repoFullName: "be-automata/rcm-runbook",
          issueOrPrNumber: 13,
        },
      },
    });
    mockOctokit.rest.issues.createComment.mockRejectedValueOnce(
      new Error("octokit 500"),
    );

    await expect(
      notifyMentionSourceOfFailure({
        db,
        threadId,
        errorType: "unknown-error",
      }),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[mention-notify] failed",
      expect.objectContaining({ threadId }),
    );
    consoleErrorSpy.mockRestore();
  });
});
