import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { getOctokitForApp } from "@/lib/github";
import { runAutomation } from "@/server-lib/automations";
import { getRepoInstallationId } from "@terragon/shared/github-app";
import { createAutomation } from "@terragon/shared/model/automations";
import { createOrganization } from "@terragon/shared/model/organizations";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import type { DBUserMessage } from "@terragon/shared";
import { handleAppMention } from "./handle-app-mention";
import {
  handleIssueCommentEvent,
  handlePullRequestReviewCommentEvent,
  handlePullRequestReviewEvent,
  type IssueCommentEvent,
  type PullRequestReviewCommentEvent,
  type PullRequestReviewEvent,
} from "./handlers";
import {
  CROSS_REPO_MENTION_REPLY,
  MENTION_NOT_STARTED_REPLY,
  analyseMention,
  authorizeCommenter,
  emptyMentionReply,
  mentionSlug,
} from "./org-mention-lane";

/**
 * The org-owned mention lane: legacy mention match, the fail-closed commenter
 * gate, and routing — the lane owns a repo's mentions only while an ENABLED
 * orgLane github_mention automation exists for it.
 *
 * protects: the legacy per-user path stays untouched for repos without the
 *   automation; the lane never starts a thread for an unauthorised commenter,
 *   a bot, a near-miss handle or an empty instruction; a repo-level webhook
 *   (no installation in the payload) still resolves its org.
 * fails_when: a disabled automation still captures mentions, the gate allows
 *   on an API error or a low association, the stamp/prompt lose the comment.
 * no_claim: the agent run itself (runAutomation is mocked) and GitHub's real
 *   permission semantics beyond `permission` / `role_name`.
 */

vi.mock("./handle-app-mention", () => ({
  handleAppMention: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/server-lib/automations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server-lib/automations")>()),
  runAutomation: vi.fn(() =>
    Promise.resolve({ threadId: "t-1", threadChatId: "c-1" }),
  ),
}));
vi.mock("@terragon/shared/github-app", () => ({
  getRepoInstallationId: vi.fn(),
  getInstallationToken: vi.fn(async () => "mock-github-token"),
  lookupInstallationId: vi.fn(async () => 424242),
}));

const SLUG = "test-app";

describe("analyseMention (legacy whole-token match)", () => {
  it("matches case-insensitively and strips every mention", () => {
    expect(analyseMention("@Test-App fix the typo", SLUG)).toEqual({
      mentioned: true,
      instruction: "fix the typo",
    });
    expect(analyseMention("(@test-app) why? cc @test-app", SLUG)).toEqual({
      mentioned: true,
      instruction: "() why? cc",
    });
    expect(analyseMention("hey @test-app, review\nplease", SLUG)).toEqual({
      mentioned: true,
      instruction: "hey , review\nplease",
    });
  });

  it("ignores near misses: a longer handle, an email, a suffix", () => {
    for (const body of [
      "@test-app-other do it",
      "@test-app_x do it",
      "@test-apps do it",
      "mail me@test-app now",
      "test-app do it",
    ]) {
      expect(analyseMention(body, SLUG), body).toEqual({ mentioned: false });
    }
  });

  it("an empty remaining instruction is null", () => {
    expect(analyseMention("@test-app", SLUG)).toEqual({
      mentioned: true,
      instruction: null,
    });
    expect(analyseMention("  @test-app \n @TEST-APP  ", SLUG)).toEqual({
      mentioned: true,
      instruction: null,
    });
  });

  it("the slug drops the App's [bot] suffix", () => {
    expect(mentionSlug("automata-ai[bot]")).toBe("automata-ai");
    expect(mentionSlug("  ")).toBeNull();
    expect(mentionSlug()).toBe(SLUG);
  });
});

