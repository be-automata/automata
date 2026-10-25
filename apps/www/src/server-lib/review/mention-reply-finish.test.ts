import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MentionLaneStamp } from "@terragon/shared";
import { getOctokitForApp } from "@/lib/github";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { getOrganizationInstallationMode } from "@terragon/shared/model/github-installation";
import {
  MENTION_REPLY_NOTICE,
  executeMentionReply,
  handleMentionReplyAtFinish,
  mentionReplyMarker,
  parseMentionReply,
  type MentionReplyGitHub,
} from "./mention-reply-finish";
import { MENTION_SKILL_NAME, validateSkillBody } from "./review-skill";
import { resolveBotLogin } from "./bot-login";
import { executeReviewFromIntent } from "./execute-review-from-intent";

/**
 * The mention lane's terminal writer: the agent emits one `json mention-reply`
 * block, the control plane posts AS THE APP — in-thread for a review comment,
 * one issue comment otherwise — exactly once (hidden marker), with a notice
 * instead of silence, and any emitted review through the review executor.
 *
 * protects: one reply per mention across redeliveries; the reply lands where
 *   the person asked; a run that emitted nothing still answers; a review on a
 *   PR reaches the review writer, never on an issue.
 * fails_when: a second reply posts despite the marker, the review-comment
 *   reply goes top-level, the notice is dropped, the review is skipped.
 * no_claim: GitHub's API behaviour (fakes) and the review executor itself
 *   (covered by execute-review-from-intent tests).
 */

vi.mock("@terragon/shared/model/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@terragon/shared/model/threads")>()),
  getThreadMinimal: vi.fn(),
  getThreadChat: vi.fn(),
}));
vi.mock(
  "@terragon/shared/model/github-installation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@terragon/shared/model/github-installation")
    >()),
    getOrganizationInstallationMode: vi.fn(async () => "active"),
  }),
);
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));
// The routing tests observe what the finish hands the review executor; the
// executor itself has its own suite.
vi.mock("./execute-review-from-intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execute-review-from-intent")>()),
  executeReviewFromIntent: vi.fn(async () => ({
    outcome: "posted" as const,
    verdict: "comment",
  })),
}));
vi.mock("./resolve-approve-floor", () => ({
  resolveApproveFloor: vi.fn(async () => undefined),
}));

const ISSUE_STAMP: MentionLaneStamp = {
  repoFullName: "acme/widgets",
  issueOrPrNumber: 7,
  isPullRequest: true,
  commentId: 101,
  commentKind: "issue",
  commenterLogin: "alice",
};
const REVIEW_STAMP: MentionLaneStamp = {
  ...ISSUE_STAMP,
  commentId: 202,
  commentKind: "review_comment",
  inReplyToId: 200,
  path: "src/a.ts",
  line: 3,
};

function block(value: unknown, tag = "json mention-reply"): string {
  return `Done.\n\n\`\`\`${tag}\n${JSON.stringify(value)}\n\`\`\``;
}

function fakeGitHub(existing: string[] = []) {
  const calls: string[] = [];
  const github = {
    listIssueCommentBodies: vi.fn(async () => existing),
    createIssueComment: vi.fn(async (_n: number, body: string) => {
      calls.push(`issue:${body}`);
    }),
    listReviewThreadBodies: vi.fn(async () => existing),
    replyToReviewComment: vi.fn(
      async (_n: number, _id: number, body: string) => {
        calls.push(`thread:${body}`);
      },
    ),
  } satisfies MentionReplyGitHub;
  return { github, calls };
}

