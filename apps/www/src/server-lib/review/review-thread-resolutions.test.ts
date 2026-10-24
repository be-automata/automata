import { describe, it, expect, vi } from "vitest";
import type { GitHubReview } from "@terragon/review/state/review-github-client";
import type { FileAtCommit } from "@terragon/review/finding-verifier";
import { toleranceToPolicy } from "@terragon/review/severity-policy";
import type { ReviewThreadClient } from "./octokit-review-client";
import {
  applyThreadResolutions,
  threadResolutionMarker,
} from "./review-thread-resolutions";
import { executeReviewFromIntent } from "./execute-review-from-intent";
import type { ReviewWriterClient } from "./review-notice";
import { makeNoticeFake } from "./review-notice.fake";

/**
 * Thread resolutions (the ported `emit_resolve_thread`) and the terminal
 * writer's verify-before-block + floor ordering.
 *
 * protects: a verified thread is replied to and resolved exactly once, only
 *   when the verdict sits at live HEAD; an unverified blocker never gates; a
 *   comment carrying a verified blocker is raised.
 * fails_when: a second execution adds a reply, a stale or notice path resolves
 *   anything, or the floor runs before verification.
 * no_claim: GitHub's REST/GraphQL behaviour (fake clients stand in).
 */

const BOT = "automata-ai-bot[bot]";
const REPO = "o/r";
const PR = 5;
const HEAD = "head-sha";
const OLD = "old-sha";

type Thread = {
  id: string;
  isResolved: boolean;
  comments: { id: number; body: string }[];
};

function makeThreadClient(threads: Thread[]) {
  const client = {
    findThreadByCommentId: vi.fn(async (_pr: number, commentId: number) => {
      const t = threads.find((x) => x.comments.some((c) => c.id === commentId));
      return t
        ? {
            threadId: t.id,
            isResolved: t.isResolved,
            commentBodies: t.comments.map((c) => c.body),
            comments: t.comments.map((c) => ({
              body: c.body,
              authorLogin: null,
            })),
          }
        : null;
    }),
    replyToReviewComment: vi.fn(
      async (_pr: number, commentId: number, body: string) => {
        const t = threads.find((x) =>
          x.comments.some((c) => c.id === commentId),
        );
        t?.comments.push({ id: 9000 + t.comments.length, body });
      },
    ),
    resolveThread: vi.fn(async (threadId: string) => {
      const t = threads.find((x) => x.id === threadId);
      if (t) t.isResolved = true;
    }),
  } satisfies ReviewThreadClient;
  return client;
}

function openThread(): Thread {
  return {
    id: "T1",
    isResolved: false,
    comments: [{ id: 111, body: "Add a guard" }],
  };
}

describe("applyThreadResolutions", () => {
  it("replies once with the marker and resolves", async () => {
    const thread = openThread();
    const client = makeThreadClient([thread]);
    const tally = await applyThreadResolutions({
      client,
      claim: async () => true,
      prNumber: PR,
      commit: HEAD,
      resolutions: [
        {
          inlineCommentId: 111,
          reply: "Verified: guard added (commit head-sha)",
        },
      ],
    });
    expect(tally).toMatchObject({
      claimed: true,
      replied: 1,
      resolved: 1,
      failed: 0,
    });
    expect(client.replyToReviewComment.mock.calls[0]![2]).toBe(
      `Verified: guard added (commit head-sha)\n\n${threadResolutionMarker(HEAD, 111)}`,
    );
    expect(thread.isResolved).toBe(true);
  });

  it("a second execution that wins a fresh claim adds no reply (marker) and resolves idempotently", async () => {
    const thread = openThread();
    const client = makeThreadClient([thread]);
    const run = () =>
      applyThreadResolutions({
        client,
        claim: async () => true,
        prNumber: PR,
        commit: HEAD,
        resolutions: [{ inlineCommentId: 111, reply: "Verified: x" }],
      });
    await run();
    thread.isResolved = false; // e.g. someone unresolved it; the marker still stands
    const second = await run();
    expect(client.replyToReviewComment).toHaveBeenCalledTimes(1);
    expect(second.skipped).toBe(1);
  });

  it("two concurrent executions share one claim: one reply in total", async () => {
    const thread = openThread();
    const client = makeThreadClient([thread]);
    const held = new Set<string>();
    const claim = async () => {
      if (held.has(HEAD)) return false;
      held.add(HEAD);
      return true;
    };
    const args = {
      client,
      claim,
      prNumber: PR,
      commit: HEAD,
      resolutions: [{ inlineCommentId: 111, reply: "Verified: x" }],
    };
    const [a, b] = await Promise.all([
      applyThreadResolutions(args),
      applyThreadResolutions(args),
    ]);
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    expect(client.replyToReviewComment).toHaveBeenCalledTimes(1);
  });

  it("skips an already-resolved thread and an id that is not on this PR; a failure is counted, not thrown", async () => {
    const resolved: Thread = {
      id: "T2",
      isResolved: true,
      comments: [{ id: 222, body: "x" }],
    };
    const client = makeThreadClient([openThread(), resolved]);
    client.resolveThread.mockRejectedValueOnce(new Error("GraphQL down"));
    const tally = await applyThreadResolutions({
      client,
      claim: async () => true,
      prNumber: PR,
      commit: HEAD,
      resolutions: [
        { inlineCommentId: 111, reply: "Verified: a" },
        { inlineCommentId: 222, reply: "Verified: b" },
        { inlineCommentId: 333, reply: "Verified: c" },
      ],
    });
    expect(tally).toMatchObject({
      replied: 1,
      resolved: 0,
      skipped: 2,
      failed: 1,
    });
  });
});

