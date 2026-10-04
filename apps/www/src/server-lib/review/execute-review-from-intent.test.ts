import { describe, it, expect, vi } from "vitest";
import { executeReviewFromIntent } from "./execute-review-from-intent";
import type { GitHubReview } from "@terragon/review/state/review-github-client";
import { reviewNoticeSha, type ReviewWriterClient } from "./review-notice";
import { makeNoticeFake } from "./review-notice.fake";
import {
  LEAD_SUMMARY,
  LEAD_TAGGED_TEXT,
  SUB_AGENT_APPROVE_FENCE,
} from "./__fixtures__/orchestrated-terminal-messages";

const BOT = "automata-ai-bot[bot]";
const REPO = "o/r";
const PR = 5;
const HEAD = "head-sha";
const OLD = "old-sha";

function makeGithub(reviews: GitHubReview[] = []) {
  // Explicit param signatures so `.mock.calls[i]` is a correctly-typed tuple.
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

  it("MALFORMED intent → a notice in the conversation + workFailed, NEVER a review", async () => {
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
      cause: "unparseable",
      workFailed: true,
    });
    // ADR-009: the PR's review state stays empty — no review of any kind.
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
    expect(github.comments).toHaveLength(1);
    expect(reviewNoticeSha(github.comments[0]!, BOT)).toBe(HEAD);
    expect(github.comments[0]!.body).toContain("has no verdict");
    expect(github.comments[0]!.body).toContain("This is not a pass");
  });

  it("TRUNCATED fenced-json → a notice, not a crash or silent skip", async () => {
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
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
    expect(github.comments).toHaveLength(1);
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

describe("executeReviewFromIntent — the no-verdict path never speaks for a stale head", () => {
  // Regression for #140 (2026-08-25): a run reaped by the hourly sweep produced
  // ZERO output, and the degraded warning ("a human should review this PR") was
  // posted at a commit pushed 73s earlier whose own review was still in flight.
  it("withholds the notice when the run reviewed an older head", async () => {
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
    expect(github.createConversationComment).not.toHaveBeenCalled();
  });

  it("still reports loudly when the run reviewed the CURRENT head", async () => {
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
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
    expect(github.comments).toHaveLength(1);
  });

  it("reports at live HEAD when the thread carries no reviewedSha (legacy)", async () => {
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
    expect(reviewNoticeSha(github.comments[0]!, BOT)).toBe(HEAD);
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

describe("executeReviewFromIntent — an abandoned run withholds only the notice", () => {
  // Codex adversarial review, 2026-08-25: terminal cause is NOT proof the run
  // produced nothing. Supersession stamps a thread terminal concurrently with
  // cancellation, so a run can persist a verdict and have its finish-hook write
  // fenced out. Suppressing the whole run would discard that verdict forever.
  it("withholds the notice for an abandoned run at HEAD", async () => {
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
    expect(github.createConversationComment).not.toHaveBeenCalled();
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

describe("ADR-009 — a non-verdict is never posted as a review", () => {
  const UNABLE = fenced({
    verdict: "unable_to_review",
    reason: "git refused the checkout: detected dubious ownership",
  });

  function expectNoReview(github: ReturnType<typeof makeGithub>) {
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
    expect(github.postInlineComment).not.toHaveBeenCalled();
  }

  it("an agent that reports it could not review gets a notice carrying its reason", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: UNABLE,
    });
    expect(res).toEqual({
      outcome: "degraded_comment",
      cause: "agent_unable",
      reason: "git refused the checkout: detected dubious ownership",
      workFailed: true,
    });
    expectNoReview(github);
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.body).toContain(
      "could not review this commit: git refused the checkout",
    );
  });

  it("an unable intent naming an OLDER commit says nothing about HEAD", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: fenced({
        verdict: "unable_to_review",
        reason: "diff was truncated",
        commit: OLD,
      }),
    });
    expect(res).toMatchObject({
      outcome: "skipped_stale_degrade",
      cause: "agent_unable",
      workFailed: true,
    });
    expectNoReview(github);
    expect(github.createConversationComment).not.toHaveBeenCalled();
  });

  // The review #228 received: an agent with no git access followed the old
  // skill and chose `comment`. Enforced server-side so a repo still running an
  // older skill body gets the same guarantee.
  it("a bare `comment` on a READY PR is a non-verdict: notice, not a COMMENTED review", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      isDraft: false,
      terminalText: fenced({
        verdict: "comment",
        commit: HEAD,
        summary: "I could not review this PR: no diff was available.",
      }),
    });
    expect(res).toMatchObject({
      outcome: "degraded_comment",
      cause: "agent_comment_without_findings",
      workFailed: true,
    });
    expectNoReview(github);
    expect(github.comments[0]!.body).toContain(
      "left a note instead of a verdict: I could not review this PR",
    );
  });

  it("an absent draft flag is read as READY (the stricter reading)", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: fenced({ verdict: "comment", commit: HEAD, summary: "?" }),
    });
    expect(res.outcome).toBe("degraded_comment");
    expectNoReview(github);
  });

  it("a bare `comment` on a DRAFT stays a review — it is the draft verdict", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      isDraft: true,
      terminalText: fenced({
        verdict: "comment",
        commit: HEAD,
        summary: "Draft: the approach looks right so far.",
      }),
    });
    expect(res).toEqual({ outcome: "posted", verdict: "comment" });
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    expect(github.createConversationComment).not.toHaveBeenCalled();
  });

  it("a `comment` WITH findings on a ready PR stays a review — it surfaces them", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      isDraft: false,
      terminalText: fenced({
        verdict: "comment",
        commit: HEAD,
        summary: "One thing worth a look.",
        findings: [
          { severity: "warning", path: "a.ts", line: 3, body: "untested" },
        ],
      }),
    });
    expect(res).toEqual({ outcome: "posted", verdict: "comment" });
    expect(github.createConversationComment).not.toHaveBeenCalled();
  });

  it("a verdict at HEAD retires the notice an earlier silent run left", async () => {
    const github = makeGithub([]);
    const base = {
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
    };
    await executeReviewFromIntent({ ...base, terminalText: UNABLE });
    expect(github.comments).toHaveLength(1);

    const res = await executeReviewFromIntent({
      ...base,
      terminalText: RC_AT_HEAD,
    });
    expect(res.outcome).toBe("posted");
    expect(github.comments).toHaveLength(0);
  });

  it("a notice for a NEW commit replaces the one for the previous commit", async () => {
    const github = makeGithub([]);
    const base = {
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      terminalText: UNABLE,
    };
    await executeReviewFromIntent({ ...base, currentHeadSha: OLD });
    await executeReviewFromIntent({ ...base, currentHeadSha: HEAD });
    expect(github.comments).toHaveLength(1);
    expect(reviewNoticeSha(github.comments[0]!, BOT)).toBe(HEAD);
  });

  it("a failing notice cleanup never costs the verdict", async () => {
    const github = makeGithub([]);
    github.listConversationComments.mockRejectedValue(new Error("502"));
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_HEAD,
    });
    expect(res.outcome).toBe("posted");
  });
});

describe("executeReviewFromIntent — preferTaggedIntent passthrough (phase 6)", () => {
  // The lead's tagged verdict, then an echoed sub-agent fence after it.
  const echoed = `${LEAD_TAGGED_TEXT}\nThe security agent said:\n${SUB_AGENT_APPROVE_FENCE}\n`;

  it("with the option the lead's tagged verdict is posted", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: echoed,
      preferTaggedIntent: true,
    });
    expect(res).toMatchObject({ outcome: "posted" });
    expect(github.submitReview).toHaveBeenCalledTimes(1);
    expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
    expect(github.submitReview.mock.calls[0]![3]).toContain(LEAD_SUMMARY);
  });

  it("without the option today's last-block rule applies (the echoed approve)", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: echoed,
    });
    expect(res).toMatchObject({ outcome: "posted" });
    expect(github.submitReview).toHaveBeenCalledTimes(1);
    expect(github.submitReview.mock.calls[0]![2]).toBe("APPROVE");
    expect(github.submitReview.mock.calls[0]![3]).not.toContain(LEAD_SUMMARY);
  });
});