describe("parseMentionReply", () => {
  it("reads the last tagged block", () => {
    const text =
      block({ kind: "mention-reply", reply: "first" }) +
      "\n" +
      block({ kind: "mention-reply", reply: "second", commit: "abc1234" });
    expect(parseMentionReply(text)).toEqual({
      ok: true,
      value: { kind: "mention-reply", reply: "second", commit: "abc1234" },
    });
  });

  it("falls back to an untagged json block of kind mention-reply", () => {
    const text =
      block({ verdict: "approve" }, "json") +
      "\n" +
      block({ kind: "mention-reply", reply: "hi" }, "json");
    expect(parseMentionReply(text)).toMatchObject({
      ok: true,
      value: { reply: "hi" },
    });
  });

  it("fails on no block, bad JSON, an empty reply or an unclosed block", () => {
    expect(parseMentionReply("just prose").ok).toBe(false);
    expect(parseMentionReply("```json mention-reply\n{ nope\n```").ok).toBe(
      false,
    );
    expect(
      parseMentionReply(block({ kind: "mention-reply", reply: "  " })).ok,
    ).toBe(false);
    expect(
      parseMentionReply('```json mention-reply\n{"kind":"mention-reply"').ok,
    ).toBe(false);
  });
});

describe("executeMentionReply", () => {
  it("issue comment → ONE top-level comment carrying the marker", async () => {
    const { github, calls } = fakeGitHub();
    const outcome = await executeMentionReply({
      github,
      stamp: ISSUE_STAMP,
      terminalText: block({ kind: "mention-reply", reply: "It is wired." }),
    });
    expect(outcome).toEqual({ outcome: "posted" });
    expect(calls).toEqual([`issue:It is wired.\n\n${mentionReplyMarker(101)}`]);
    expect(github.replyToReviewComment).not.toHaveBeenCalled();
  });

  it("review comment → a reply in the same thread (to its top-level comment)", async () => {
    const { github } = fakeGitHub();
    await executeMentionReply({
      github,
      stamp: REVIEW_STAMP,
      terminalText: block({
        kind: "mention-reply",
        reply: "Fixed.",
        commit: "deadbeefcafe",
      }),
    });
    expect(github.listReviewThreadBodies).toHaveBeenCalledWith(7, 202);
    expect(github.replyToReviewComment).toHaveBeenCalledWith(
      7,
      200,
      `Fixed.\n\n_Pushed \`deadbeefcafe\`._\n\n${mentionReplyMarker(202)}`,
    );
    expect(github.createIssueComment).not.toHaveBeenCalled();
  });

  it("a reply already carrying the marker → nothing posted, no review re-run", async () => {
    const { github } = fakeGitHub([`old\n\n${mentionReplyMarker(101)}`]);
    const runReview = vi.fn();
    const outcome = await executeMentionReply({
      github,
      stamp: ISSUE_STAMP,
      terminalText: block({
        kind: "mention-reply",
        reply: "again",
        review: { verdict: "approve", commit: "a", summary: "s" },
      }),
      runReview,
    });
    expect(outcome).toEqual({ outcome: "skipped_existing" });
    expect(github.createIssueComment).not.toHaveBeenCalled();
    expect(runReview).not.toHaveBeenCalled();
  });

  it("another comment's marker does not count", async () => {
    const { github } = fakeGitHub([mentionReplyMarker(999)]);
    await executeMentionReply({
      github,
      stamp: ISSUE_STAMP,
      terminalText: block({ kind: "mention-reply", reply: "ok" }),
    });
    expect(github.createIssueComment).toHaveBeenCalledTimes(1);
  });

  it("no parseable block → the notice, with the marker, never silence", async () => {
    for (const stamp of [ISSUE_STAMP, REVIEW_STAMP]) {
      const { github, calls } = fakeGitHub();
      const outcome = await executeMentionReply({
        github,
        stamp,
        terminalText: "I looked around and got lost.",
      });
      expect(outcome.outcome).toBe("notice_posted");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(MENTION_REPLY_NOTICE);
      expect(calls[0]).toContain(mentionReplyMarker(stamp.commentId));
    }
  });

  // Card: protects=#472, a mention whose run the provider refused names the
  // cause (rejected credential, reconnect) instead of "couldn't complete";
  // fails_when=the generic notice posts, the marker is lost, or a parsed reply
  // is replaced by the notice; no_claim=how the classification is stored
  // (handle-daemon-event suite).
  it("a run the provider refused → the provider notice, never 'couldn't complete'", async () => {
    const { github, calls } = fakeGitHub();
    const outcome = await executeMentionReply({
      github,
      stamp: ISSUE_STAMP,
      terminalText:
        "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
      providerUnavailable: { kind: "auth_rejected" },
    });
    expect(outcome).toEqual({
      outcome: "notice_posted",
      reason: "provider_unavailable: auth_rejected",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain(MENTION_REPLY_NOTICE);
    expect(calls[0]).toContain(
      "Nothing was changed: Automata's Claude credential for this organization was rejected by the provider, so the agent could not start; an org admin must reconnect it. Mention me again once an org admin reconnects the Claude credential.",
    );
    expect(calls[0]).toContain(mentionReplyMarker(ISSUE_STAMP.commentId));

    // A reply that parsed is posted as is, whatever the classification says.
    const parsed = fakeGitHub();
    await executeMentionReply({
      github: parsed.github,
      stamp: ISSUE_STAMP,
      terminalText: block({ kind: "mention-reply", reply: "All good." }),
      providerUnavailable: { kind: "auth_rejected" },
    });
    expect(parsed.calls[0]).toContain("All good.");
    expect(parsed.calls[0]).not.toContain("credential");
  });

  it("a marker lookup failure still posts (a lost reply is worse than a duplicate)", async () => {
    const { github } = fakeGitHub();
    github.listIssueCommentBodies.mockRejectedValueOnce(new Error("502"));
    const outcome = await executeMentionReply({
      github,
      stamp: ISSUE_STAMP,
      terminalText: block({ kind: "mention-reply", reply: "ok" }),
    });
    expect(outcome.outcome).toBe("posted");
  });

  it("a failed post is reported, not thrown", async () => {
    const { github } = fakeGitHub();
    github.createIssueComment.mockRejectedValueOnce(new Error("403"));
    const outcome = await executeMentionReply({
      github,
      stamp: ISSUE_STAMP,
      terminalText: block({ kind: "mention-reply", reply: "ok" }),
    });
    expect(outcome).toEqual({ outcome: "post_failed", failureReason: "403" });
  });

  it("review on a PR → through the review executor, BEFORE the reply", async () => {
    const { github, calls } = fakeGitHub();
    const review = {
      verdict: "request_changes",
      commit: "abc",
      summary: "one issue",
      findings: [{ path: "a.ts", line: 1, body: "bug", severity: "error" }],
    };
    const runReview = vi.fn(async (text: string) => {
      calls.push("review");
      expect(text.startsWith("```json\n")).toBe(true);
      expect(JSON.parse(text.slice(8, -4))).toEqual(review);
      return { outcome: "posted" as const, verdict: "request_changes" };
    });
    const outcome = await executeMentionReply({
      github,
      stamp: ISSUE_STAMP,
      terminalText: block({
        kind: "mention-reply",
        reply: "Re-reviewed.",
        review,
      }),
      runReview,
    });
    expect(runReview).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe("review");
    expect(calls[1]).toMatch(/^issue:Re-reviewed\./);
    expect(outcome).toEqual({ outcome: "posted", review: "posted" });
  });

  it("review on an ISSUE is ignored; the reply still posts", async () => {
    const { github } = fakeGitHub();
    const runReview = vi.fn();
    await executeMentionReply({
      github,
      stamp: { ...ISSUE_STAMP, isPullRequest: false },
      terminalText: block({
        kind: "mention-reply",
        reply: "Answer.",
        review: { verdict: "approve", commit: "a", summary: "s" },
      }),
      runReview,
    });
    expect(runReview).not.toHaveBeenCalled();
    expect(github.createIssueComment).toHaveBeenCalledTimes(1);
  });
});

describe("handleMentionReplyAtFinish (routing by stamp)", () => {
  const octokit = {
    paginate: vi.fn(async () => []),
    graphql: vi.fn(async () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    })),
    rest: {
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(async () => ({ data: {} })),
      },
      pulls: {
        createReplyForReviewComment: vi.fn(async () => ({ data: {} })),
        // The live PR read: ready now.
        get: vi.fn(async () => ({
          data: {
            head: { sha: "abc" },
            draft: false,
            state: "open",
            user: { login: "octocat" },
            base: { ref: "main" },
          },
        })),
      },
    },
  };
  const args = {
    db: {} as never,
    userId: "u-1",
    threadId: "t-1",
    threadChatId: "c-1",
  };
  const agentText = block({ kind: "mention-reply", reply: "Thread reply." });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as never);
    vi.mocked(getThreadChat).mockResolvedValue({
      messages: [
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: agentText }],
        },
      ],
    } as never);
  });

  it("a thread without the mention stamp → no-op", async () => {
    vi.mocked(getThreadMinimal).mockResolvedValue({
      organizationId: "o-1",
      sourceMetadata: {
        type: "automation-skill",
        skillName: "github-ops",
        contentSha: "x",
        source: "db-version",
      },
    } as never);
    await handleMentionReplyAtFinish(args);
    expect(getOctokitForApp).not.toHaveBeenCalled();
  });

  // #504: a mention review judges a bare `comment` by the draft state the
  // mention's prompt stated, beside the live read.
  it.each([true, false, undefined])(
    "a PR mention's review gets the stamped draft state (isDraft=%s)",
    async (isDraft) => {
      vi.mocked(getThreadChat).mockResolvedValue({
        messages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [
              {
                type: "text",
                text: block({
                  kind: "mention-reply",
                  reply: "Reviewed.",
                  review: { verdict: "comment", commit: "abc", summary: "ok" },
                }),
              },
            ],
          },
        ],
      } as never);
      vi.mocked(getThreadMinimal).mockResolvedValue({
        organizationId: "o-1",
        terminalCause: null,
        sourceMetadata: {
          type: "automation-skill",
          skillName: MENTION_SKILL_NAME,
          contentSha: "x",
          source: "db-version",
          mention:
            isDraft === undefined ? ISSUE_STAMP : { ...ISSUE_STAMP, isDraft },
        },
      } as never);
      await handleMentionReplyAtFinish(args);
      expect(executeReviewFromIntent).toHaveBeenCalledTimes(1);
      const reviewArgs = vi.mocked(executeReviewFromIntent).mock.calls[0]![0];
      expect(reviewArgs.draftAtDispatch).toBe(isDraft);
      expect(reviewArgs.isDraft).toBe(false);
    },
  );

  it("a review-comment mention → the App replies in the thread", async () => {
    vi.mocked(getThreadMinimal).mockResolvedValue({
      organizationId: "o-1",
      terminalCause: null,
      sourceMetadata: {
        type: "automation-skill",
        skillName: MENTION_SKILL_NAME,
        contentSha: "x",
        source: "db-version",
        mention: REVIEW_STAMP,
      },
    } as never);
    await handleMentionReplyAtFinish(args);
    expect(octokit.rest.pulls.createReplyForReviewComment).toHaveBeenCalledWith(
      {
        owner: "acme",
        repo: "widgets",
        pull_number: 7,
        comment_id: 200,
        body: `Thread reply.\n\n${mentionReplyMarker(202)}`,
      },
    );
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  // Card: protects=#472, the finish hook reads the chat's provider-unavailable
  // classification into the reply; fails_when=the hook drops it and the
  // mention gets "couldn't complete"; no_claim=the wording (unit test above).
  it("a chat ended provider-unavailable → the reply names the rejected credential", async () => {
    const revoked =
      "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";
    vi.mocked(getThreadChat).mockResolvedValue({
      errorMessage: "provider-unavailable",
      errorMessageInfo: JSON.stringify({ kind: "auth_rejected" }),
      messages: [
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: revoked }],
        },
      ],
    } as never);
    vi.mocked(getThreadMinimal).mockResolvedValue({
      organizationId: "o-1",
      terminalCause: null,
      sourceMetadata: {
        type: "automation-skill",
        skillName: MENTION_SKILL_NAME,
        contentSha: "x",
        source: "db-version",
        mention: ISSUE_STAMP,
      },
    } as never);
    await handleMentionReplyAtFinish(args);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 7,
        body: expect.stringContaining("an org admin must reconnect it"),
      }),
    );
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(MENTION_REPLY_NOTICE),
      }),
    );
  });

  it("only the App's own comment carrying the marker counts as answered", async () => {
    const stampMeta = {
      organizationId: "o-1",
      terminalCause: null,
      sourceMetadata: {
        type: "automation-skill",
        skillName: MENTION_SKILL_NAME,
        contentSha: "x",
        source: "db-version",
        mention: ISSUE_STAMP,
      },
    };
    vi.mocked(getThreadMinimal).mockResolvedValue(stampMeta as never);
    // Anyone can type the marker: a person's comment must not silence the App.
    octokit.paginate.mockResolvedValueOnce([
      { user: { login: "mallory" }, body: mentionReplyMarker(101) },
    ] as never);
    await handleMentionReplyAtFinish(args);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);

    octokit.paginate.mockResolvedValueOnce([
      { user: { login: resolveBotLogin() }, body: mentionReplyMarker(101) },
    ] as never);
    await handleMentionReplyAtFinish(args);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("a review thread: a marker from a person is ignored, the App's (GraphQL login, no [bot]) counts", async () => {
    vi.mocked(getThreadMinimal).mockResolvedValue({
      organizationId: "o-1",
      terminalCause: null,
      sourceMetadata: {
        type: "automation-skill",
        skillName: MENTION_SKILL_NAME,
        contentSha: "x",
        source: "db-version",
        mention: REVIEW_STAMP,
      },
    } as never);
    const thread = (login: string) => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "th-1",
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      databaseId: 202,
                      body: "@x do it",
                      author: { login: "bob" },
                    },
                    {
                      databaseId: 203,
                      body: mentionReplyMarker(202),
                      author: { login },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    octokit.graphql.mockResolvedValueOnce(thread("mallory") as never);
    await handleMentionReplyAtFinish(args);
    expect(
      octokit.rest.pulls.createReplyForReviewComment,
    ).toHaveBeenCalledTimes(1);
    octokit.graphql.mockResolvedValueOnce(
      thread(resolveBotLogin().replace(/\[bot\]$/, "")) as never,
    );
    await handleMentionReplyAtFinish(args);
    expect(
      octokit.rest.pulls.createReplyForReviewComment,
    ).toHaveBeenCalledTimes(1);
  });

  it("a shadow org posts nothing", async () => {
    vi.mocked(getOrganizationInstallationMode).mockResolvedValueOnce(
      "shadow" as never,
    );
    vi.mocked(getThreadMinimal).mockResolvedValue({
      organizationId: "o-1",
      sourceMetadata: {
        type: "automation-skill",
        skillName: MENTION_SKILL_NAME,
        contentSha: "x",
        source: "db-version",
        mention: ISSUE_STAMP,
      },
    } as never);
    await handleMentionReplyAtFinish(args);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });
});

