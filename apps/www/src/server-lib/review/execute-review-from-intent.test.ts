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
    expect(res).toMatchObject({
      outcome: "degraded_comment",
      workFailed: true,
    });
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
    const staleIntent = fenced({
      verdict: "approve",
      commit: OLD,
      summary: "ok",
    });
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

describe("executeReviewFromIntent — degraded path never speaks for a stale head", () => {
  // Regression for #140 (2026-08-25): a run reaped by the hourly sweep produced
  // ZERO output, and the degraded warning ("a human should review this PR") was
  // posted at a commit pushed 73s earlier whose own review was still in flight.
  it("skips the degraded COMMENT when the run reviewed an older head", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: "", // killed mid-run: no agent output at all
      reviewedSha: OLD,
    });
    // Distinct from skipped_superseded: that means "a newer review already
    // posted"; this means "the agent never emitted, and it wasn't about HEAD".
    // workFailed keeps it loud in telemetry even though nothing reaches GitHub.
    expect(res).toMatchObject({
      outcome: "skipped_stale_degrade",
      workFailed: true,
    });
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
  });

  it("still degrades loudly when the run reviewed the CURRENT head", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: "I looked at it and it seems fine.",
      reviewedSha: HEAD,
    });
    expect(res.outcome).toBe("degraded_comment");
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    expect(github.submitReviewWithComments.mock.calls[0]![4]).toContain(
      DEGRADED_INTENT_MARKER,
    );
  });

  it("degrades at live HEAD when the thread carries no reviewedSha (legacy)", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: "",
      reviewedSha: null,
    });
    expect(res.outcome).toBe("degraded_comment");
    expect(github.submitReviewWithComments.mock.calls[0]![2]).toBe(HEAD);
  });

  it("a real verdict from an older head still posts (stale path unchanged)", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: fenced({
        verdict: "request_changes",
        commit: OLD,
        summary: "Off-by-one.",
        findings: [
          { severity: "error", path: "a.ts", line: 3, body: "use >=" },
        ],
      }),
      reviewedSha: OLD,
    });
    expect(res.outcome).toBe("posted_stale_comment");
    expect(github.submitReviewWithComments.mock.calls[0]![2]).toBe(OLD);
  });
});

describe("executeReviewFromIntent — an abandoned run withholds only the warning", () => {
  // Codex adversarial review, 2026-08-25: terminal cause is NOT proof the run
  // produced nothing. Supersession stamps a thread terminal concurrently with
  // cancellation, so a run can persist a verdict and have its finish-hook write
  // fenced out. Suppressing the whole run would discard that verdict forever.
  it("withholds the degraded warning for an abandoned run at HEAD", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: "",
      reviewedSha: HEAD,
      runAbandoned: true,
    });
    expect(res).toMatchObject({
      outcome: "skipped_stale_degrade",
      workFailed: true,
    });
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
  });

  it("STILL POSTS a real verdict an abandoned run managed to persist", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_HEAD,
      reviewedSha: HEAD,
      runAbandoned: true,
    });
    expect(res.outcome).toBe("posted");
    expect(github.submitReview).toHaveBeenCalledTimes(1);
    expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
  });

  it("STILL POSTS an abandoned run's verdict for an older commit, at that commit", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: fenced({
        verdict: "request_changes",
        commit: OLD,
        summary: "Off-by-one.",
        findings: [
          { severity: "error", path: "a.ts", line: 3, body: "use >=" },
        ],
      }),
      reviewedSha: OLD,
      runAbandoned: true,
    });
    expect(res.outcome).toBe("posted_stale_comment");
    expect(github.submitReviewWithComments.mock.calls[0]![2]).toBe(OLD);
  });
});
