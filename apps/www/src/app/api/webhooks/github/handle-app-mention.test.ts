import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { handleAppMention } from "./handle-app-mention";
import { User, GitHubPR } from "@terragon/shared";
import {
  createTestGitHubPR,
  createTestThread,
  createTestUser,
  setFeatureFlagOverrideForTest,
} from "@terragon/shared/model/test-helpers";
import { updateUserSettings } from "@terragon/shared/model/user";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import {
  getOctokitForUser,
  getOctokitForApp,
  getIsPRAuthor,
  getIsIssueAuthor,
  getPRAuthorGitHubUsername,
  getIssueAuthorGitHubUsername,
} from "@/lib/github";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { getDiffContextStr } from "./utils";
import { createAutomation } from "@terragon/shared/model/automations";
import { createOrganization } from "@terragon/shared/model/organizations";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { convertToPlainText } from "@/lib/db-message-helpers";
import { redis } from "@/lib/redis";
import { nanoid } from "nanoid";

vi.mock("@/server-lib/new-thread-internal", () => ({
  newThreadInternal: vi.fn().mockResolvedValue({ id: "new-thread-created-id" }),
}));

vi.mock("@/server-lib/follow-up", () => ({
  queueFollowUpInternal: vi.fn(),
}));

describe("handleAppMention", () => {
  let user: User;
  let pr: GitHubPR;
  let prWithNoThread: GitHubPR;
  let githubAccountId: number;
  let threadIdWithPR: string;
  let threadChatIdWithPR: string;
  let mockOctokit: any;

  beforeAll(async () => {
    const testUserResult = await createTestUser({ db });
    user = testUserResult.user;
    githubAccountId = parseInt(testUserResult.githubAccount.id);
    pr = await createTestGitHubPR({ db });
    prWithNoThread = await createTestGitHubPR({ db });
    const createTestThreadResult = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: pr.repoFullName,
        githubPRNumber: pr.number,
      },
    });
    threadIdWithPR = createTestThreadResult.threadId;
    threadChatIdWithPR = createTestThreadResult.threadChatId;
  });

  beforeEach(async () => {
    // Clear Redis batch keys to ensure test isolation
    const keys = await redis.keys("thread-batch:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    // Mock Octokit PR response
    mockOctokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              head: { ref: "feature-branch" },
              base: { ref: "main" },
            },
          }),
        },
        repos: {
          get: vi.fn().mockResolvedValue({
            data: {
              default_branch: "main",
            },
          }),
        },
        reactions: {
          createForIssueComment: vi.fn().mockResolvedValue({ data: {} }),
          createForPullRequestReviewComment: vi
            .fn()
            .mockResolvedValue({ data: {} }),
        },
      },
    };
    vi.clearAllMocks();
    vi.mocked(getOctokitForUser).mockResolvedValue(mockOctokit as any);
    vi.mocked(getOctokitForApp).mockResolvedValue(mockOctokit as any);
    // Reset newThreadInternal to successful state
    vi.mocked(newThreadInternal).mockResolvedValue({
      threadId: "new-thread-created-id",
      threadChatId: "new-thread-chat-created-id",
    });
  });

  it("should not create thread when user account is not found", async () => {
    await handleAppMention({
      repoFullName: pr.repoFullName,
      issueOrPrNumber: pr.number,
      issueOrPrType: "pull_request",
      commentId: 123456,
      commentGitHubUsername: "commenter",
      commentBody: "Hey @app, please help",
      commentGitHubAccountId: 999999, // Non-existent user ID
    });
    expect(getOctokitForUser).not.toHaveBeenCalled();
    expect(newThreadInternal).not.toHaveBeenCalled();
  });

  it("should handle missing GitHub user ID", async () => {
    await handleAppMention({
      repoFullName: pr.repoFullName,
      issueOrPrNumber: pr.number,
      issueOrPrType: "pull_request",
      commentId: 123456,
      commentGitHubUsername: "commenter",
      commentBody: "Hey @app, please help",
      commentGitHubAccountId: undefined, // No user ID
    });
    expect(getOctokitForUser).not.toHaveBeenCalled();
    expect(newThreadInternal).not.toHaveBeenCalled();
  });

  it("should not create thread when user has no GitHub access token", async () => {
    vi.mocked(getOctokitForUser).mockResolvedValue(null);
    await handleAppMention({
      repoFullName: pr.repoFullName,
      issueOrPrNumber: pr.number,
      issueOrPrType: "pull_request",
      commentId: 123456,
      commentGitHubUsername: "commenter",
      commentBody: "Hey @app, please help",
      commentGitHubAccountId: githubAccountId,
    });
    expect(newThreadInternal).not.toHaveBeenCalled();
  });

  it("should handle errors when fetching PR details", async () => {
    mockOctokit.rest.pulls.get.mockRejectedValue(new Error("GitHub API error"));
    await handleAppMention({
      repoFullName: "owner/repo",
      issueOrPrNumber: 123,
      issueOrPrType: "pull_request",
      commentId: 123456,
      commentGitHubUsername: "commenter",
      commentBody: "Hey @app, please help",
      commentGitHubAccountId: githubAccountId,
    });
    expect(newThreadInternal).not.toHaveBeenCalled();
  });

  it("should handle invalid repository name format", async () => {
    await expect(
      handleAppMention({
        repoFullName: "invalid-repo-name", // Missing slash
        issueOrPrNumber: 123,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @app, please help",
        commentGitHubAccountId: githubAccountId,
      }),
    ).rejects.toThrow("Invalid repository full name: invalid-repo-name");
    expect(newThreadInternal).not.toHaveBeenCalled();
  });

  describe("singleThreadForGitHubMentions=true", () => {
    beforeEach(async () => {
      await updateUserSettings({
        db,
        userId: user.id,
        updates: {
          singleThreadForGitHubMentions: true,
        },
      });
    });

    it("should queue follow-up to existing thread when one exists", async () => {
      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @app, please fix this additional issue",
        commentGitHubAccountId: githubAccountId,
      });
      expect(queueFollowUpInternal).toHaveBeenCalledWith({
        userId: user.id,
        threadId: threadIdWithPR,
        threadChatId: threadChatIdWithPR,
        messages: [
          expect.objectContaining({
            type: "user",
            model: null,
            parts: [
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining(
                  `@commenter mentioned you on PR #${pr.number}`,
                ),
              }),
            ],
          }),
        ],
        source: "github",
        appendOrReplace: "append",
      });

      const callArgs = vi.mocked(queueFollowUpInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.messages[0]?.parts[0]?.text;
      expect(messageText.replace(/#(\d+)/g, "<PR_NUMBER>"))
        .toMatchInlineSnapshot(`
          "@commenter mentioned you on PR <PR_NUMBER>:

          This is the message:

          Hey @app, please fix this additional issue

          You can use the github cli to pull comments, reply, and push changes."
        `);
      // Verify new thread was NOT created
      expect(newThreadInternal).not.toHaveBeenCalled();
    });

    it("derives the thread's org from the GitHub App installation (WI-5)", async () => {
      const org = await createOrganization({
        db,
        name: "Acme",
        slug: `acme-${nanoid(8).toLowerCase()}`,
      });
      const installationId = Math.floor(Math.random() * 1_000_000_000);
      await bindGithubInstallationToOrg({
        db,
        installationId,
        organizationId: org.id,
      });

      await handleAppMention({
        repoFullName: prWithNoThread.repoFullName,
        issueOrPrNumber: prWithNoThread.number,
        issueOrPrType: "pull_request",
        commentId: 123457,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @app, please help with this",
        commentGitHubAccountId: githubAccountId,
        installationId,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: org.id }),
      );
    });

    it("passes a null org when the installation is unmapped (nullable-safe)", async () => {
      await handleAppMention({
        repoFullName: prWithNoThread.repoFullName,
        issueOrPrNumber: prWithNoThread.number,
        issueOrPrType: "pull_request",
        commentId: 123458,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @app, please help with this",
        commentGitHubAccountId: githubAccountId,
        installationId: 999_999_999,
      });

      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      expect(callArgs?.organizationId ?? null).toBeNull();
    });

    it("shadow-mode installation: creates the thread as shadow (no boot) and suppresses the eyes reaction", async () => {
      const org = await createOrganization({
        db,
        name: "Shadow Org",
        slug: `shadow-${nanoid(8).toLowerCase()}`,
      });
      const installationId = Math.floor(Math.random() * 1_000_000_000);
      await bindGithubInstallationToOrg({
        db,
        installationId,
        organizationId: org.id,
        mode: "shadow",
      });

      await handleAppMention({
        repoFullName: prWithNoThread.repoFullName,
        issueOrPrNumber: prWithNoThread.number,
        issueOrPrType: "pull_request",
        commentId: 123459,
        commentType: "issue_comment",
        commentGitHubUsername: "commenter",
        commentBody: "Hey @app, please help with this",
        commentGitHubAccountId: githubAccountId,
        installationId,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: org.id, shadow: true }),
      );
      // Zero GitHub side effects in shadow mode: no eyes reaction.
      expect(
        mockOctokit.rest.reactions.createForIssueComment,
      ).not.toHaveBeenCalled();
    });

    it("active-mode installation: creates the thread non-shadow (boots) and adds the eyes reaction", async () => {
      const org = await createOrganization({
        db,
        name: "Active Org",
        slug: `active-${nanoid(8).toLowerCase()}`,
      });
      const installationId = Math.floor(Math.random() * 1_000_000_000);
      await bindGithubInstallationToOrg({
        db,
        installationId,
        organizationId: org.id,
        mode: "active",
      });

      await handleAppMention({
        repoFullName: prWithNoThread.repoFullName,
        issueOrPrNumber: prWithNoThread.number,
        issueOrPrType: "pull_request",
        commentId: 123460,
        commentType: "issue_comment",
        commentGitHubUsername: "commenter",
        commentBody: "Hey @app, please help with this",
        commentGitHubAccountId: githubAccountId,
        installationId,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: org.id, shadow: false }),
      );
      expect(
        mockOctokit.rest.reactions.createForIssueComment,
      ).toHaveBeenCalled();
    });

    it("should create new thread when no existing thread is found", async () => {
      await handleAppMention({
        repoFullName: prWithNoThread.repoFullName,
        issueOrPrNumber: prWithNoThread.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @app, please help with this",
        commentGitHubAccountId: githubAccountId,
      });
      expect(queueFollowUpInternal).not.toHaveBeenCalled();
      expect(newThreadInternal).toHaveBeenCalled();
      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
          message: {
            type: "user",
            model: null,
            parts: [
              {
                type: "text",
                text: expect.stringContaining(
                  `@commenter mentioned you on PR #${prWithNoThread.number}`,
                ),
              },
            ],
            timestamp: expect.any(String),
          },
          parentThreadId: undefined,
          parentToolId: undefined,
          baseBranchName: "main",
          headBranchName: "feature-branch",
          githubRepoFullName: prWithNoThread.repoFullName,
          githubPRNumber: prWithNoThread.number,
          githubIssueNumber: undefined,
          sourceType: "github-mention",
          sourceMetadata: expect.objectContaining({
            repoFullName: prWithNoThread.repoFullName,
            issueOrPrNumber: prWithNoThread.number,
          }),
        }),
      );
      expect(queueFollowUpInternal).not.toHaveBeenCalled();

      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.message.parts[0]?.text;
      expect(messageText.replace(/#(\d+)/g, "<PR_NUMBER>"))
        .toMatchInlineSnapshot(`
        "@commenter mentioned you on PR <PR_NUMBER>:

        This is the message:

        Hey @app, please help with this

        You can use the github cli to pull comments, reply, and push changes."
      `);
    });
  });

  describe("singleThreadForGitHubMentions=false", () => {
    beforeEach(async () => {
      await updateUserSettings({
        db,
        userId: user.id,
        updates: {
          singleThreadForGitHubMentions: false,
        },
      });
    });

    it("should batch concurrent mentions within 1-minute window - only create one thread", async () => {
      // Enable batching feature flag
      await setFeatureFlagOverrideForTest({
        db,
        userId: user.id,
        name: "batchGitHubMentions",
        value: true,
      });

      // Simulate multiple concurrent mentions arriving at the same time
      // These should be batched into a single thread creation
      const mention1 = handleAppMention({
        repoFullName: prWithNoThread.repoFullName,
        issueOrPrNumber: prWithNoThread.number,
        issueOrPrType: "pull_request",
        commentId: 111111,
        commentGitHubUsername: "commenter1",
        commentBody: "Hey @app, first comment",
        commentGitHubAccountId: githubAccountId,
      });

      const mention2 = handleAppMention({
        repoFullName: prWithNoThread.repoFullName,
        issueOrPrNumber: prWithNoThread.number,
        issueOrPrType: "pull_request",
        commentId: 222222,
        commentGitHubUsername: "commenter2",
        commentBody: "Hey @app, second comment",
        commentGitHubAccountId: githubAccountId,
      });

      const mention3 = handleAppMention({
        repoFullName: prWithNoThread.repoFullName,
        issueOrPrNumber: prWithNoThread.number,
        issueOrPrType: "pull_request",
        commentId: 333333,
        commentGitHubUsername: "commenter3",
        commentBody: "Hey @app, third comment",
        commentGitHubAccountId: githubAccountId,
      });

      await Promise.all([mention1, mention2, mention3]);

      // Only ONE thread should be created despite 3 concurrent mentions
      // The other mentions are queued as follow-ups to the same thread
      // This prevents hitting concurrency and sandbox rate limits
      expect(newThreadInternal).toHaveBeenCalledTimes(1);
      expect(queueFollowUpInternal).toHaveBeenCalledTimes(2);

      // Verify all follow-ups went to the same thread
      const followUpCalls = vi.mocked(queueFollowUpInternal).mock.calls;
      const threadIds = followUpCalls.map((call) => call[0].threadId);
      expect(new Set(threadIds).size).toBe(1);
      expect(threadIds[0]).toBe("new-thread-created-id");
    });

    it("should create a new thread when user is found and has GitHub token", async () => {
      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @app, please fix this bug",
        commentGitHubAccountId: githubAccountId,
      });
      // Verify getOctokitForUser was called
      expect(getOctokitForUser).toHaveBeenCalledWith({ userId: user.id });
      // Verify PR details were fetched
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledWith({
        owner: pr.repoFullName.split("/")[0],
        repo: pr.repoFullName.split("/")[1],
        pull_number: pr.number,
      });
      // Verify thread creation
      expect(newThreadInternal).toHaveBeenCalled();
      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
          message: {
            type: "user",
            model: null,
            parts: [
              {
                type: "text",
                text: expect.stringContaining(
                  `@commenter mentioned you on PR #${pr.number}`,
                ),
              },
            ],
            timestamp: expect.any(String),
          },
          parentThreadId: undefined,
          parentToolId: undefined,
          baseBranchName: "main",
          headBranchName: "feature-branch",
          githubRepoFullName: pr.repoFullName,
          githubPRNumber: pr.number,
          githubIssueNumber: undefined,
          sourceType: "github-mention",
          sourceMetadata: expect.objectContaining({
            repoFullName: pr.repoFullName,
            issueOrPrNumber: pr.number,
          }),
        }),
      );
    });

    it("should handle errors when creating thread", async () => {
      vi.mocked(newThreadInternal).mockRejectedValue(
        new Error("Thread creation failed"),
      );
      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @app, please help",
        commentGitHubAccountId: githubAccountId,
      });
      // Should have attempted to create thread
      expect(newThreadInternal).toHaveBeenCalled();
    });

    it("should include full comment body in thread message", async () => {
      const longComment = `\
Hey @app, I found several issues:
  1. The button doesn't work on mobile
  2. The API returns 500 errors
  3. The UI is not responsive

  Can you please help fix these?
      `;

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: longComment,
        commentGitHubAccountId: githubAccountId,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            parts: [
              expect.objectContaining({
                text: expect.stringContaining(longComment),
              }),
            ],
          }),
          sourceType: "github-mention",
          sourceMetadata: expect.any(Object),
        }),
      );
      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.message.parts[0]?.text;
      expect(messageText.replace(/#(\d+)/g, "<PR_NUMBER>"))
        .toMatchInlineSnapshot(`
          "@commenter mentioned you on PR <PR_NUMBER>:

          This is the message:

          Hey @app, I found several issues:
            1. The button doesn't work on mobile
            2. The API returns 500 errors
            3. The UI is not responsive

            Can you please help fix these?
                

          You can use the github cli to pull comments, reply, and push changes."
        `);
    });

    it("should handle issue mentions correctly", async () => {
      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "issue",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @app, please address this issue",
        commentGitHubAccountId: githubAccountId,
      });
      // Verify repo details were fetched for issue
      expect(mockOctokit.rest.repos.get).toHaveBeenCalledWith({
        owner: pr.repoFullName.split("/")[0],
        repo: pr.repoFullName.split("/")[1],
      });
      // Verify thread creation with createNewBranch = true for issues
      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            parts: [
              expect.objectContaining({
                text: expect.stringContaining(
                  `@commenter mentioned you on Issue #${pr.number}`,
                ),
              }),
            ],
          }),
          baseBranchName: "main",
          headBranchName: undefined,
          sourceType: "github-mention",
          sourceMetadata: expect.any(Object),
        }),
      );

      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.message.parts[0]?.text;
      expect(messageText.replace(/#(\d+)/g, "<PR_NUMBER>"))
        .toMatchInlineSnapshot(`
        "@commenter mentioned you on Issue <PR_NUMBER>:

        This is the message:

        Hey @app, please address this issue

        You can use the github cli to pull comments, reply, and push changes."
      `);
    });

    it("should always create new thread even if existing thread exists", async () => {
      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @app, please fix this",
        commentGitHubAccountId: githubAccountId,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
          message: expect.objectContaining({
            parts: [
              expect.objectContaining({
                text: expect.stringContaining(
                  `@commenter mentioned you on PR #${pr.number}`,
                ),
              }),
            ],
          }),
          parentThreadId: undefined,
          parentToolId: undefined,
          baseBranchName: "main",
          headBranchName: "feature-branch",
          githubRepoFullName: pr.repoFullName,
          githubPRNumber: pr.number,
          sourceType: "github-mention",
          sourceMetadata: expect.any(Object),
        }),
      );
      expect(queueFollowUpInternal).not.toHaveBeenCalled();
    });
  });

  describe("diff context handling", () => {
    beforeEach(async () => {
      await updateUserSettings({
        db,
        userId: user.id,
        updates: {
          singleThreadForGitHubMentions: false,
        },
      });
    });

    it("should include diff context in thread message when provided", async () => {
      const comment: any = {
        path: "src/components/Button.tsx",
        line: 42,
        side: "RIGHT" as const,
        start_line: 40,
        start_side: "RIGHT" as const,
        diff_hunk:
          "@@ -40,3 +40,5 @@ export function Button() {\n   return <button>Click me</button>;\n }\n+\n+// TODO: Add proper styling",
        commit_id: "abc123",
        in_reply_to_id: 123456,
      };
      const diffContext = getDiffContextStr(comment);
      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "This needs better error handling",
        commentGitHubAccountId: githubAccountId,
        diffContext,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            parts: [
              expect.objectContaining({
                text: expect.stringContaining(
                  "--- a/src/components/Button.tsx",
                ),
              }),
            ],
          }),
          sourceType: "github-mention",
          sourceMetadata: expect.any(Object),
        }),
      );

      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.message.parts[0]?.text;
      expect(messageText.replace(/#(\d+)/g, "<PR_NUMBER>"))
        .toMatchInlineSnapshot(`
          "@commenter mentioned you on PR <PR_NUMBER>:

          Comment context:

          // Side: head, Start line: 40, End line: 42
          Comment id: undefined
          \`\`\`diff
          diff --git a/src/components/Button.tsx b/src/components/Button.tsx
          index abc123
          --- a/src/components/Button.tsx
          +++ b/src/components/Button.tsx

          @@ -40,3 +40,5 @@ export function Button() {
             return <button>Click me</button>;
           }
          +
          +// TODO: Add proper styling
          \`\`\`

          This is the message:

          This needs better error handling

          You can use the github cli to pull comments, reply, and push changes."
        `);
    });

    it("should handle partial diff context gracefully", async () => {
      const comment: any = {
        path: "README.md",
        line: 10,
        side: "LEFT" as const,
      };
      const diffContext = getDiffContextStr(comment);
      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "This documentation is outdated",
        commentGitHubAccountId: githubAccountId,
        diffContext,
      });

      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.message.parts[0]?.text;
      expect(messageText.replace(/#(\d+)/g, "<PR_NUMBER>"))
        .toMatchInlineSnapshot(`
          "@commenter mentioned you on PR <PR_NUMBER>:

          Comment context:

          // Side: base, Line: 10
          \`\`\`diff
          diff --git a/README.md b/README.md
          --- a/README.md
          +++ b/README.md
          \`\`\`

          This is the message:

          This documentation is outdated

          You can use the github cli to pull comments, reply, and push changes."
        `);
    });

    it("should work without diff context", async () => {
      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "General comment on the PR",
        commentGitHubAccountId: githubAccountId,
      });

      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.message.parts[0]?.text;
      expect(messageText.replace(/#(\d+)/g, "<PR_NUMBER>"))
        .toMatchInlineSnapshot(`
          "@commenter mentioned you on PR <PR_NUMBER>:

          This is the message:

          General comment on the PR

          You can use the github cli to pull comments, reply, and push changes."
        `);
    });
  });

  describe("author vs non-author message formatting", () => {
    beforeEach(async () => {
      await updateUserSettings({
        db,
        userId: user.id,
        updates: {
          singleThreadForGitHubMentions: false,
        },
      });
    });

    it("non-author mention", async () => {
      vi.mocked(getIsPRAuthor).mockResolvedValue(false);

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "other-user",
        commentBody: "Hey, can you help with this?",
        commentGitHubAccountId: githubAccountId,
      });

      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      const messageText = convertToPlainText({ message: callArgs?.message! });
      expect(messageText.replace(/#(\d+)/g, "<PR_NUMBER>"))
        .toMatchInlineSnapshot(`
          "@other-user mentioned you on PR <PR_NUMBER>:

          This is the message:

          Hey, can you help with this?

          You can use the github cli to pull comments, reply, and push changes."
        `);
    });

    it("author mention", async () => {
      vi.mocked(getIsPRAuthor).mockResolvedValue(true);

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "pr-author",
        commentBody: "Please fix this",
        commentGitHubAccountId: githubAccountId,
      });

      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      const messageText = convertToPlainText({ message: callArgs?.message! });
      expect(messageText.replace(/#(\d+)/g, "<PR_NUMBER>"))
        .toMatchInlineSnapshot(`
        "@pr-author mentioned you on PR <PR_NUMBER>:

        This is the message:

        Please fix this

        You can use the github cli to pull comments, reply, and push changes."
      `);
    });

    it("author follow-up", async () => {
      vi.mocked(getIsPRAuthor).mockResolvedValue(true);

      await updateUserSettings({
        db,
        userId: user.id,
        updates: {
          singleThreadForGitHubMentions: true,
        },
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "pr-author",
        commentBody: "Additional context",
        commentGitHubAccountId: githubAccountId,
      });

      expect(queueFollowUpInternal).toHaveBeenCalled();
      const callArgs = vi.mocked(queueFollowUpInternal).mock.calls[0]?.[0];
      const messageText = convertToPlainText({
        message: callArgs?.messages[0]!,
      });
      expect(messageText.replace(/#(\d+)/g, "<PR_NUMBER>"))
        .toMatchInlineSnapshot(`
        "I left a comment on PR <PR_NUMBER>:

        My comment:

        Additional context

        You can use the github cli to pull comments, reply, and push changes."
      `);
    });

    it("should handle author vs non-author for issues", async () => {
      vi.mocked(getIsIssueAuthor).mockResolvedValue(true);

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "issue",
        commentId: 123456,
        commentGitHubUsername: "issue-author",
        commentBody: "More info",
        commentGitHubAccountId: githubAccountId,
      });

      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      const messageText = convertToPlainText({ message: callArgs?.message! });
      expect(messageText.replace(/#(\d+)/g, "<ISSUE_NUMBER>"))
        .toMatchInlineSnapshot(`
        "@issue-author mentioned you on Issue <ISSUE_NUMBER>:

        This is the message:

        More info

        You can use the github cli to pull comments, reply, and push changes."
      `);
    });
  });

  describe("github-mention automations", () => {
    let automationUser: User;

    beforeAll(async () => {
      const testUserResult = await createTestUser({ db, accessTier: "pro" });
      automationUser = testUserResult.user;
    });

    beforeEach(async () => {
      // Clean up automations from previous tests
      await db.delete(schema.automations);

      vi.mocked(getIsPRAuthor).mockResolvedValue(false);
      vi.mocked(getIsIssueAuthor).mockResolvedValue(false);
      vi.mocked(getPRAuthorGitHubUsername).mockResolvedValue("pr-author");
      vi.mocked(getIssueAuthorGitHubUsername).mockResolvedValue("issue-author");
    });

    it("should create task for mentioning user when no automation exists", async () => {
      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @app, please help",
        commentGitHubAccountId: githubAccountId,
      });

      expect(newThreadInternal).toHaveBeenCalledTimes(1);
      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
        }),
      );
    });

    it("should create task for automation user when bot mention matches filter", async () => {
      // Mock the automation user as the PR author
      vi.mocked(getIsPRAuthor).mockImplementation(async ({ userId }) => {
        return userId === automationUser.id;
      });

      // Create automation that triggers on specific bot mentions
      await createAutomation({
        db,
        userId: automationUser.id,
        accessTier: "pro",
        automation: {
          name: "Bot Mention Automation",
          repoFullName: pr.repoFullName,
          branchName: "main",
          enabled: true,
          triggerType: "github_mention",
          triggerConfig: {
            filter: {
              includeBotMentions: true,
              botUsernames: "dependabot[bot], renovate[bot]",
              includeOtherAuthors: false,
            },
          },
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [],
                timestamp: new Date().toISOString(),
              },
            },
          },
        },
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "dependabot[bot]",
        commentBody: "@app please review",
        commentGitHubAccountId: undefined,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: automationUser.id,
        }),
      );
    });

    it("should not create task when bot username does not match filter", async () => {
      await createAutomation({
        db,
        userId: automationUser.id,
        accessTier: "pro",
        automation: {
          name: "Bot Mention Automation",
          repoFullName: pr.repoFullName,
          branchName: "main",
          enabled: true,
          triggerType: "github_mention",
          triggerConfig: {
            filter: {
              includeBotMentions: true,
              botUsernames: "dependabot[bot]",
              includeOtherAuthors: false,
            },
          },
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [],
                timestamp: new Date().toISOString(),
              },
            },
          },
        },
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "renovate[bot]",
        commentBody: "@app please review",
        commentGitHubAccountId: undefined,
      });

      // Should not create any tasks (no mentioning user, bot doesn't match)
      expect(newThreadInternal).not.toHaveBeenCalled();
    });

    it("should create task when user is PR author and automation exists", async () => {
      vi.mocked(getIsPRAuthor).mockResolvedValue(true);

      await createAutomation({
        db,
        userId: automationUser.id,
        accessTier: "pro",
        automation: {
          name: "PR Author Automation",
          repoFullName: pr.repoFullName,
          branchName: "main",
          enabled: true,
          triggerType: "github_mention",
          triggerConfig: {
            filter: {
              includeBotMentions: true,
              botUsernames: "dependabot[bot]",
              includeOtherAuthors: false,
            },
          },
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [],
                timestamp: new Date().toISOString(),
              },
            },
          },
        },
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "dependabot[bot]",
        commentBody: "@app please review",
        commentGitHubAccountId: undefined,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: automationUser.id,
        }),
      );
    });

    it("should create task when other author matches filter", async () => {
      vi.mocked(getPRAuthorGitHubUsername).mockResolvedValue("allowed-author");

      await createAutomation({
        db,
        userId: automationUser.id,
        accessTier: "core",
        automation: {
          name: "Other Authors Automation",
          repoFullName: pr.repoFullName,
          branchName: "main",
          enabled: true,
          triggerType: "github_mention",
          triggerConfig: {
            filter: {
              includeBotMentions: true,
              botUsernames: "dependabot[bot]",
              includeOtherAuthors: true,
              otherAuthors: "allowed-author, another-author",
            },
          },
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [],
                timestamp: new Date().toISOString(),
              },
            },
          },
        },
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "dependabot[bot]",
        commentBody: "@app please review",
        commentGitHubAccountId: undefined,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: automationUser.id,
        }),
      );
    });

    it("should not create task when other author does not match filter", async () => {
      vi.mocked(getPRAuthorGitHubUsername).mockResolvedValue(
        "different-author",
      );

      await createAutomation({
        db,
        userId: automationUser.id,
        accessTier: "pro",
        automation: {
          name: "Other Authors Automation",
          repoFullName: pr.repoFullName,
          branchName: "main",
          enabled: true,
          triggerType: "github_mention",
          triggerConfig: {
            filter: {
              includeBotMentions: true,
              botUsernames: "dependabot[bot]",
              includeOtherAuthors: true,
              otherAuthors: "allowed-author",
            },
          },
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [],
                timestamp: new Date().toISOString(),
              },
            },
          },
        },
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "dependabot[bot]",
        commentBody: "@app please review",
        commentGitHubAccountId: undefined,
      });

      expect(newThreadInternal).not.toHaveBeenCalled();
    });

    it("should create tasks for both mentioning user and automation user when both apply", async () => {
      // Mentioning user is a Terragon user but not the automation owner
      await createAutomation({
        db,
        userId: automationUser.id,
        accessTier: "core",
        automation: {
          name: "Bot Mention Automation",
          repoFullName: pr.repoFullName,
          branchName: "main",
          enabled: true,
          triggerType: "github_mention",
          triggerConfig: {
            filter: {
              includeBotMentions: true,
              botUsernames: "dependabot[bot]",
              includeOtherAuthors: false,
            },
          },
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [
                  {
                    type: "text",
                    text: "Additional context from automation",
                  },
                ],
                timestamp: new Date().toISOString(),
              },
            },
          },
        },
      });

      vi.mocked(getIsPRAuthor).mockImplementation(async ({ userId }) => {
        return userId === automationUser.id;
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "dependabot[bot]",
        commentBody: "@app please review",
        commentGitHubAccountId: githubAccountId, // This is a different user
      });

      // Should create two tasks: one for mentioning user, one for automation user
      expect(newThreadInternal).toHaveBeenCalledTimes(2);

      // Check that both users got tasks
      const calls = vi.mocked(newThreadInternal).mock.calls;
      const userIds = calls.map((call) => call[0]?.userId);
      expect(userIds).toContain(user.id); // mentioning user
      expect(userIds).toContain(automationUser.id); // automation user
    });

    it("should include additional message from automation action config", async () => {
      // Mock the automation user as the PR author
      vi.mocked(getIsPRAuthor).mockImplementation(async ({ userId }) => {
        return userId === automationUser.id;
      });

      await createAutomation({
        db,
        userId: automationUser.id,
        accessTier: "pro",
        automation: {
          name: "Bot Mention with Custom Message",
          repoFullName: pr.repoFullName,
          branchName: "main",
          enabled: true,
          triggerType: "github_mention",
          triggerConfig: {
            filter: {
              includeBotMentions: true,
              botUsernames: "dependabot[bot]",
              includeOtherAuthors: false,
            },
          },
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: "sonnet",
                parts: [
                  {
                    type: "text",
                    text: "Please review this carefully and ensure all tests pass.",
                  },
                ],
                timestamp: new Date().toISOString(),
              },
            },
          },
        },
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "dependabot[bot]",
        commentBody: "@app please review",
        commentGitHubAccountId: undefined,
      });

      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      expect(callArgs?.message.model).toBe("sonnet");
      const messageText = convertToPlainText({ message: callArgs?.message! });
      expect(messageText.replace(/#(\d+)/g, "<PR_NUMBER>"))
        .toMatchInlineSnapshot(`
          "@dependabot[bot] mentioned you on PR <PR_NUMBER>:

          This is the message:

          @app please review

          You can use the github cli to pull comments, reply, and push changes.

          Please review this carefully and ensure all tests pass."
        `);
    });

    it("should work with issue automations", async () => {
      vi.mocked(getIsIssueAuthor).mockResolvedValue(true);

      await createAutomation({
        db,
        userId: automationUser.id,
        accessTier: "pro",
        automation: {
          name: "Issue Bot Automation",
          repoFullName: pr.repoFullName,
          branchName: "main",
          enabled: true,
          triggerType: "github_mention",
          triggerConfig: {
            filter: {
              includeBotMentions: true,
              botUsernames: "linear[bot]",
              includeOtherAuthors: false,
            },
          },
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [],
                timestamp: new Date().toISOString(),
              },
            },
          },
        },
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "issue",
        commentId: 123456,
        commentGitHubUsername: "linear[bot]",
        commentBody: "@app sync this",
        commentGitHubAccountId: undefined,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: automationUser.id,
          githubIssueNumber: pr.number,
          baseBranchName: "main",
          headBranchName: undefined,
        }),
      );
    });
  });

  describe("model selection from comment", () => {
    beforeEach(async () => {
      await updateUserSettings({
        db,
        userId: user.id,
        updates: {
          singleThreadForGitHubMentions: false,
        },
      });
    });

    it("should use model specified in comment", async () => {
      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "@test-app [opus] fix this critical bug",
        commentGitHubAccountId: githubAccountId,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            model: "opus",
          }),
        }),
      );
    });

    it("should use model from comment over default GitHub mention model", async () => {
      await updateUserSettings({
        db,
        userId: user.id,
        updates: {
          defaultGitHubMentionModel: "haiku",
        },
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "@test-app [sonnet] refactor this code",
        commentGitHubAccountId: githubAccountId,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            model: "sonnet",
          }),
        }),
      );
    });

    it("should fall back to default model when no model in comment", async () => {
      await updateUserSettings({
        db,
        userId: user.id,
        updates: {
          defaultGitHubMentionModel: "haiku",
        },
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "@test-app fix this bug",
        commentGitHubAccountId: githubAccountId,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            model: "haiku",
          }),
        }),
      );
    });

    it("should handle invalid model names gracefully", async () => {
      // Reset default model to ensure we're testing invalid model handling
      await updateUserSettings({
        db,
        userId: user.id,
        updates: {
          defaultGitHubMentionModel: null,
        },
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "@test-app [invalid-model] fix this",
        commentGitHubAccountId: githubAccountId,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            model: null,
          }),
        }),
      );
    });

    it("should support all valid model names", async () => {
      // Test with gpt-5 as representative of all model types
      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: `@test-app [gpt-5] test task`,
        commentGitHubAccountId: githubAccountId,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            model: "gpt-5",
          }),
        }),
      );
    });

    it("should use extracted model over automation model", async () => {
      // Mock the automation user as the PR author
      vi.mocked(getIsPRAuthor).mockImplementation(async ({ userId }) => {
        return userId === user.id;
      });

      await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Test Automation",
          repoFullName: pr.repoFullName,
          branchName: "main",
          enabled: true,
          triggerType: "github_mention",
          triggerConfig: {
            filter: {
              includeBotMentions: false,
              includeOtherAuthors: false,
            },
          },
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: "haiku",
                parts: [],
                timestamp: new Date().toISOString(),
              },
            },
          },
        },
      });

      await handleAppMention({
        repoFullName: pr.repoFullName,
        issueOrPrNumber: pr.number,
        issueOrPrType: "pull_request",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "@test-app [opus] fix this",
        commentGitHubAccountId: githubAccountId,
      });

      // Should use extracted model (opus) which has higher priority than automation model
      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            model: "opus",
          }),
        }),
      );
    });
  });
});