describe("github-mention skill validator", () => {
  const tracked = readFileSync(
    new URL(
      "../../../../../deploy/skills/github-mention/SKILL.md",
      import.meta.url,
    ),
    "utf8",
  );

  it("accepts the tracked skill and rejects a body without the block", () => {
    expect(() =>
      validateSkillBody(MENTION_SKILL_NAME, tracked, "tracked"),
    ).not.toThrow();
    expect(tracked).toContain(
      "<!-- automata:context pr-view prior-reviews review-threads -->",
    );
    expect(() =>
      validateSkillBody(
        MENTION_SKILL_NAME,
        "Answer the mention.\n```json\n{}\n```",
        "v1",
      ),
    ).toThrow(/mention-reply/);
    expect(() =>
      validateSkillBody(MENTION_SKILL_NAME, "Reply with mention-reply.", "v2"),
    ).toThrow(/mention-reply/);
  });

  it("checks the contract on the classic render the lane receives (#492)", () => {
    const wrap = (condition: string) =>
      `Intro.\n<!-- automata:if ${condition} -->\n${tracked}\n<!-- automata:endif -->`;
    expect(() =>
      validateSkillBody(MENTION_SKILL_NAME, wrap("classic"), "classic"),
    ).not.toThrow();
    expect(() =>
      validateSkillBody(MENTION_SKILL_NAME, wrap("orchestrated"), "orch"),
    ).toThrow(/mention-reply/);
  });
});
