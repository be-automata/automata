import { describe, it, expect, vi } from "vitest";
import {
  executeReviewFromIntent,
  DEGRADED_INTENT_MARKER,
} from "./execute-review-from-intent";
import type {
  GitHubReview,
  ReviewGitHubClient,
} from "@terragon/review/state/review-github-client";

const BOT = "automata-ai-bot[bot]";
const REPO = "o/r";
const PR = 5;
const HEAD = "head-sha";
const OLD = "old-sha";

function makeGithub(reviews: GitHubReview[] = []) {
  // Explicit param signatures so `.mock.calls[i]` is a correctly-typed tuple.
  return {
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
  } satisfies ReviewGitHubClient;
}

function fenced(obj: unknown): string {
  return `Review complete.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;
}

const RC_AT_HEAD = fenced({
  verdict: "request_changes",
  commit: HEAD,
  summary: "Off-by-one in isAdult.",
  findings: [{ severity: "error", path: "a.ts", line: 3, body: "use >=" }],
});

describe("executeReviewFromIntent", () => {
  it("posts the verdict once when the intent is at HEAD and no review exists", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_HEAD,
    });
    expect(res.outcome).toBe("posted");
    expect(github.submitReview).toHaveBeenCalledTimes(1);
    expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
  });

  it("MALFORMED intent → degraded marked COMMENT + workFailed (never silent)", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: "I looked at the PR and it seems fine to me.",
    });
    expect(res).toMatchObject({ outcome: "degraded_comment", workFailed: true });
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    const body = github.submitReviewWithComments.mock.calls[0]![4] as string;
    expect(body).toContain(DEGRADED_INTENT_MARKER);
    expect(github.submitReviewWithComments.mock.calls[0]![3]).toBe("COMMENT");
  });

  it("TRUNCATED fenced-json → degraded COMMENT, not a crash or silent skip", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: '```json\n{ "verdict": "request_changes", "commit": "he',
    });
    expect(res.outcome).toBe("degraded_comment");
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
  });

  it("STALE intent + no newer review → posts a COMMENT at the reviewed commit (never silent-drop)", async () => {
    const github = makeGithub([]); // nothing at current HEAD
    const staleIntent = fenced({
      verdict: "request_changes",
      commit: OLD,
      summary: "Issue at old commit.",
    });
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: staleIntent,
    });
    expect(res).toMatchObject({
      outcome: "posted_stale_comment",
      intendedVerdict: "request_changes",
    });
    // posted as a COMMENT AT the reviewed commit, with a "PR has moved" note
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    const [, , commitSha, event, body] =
      github.submitReviewWithComments.mock.calls[0]!;
    expect(commitSha).toBe(OLD);
    expect(event).toBe("COMMENT");
    expect(body as string).toContain("has since advanced");
    expect(github.submitReview).not.toHaveBeenCalled();
  });

  it("STALE intent + a newer bot review at HEAD → skipped_superseded (no post)", async () => {
    const newer: GitHubReview = {
      id: 1,
      user: { login: BOT },
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-07-19T00:00:00Z",
      dismissedAt: null,
      commitId: HEAD,
      body: "",
    };
    const github = makeGithub([newer]);
    const staleIntent = fenced({ verdict: "approve", commit: OLD, summary: "ok" });
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: staleIntent,
    });
    expect(res.outcome).toBe("skipped_superseded");
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
  });

  it("same-verdict bot review already at HEAD → skipped_existing (idempotent)", async () => {
    const existing: GitHubReview = {
      id: 2,
      user: { login: BOT },
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-07-19T00:00:00Z",
      dismissedAt: null,
      commitId: HEAD,
      body: "",
    };
    const github = makeGithub([existing]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_HEAD,
    });
    expect(res.outcome).toBe("skipped_existing");
    expect(github.submitReview).not.toHaveBeenCalled();
  });

  it("post failure surfaces as post_failed + workFailed", async () => {
    const github = makeGithub([]);
    github.submitReview = vi.fn(async () => {
      throw new Error("gh 403");
    });
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_HEAD,
    });
    expect(res).toMatchObject({ outcome: "post_failed", workFailed: true });
  });
});
