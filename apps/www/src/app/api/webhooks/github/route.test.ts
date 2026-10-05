import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import crypto from "crypto";
import { POST } from "./route";
import { createMockNextRequest } from "@/test-helpers/mock-next";
import { db } from "@/lib/db";
import { updateGitHubPR } from "@/lib/github";
import { handleAppMention } from "./handle-app-mention";
import { WebhookSkip } from "./webhook-skip";
import {
  handleIssueEvent,
  handleSelfHealIssueReopened,
  handleSelfHealIssueUnready,
  handleIssueLabeledMirror,
  handlePullRequestMirror,
  handlePullRequestStatusChange,
  handleWorkflowRunEvent,
} from "./handlers";
import {
  createTestUser,
  createTestGitHubPR,
} from "@terragon/shared/model/test-helpers";
import { env } from "@terragon/env/apps-www";
import { waitUntil } from "@/lib/wait-until";
import { handleSelfHealCiEvent } from "@/server-lib/audit/evaluate-fix-ci";
import { handleSelfHealPrClosed } from "@/server-lib/audit/fix-pr-lifecycle";
import { createSelfHealOctokit } from "@/server-lib/audit/self-heal-octokit";
import { insertFinding } from "@terragon/shared/model/audit-findings";
import {
  claimFixAttempt,
  updateFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import { createOrganization } from "@terragon/shared/model/organizations";
import { nanoid } from "nanoid";

vi.mock("./handle-app-mention", () => ({
  handleAppMention: vi.fn(),
}));
// Pass-through spies: every other test keeps the real handlers.
vi.mock("./handlers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./handlers")>();
  return {
    ...actual,
    handleIssueEvent: vi.fn(actual.handleIssueEvent),
    handleSelfHealIssueUnready: vi.fn(actual.handleSelfHealIssueUnready),
    handleSelfHealIssueReopened: vi.fn(actual.handleSelfHealIssueReopened),
    handleIssueLabeledMirror: vi.fn(actual.handleIssueLabeledMirror),
    handleWorkflowRunEvent: vi.fn(actual.handleWorkflowRunEvent),
    handlePullRequestStatusChange: vi.fn(actual.handlePullRequestStatusChange),
    handlePullRequestMirror: vi.fn(actual.handlePullRequestMirror),
  };
});
vi.mock("@/server-lib/audit/fix-pr-lifecycle", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/server-lib/audit/fix-pr-lifecycle")
    >();
  return {
    ...actual,
    handleSelfHealPrClosed: vi.fn(actual.handleSelfHealPrClosed),
  };
});
vi.mock("@/server-lib/audit/evaluate-fix-ci", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server-lib/audit/evaluate-fix-ci")>();
  return {
    ...actual,
    handleSelfHealCiEvent: vi.fn(actual.handleSelfHealCiEvent),
  };
});
vi.mock("@/server-lib/audit/self-heal-octokit", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/server-lib/audit/self-heal-octokit")
    >();
  return {
    ...actual,
    createSelfHealOctokit: vi.fn(actual.createSelfHealOctokit),
  };
});

function createSignature(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  return `sha256=${hmac.update(payload).digest("hex")}`;
}

async function createMockRequest(
  body: any,
  customHeaders: Record<string, string> = {},
): Promise<NextRequest> {
  const payload = JSON.stringify(body);
  const signature =
    customHeaders["x-hub-signature-256"] ||
    createSignature(payload, env.GITHUB_WEBHOOK_SECRET);
  return await createMockNextRequest(body, {
    "x-github-delivery": "123",
    "x-hub-signature-256": signature,
    "x-github-event": "pull_request",
    ...customHeaders,
  });
}

function createPullRequestBody({
  action,
  repoFullName,
  prNumber,
  githubAccountId = 123,
}: {
  action: string;
  repoFullName: string;
  prNumber: number;
  githubAccountId?: number;
}) {
  return {
    action,
    pull_request: {
      id: 1,
      number: prNumber,
      state: "open",
      draft: false,
      merged: false,
      html_url: `https://github.com/${repoFullName}/pull/${prNumber}`,
      user: { login: "user", id: githubAccountId },
    },
    repository: {
      full_name: repoFullName,
      owner: {
        login: "owner",
        id: githubAccountId,
      },
      name: "repo",
    },
  };
}