describe("authorizeCommenter (fail-closed)", () => {
  it("allows a trusted association with write, maintain or admin", async () => {
    for (const [permission, roleName] of [
      ["write", "write"],
      ["admin", "admin"],
      ["write", "maintain"],
    ] as const) {
      const decision = await authorizeCommenter({
        association: "MEMBER",
        readPermission: async () => ({ permission, roleName }),
      });
      expect(decision.allowed, `${permission}/${roleName}`).toBe(true);
    }
  });

  it("denies a low association without asking the API", async () => {
    const readPermission = vi.fn(async () => ({ permission: "admin" }));
    for (const association of ["CONTRIBUTOR", "NONE", "FIRST_TIMER", null]) {
      expect(
        await authorizeCommenter({ association, readPermission }),
      ).toMatchObject({ allowed: false, reason: "association_prefilter" });
    }
    expect(readPermission).not.toHaveBeenCalled();
  });

  it("denies read/triage and any API failure", async () => {
    expect(
      await authorizeCommenter({
        association: "COLLABORATOR",
        readPermission: async () => ({
          permission: "read",
          roleName: "triage",
        }),
      }),
    ).toMatchObject({ allowed: false, reason: "insufficient_permission" });
    expect(
      await authorizeCommenter({
        association: "OWNER",
        readPermission: async () => {
          throw new Error("502");
        },
      }),
    ).toMatchObject({ allowed: false, reason: "permission_api_error" });
    expect(
      await authorizeCommenter({
        association: "OWNER",
        readPermission: async () => ({}),
      }),
    ).toMatchObject({ allowed: false, reason: "insufficient_permission" });
  });
});