function makeGithub(reviews: GitHubReview[] = []) {
  return {
    ...makeNoticeFake(BOT),
    listReviews: vi.fn(async (_repo: string, _pr: number) => reviews),
    submitReview: vi.fn(
      async (
        _repo: string,
        _pr: number,
        _verdict: "APPROVE" | "REQUEST_CHANGES",
        _body: string,
      ) => {},
    ),
    submitReviewWithComments: vi.fn(
      async (
        _repo: string,
        _pr: number,
        _sha: string,
        _verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
        _body: string,
        _comments: Array<{ path: string; line: number; body: string }>,
      ) => {},
    ),
    dismissReview: vi.fn(
      async (_repo: string, _pr: number, _id: number, _msg: string) => {},
    ),
    postInlineComment: vi.fn(
      async (
        _repo: string,
        _pr: number,
        _path: string,
        _line: number,
        _body: string,
        _sha: string,
      ) => {},
    ),
  } satisfies ReviewWriterClient;
}

function fenced(obj: unknown): string {
  return `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;
}

const FILE = "line one\nconst guard = check(x);\nline three\n";
const reader = async (path: string, sha: string): Promise<FileAtCommit> =>
  path === "a.ts" && sha === HEAD
    ? { kind: "content", text: FILE }
    : { kind: "missing" };

function intent(overrides: Record<string, unknown>) {
  return fenced({
    verdict: "approve",
    commit: HEAD,
    summary: "Looks good.",
    resolvedThreads: [
      {
        inlineCommentId: 111,
        reply: "Verified: guard added (commit head-sha)",
      },
    ],
    ...overrides,
  });
}

describe("executeReviewFromIntent — resolutions + verify-before-block", () => {
  it("posted at live HEAD → the named thread is replied to and resolved", async () => {
    const github = makeGithub([]);
    const client = makeThreadClient([openThread()]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: intent({}),
      readFileAtCommit: reader,
      threadResolutions: { client, claim: async () => true },
    });
    expect(res.outcome).toBe("posted");
    expect(client.resolveThread).toHaveBeenCalledWith("T1");
  });

  it("verdict already posted at HEAD (redelivered run) → resolutions still complete", async () => {
    const github = makeGithub([
      {
        id: 1,
        user: { login: BOT },
        state: "APPROVED",
        submittedAt: "t",
        dismissedAt: null,
        commitId: HEAD,
        body: "ok",
      },
    ]);
    const client = makeThreadClient([openThread()]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: intent({}),
      threadResolutions: { client, claim: async () => true },
    });
    expect(res.outcome).toBe("skipped_existing");
    expect(client.resolveThread).toHaveBeenCalledTimes(1);
  });

  // #504: a draft-era bare comment that yields to the ready-PR verdict at
  // HEAD leaves that verdict's open threads alone.
  it("a draft-era note that yielded to a verdict at HEAD → nothing is resolved", async () => {
    const github = makeGithub([
      {
        id: 1,
        user: { login: BOT },
        state: "CHANGES_REQUESTED",
        submittedAt: "t",
        dismissedAt: null,
        commitId: HEAD,
        body: "fix the guard",
      },
    ]);
    const client = makeThreadClient([openThread()]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      isDraft: false,
      draftAtDispatch: true,
      terminalText: intent({ verdict: "comment", summary: "Draft: fine." }),
      threadResolutions: { client, claim: async () => true },
    });
    expect(res.outcome).toBe("skipped_existing");
    expect(client.findThreadByCommentId).not.toHaveBeenCalled();
  });

  it("a redelivered draft-era note that already posted still finishes its resolutions", async () => {
    // First delivery posts the note, then "crashes" before resolutions.
    const first = makeGithub([]);
    const terminalText = intent({
      verdict: "comment",
      summary: "Draft: fine.",
    });
    const base = {
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      isDraft: false,
      draftAtDispatch: true,
      terminalText,
    };
    await executeReviewFromIntent({ ...base, github: first });
    const postedBody = first.submitReviewWithComments.mock.calls[0]![4];
    // The redelivery finds that same note in force at HEAD.
    const github = makeGithub([
      {
        id: 2,
        user: { login: BOT },
        state: "COMMENTED",
        submittedAt: "t",
        dismissedAt: null,
        commitId: HEAD,
        body: postedBody,
      },
    ]);
    const client = makeThreadClient([openThread()]);
    const res = await executeReviewFromIntent({
      ...base,
      github,
      threadResolutions: { client, claim: async () => true },
    });
    expect(res.outcome).toBe("skipped_existing");
    expect(client.resolveThread).toHaveBeenCalledTimes(1);
  });

  it("stale intent → nothing is resolved", async () => {
    const github = makeGithub([]);
    const client = makeThreadClient([openThread()]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: intent({ commit: OLD }),
      threadResolutions: { client, claim: async () => true },
    });
    expect(res.outcome).toBe("posted_stale_comment");
    expect(client.findThreadByCommentId).not.toHaveBeenCalled();
  });

  it("no-verdict notice path → nothing is resolved", async () => {
    const github = makeGithub([]);
    const client = makeThreadClient([openThread()]);
    await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: fenced({
        verdict: "unable_to_review",
        reason: "no diff",
        commit: HEAD,
      }),
      threadResolutions: { client, claim: async () => true },
    });
    expect(client.findThreadByCommentId).not.toHaveBeenCalled();
  });

  it("an unverified sole blocker on request_changes posts a COMMENT review carrying the annotated finding", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: intent({
        verdict: "request_changes",
        resolvedThreads: [],
        findings: [
          {
            severity: "error",
            path: "a.ts",
            line: 2,
            body: "dead code",
            quote: "return twice();",
          },
        ],
      }),
      readFileAtCommit: reader,
    });
    expect(res).toEqual({ outcome: "posted", verdict: "comment" });
    const [, , , event, body] = github.submitReviewWithComments.mock.calls[0]!;
    expect(event).toBe("COMMENT");
    expect(body).toContain("[unverified — quoted text not found at HEAD]");
    expect(github.submitReview).not.toHaveBeenCalled();
  });

  it("a comment carrying a VERIFIED warning is raised to REQUEST_CHANGES", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: intent({
        verdict: "comment",
        resolvedThreads: [],
        findings: [
          {
            severity: "warning",
            path: "a.ts",
            line: 2,
            body: "unguarded",
            quote: "const guard = check(x);",
          },
        ],
      }),
      readFileAtCommit: reader,
    });
    expect(res).toEqual({ outcome: "posted", verdict: "request_changes" });
    expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
  });

  it("info tolerance: approve + one verified info finding → REQUEST_CHANGES", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      approveFloorPolicy: toleranceToPolicy("info"),
      terminalText: intent({
        resolvedThreads: [],
        findings: [
          {
            severity: "info",
            path: "a.ts",
            line: 2,
            body: "nit",
            quote: "const guard = check(x);",
          },
        ],
      }),
      readFileAtCommit: reader,
    });
    expect(res).toEqual({ outcome: "posted", verdict: "request_changes" });
  });
});