describe("GitHub webhook route", () => {
  let githubAccountId: number;

  beforeAll(async () => {
    const testUserResult = await createTestUser({ db });
    githubAccountId = parseInt(testUserResult.githubAccount.id);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(updateGitHubPR).mockResolvedValue();
  });

  describe("webhook validation", () => {
    it("should return 401 for invalid signature", async () => {
      const request = await createMockRequest(
        { action: "opened" },
        { "x-hub-signature-256": "sha256=000" },
      );
      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(401);
      expect(data.error).toBe("Invalid signature");
    });

    it("should accept valid signature", async () => {
      const request = await createMockRequest({
        action: "opened",
        pull_request: { number: 123 },
        repository: { full_name: "owner/repo" },
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
    });
  });

  describe("PR processing", () => {
    it("should process relevant PR actions", async () => {
      const pr = await createTestGitHubPR({ db });
      const relevantActions = [
        "opened",
        "closed",
        "reopened",
        "ready_for_review",
        "converted_to_draft",
      ];

      for (const action of relevantActions) {
        const body = createPullRequestBody({
          action,
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
        });
        const request = await createMockRequest(body);

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
        expect(updateGitHubPR).toHaveBeenCalledWith({
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          createIfNotFound: false,
        });
      }
    });

    it("should handle draft PR being closed", async () => {
      // Create a test PR in the database
      const pr = await createTestGitHubPR({ db });
      const body = createPullRequestBody({
        action: "closed",
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
      });
      const request = await createMockRequest(body);
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
        createIfNotFound: false,
      });
    });

    it("should handle PR not found in database", async () => {
      // Don't create a PR in the database to test the not found case
      // Use a different PR number that definitely doesn't exist
      const nonExistentPRBody = createPullRequestBody({
        action: "opened",
        repoFullName: "owner/repo",
        prNumber: 999999,
      });
      const request = await createMockRequest(nonExistentPRBody);
      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).not.toHaveBeenCalled();
    });

    it("should return 500 for unexpected errors", async () => {
      const pr = await createTestGitHubPR({ db });
      const body = createPullRequestBody({
        action: "opened",
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
      });
      const request = await createMockRequest(body);
      // Mock updateGitHubPR to throw an error instead
      vi.mocked(updateGitHubPR).mockRejectedValue(new Error("Database error"));
      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });
  });

  describe("issue comment events (PR comment flow)", () => {
    function createValidIssueCommentBody({
      action = "created",
      repoFullName = "owner/repo",
      prNumber = 123,
      commentId,
      githubAccountId,
      commentBody,
      isPullRequest = true,
      issueTitle = "Default Issue Title",
      issueBody = "Default issue body description",
    }: {
      action?: "created" | "edited" | "deleted";
      repoFullName?: string;
      prNumber?: number;
      commentId?: number;
      githubAccountId: number | undefined;
      commentBody: string;
      isPullRequest?: boolean;
      issueTitle?: string;
      issueBody?: string | null;
    }) {
      return {
        action,
        issue: {
          number: prNumber,
          title: issueTitle,
          body: issueBody,
          pull_request: isPullRequest
            ? {
                url: `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
              }
            : undefined,
        },
        comment: {
          id: commentId,
          body: commentBody,
          user: {
            login: "commenter",
            id: githubAccountId,
          },
        },
        repository: {
          full_name: repoFullName,
          owner: {
            login: "owner",
            id: githubAccountId,
          },
          name: "repo",
        },
      };
    }

    it("should process app mentions in PR comments", async () => {
      const request = await createMockRequest(
        createValidIssueCommentBody({
          repoFullName: "owner/repo",
          prNumber: 123,
          githubAccountId,
          commentBody: "Hey @test-app, can you help fix this issue?",
        }),
        {
          "x-github-event": "issue_comment",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: "owner/repo",
        issueOrPrNumber: 123,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @test-app, can you help fix this issue?",
        commentGitHubAccountId: githubAccountId,
        commentType: "issue_comment",
        issueContext: undefined,
      });
    });

    it("WI-8: fast-acks 2xx (not 500) when a mention handler business-rejects", async () => {
      // e.g. App not installed on the repo / bad creds — a business rejection,
      // not a transient failure. GitHub must not retry it.
      vi.mocked(handleAppMention).mockRejectedValueOnce(
        new WebhookSkip("app_access_unavailable", "not installed", {
          repoFullName: "owner/repo",
        }),
      );
      const request = await createMockRequest(
        createValidIssueCommentBody({
          repoFullName: "owner/repo",
          prNumber: 123,
          githubAccountId,
          commentBody: "Hey @test-app, can you help fix this issue?",
        }),
        { "x-github-event": "issue_comment" },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.skipped).toBe(true);
      expect(data.category).toBe("app_access_unavailable");
    });

    it("should ignore comments without app mention", async () => {
      const bodyWithoutMention = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        githubAccountId,
        commentBody:
          "This is just a regular comment without mentioning the app",
      });

      const request = await createMockRequest(bodyWithoutMention, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should ignore edited or deleted comments", async () => {
      const editedCommentBody = createValidIssueCommentBody({
        action: "edited",
        commentBody: "Hey @test-app, can you help fix this issue?",
        githubAccountId,
      });
      const request = await createMockRequest(editedCommentBody, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should handle comments on issues (not PRs)", async () => {
      const issueCommentBody = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        commentId: 123456,
        githubAccountId,
        commentBody: "Hey @test-app, can you help fix this issue?",
        isPullRequest: false,
      });
      const request = await createMockRequest(issueCommentBody, {
        "x-github-event": "issue_comment",
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: "owner/repo",
        issueOrPrNumber: 123,
        issueOrPrType: "issue",
        commentId: 123456,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @test-app, can you help fix this issue?",
        commentGitHubAccountId: githubAccountId,
        commentType: "issue_comment",
        issueContext:
          "**Default Issue Title**\n\nDefault issue body description",
      });
    });

    it("should handle comments without user ID", async () => {
      const commentWithoutUserId = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        githubAccountId: undefined,
        commentBody: "Hey @test-app, please help!",
      });

      const request = await createMockRequest(commentWithoutUserId, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: "owner/repo",
        issueOrPrNumber: 123,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @test-app, please help!",
        commentGitHubAccountId: undefined,
        commentType: "issue_comment",
        issueContext: undefined,
      });
    });

    it("should handle case-insensitive app mentions", async () => {
      const caseInsensitiveMention = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        githubAccountId,
        commentBody: "Hey @TEST-APP, can you help?",
      });

      const request = await createMockRequest(caseInsensitiveMention, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: "owner/repo",
        issueOrPrNumber: 123,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "commenter",
        commentBody: "Hey @TEST-APP, can you help?",
        commentGitHubAccountId: githubAccountId,
        commentType: "issue_comment",
        issueContext: undefined,
      });
    });

    it("should handle multiple mentions in comment", async () => {
      const multipleMentions = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        githubAccountId,
        commentBody: "@other-user @test-app please review this @test-app",
      });

      const request = await createMockRequest(multipleMentions, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledTimes(1);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: "owner/repo",
        issueOrPrNumber: 123,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "commenter",
        commentBody: "@other-user @test-app please review this @test-app",
        commentGitHubAccountId: githubAccountId,
        commentType: "issue_comment",
        issueContext: undefined,
      });
    });

    it("should trigger on partial app name matches when app name is a prefix", async () => {
      const partialMatch = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        githubAccountId,
        commentBody: "This mentions @test-app-other which should trigger",
      });

      const request = await createMockRequest(partialMatch, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      // This will trigger because the regex only has word boundary at the end
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: "owner/repo",
        issueOrPrNumber: 123,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "commenter",
        commentBody: "This mentions @test-app-other which should trigger",
        commentGitHubAccountId: githubAccountId,
        commentType: "issue_comment",
        issueContext: undefined,
      });
    });

    it("should not trigger when app name is mentioned without @ prefix", async () => {
      const noAtPrefix = createValidIssueCommentBody({
        repoFullName: "owner/repo",
        prNumber: 123,
        githubAccountId,
        commentBody: "Just mentioning test-app without the @ symbol",
      });

      const request = await createMockRequest(noAtPrefix, {
        "x-github-event": "issue_comment",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should handle errors in handleAppMention gracefully", async () => {
      vi.mocked(handleAppMention).mockRejectedValue(
        new Error("Failed to create thread"),
      );
      const request = await createMockRequest(
        createValidIssueCommentBody({
          repoFullName: "owner/repo",
          prNumber: 123,
          githubAccountId,
          commentBody: "Hey @test-app, can you help fix this issue?",
        }),
        {
          "x-github-event": "issue_comment",
        },
      );
      const response = await POST(request);
      const data = await response.json();
      // The route should handle the error and return 500
      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });

    it("should pass issue title and body to handleAppMention", async () => {
      vi.mocked(handleAppMention).mockResolvedValue();

      const issueTitle = "Fix authentication bug in login flow";
      const issueBody = "Users are unable to login when using OAuth provider";

      const request = await createMockRequest(
        createValidIssueCommentBody({
          repoFullName: "owner/repo",
          prNumber: 456,
          githubAccountId,
          commentBody: "Hey @test-app, can you help fix this?",
          issueTitle,
          issueBody,
        }),
        {
          "x-github-event": "issue_comment",
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith(
        expect.objectContaining({
          repoFullName: "owner/repo",
          issueOrPrNumber: 456,
          issueOrPrType: "pull_request",
          commentGitHubUsername: "commenter",
          commentBody: "Hey @test-app, can you help fix this?",
          commentGitHubAccountId: githubAccountId,
        }),
      );
    });
  });

  describe("pull request review events", () => {
    function createValidPullRequestReviewBody({
      repoFullName,
      prNumber,
      githubAccountId,
      commentBody,
      action = "submitted",
      state = "commented",
      prTitle = "Default PR Title",
      prBody = "Default PR body description",
    }: {
      repoFullName: string;
      prNumber: number;
      githubAccountId: number | null;
      commentBody: string | null;
      action?: "submitted" | "edited" | "dismissed";
      state?: "commented" | "approved" | "changes_requested";
      prTitle?: string;
      prBody?: string | null;
    }) {
      return {
        action,
        review: {
          body: commentBody,
          user: {
            login: "reviewer",
            id: githubAccountId ?? undefined,
          },
          state,
        },
        pull_request: {
          number: prNumber,
          title: prTitle,
          body: prBody,
        },
        repository: {
          full_name: repoFullName,
          owner: {
            login: "owner",
          },
          name: "repo",
        },
      };
    }

    it("should process app mentions in PR reviews", async () => {
      vi.mocked(handleAppMention).mockResolvedValue();

      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "@test-app please take a look at this PR",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: githubPR.repoFullName,
        issueOrPrNumber: githubPR.number,
        issueOrPrType: "pull_request",
        commentGitHubUsername: "reviewer",
        commentBody: "@test-app please take a look at this PR",
        commentGitHubAccountId: githubAccountId,
      });
    });

    it("should ignore reviews without app mention", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "LGTM!",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should ignore reviews with null body", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: null,
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should ignore edited or dismissed reviews", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "LGTM!",
          action: "edited",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should handle different review states with mentions", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const reviewStates = [
        "approved",
        "changes_requested",
        "commented",
      ] as const;
      for (const state of reviewStates) {
        vi.resetAllMocks();
        const body = createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "@test-app LGTM!",
          state,
        });
        const request = await createMockRequest(body, {
          "x-github-event": "pull_request_review",
        });

        const response = await POST(request);
        const data = await response.json();
        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
        expect(handleAppMention).toHaveBeenCalledWith({
          repoFullName: githubPR.repoFullName,
          issueOrPrNumber: githubPR.number,
          issueOrPrType: "pull_request",
          commentGitHubUsername: "reviewer",
          commentBody: "@test-app LGTM!",
          commentGitHubAccountId: githubAccountId,
        });
      }
    });

    it("should handle reviews without user ID", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId: null,
          commentBody: "@test-app please take a look at this PR",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: githubPR.repoFullName,
        issueOrPrNumber: githubPR.number,
        issueOrPrType: "pull_request",
        commentGitHubUsername: "reviewer",
        commentBody: "@test-app please take a look at this PR",
        commentGitHubAccountId: undefined,
      });
    });

    it("should handle case-insensitive app mentions in reviews", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          githubAccountId,
          commentBody: "@TEST-APP needs your attention",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: githubPR.repoFullName,
        issueOrPrNumber: githubPR.number,
        issueOrPrType: "pull_request",
        commentGitHubUsername: "reviewer",
        commentBody: "@TEST-APP needs your attention",
        commentGitHubAccountId: githubAccountId,
      });
    });

    it("should handle errors in handleAppMention for reviews", async () => {
      vi.mocked(handleAppMention).mockRejectedValue(
        new Error("Failed to create thread"),
      );

      await createTestGitHubPR({
        db,
        overrides: {
          repoFullName: "owner/repo",
          number: 123,
          status: "open",
        },
      });
      const request = await createMockRequest(
        createValidPullRequestReviewBody({
          repoFullName: "owner/repo",
          prNumber: 123,
          githubAccountId,
          commentBody: "@test-app please take a look at this PR",
        }),
        {
          "x-github-event": "pull_request_review",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });
  });

  describe("pull request review comment events", () => {
    function createValidPullRequestReviewCommentBody({
      repoFullName,
      prNumber,
      githubAccountId,
      commentBody,
      action = "created",
      prTitle = "Default PR Title",
      prBody = "Default PR body description",
    }: {
      repoFullName: string;
      prNumber: number;
      githubAccountId: number | null;
      commentBody: string;
      action?: "created" | "edited" | "deleted";
      prTitle?: string;
      prBody?: string | null;
    }) {
      return {
        action,
        pull_request: {
          number: prNumber,
          title: prTitle,
          body: prBody,
        },
        comment: {
          body: commentBody,
          user: {
            login: "reviewer",
            id: githubAccountId ?? undefined,
          },
        },
        repository: {
          full_name: repoFullName,
          owner: {
            login: "owner",
          },
          name: "repo",
        },
      };
    }

    it("should process app mentions in PR review comments", async () => {
      vi.mocked(handleAppMention).mockResolvedValue();

      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewCommentBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          commentBody: "@test-app please review this code",
          githubAccountId,
        }),
        {
          "x-github-event": "pull_request_review_comment",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: githubPR.repoFullName,
        issueOrPrNumber: githubPR.number,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "reviewer",
        commentBody: "@test-app please review this code",
        commentGitHubAccountId: githubAccountId,
        commentType: "review_comment",
        diffContext: "",
        commentContext: undefined,
      });
    });

    it("should ignore review comments without app mention", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewCommentBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          commentBody: "This code looks good",
          githubAccountId,
        }),
        {
          "x-github-event": "pull_request_review_comment",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should ignore edited or deleted review comments", async () => {
      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewCommentBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          commentBody: "@test-app please review this code",
          githubAccountId,
          action: "edited",
        }),
        {
          "x-github-event": "pull_request_review_comment",
        },
      );

      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).not.toHaveBeenCalled();
    });

    it("should handle review comments without user ID", async () => {
      vi.mocked(handleAppMention).mockResolvedValue();

      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewCommentBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          commentBody: "@test-app check this",
          githubAccountId: null,
        }),
        {
          "x-github-event": "pull_request_review_comment",
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: githubPR.repoFullName,
        issueOrPrNumber: githubPR.number,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "reviewer",
        commentBody: "@test-app check this",
        commentGitHubAccountId: undefined,
        commentType: "review_comment",
        diffContext: "",
        commentContext: undefined,
      });
    });

    it("should handle case-insensitive app mentions in review comments", async () => {
      vi.mocked(handleAppMention).mockResolvedValue();

      const githubPR = await createTestGitHubPR({ db });
      const request = await createMockRequest(
        createValidPullRequestReviewCommentBody({
          repoFullName: githubPR.repoFullName,
          prNumber: githubPR.number,
          commentBody: "@TEST-APP please check this",
          githubAccountId,
        }),
        {
          "x-github-event": "pull_request_review_comment",
        },
      );
      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(handleAppMention).toHaveBeenCalledWith({
        repoFullName: githubPR.repoFullName,
        issueOrPrNumber: githubPR.number,
        issueOrPrType: "pull_request",
        commentId: undefined,
        commentGitHubUsername: "reviewer",
        commentBody: "@TEST-APP please check this",
        commentGitHubAccountId: githubAccountId,
        commentType: "review_comment",
        diffContext: "",
        commentContext: undefined,
      });
    });
  });

  describe("check run events", () => {
    function createCheckRunBody({
      action = "completed",
      repoFullName = "owner/repo",
      prNumbers = [123],
      checkRunId = 1,
      conclusion = "success",
      status = "completed",
    }: {
      action?: string;
      repoFullName?: string;
      prNumbers?: number[];
      checkRunId?: number;
      conclusion?: string | null;
      status?: string;
    }) {
      return {
        action,
        check_run: {
          id: checkRunId,
          status,
          conclusion,
          pull_requests: prNumbers.map((num) => ({ number: num })),
        },
        repository: {
          full_name: repoFullName,
          owner: { login: "owner" },
          name: "repo",
        },
      };
    }

    it("should update PR checks when check run is completed", async () => {
      const pr = await createTestGitHubPR({ db });
      const body = createCheckRunBody({
        repoFullName: pr.repoFullName,
        prNumbers: [pr.number],
        conclusion: "success",
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_run",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
        createIfNotFound: false,
      });
    });

    it("should handle check runs with multiple PRs", async () => {
      const pr1 = await createTestGitHubPR({ db });
      const pr2 = await createTestGitHubPR({
        db,
        overrides: {
          number: pr1.number + 1,
          repoFullName: pr1.repoFullName,
        },
      });

      const body = createCheckRunBody({
        repoFullName: pr1.repoFullName,
        prNumbers: [pr1.number, pr2.number],
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_run",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).toHaveBeenCalledTimes(2);
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr1.repoFullName,
        prNumber: pr1.number,
        createIfNotFound: false,
      });
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr2.repoFullName,
        prNumber: pr2.number,
        createIfNotFound: false,
      });
    });

    it("should handle check runs with no associated PRs", async () => {
      const body = createCheckRunBody({
        prNumbers: [],
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_run",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).not.toHaveBeenCalled();
    });

    it("should handle different check run actions", async () => {
      const pr = await createTestGitHubPR({ db });
      const actions = ["created", "completed", "rerequested"];

      for (const action of actions) {
        vi.clearAllMocks();
        const body = createCheckRunBody({
          action,
          repoFullName: pr.repoFullName,
          prNumbers: [pr.number],
        });
        const request = await createMockRequest(body, {
          "x-github-event": "check_run",
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
        expect(updateGitHubPR).toHaveBeenCalledWith({
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          createIfNotFound: false,
        });
      }
    });

    it("should handle check run errors gracefully", async () => {
      vi.mocked(updateGitHubPR).mockRejectedValue(new Error("API error"));

      const pr = await createTestGitHubPR({ db });
      const body = createCheckRunBody({
        repoFullName: pr.repoFullName,
        prNumbers: [pr.number],
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_run",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });
  });

  describe("check suite events", () => {
    function createCheckSuiteBody({
      action = "completed",
      repoFullName = "owner/repo",
      prNumbers = [123],
      checkSuiteId = 1,
      conclusion = "success",
      status = "completed",
    }: {
      action?: string;
      repoFullName?: string;
      prNumbers?: number[];
      checkSuiteId?: number;
      conclusion?: string | null;
      status?: string;
    }) {
      return {
        action,
        check_suite: {
          id: checkSuiteId,
          status,
          conclusion,
          pull_requests: prNumbers.map((num) => ({ number: num })),
        },
        repository: {
          full_name: repoFullName,
          owner: { login: "owner" },
          name: "repo",
        },
      };
    }

    beforeEach(() => {
      vi.mocked(updateGitHubPR).mockResolvedValue();
    });

    it("should update PR checks when check suite is completed", async () => {
      const pr = await createTestGitHubPR({ db });
      const body = createCheckSuiteBody({
        repoFullName: pr.repoFullName,
        prNumbers: [pr.number],
        conclusion: "success",
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_suite",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
        createIfNotFound: false,
      });
    });

    it("should handle check suites with multiple PRs", async () => {
      const pr1 = await createTestGitHubPR({ db });
      const pr2 = await createTestGitHubPR({
        db,
        overrides: {
          number: pr1.number + 1,
          repoFullName: pr1.repoFullName,
        },
      });

      const body = createCheckSuiteBody({
        repoFullName: pr1.repoFullName,
        prNumbers: [pr1.number, pr2.number],
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_suite",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).toHaveBeenCalledTimes(2);
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr1.repoFullName,
        prNumber: pr1.number,
        createIfNotFound: false,
      });
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr2.repoFullName,
        prNumber: pr2.number,
        createIfNotFound: false,
      });
    });

    it("should handle check suites with no associated PRs", async () => {
      const body = createCheckSuiteBody({
        prNumbers: [],
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_suite",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(updateGitHubPR).not.toHaveBeenCalled();
    });

    it("should handle different check suite actions", async () => {
      const pr = await createTestGitHubPR({ db });
      const actions = ["completed", "rerequested"];

      for (const action of actions) {
        vi.clearAllMocks();
        const body = createCheckSuiteBody({
          action,
          repoFullName: pr.repoFullName,
          prNumbers: [pr.number],
        });
        const request = await createMockRequest(body, {
          "x-github-event": "check_suite",
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
        expect(updateGitHubPR).toHaveBeenCalledWith({
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          createIfNotFound: false,
        });
      }
    });

    it("should handle check suite errors gracefully", async () => {
      vi.mocked(updateGitHubPR).mockRejectedValue(new Error("API error"));

      const pr = await createTestGitHubPR({ db });
      const body = createCheckSuiteBody({
        repoFullName: pr.repoFullName,
        prNumbers: [pr.number],
      });
      const request = await createMockRequest(body, {
        "x-github-event": "check_suite",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Internal server error");
    });
  });

  describe("issue events", () => {
    function createIssueBody(action: string) {
      return {
        action,
        issue: { number: 7, user: { login: "octocat" }, labels: [] },
        label: { name: "automata:auto-fix" },
        repository: {
          full_name: "owner/repo",
          owner: { login: "owner" },
          name: "repo",
        },
      };
    }

    beforeEach(() => {
      vi.mocked(handleIssueEvent).mockResolvedValue();
      vi.mocked(handleIssueLabeledMirror).mockResolvedValue();
    });

    it("issues.labeled reaches both the mirror intake and the issue automations", async () => {
      const request = await createMockRequest(createIssueBody("labeled"), {
        "x-github-event": "issues",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(handleIssueLabeledMirror).toHaveBeenCalledTimes(1);
      expect(handleIssueEvent).toHaveBeenCalledTimes(1);
    });

    it.each(["closed", "unlabeled"])(
      "R7: issues.%s reaches only the self-heal unready handler",
      async (action) => {
        vi.mocked(handleSelfHealIssueUnready).mockResolvedValue();
        const request = await createMockRequest(createIssueBody(action), {
          "x-github-event": "issues",
        });
        const response = await POST(request);
        expect(response.status).toBe(200);
        expect(handleSelfHealIssueUnready).toHaveBeenCalledTimes(1);
        expect(handleIssueEvent).not.toHaveBeenCalled();
        expect(handleIssueLabeledMirror).not.toHaveBeenCalled();
      },
    );

    it("issues.reopened reaches only the self-heal reopened handler", async () => {
      vi.mocked(handleSelfHealIssueReopened).mockResolvedValue();
      const request = await createMockRequest(createIssueBody("reopened"), {
        "x-github-event": "issues",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(handleSelfHealIssueReopened).toHaveBeenCalledTimes(1);
      expect(handleSelfHealIssueUnready).not.toHaveBeenCalled();
      expect(handleIssueEvent).not.toHaveBeenCalled();
      expect(handleIssueLabeledMirror).not.toHaveBeenCalled();
    });

    it("issues.opened reaches only the issue automations", async () => {
      const request = await createMockRequest(createIssueBody("opened"), {
        "x-github-event": "issues",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(handleIssueEvent).toHaveBeenCalledTimes(1);
      expect(handleIssueLabeledMirror).not.toHaveBeenCalled();
    });
  });
  describe("self-heal CI completion (GATE-01)", () => {
    const SHA = "c".repeat(40);

    it("check_suite.completed reaches the self-heal handler AND the existing check handler", async () => {
      const pr = await createTestGitHubPR({ db });
      const body = {
        action: "completed",
        check_suite: {
          id: 1,
          head_sha: SHA,
          status: "completed",
          conclusion: "success",
          pull_requests: [{ number: pr.number }],
        },
        repository: {
          full_name: pr.repoFullName,
          owner: { login: "owner" },
          name: "repo",
        },
      };
      const request = await createMockRequest(body, {
        "x-github-event": "check_suite",
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(handleSelfHealCiEvent).toHaveBeenCalledTimes(1);
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
        createIfNotFound: false,
      });
    });

    it("check_suite.rerequested does not reach the self-heal handler", async () => {
      const request = await createMockRequest(
        {
          action: "rerequested",
          check_suite: { id: 1, head_sha: SHA, pull_requests: [] },
          repository: {
            full_name: "owner/repo",
            owner: { login: "owner" },
            name: "repo",
          },
        },
        { "x-github-event": "check_suite" },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(handleSelfHealCiEvent).not.toHaveBeenCalled();
    });

    it("workflow_run.completed reaches the self-heal handler AND the existing workflow handler", async () => {
      const request = await createMockRequest(
        {
          action: "completed",
          workflow_run: {
            id: 9,
            name: "ci",
            head_sha: SHA,
            head_branch: "automata/fix-1-abcdef01-a1",
            conclusion: "success",
          },
          repository: {
            full_name: "owner/repo",
            owner: { login: "owner" },
            name: "repo",
          },
        },
        { "x-github-event": "workflow_run" },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(handleSelfHealCiEvent).toHaveBeenCalledTimes(1);
      expect(handleWorkflowRunEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleSelfHealCiEvent (DB-first)", () => {
    const REPO = "acme/widgets";
    let orgId: string;
    let attemptId: string;
    let sha: string;

    const payload = (headSha: string, repo = REPO) => ({
      action: "completed",
      check_suite: { head_sha: headSha },
      repository: { full_name: repo },
    });

    beforeEach(async () => {
      sha = crypto.randomBytes(20).toString("hex");
      orgId = (
        await createOrganization({
          db,
          name: "Org",
          slug: `org-${nanoid(8).toLowerCase()}`,
        })
      ).id;
      const finding = await insertFinding({
        db,
        organizationId: orgId,
        finding: {
          repoFullName: REPO,
          fingerprint: "0123456789abcdef",
          audit: "security-audit",
          ruleId: "dep.vulnerable",
          severity: "high",
          checkKind: "script",
          title: "Vulnerable dependency",
          subject: "lodash",
          planFiles: ["src/a.ts"],
          status: "open",
          issueNumber: 42,
          autoFixLabeled: true,
          fixReadyAt: new Date(),
        },
      });
      const claimed = await claimFixAttempt({
        db,
        organizationId: orgId,
        findingId: finding.id,
        maxAttempts: 3,
        cooldownMin: 30,
        branchFor: (n) => `automata/fix-42-01234567-a${n}`,
      });
      if (!claimed) throw new Error("claim failed");
      attemptId = claimed.attempt.id;
      await updateFixAttempt({
        db,
        organizationId: orgId,
        id: attemptId,
        patch: {
          phase: "ci_pending",
          prState: "draft",
          prNumber: 501,
          prOpenedAt: new Date(),
          gatedHeadSha: sha,
          checkStatus: "passed",
        },
      });
    });

    it("a head sha no draft is gated on → no evaluation, no Octokit, no waitUntil", async () => {
      const evaluate = vi.fn();
      await handleSelfHealCiEvent(payload("e".repeat(40)), { evaluate });
      expect(evaluate).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
      expect(createSelfHealOctokit).not.toHaveBeenCalled();
    });

    it("a payload without a head sha or repo is ignored", async () => {
      const evaluate = vi.fn();
      await handleSelfHealCiEvent({ action: "completed" }, { evaluate });
      await handleSelfHealCiEvent(payload(sha, "other/repo"), { evaluate });
      expect(evaluate).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
    });

    it("the gated head of a draft → waitUntil(evaluateFixCi) once, no GitHub call inline", async () => {
      const evaluate = vi.fn(async (_args: unknown) => "pending" as const);
      await handleSelfHealCiEvent(payload(sha, "ACME/Widgets"), { evaluate });
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
        organizationId: orgId,
        attemptId,
      });
      expect(createSelfHealOctokit).not.toHaveBeenCalled();
    });

    it("a head branch outside automata/fix-* never reaches the DB", async () => {
      const failing = {
        select: vi.fn(),
        transaction: vi.fn(),
      };
      const evaluate = vi.fn();
      await handleSelfHealCiEvent(
        {
          ...payload(sha),
          check_suite: { head_sha: sha, head_branch: "main" },
        },
        { db: failing as unknown as typeof db, evaluate },
      );
      expect(failing.select).not.toHaveBeenCalled();
      expect(failing.transaction).not.toHaveBeenCalled();
      expect(evaluate).not.toHaveBeenCalled();
    });

    it("the draft's own fix branch is still looked up", async () => {
      const evaluate = vi.fn(async (_args: unknown) => "pending" as const);
      await handleSelfHealCiEvent(
        {
          ...payload(sha),
          check_suite: {
            head_sha: sha,
            head_branch: "automata/fix-42-01234567-a1",
          },
        },
        { evaluate },
      );
      expect(evaluate).toHaveBeenCalledTimes(1);
    });

    it("a draft already marked ready is not re-evaluated", async () => {
      await updateFixAttempt({
        db,
        organizationId: orgId,
        id: attemptId,
        patch: { prState: "ready", phase: "ready" },
      });
      const evaluate = vi.fn();
      await handleSelfHealCiEvent(payload(sha), { evaluate });
      expect(evaluate).not.toHaveBeenCalled();
    });

    it("never throws (a DB failure is logged)", async () => {
      const failing = {
        select: () => {
          throw new Error("db down");
        },
        transaction: () => {
          throw new Error("db down");
        },
      } as unknown as typeof db;
      vi.spyOn(console, "error").mockImplementationOnce(() => undefined);
      await expect(
        handleSelfHealCiEvent(payload(sha), { db: failing, evaluate: vi.fn() }),
      ).resolves.toBeUndefined();
    });
  });
  describe("self-heal fix PR lifecycle (R5)", () => {
    it("pull_request.closed reaches the self-heal handler AND both existing closed handlers", async () => {
      const pr = await createTestGitHubPR({ db });
      const body = createPullRequestBody({
        action: "closed",
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
      });
      const response = await POST(await createMockRequest(body));
      expect(response.status).toBe(200);
      expect(handleSelfHealPrClosed).toHaveBeenCalledTimes(1);
      expect(handlePullRequestStatusChange).toHaveBeenCalledTimes(1);
      expect(handlePullRequestMirror).toHaveBeenCalledTimes(1);
      expect(updateGitHubPR).toHaveBeenCalledWith({
        repoFullName: pr.repoFullName,
        prNumber: pr.number,
        createIfNotFound: false,
      });
      // Not a self-heal fix PR: one lookup, no GitHub client, nothing deferred.
      expect(createSelfHealOctokit).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
    });

    it("other pull_request actions do not reach the self-heal handler", async () => {
      const pr = await createTestGitHubPR({ db });
      for (const action of ["opened", "reopened", "ready_for_review"]) {
        const body = createPullRequestBody({
          action,
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
        });
        const response = await POST(await createMockRequest(body));
        expect(response.status).toBe(200);
      }
      expect(handleSelfHealPrClosed).not.toHaveBeenCalled();
    });
  });
});
