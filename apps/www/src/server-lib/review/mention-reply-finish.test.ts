import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MentionLaneStamp } from "@terragon/shared";
import type { DBMessage } from "@terragon/shared/db/db-message";
import { parseAgentPrContent } from "@/server-lib/task/agent-pr-content";
import { mentionStamp } from "@/test-helpers/mention-stamp";
import type { RemoteTaskPrOutcome } from "@/server-lib/task/remote-task-pr";
import { DELIVERY_LABEL } from "@/server-lib/delivery/delivery-effects";
import { getOctokitForApp } from "@/lib/github";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { getOrganizationInstallationMode } from "@terragon/shared/model/github-installation";
import {
  MENTION_REPLY_NOTICE,
  executeMentionReply,
  handleMentionRepliesAtTerminal,
  handleMentionReplyAtFinish,
  mentionReplyMarker,
  parseMentionReply,
  renderMentionTerminalNotice,
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

const ISSUE_STAMP = mentionStamp({
  isPullRequest: true,
  commentId: 101,
  commenterLogin: "alice",
});
/** The ISSUE mention (ISSUE_STAMP above is, despite its name, a PR one). */
const ISSUE_MENTION = mentionStamp({ ...ISSUE_STAMP, isPullRequest: false });
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

describe("a final message with a pull-request block and a mention-reply block (#752)", () => {
  const reply = block({ kind: "mention-reply", reply: "Done in abc1234." });
  const pr = block(
    { title: "feat(acme): add request logging", body: "## Summary\n- logs" },
    "json pull-request",
  );
  const asMessages = (text: string): DBMessage[] => [
    {
      type: "agent",
      parent_tool_use_id: null,
      parts: [{ type: "text", text }],
    },
  ];

  it.each([
    ["before", `Notes.\n${pr}\n${reply}`],
    ["after", `Notes.\n${reply}\n${pr}`],
  ])("parses both when the pull-request block comes %s", (_where, text) => {
    expect(parseMentionReply(text)).toMatchObject({
      ok: true,
      value: { reply: "Done in abc1234." },
    });
    expect(parseAgentPrContent(asMessages(text))).toEqual({
      title: "feat(acme): add request logging",
      body: "## Summary\n- logs",
    });
  });

  it("yields no PR content (the generated fallback applies) when the block is missing or invalid", () => {
    expect(parseAgentPrContent(asMessages(reply))).toBeNull();
    expect(
      parseAgentPrContent(
        asMessages(
          `${block({ title: "", body: "x" }, "json pull-request")}\n${reply}`,
        ),
      ),
    ).toBeNull();
    expect(
      parseAgentPrContent(
        asMessages(`\`\`\`json pull-request\n{ nope\n\`\`\`\n${reply}`),
      ),
    ).toBeNull();
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

  // Card: protects=#668, a mention whose run ended on a typed terminal (no
  // daemon finish) says what happened instead of "a human should look";
  // fails_when=the generic notice posts, the marker is lost, or the cause
  // outranks a parsed reply or a provider refusal; no_claim=which path wrote
  // the cause (the call-site suites).
  it("a typed terminal cause → the cause notice, with the marker", async () => {
    const { github, calls } = fakeGitHub();
    const outcome = await executeMentionReply({
      github,
      stamp: ISSUE_STAMP,
      terminalText: "",
      terminalCause: "timeout",
    });
    expect(outcome).toEqual({
      outcome: "notice_posted",
      reason: "terminal: timeout",
    });
    expect(calls).toEqual([
      `issue:I couldn't finish this: the run hit its time limit before it could answer. Mention me again to retry.\n\n${mentionReplyMarker(ISSUE_STAMP.commentId)}`,
    ]);

    const parsed = fakeGitHub();
    await executeMentionReply({
      github: parsed.github,
      stamp: ISSUE_STAMP,
      terminalText: block({ kind: "mention-reply", reply: "Done anyway." }),
      terminalCause: "timeout",
    });
    expect(parsed.calls[0]).toContain("Done anyway.");
    expect(parsed.calls[0]).not.toContain("couldn't finish");

    const refused = fakeGitHub();
    await executeMentionReply({
      github: refused.github,
      stamp: ISSUE_STAMP,
      terminalText: "",
      providerUnavailable: { kind: "auth_rejected" },
      terminalCause: "daemon-failed",
    });
    expect(refused.calls[0]).toContain("an org admin must reconnect it");
    expect(refused.calls[0]).not.toContain("couldn't finish");
  });

  it("every failure cause has its own wording, none claims nothing was pushed", () => {
    const failures = [
      "timeout",
      "daemon-failed",
      "publish-failed",
      "plane-offline",
      "run-failed-unreported",
      "out-of-memory",
    ] as const;
    const texts = failures.map(renderMentionTerminalNotice);
    expect(new Set(texts).size).toBe(failures.length);
    for (const text of texts) {
      expect(text).toMatch(
        /^I couldn't finish this: .+\. Mention me again to retry\.$/,
      );
      expect(text).not.toMatch(/nothing was (changed|pushed)/i);
    }
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
      stamp: ISSUE_MENTION,
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

describe("the pull request outcome in an issue mention's reply (#729)", () => {
  const URL = "https://github.com/acme/widgets/pull/55";
  const text = block({ kind: "mention-reply", reply: "Done it." });
  const post = async (
    pullRequest: Parameters<typeof executeMentionReply>[0]["pullRequest"],
    stamp: MentionLaneStamp = ISSUE_MENTION,
    terminalText = text,
  ) => {
    const { github, calls } = fakeGitHub();
    await executeMentionReply({ github, stamp, terminalText, pullRequest });
    return calls[0] ?? "";
  };

  it("opened → links the draft PR, before the marker", async () => {
    expect(await post({ status: "opened", prNumber: 55, recorded: true })).toBe(
      `issue:Done it.\n\nOpened a draft pull request: ${URL}\n\n${mentionReplyMarker(101)}`,
    );
  });

  it.each([
    [
      "opened but not recorded → still links the PR",
      { status: "opened", prNumber: 55, recorded: false },
      `Opened a draft pull request: ${URL}`,
    ],
    [
      "adopted → links the open PR",
      { status: "adopted", prNumber: 55, recorded: true },
      `Updated the open pull request: ${URL}`,
    ],
    [
      "auto_create_off → says automatic PRs are off (OD-7)",
      { status: "skipped", reason: "auto_create_off" },
      "automatic pull requests are turned off",
    ],
    [
      "no_changes → only the no-changes line (AC-5)",
      { status: "skipped", reason: "no_changes" },
      "_No pull request was opened: no changes were pushed._",
    ],
    [
      "no_branch → only the no-changes line (AC-5)",
      { status: "skipped", reason: "no_branch" },
      "_No pull request was opened: no changes were pushed._",
    ],
  ] as const)("%s", async (_name, outcome, line) => {
    const body = await post(outcome);
    expect(body).toContain("Done it.");
    expect(body).toContain(line);
    if (outcome.status === "skipped") expect(body).not.toContain("github.com");
  });

  it.each([
    null,
    undefined,
    { status: "skipped", reason: "has_pr" },
    { status: "skipped", reason: "checkpointing_off" },
  ] as const)("adds no line for %j", async (outcome) => {
    expect(await post(outcome as never)).toBe(
      `issue:Done it.\n\n${mentionReplyMarker(101)}`,
    );
  });

  it("sits after the pushed commit and before the delivery hint", async () => {
    const withCommit = block({
      kind: "mention-reply",
      reply: "Done it.",
      commit: "abcdef1234567",
    });
    const body = await post(
      { status: "opened", prNumber: 55, recorded: true },
      { ...ISSUE_MENTION, asksForDelivery: true },
      withCommit,
    );
    const at = (needle: string) => body.indexOf(needle);
    expect(at("_Pushed")).toBeLessThan(at("Opened a draft"));
    expect(at("Opened a draft")).toBeLessThan(at(DELIVERY_LABEL));
    expect(at(DELIVERY_LABEL)).toBeLessThan(at("automata:mention-reply"));
  });

  it("the delivery hint names the label only when asked (OD-6)", async () => {
    expect(await post(null)).not.toContain(DELIVERY_LABEL);
    expect(
      await post(null, { ...ISSUE_MENTION, asksForDelivery: true }),
    ).toContain(`add the \`${DELIVERY_LABEL}\` label to this issue`);
  });

  it.each([
    ["generic notice", {}, MENTION_REPLY_NOTICE],
    [
      "terminal notice",
      { terminalCause: "timeout" as const },
      "hit its time limit",
    ],
    [
      "provider notice",
      { providerUnavailable: { kind: "auth_rejected" as const } },
      "Nothing was changed",
    ],
  ])(
    "the PR line rides the %s too, before the marker",
    async (_name, causes, expected) => {
      const { github, calls } = fakeGitHub();
      await executeMentionReply({
        github,
        stamp: ISSUE_MENTION,
        terminalText: "no block",
        pullRequest: { status: "opened", prNumber: 55, recorded: true },
        ...causes,
      });
      expect(calls[0]).toContain(expected);
      expect(calls[0]).toContain(URL);
      expect(calls[0]).toMatch(new RegExp(`${mentionReplyMarker(101)}$`));
    },
  );

  it("a PR mention never gets a PR line or the hint", async () => {
    const body = await post(
      { status: "opened", prNumber: 55, recorded: true },
      { ...ISSUE_STAMP, asksForDelivery: true },
    );
    expect(body).toBe(`issue:Done it.\n\n${mentionReplyMarker(101)}`);
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

  describe("the pull request outcome (#729)", () => {
    const stampOf = (mention: MentionLaneStamp) =>
      ({
        organizationId: "o-1",
        terminalCause: null,
        sourceMetadata: {
          type: "automation-skill",
          skillName: MENTION_SKILL_NAME,
          contentSha: "x",
          source: "db-version",
          mention,
        },
      }) as never;
    const lastBody = () =>
      (
        octokit.rest.issues.createComment.mock.calls.at(-1) as unknown as [
          { body: string },
        ]
      )[0].body;

    it("an issue mention's reply is written after the PR outcome and links it", async () => {
      vi.mocked(getThreadMinimal).mockResolvedValue(stampOf(ISSUE_MENTION));
      let resolvePr!: (v: RemoteTaskPrOutcome) => void;
      const remotePullRequest = new Promise<RemoteTaskPrOutcome>((resolve) => {
        resolvePr = resolve;
      });
      const done = handleMentionReplyAtFinish({ ...args, remotePullRequest });
      await new Promise((r) => setTimeout(r, 20));
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
      resolvePr({ status: "opened", prNumber: 55, recorded: true });
      await done;
      expect(lastBody()).toContain(
        "Opened a draft pull request: https://github.com/acme/widgets/pull/55",
      );
    });

    it("a PR mention ignores the promise and never waits for it", async () => {
      vi.mocked(getThreadMinimal).mockResolvedValue(stampOf(ISSUE_STAMP));
      await handleMentionReplyAtFinish({
        ...args,
        remotePullRequest: new Promise(() => {}),
      });
      expect(lastBody()).not.toContain("pull request");
    });

    it("gives up after 20 s: replies without a PR line and logs pr_outcome_timeout", async () => {
      vi.mocked(getThreadMinimal).mockResolvedValue(stampOf(ISSUE_MENTION));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.useFakeTimers();
      try {
        const done = handleMentionReplyAtFinish({
          ...args,
          remotePullRequest: new Promise(() => {}),
        });
        await vi.advanceTimersByTimeAsync(19_999);
        expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await done;
      } finally {
        vi.useRealTimers();
      }
      expect(lastBody()).toBe(`Thread reply.\n\n${mentionReplyMarker(101)}`);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("pull request outcome not ready"),
        expect.objectContaining({ reason: "pr_outcome_timeout" }),
      );
      warn.mockRestore();
    });

    // card: protects=roborev 1371: when the App client fails before the wait, no pr_outcome_timeout is logged 20 s later for a reply that never posts; fails_when=the timer starts before the reply's own reads; no_claim=the failure log itself
    it("a failed App client ends the reply before the wait: no stray timeout log", async () => {
      vi.mocked(getThreadMinimal).mockResolvedValue(stampOf(ISSUE_MENTION));
      vi.mocked(getOctokitForApp).mockRejectedValueOnce(
        new Error("no install"),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.useFakeTimers();
      try {
        await handleMentionReplyAtFinish({
          ...args,
          remotePullRequest: new Promise(() => {}),
        });
        await vi.advanceTimersByTimeAsync(25_000);
      } finally {
        vi.useRealTimers();
      }
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(
        warn.mock.calls.some((c) =>
          JSON.stringify(c).includes("pr_outcome_timeout"),
        ),
      ).toBe(false);
      warn.mockRestore();
      error.mockRestore();
    });

    it("a shadow org posts nothing even with an outcome", async () => {
      vi.mocked(getOrganizationInstallationMode).mockResolvedValueOnce(
        "shadow" as never,
      );
      vi.mocked(getThreadMinimal).mockResolvedValue(stampOf(ISSUE_MENTION));
      await handleMentionReplyAtFinish({
        ...args,
        remotePullRequest: Promise.resolve({
          status: "opened",
          prNumber: 55,
          recorded: true,
        }),
      });
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });
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

describe("typed-terminal mention replies (#668)", () => {
  const octokit = {
    paginate: vi.fn(async () => [] as unknown[]),
    rest: {
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(async () => ({ data: {} })),
      },
    },
  };
  const mentionThread = (terminalCause: string | null) => ({
    organizationId: "o-1",
    version: 0,
    terminalCause,
    sourceMetadata: {
      type: "automation-skill",
      skillName: MENTION_SKILL_NAME,
      contentSha: "x",
      source: "db-version",
      mention: ISSUE_STAMP,
    },
  });
  /** The one `select … from thread where id in (…)` the batch entry runs. */
  const fakeDb = (rows: unknown[]) =>
    ({
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(async () => rows) })),
      })),
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as never);
    // The run ended before the agent said anything.
    vi.mocked(getThreadChat).mockResolvedValue({ messages: [] } as never);
  });

  // Card: protects=#668 AC-3, plane-offline (a mention that never ran) is
  // answered although the review lane treats it as abandoned; a person's stop
  // and the policy causes stay silent; fails_when=the review lane's abandoned
  // list is reused; no_claim=the cause each path writes.
  it.each([
    ["plane-offline", true],
    ["timeout", true],
    ["run-failed-unreported", true],
    ["daemon-failed", true],
    ["out-of-memory", true],
    ["user-cancelled", false],
    ["superseded", false],
    ["discarded", false],
    ["stale-skipped", false],
  ])("cause %s → replies: %s", async (cause, replies) => {
    vi.mocked(getThreadMinimal).mockResolvedValue(
      mentionThread(cause) as never,
    );
    await handleMentionReplyAtFinish({
      db: {} as never,
      userId: "u-1",
      threadId: "t-1",
      threadChatId: null,
    });
    if (replies) {
      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 7,
          body: expect.stringContaining(
            renderMentionTerminalNotice(cause as never),
          ),
        }),
      );
    } else {
      expect(getOctokitForApp).not.toHaveBeenCalled();
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    }
  });

  it("no chat id from the caller: a v0 thread reads its chat from the thread row", async () => {
    vi.mocked(getThreadMinimal).mockResolvedValue(
      mentionThread("timeout") as never,
    );
    await handleMentionReplyAtFinish({
      db: {} as never,
      userId: "u-1",
      threadId: "t-1",
      threadChatId: null,
    });
    expect(getThreadChat).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "t-1",
        threadChatId: LEGACY_THREAD_CHAT_ID,
      }),
    );
  });

  // Card: protects=#668 AC-4/5, the batch entry answers mention threads only
  // and a mention already answered is not answered again; fails_when=a
  // non-mention thread costs a GitHub call or the marker is ignored.
  it("the batch entry answers mention threads only", async () => {
    vi.mocked(getThreadMinimal).mockResolvedValue(
      mentionThread("timeout") as never,
    );
    await handleMentionRepliesAtTerminal({
      db: fakeDb([
        { id: "t-task", userId: "u-1", sourceMetadata: null },
        {
          id: "t-review",
          userId: "u-1",
          sourceMetadata: {
            type: "automation-skill",
            skillName: "pr-review",
            contentSha: "x",
            source: "db-version",
          },
        },
        {
          id: "t-mention",
          userId: "u-1",
          sourceMetadata: mentionThread("timeout").sourceMetadata,
        },
      ]),
      targets: [
        { threadId: "t-task" },
        { threadId: "t-review" },
        { threadId: "t-mention", threadChatId: "c-9" },
      ],
    });
    expect(getThreadMinimal).toHaveBeenCalledTimes(1);
    expect(getThreadMinimal).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "t-mention", userId: "u-1" }),
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    // The chat the caller named is the one read.
    expect(getThreadChat).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "t-mention", threadChatId: "c-9" }),
    );

    // Answered already (the App's marker is there): nothing posts again.
    octokit.paginate.mockResolvedValueOnce([
      { user: { login: resolveBotLogin() }, body: mentionReplyMarker(101) },
    ]);
    await handleMentionRepliesAtTerminal({
      db: fakeDb([
        {
          id: "t-mention",
          userId: "u-1",
          sourceMetadata: mentionThread("timeout").sourceMetadata,
        },
      ]),
      targets: [{ threadId: "t-mention" }],
    });
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("no ids → no read; a failed read is logged, never thrown", async () => {
    const db = fakeDb([]);
    await handleMentionRepliesAtTerminal({ db, targets: [] });
    expect(
      (db as { select: ReturnType<typeof vi.fn> }).select,
    ).not.toHaveBeenCalled();

    const broken = {
      select: vi.fn(() => {
        throw new Error("db down");
      }),
    } as never;
    await expect(
      handleMentionRepliesAtTerminal({
        db: broken,
        targets: [{ threadId: "t-1" }],
      }),
    ).resolves.toBeUndefined();
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

  it("lets an issue mention push its work branch, never open a PR itself (#729)", () => {
    expect(tracked).toContain("git push origin HEAD");
    expect(tracked).toContain("gh pr create");
    expect(tracked).toContain("Refs #<N>");
    expect(tracked).not.toContain("On an issue, push nothing");
    expect(tracked).not.toContain("push nothing.");
    // Action 2 (code change) is no longer pull-request-only; action 3 still is.
    expect(tracked).toMatch(/### 2\. Code change \([^\n]*\)\n/);
    expect(tracked).not.toMatch(/### 2\. Code change[^\n]*pull requests only/);
    expect(tracked).toMatch(
      /Never open a pull request yourself, and never push any ref but the one checked out/,
    );
    // The platform opens the PR and links it; the agent is told so.
    expect(tracked).toMatch(/platform opens one draft pull request/);
    expect(() =>
      validateSkillBody(MENTION_SKILL_NAME, tracked, "tracked"),
    ).not.toThrow();
  });

  it("tells the agent to fill the repo's PR template in a pull-request block (#752)", () => {
    expect(tracked).toContain("json pull-request");
    expect(tracked).toContain(".github/pull_request_template.md");
    expect(tracked).toContain(".github/PULL_REQUEST_TEMPLATE/*");
    expect(tracked).toContain("`CLAUDE.md` / `AGENTS.md`");
    expect(tracked).toMatch(/Do NOT write the `Refs #<N>` issue reference/);
    expect(tracked).toMatch(/Do NOT name or invent a branch/);
    expect(tracked).not.toContain("Emit exactly one block");
    expect(tracked).not.toContain("exactly one fenced block");
    expect(tracked).toContain("ticket-keyed");
  });

  it("keeps the seeded github-mention body in step with the tracked skill's block rule (#752)", () => {
    const seedSource = readFileSync(
      new URL(
        "../../../../../deploy/lib/seed-skill-bodies.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(seedSource).toContain("json mention-reply");
    expect(seedSource).toContain("json pull-request");
    expect(seedSource).not.toContain("exactly one block");
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