describe("routing: org lane vs the legacy per-user path", () => {
  let ownerUserId: string;
  let organizationId: string;
  let installationId: number;
  let octokit: ReturnType<typeof fakeOctokit>;

  function fakeOctokit(permission = "write") {
    return {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: vi.fn(async () => ({
            data: { permission, role_name: permission },
          })),
          get: vi.fn(async () => ({ data: { default_branch: "main" } })),
        },
        pulls: {
          get: vi.fn(async () => ({
            data: {
              head: { ref: "feature/x", repo: { full_name: "acme/same" } },
              base: { ref: "main", repo: { full_name: "acme/same" } },
            },
          })),
          createReplyForReviewComment: vi.fn(async () => ({ data: {} })),
        },
        issues: { createComment: vi.fn(async () => ({ data: {} })) },
        reactions: {
          createForIssueComment: vi.fn(async () => ({ data: {} })),
          createForPullRequestReviewComment: vi.fn(async () => ({ data: {} })),
        },
      },
    };
  }

  async function repoWithLane({
    enabled = true,
    orgLane = true,
    orgId = organizationId,
  }: { enabled?: boolean; orgLane?: boolean; orgId?: string } = {}) {
    const repoFullName = `acme/widgets-${nanoid(6).toLowerCase()}`;
    const automation = await createAutomation({
      db,
      userId: ownerUserId,
      accessTier: "pro",
      organizationId: orgId,
      automation: {
        name: "GitHub mention (github-mention)",
        repoFullName,
        branchName: "main",
        enabled,
        triggerType: "github_mention",
        triggerConfig: { filter: orgLane ? { orgLane: true } : {} },
        action: {
          type: "skill_message",
          config: {
            skillName: "github-mention",
            version: "latest",
            model: "opus",
          },
        },
        disableGitCheckpointing: true,
      },
    });
    return { repoFullName, automationId: automation.id };
  }

  function issueComment({
    repoFullName,
    body = "@test-app why is the build red?",
    login = "alice",
    type = "User",
    association = "MEMBER",
    pr = true,
    withInstallation = true,
  }: {
    repoFullName: string;
    body?: string;
    login?: string;
    type?: string;
    association?: string;
    pr?: boolean;
    withInstallation?: boolean;
  }): IssueCommentEvent {
    return {
      action: "created",
      ...(withInstallation ? { installation: { id: installationId } } : {}),
      issue: {
        number: 7,
        title: "t",
        body: "b",
        ...(pr ? { pull_request: { url: "x" } } : {}),
      },
      comment: {
        id: Math.floor(Math.random() * 1e9),
        body,
        author_association: association,
        user: { login, id: 1, type },
      },
      repository: { full_name: repoFullName },
    } as unknown as IssueCommentEvent;
  }

  beforeAll(async () => {
    const { user } = await createTestUser({ db });
    ownerUserId = user.id;
    const org = await createOrganization({
      db,
      name: "Acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    organizationId = org.id;
    installationId = Math.floor(Math.random() * 1_000_000_000);
    await bindGithubInstallationToOrg({
      db,
      installationId,
      organizationId,
      mode: "active",
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    octokit = fakeOctokit();
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as never);
  });

  it("no org-lane automation → the legacy path runs, unchanged", async () => {
    const { repoFullName } = await repoWithLane({ orgLane: false });
    await handleIssueCommentEvent(issueComment({ repoFullName }));
    expect(handleAppMention).toHaveBeenCalledTimes(1);
    expect(runAutomation).not.toHaveBeenCalled();
  });

  it("a DISABLED org-lane automation → the legacy path runs", async () => {
    const { repoFullName } = await repoWithLane({ enabled: false });
    await handleIssueCommentEvent(issueComment({ repoFullName }));
    expect(handleAppMention).toHaveBeenCalledTimes(1);
    expect(runAutomation).not.toHaveBeenCalled();
  });

  it("an enabled org-lane automation wins: one thread as the owner, stamped, legacy skipped", async () => {
    const { repoFullName, automationId } = await repoWithLane();
    const event = issueComment({ repoFullName });
    await handleIssueCommentEvent(event);
    expect(handleAppMention).not.toHaveBeenCalled();
    expect(runAutomation).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runAutomation).mock.calls[0]![0];
    expect(call.userId).toBe(ownerUserId);
    expect(call.automationId).toBe(automationId);
    expect(call.options?.prNumber).toBe(7);
    expect(call.options?.branchName).toBe("feature/x");
    expect(call.options?.prBaseBranchName).toBe("main");
    expect(call.options?.stampExtra?.mention).toEqual({
      repoFullName,
      issueOrPrNumber: 7,
      isPullRequest: true,
      commentId: event.comment.id,
      commentKind: "issue",
      commenterLogin: "alice",
    });
    const message: DBUserMessage = {
      type: "user",
      model: "opus",
      parts: [{ type: "text", text: "SKILL BODY" }],
      timestamp: "2026-10-20T00:00:00Z",
    };
    const sent = call.options!.transformMessage!(message);
    const text = sent.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    // A PR mention leads with the control-plane PR facts (base, head, diff
    // command), then the skill body, then the mention block.
    expect(sent.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(
        /^PR #7: base `main`, head `feature\/x`\. The change under review is `git diff origin\/main\.\.\.HEAD`/,
      ),
    });
    expect(sent.parts[1]).toEqual({ type: "text", text: "SKILL BODY" });
    expect(text).toContain("## Mention");
    expect(text).toContain('<user_content source="github_issue_comment">');
    expect(text).toContain("Commenter: @alice");
    expect(text).toContain("why is the build red?");
    expect(text).not.toContain("@test-app why");
    expect(octokit.rest.reactions.createForIssueComment).toHaveBeenCalled();
  });

  it("a redelivered comment starts no second thread", async () => {
    const { repoFullName } = await repoWithLane();
    const event = issueComment({ repoFullName });
    await handleIssueCommentEvent(event);
    await handleIssueCommentEvent(event);
    expect(runAutomation).toHaveBeenCalledTimes(1);
  });

  it("an issue mention: no PR number, the default branch, issueNumber set", async () => {
    const { repoFullName } = await repoWithLane();
    await handleIssueCommentEvent(issueComment({ repoFullName, pr: false }));
    const call = vi.mocked(runAutomation).mock.calls[0]![0];
    expect(call.options?.prNumber).toBeUndefined();
    expect(call.options?.issueNumber).toBe(7);
    expect(call.options?.branchName).toBe("main");
    expect(call.options?.stampExtra?.mention?.isPullRequest).toBe(false);
  });

  it("repo-level hook: no installation in the payload → looked up from the App", async () => {
    const { repoFullName } = await repoWithLane();
    vi.mocked(getRepoInstallationId).mockResolvedValue(installationId);
    await handleIssueCommentEvent(
      issueComment({ repoFullName, withInstallation: false }),
    );
    const [owner, repo] = repoFullName.split("/");
    expect(getRepoInstallationId).toHaveBeenCalledWith(owner, repo);
    expect(runAutomation).toHaveBeenCalledTimes(1);
  });

  it("the payload's installation is used as is (no App lookup)", async () => {
    const { repoFullName } = await repoWithLane();
    await handleIssueCommentEvent(issueComment({ repoFullName }));
    expect(getRepoInstallationId).not.toHaveBeenCalled();
  });

  it("an installation bound to ANOTHER org → skipped, no thread, no legacy", async () => {
    const other = await createOrganization({
      db,
      name: "Other",
      slug: `other-${nanoid(8).toLowerCase()}`,
    });
    const { repoFullName } = await repoWithLane({ orgId: other.id });
    await handleIssueCommentEvent(issueComment({ repoFullName }));
    expect(runAutomation).not.toHaveBeenCalled();
    expect(handleAppMention).not.toHaveBeenCalled();
  });

  it("an unauthorised commenter (read access, or a low association) starts nothing", async () => {
    const { repoFullName } = await repoWithLane();
    octokit = fakeOctokit("read");
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as never);
    await handleIssueCommentEvent(issueComment({ repoFullName }));
    await handleIssueCommentEvent(
      issueComment({ repoFullName, association: "CONTRIBUTOR" }),
    );
    expect(runAutomation).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("a permission API error denies (fail-closed)", async () => {
    const { repoFullName } = await repoWithLane();
    octokit.rest.repos.getCollaboratorPermissionLevel.mockRejectedValue(
      new Error("boom"),
    );
    await handleIssueCommentEvent(issueComment({ repoFullName }));
    expect(runAutomation).not.toHaveBeenCalled();
  });

  it("bots and the App itself never trigger it", async () => {
    const { repoFullName } = await repoWithLane();
    for (const [login, type] of [
      ["dependabot[bot]", "Bot"],
      ["test-app[bot]", "Bot"],
      ["sneaky", "Bot"],
    ]) {
      await handleIssueCommentEvent(
        issueComment({ repoFullName, login, type }),
      );
    }
    expect(runAutomation).not.toHaveBeenCalled();
    expect(handleAppMention).not.toHaveBeenCalled();
  });

  it("a near-miss handle is ignored on an org-lane repo", async () => {
    const { repoFullName } = await repoWithLane();
    await handleIssueCommentEvent(
      issueComment({ repoFullName, body: "@test-app-other do it" }),
    );
    expect(runAutomation).not.toHaveBeenCalled();
    expect(handleAppMention).not.toHaveBeenCalled();
  });

  it("an empty instruction gets one short reply and no thread", async () => {
    const { repoFullName } = await repoWithLane();
    await handleIssueCommentEvent(
      issueComment({ repoFullName, body: "@test-app" }),
    );
    expect(runAutomation).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(
      (octokit.rest.issues.createComment.mock.calls[0] as unknown[])[0],
    ).toMatchObject({
      body: `@alice ${emptyMentionReply(SLUG)}`,
    });
  });

  it("a review comment: in-thread kind, anchor and hunk on the stamp", async () => {
    const { repoFullName } = await repoWithLane();
    const event = {
      action: "created",
      installation: { id: installationId },
      pull_request: { number: 9 },
      comment: {
        id: 5555,
        in_reply_to_id: 4444,
        body: "@test-app rename this",
        author_association: "COLLABORATOR",
        user: { login: "bob", id: 2, type: "User" },
        path: "src/a.ts",
        line: 12,
        diff_hunk: "@@ -1,2 +1,2 @@\n-a\n+b",
      },
      repository: { full_name: repoFullName },
    } as unknown as PullRequestReviewCommentEvent;
    await handlePullRequestReviewCommentEvent(event);
    expect(handleAppMention).not.toHaveBeenCalled();
    const call = vi.mocked(runAutomation).mock.calls[0]![0];
    expect(call.options?.stampExtra?.mention).toMatchObject({
      commentKind: "review_comment",
      commentId: 5555,
      inReplyToId: 4444,
      path: "src/a.ts",
      line: 12,
      diffHunk: "@@ -1,2 +1,2 @@\n-a\n+b",
      commenterLogin: "bob",
    });
    expect(
      octokit.rest.reactions.createForPullRequestReviewComment,
    ).toHaveBeenCalled();
  });

  it("shadow installation: the thread is created, but no reaction and no reply", async () => {
    const shadowOrg = await createOrganization({
      db,
      name: "Shadow",
      slug: `shadow-${nanoid(8).toLowerCase()}`,
    });
    const shadowInstallation = Math.floor(Math.random() * 1_000_000_000);
    await bindGithubInstallationToOrg({
      db,
      installationId: shadowInstallation,
      organizationId: shadowOrg.id,
      mode: "shadow",
    });
    const { repoFullName } = await repoWithLane({ orgId: shadowOrg.id });
    const event = issueComment({ repoFullName });
    (event as unknown as { installation: { id: number } }).installation.id =
      shadowInstallation;
    await handleIssueCommentEvent(event);
    expect(runAutomation).toHaveBeenCalledTimes(1);
    expect(octokit.rest.reactions.createForIssueComment).not.toHaveBeenCalled();
    const empty = issueComment({ repoFullName, body: "@test-app" });
    (empty as unknown as { installation: { id: number } }).installation.id =
      shadowInstallation;
    await handleIssueCommentEvent(empty);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("a review BODY mention on an org-lane repo is neither answered nor sent to legacy", async () => {
    const { repoFullName } = await repoWithLane();
    await handlePullRequestReviewEvent({
      action: "submitted",
      installation: { id: installationId },
      pull_request: { number: 9 },
      review: { id: 1, body: "@test-app look", user: { login: "bob", id: 2 } },
      repository: { full_name: repoFullName },
    } as unknown as PullRequestReviewEvent);
    expect(handleAppMention).not.toHaveBeenCalled();
    expect(runAutomation).not.toHaveBeenCalled();
  });
  it("a fork PR: one short reply, no thread, no reaction", async () => {
    const { repoFullName } = await repoWithLane();
    for (const head of [
      { ref: "main", repo: { full_name: "mallory/widgets" } },
      // A deleted fork: no head repo at all fails closed.
      { ref: "main", repo: null },
    ]) {
      octokit.rest.pulls.get.mockResolvedValueOnce({
        data: { head, base: { ref: "main", repo: { full_name: "acme/same" } } },
      } as never);
      await handleIssueCommentEvent(issueComment({ repoFullName }));
    }
    expect(runAutomation).not.toHaveBeenCalled();
    expect(handleAppMention).not.toHaveBeenCalled();
    expect(octokit.rest.reactions.createForIssueComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
    expect(
      (octokit.rest.issues.createComment.mock.calls[0] as unknown[])[0],
    ).toMatchObject({ body: `@alice ${CROSS_REPO_MENTION_REPLY}` });
  });

  it("no thread started (runAutomation returned nothing or threw) → one notice, never silence", async () => {
    const { repoFullName } = await repoWithLane();
    vi.mocked(runAutomation).mockResolvedValueOnce(undefined);
    await handleIssueCommentEvent(issueComment({ repoFullName }));
    vi.mocked(runAutomation).mockRejectedValueOnce(new Error("no credits"));
    await handleIssueCommentEvent(issueComment({ repoFullName }));
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
    for (const call of octokit.rest.issues.createComment.mock.calls) {
      expect((call as unknown[])[0]).toMatchObject({
        body: `@alice ${MENTION_NOT_STARTED_REPLY}`,
      });
    }
  });

  it("a failed PR read releases the claim: the delivery fails, a redelivery retries", async () => {
    const { repoFullName } = await repoWithLane();
    const event = issueComment({ repoFullName });
    octokit.rest.pulls.get.mockRejectedValueOnce(new Error("502"));
    await expect(handleIssueCommentEvent(event)).rejects.toThrow("502");
    expect(runAutomation).not.toHaveBeenCalled();
    await handleIssueCommentEvent(event);
    expect(runAutomation).toHaveBeenCalledTimes(1);
  });

  it("a redelivered empty mention is answered once", async () => {
    const { repoFullName } = await repoWithLane();
    const event = issueComment({ repoFullName, body: "@test-app" });
    await handleIssueCommentEvent(event);
    await handleIssueCommentEvent(event);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("an empty review-comment mention replies in the thread (to its first comment), no @-prefix", async () => {
    const { repoFullName } = await repoWithLane();
    await handlePullRequestReviewCommentEvent({
      action: "created",
      installation: { id: installationId },
      pull_request: { number: 9 },
      comment: {
        id: 7777,
        in_reply_to_id: 7000,
        body: "@test-app",
        author_association: "MEMBER",
        user: { login: "bob", id: 2, type: "User" },
        path: "src/a.ts",
        line: 1,
        diff_hunk: "@@",
      },
      repository: { full_name: repoFullName },
    } as unknown as PullRequestReviewCommentEvent);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.createReplyForReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 9,
        comment_id: 7000,
        body: emptyMentionReply(SLUG),
      }),
    );
  });
});
