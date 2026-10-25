import { describe, it, expect, vi } from "vitest";
import {
  DEGRADED_INTENT_MARKER,
  DRAFT_ERA_NOTE_MARKER,
  botAuthoredVerdictLine,
  executeReviewFromIntent,
  isDegradedComment,
  reviewBaseMarker,
} from "./execute-review-from-intent";
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

  // #504: the prompt said "draft" (stamped at dispatch), the PR left draft
  // before finish. The agent's bare `comment` answered the PR it was shown.
  describe("draft at dispatch, ready at finish", () => {
    const base = {
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      isDraft: false,
    };
    const BARE_COMMENT = fenced({
      verdict: "comment",
      commit: HEAD,
      summary: "Draft: the approach looks right so far.",
    });

    it("a bare `comment` posts as a review, never a notice", async () => {
      const github = makeGithub([]);
      const res = await executeReviewFromIntent({
        ...base,
        github,
        draftAtDispatch: true,
        terminalText: BARE_COMMENT,
      });
      expect(res).toEqual({ outcome: "posted", verdict: "comment" });
      expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
      expect(github.createConversationComment).not.toHaveBeenCalled();
    });

    it("ready at dispatch AND at finish is still the ADR-009 notice", async () => {
      const github = makeGithub([]);
      const res = await executeReviewFromIntent({
        ...base,
        github,
        draftAtDispatch: false,
        terminalText: BARE_COMMENT,
      });
      expect(res).toMatchObject({
        outcome: "degraded_comment",
        cause: "agent_comment_without_findings",
      });
      expectNoReview(github);
    });

    it("the floor cap follows the LIVE state: request_changes stays formal", async () => {
      const github = makeGithub([]);
      const res = await executeReviewFromIntent({
        ...base,
        github,
        draftAtDispatch: true,
        terminalText: RC_AT_HEAD,
      });
      expect(res.outcome).toBe("posted");
      expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
    });

    // A late draft-era comment (the sweep, a slow finish) must not dismiss
    // the verdict the ready-PR run already posted at the same HEAD.
    it.each(["APPROVED", "CHANGES_REQUESTED"] as const)(
      "never replaces a %s review already in force at HEAD",
      async (state) => {
        const github = makeGithub([
          {
            id: 9,
            user: { login: BOT },
            state,
            submittedAt: "2026-10-24T12:00:00Z",
            dismissedAt: null,
            commitId: HEAD,
            body: "Ready-PR verdict.",
          },
        ]);
        const res = await executeReviewFromIntent({
          ...base,
          github,
          draftAtDispatch: true,
          terminalText: BARE_COMMENT,
        });
        expect(res.outcome).toBe("skipped_existing");
        expect(github.dismissReview).not.toHaveBeenCalled();
        expectNoReview(github);
        expect(github.createConversationComment).not.toHaveBeenCalled();
      },
    );

    it("after a retarget, a review of the OLD base is not one to yield to", async () => {
      const github = makeGithub([
        {
          id: 9,
          user: { login: BOT },
          state: "APPROVED",
          submittedAt: "2026-10-24T12:00:00Z",
          dismissedAt: null,
          commitId: HEAD,
          body: `LGTM.\n\n${reviewBaseMarker("feat/parent")}`,
        },
      ]);
      const res = await executeReviewFromIntent({
        ...base,
        github,
        draftAtDispatch: true,
        reviewBase: "main",
        liveBase: "main",
        terminalText: BARE_COMMENT,
      });
      expect(res).toEqual({ outcome: "posted", verdict: "comment" });
      expect(github.dismissReview).not.toHaveBeenCalled();
    });

    it("a legacy degraded COMMENT at HEAD is silence, not a review to yield to", async () => {
      const github = makeGithub([
        {
          id: 9,
          user: { login: BOT },
          state: "COMMENTED",
          submittedAt: "2026-10-24T12:00:00Z",
          dismissedAt: null,
          commitId: HEAD,
          body: `${DEGRADED_INTENT_MARKER}\n\n_Reason: no JSON._`,
        },
      ]);
      const res = await executeReviewFromIntent({
        ...base,
        github,
        draftAtDispatch: true,
        terminalText: BARE_COMMENT,
      });
      expect(res).toEqual({ outcome: "posted", verdict: "comment" });
    });

    it("an unknown live draft state still yields to a verdict at HEAD", async () => {
      const github = makeGithub([
        {
          id: 9,
          user: { login: BOT },
          state: "APPROVED",
          submittedAt: "2026-10-24T12:00:00Z",
          dismissedAt: null,
          commitId: HEAD,
          body: "Ready-PR verdict.",
        },
      ]);
      const res = await executeReviewFromIntent({
        github,
        repoFullName: REPO,
        prNumber: PR,
        botLogin: BOT,
        currentHeadSha: HEAD,
        draftAtDispatch: true,
        terminalText: BARE_COMMENT,
      });
      expect(res.outcome).toBe("skipped_existing");
      expect(github.dismissReview).not.toHaveBeenCalled();
    });

    // No read, no post: the note has no other idempotency check, so the run
    // fails loud and the hourly sweep retries once GitHub answers.
    it("a failed review lookup posts nothing and fails the run", async () => {
      const github = makeGithub([]);
      github.listReviews.mockRejectedValue(new Error("502"));
      const res = await executeReviewFromIntent({
        ...base,
        github,
        draftAtDispatch: true,
        terminalText: BARE_COMMENT,
      });
      expect(res).toMatchObject({ outcome: "post_failed", workFailed: true });
      expectNoReview(github);
    });

    it("a legacy degraded COMMENT at HEAD never swallows a later COMMENT with findings", async () => {
      const github = makeGithub([
        {
          id: 8,
          user: { login: BOT },
          state: "APPROVED",
          submittedAt: "2026-10-24T11:00:00Z",
          dismissedAt: null,
          commitId: HEAD,
          body: "LGTM.",
        },
        {
          id: 9,
          user: { login: BOT },
          state: "COMMENTED",
          submittedAt: "2026-10-24T12:00:00Z",
          dismissedAt: null,
          commitId: HEAD,
          body: `${DEGRADED_INTENT_MARKER}\n\n_Reason: x._`,
        },
      ]);
      const res = await executeReviewFromIntent({
        ...base,
        github,
        terminalText: fenced({
          verdict: "comment",
          commit: HEAD,
          summary: "One thing worth a look.",
          findings: [
            { severity: "info", path: "a.ts", line: 3, body: "untested" },
          ],
        }),
      });
      expect(res).toEqual({ outcome: "posted", verdict: "comment" });
    });

    // The PR also moved on: a draft-era comment about an older commit says
    // nothing about the ready PR at HEAD, so it stays a withheld no-verdict.
    it("a bare `comment` at an older commit stays a withheld no-verdict", async () => {
      const github = makeGithub([]);
      const res = await executeReviewFromIntent({
        ...base,
        github,
        draftAtDispatch: true,
        terminalText: fenced({
          verdict: "comment",
          commit: OLD,
          summary: "Draft: the approach looks right so far.",
        }),
      });
      expect(res.outcome).toBe("skipped_stale_degrade");
      expectNoReview(github);
      expect(github.createConversationComment).not.toHaveBeenCalled();
    });

    it("the note is marked, and a later COMMENT with findings still posts over it", async () => {
      const github = makeGithub([]);
      await executeReviewFromIntent({
        ...base,
        github,
        draftAtDispatch: true,
        terminalText: BARE_COMMENT,
      });
      const noteBody = github.submitReviewWithComments.mock.calls[0]![4];
      expect(noteBody.trimEnd().endsWith(DRAFT_ERA_NOTE_MARKER)).toBe(true);
      // The ready-PR run's review, with the note in force at HEAD.
      github.listReviews.mockResolvedValue([
        {
          id: 9,
          user: { login: BOT },
          state: "COMMENTED",
          submittedAt: "2026-10-24T12:00:00Z",
          dismissedAt: null,
          commitId: HEAD,
          body: noteBody,
        },
      ]);
      const res = await executeReviewFromIntent({
        ...base,
        github,
        draftAtDispatch: false,
        terminalText: fenced({
          verdict: "comment",
          commit: HEAD,
          summary: "One thing worth a look.",
          findings: [
            { severity: "info", path: "a.ts", line: 3, body: "untested" },
          ],
        }),
      });
      expect(res).toEqual({ outcome: "posted", verdict: "comment" });
      expect(github.submitReviewWithComments).toHaveBeenCalledTimes(2);
    });

    it.each(["the intent commit", "HEAD"])(
      "a draft-era note at %s never blocks a stale real verdict",
      async (at) => {
        const github = makeGithub([
          {
            id: 9,
            user: { login: BOT },
            state: "COMMENTED",
            submittedAt: "2026-10-24T12:00:00Z",
            dismissedAt: null,
            commitId: at === "HEAD" ? HEAD : OLD,
            body: `Draft: fine.\n\n${DRAFT_ERA_NOTE_MARKER}`,
          },
        ]);
        const res = await executeReviewFromIntent({
          ...base,
          github,
          terminalText: fenced({
            verdict: "request_changes",
            commit: OLD,
            summary: "Off-by-one.",
            findings: [
              { severity: "error", path: "a.ts", line: 3, body: "use >=" },
            ],
          }),
        });
        expect(res.outcome).toBe("posted_stale_comment");
        expect(github.submitReviewWithComments.mock.calls[0]![2]).toBe(OLD);
      },
    );

    it("agent text can never carry the marker: a real verdict stays a verdict", async () => {
      const github = makeGithub([]);
      await executeReviewFromIntent({
        ...base,
        github,
        terminalText: fenced({
          verdict: "comment",
          commit: HEAD,
          summary: `One thing worth a look.\n\n${DRAFT_ERA_NOTE_MARKER}`,
          findings: [
            { severity: "info", path: "a.ts", line: 3, body: "untested" },
          ],
        }),
      });
      const body = github.submitReviewWithComments.mock.calls[0]![4];
      expect(body).not.toContain(DRAFT_ERA_NOTE_MARKER);
    });

    it.each([
      ["a finding body", "findings"],
      ["a nested marker in the summary", "nested"],
      ["a finding path", "path"],
    ])("agent text cannot forge the marker through %s", async (_, how) => {
      const github = makeGithub([]);
      const nested =
        "<!-- automata:draft-era<!-- automata:draft-era-note -->-note -->";
      await executeReviewFromIntent({
        ...base,
        github,
        terminalText: fenced({
          verdict: "comment",
          commit: HEAD,
          summary: how === "nested" ? `Look.\n\n${nested}` : "Look.",
          findings: [
            {
              severity: "info",
              path: how === "path" ? `a.ts${DRAFT_ERA_NOTE_MARKER}` : "a.ts",
              line: 3,
              body:
                how === "findings"
                  ? `untested ${DRAFT_ERA_NOTE_MARKER}`
                  : "untested",
            },
          ],
        }),
      });
      const body = github.submitReviewWithComments.mock.calls[0]![4];
      expect(body).not.toMatch(/<!--\s*automata:draft-era-note\s*-->/i);
    });

    it("a stale real verdict cannot be marked by agent text", async () => {
      const github = makeGithub([]);
      await executeReviewFromIntent({
        ...base,
        github,
        terminalText: fenced({
          verdict: "request_changes",
          commit: OLD,
          summary: `Off-by-one.\n\n${DRAFT_ERA_NOTE_MARKER}`,
          findings: [
            { severity: "error", path: "a.ts", line: 3, body: "use >=" },
          ],
        }),
      });
      const body = github.submitReviewWithComments.mock.calls[0]![4];
      expect(body).not.toContain(DRAFT_ERA_NOTE_MARKER);
    });

    it("a note about a commit the run was not dispatched to stays a no-verdict", async () => {
      const github = makeGithub([]);
      const res = await executeReviewFromIntent({
        ...base,
        github,
        draftAtDispatch: true,
        reviewedSha: OLD,
        terminalText: BARE_COMMENT,
      });
      expect(res.outcome).toBe("skipped_stale_degrade");
      expectNoReview(github);
    });

    it("a posted note never retires a no-verdict notice", async () => {
      const github = makeGithub([]);
      await executeReviewFromIntent({ ...base, github, terminalText: UNABLE });
      expect(github.comments).toHaveLength(1);
      const res = await executeReviewFromIntent({
        ...base,
        github,
        draftAtDispatch: true,
        terminalText: BARE_COMMENT,
      });
      expect(res).toEqual({ outcome: "posted", verdict: "comment" });
      expect(github.comments).toHaveLength(1);
    });

    it("an abandoned run keeps today's rule: no review at HEAD, no notice", async () => {
      const github = makeGithub([]);
      const res = await executeReviewFromIntent({
        ...base,
        github,
        draftAtDispatch: true,
        runAbandoned: true,
        terminalText: BARE_COMMENT,
      });
      expect(res.outcome).toBe("skipped_stale_degrade");
      expectNoReview(github);
      expect(github.createConversationComment).not.toHaveBeenCalled();
    });
  });

  it("a `comment` WITH findings on a ready PR stays a review — it surfaces them", async () => {
    // The finding sits BELOW the block threshold: a blocking one would be
    // raised to request_changes by the floor (covered in
    // review-thread-resolutions.test.ts); this case is about ADR-009 only.
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
          { severity: "info", path: "a.ts", line: 3, body: "untested" },
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

describe("executeReviewFromIntent — a PR the bot opened itself (self-heal fix PR)", () => {
  // Live on PR #266: the review run reached `approve` at the head, and nothing
  // reached GitHub — GitHub answers a formal APPROVE / REQUEST_CHANGES from the
  // PR's own author with a 422, and the self-heal fix PR's author IS the App.
  const APPROVE_WITH_NIT = fenced({
    verdict: "approve",
    commit: HEAD,
    summary: "Fix is correct.",
    findings: [{ severity: "info", path: "a.ts", line: 3, body: "a nit" }],
  });

  it("approve → a COMMENT at HEAD led by the verdict line; findings folded exactly as before", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: APPROVE_WITH_NIT,
      prAuthoredByBot: true,
    });
    expect(res).toEqual({
      outcome: "posted",
      verdict: "approve",
      postedAsComment: true,
    });
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    const [, , sha, event, body, comments] =
      github.submitReviewWithComments.mock.calls[0]!;
    expect(sha).toBe(HEAD);
    expect(event).toBe("COMMENT");
    expect(comments).toEqual([]);
    expect(body.startsWith(`${botAuthoredVerdictLine("approve")}\n\n`)).toBe(
      true,
    );
    expect(body).toContain("Fix is correct.");
    expect(body).toContain("**[info]** `a.ts:3` — a nit");
  });

  it("the verdict line names the verdict and why it is a comment", () => {
    expect(botAuthoredVerdictLine("approve")).toBe(
      "**Verdict: approve** (posted as a comment: GitHub does not let an app approve or request changes on a pull request it opened)",
    );
  });

  it("inline findings are still posted as inline threads, not folded", async () => {
    const github = makeGithub([]);
    await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: APPROVE_WITH_NIT,
      prAuthoredByBot: true,
      postInlineComments: true,
    });
    const body = github.submitReviewWithComments.mock.calls[0]![4];
    expect(body).not.toContain("**Findings");
    expect(github.postInlineComment).toHaveBeenCalledTimes(1);
    expect(github.postInlineComment.mock.calls[0]!.slice(2)).toEqual([
      "a.ts",
      3,
      "a nit",
      HEAD,
    ]);
  });

  it("request_changes → a COMMENT stating request_changes", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_HEAD,
      prAuthoredByBot: true,
    });
    expect(res).toMatchObject({
      outcome: "posted",
      verdict: "request_changes",
      postedAsComment: true,
    });
    expect(github.submitReview).not.toHaveBeenCalled();
    const [, , , event, body] = github.submitReviewWithComments.mock.calls[0]!;
    expect(event).toBe("COMMENT");
    expect(body.startsWith(botAuthoredVerdictLine("request_changes"))).toBe(
      true,
    );
    expect(body).toContain("**[error]** `a.ts:3` — use >=");
  });

  it("the floor runs first: the stated verdict is the effective one", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: fenced({
        verdict: "approve",
        commit: HEAD,
        summary: "Looks fine.",
        findings: [{ severity: "error", path: "a.ts", line: 3, body: "bug" }],
      }),
      prAuthoredByBot: true,
    });
    expect(res).toMatchObject({ verdict: "request_changes" });
    const body = github.submitReviewWithComments.mock.calls[0]![4];
    expect(body.startsWith(botAuthoredVerdictLine("request_changes"))).toBe(
      true,
    );
  });

  it.each([false, undefined])(
    "a PR the bot did NOT open is unchanged: a formal APPROVE (prAuthoredByBot=%s)",
    async (prAuthoredByBot) => {
      const github = makeGithub([]);
      const res = await executeReviewFromIntent({
        github,
        repoFullName: REPO,
        prNumber: PR,
        botLogin: BOT,
        currentHeadSha: HEAD,
        terminalText: APPROVE_WITH_NIT,
        prAuthoredByBot,
      });
      expect(res).toEqual({ outcome: "posted", verdict: "approve" });
      expect(github.submitReviewWithComments).not.toHaveBeenCalled();
      expect(github.submitReview).toHaveBeenCalledTimes(1);
      const [, , event, body] = github.submitReview.mock.calls[0]!;
      expect(event).toBe("APPROVE");
      expect(body).not.toContain("**Verdict:");
    },
  );

  it("a draft's own `comment` verdict carries no verdict line", async () => {
    const github = makeGithub([]);
    await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: fenced({
        verdict: "comment",
        commit: HEAD,
        summary: "Draft looks on track.",
      }),
      prAuthoredByBot: true,
      isDraft: true,
    });
    const body = github.submitReviewWithComments.mock.calls[0]![4];
    expect(body).not.toContain("**Verdict:");
  });

  it("a redelivery finds its own COMMENT verdict at HEAD and posts nothing", async () => {
    const delivered: GitHubReview = {
      id: 9,
      user: { login: BOT },
      state: "COMMENTED",
      submittedAt: "2026-10-05T00:00:00Z",
      dismissedAt: null,
      commitId: HEAD,
      body: `${botAuthoredVerdictLine("approve")}\n\nFix is correct.`,
    };
    // A verdict, not silence: every guard filters degraded comments first.
    expect(isDegradedComment(delivered)).toBe(false);
    const github = makeGithub([delivered]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: APPROVE_WITH_NIT,
      prAuthoredByBot: true,
    });
    expect(res.outcome).toBe("skipped_existing");
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
  });

  it("a stale replay at the commit of its COMMENT verdict is dropped", async () => {
    const delivered: GitHubReview = {
      id: 9,
      user: { login: BOT },
      state: "COMMENTED",
      submittedAt: "2026-10-05T00:00:00Z",
      dismissedAt: null,
      commitId: OLD,
      body: `${botAuthoredVerdictLine("approve")}\n\nFix is correct.`,
    };
    const github = makeGithub([delivered]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: fenced({
        verdict: "approve",
        commit: OLD,
        summary: "Fix is correct.",
      }),
      prAuthoredByBot: true,
    });
    expect(res).toEqual({
      outcome: "skipped_duplicate_at_commit",
      commit: OLD,
    });
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
  });
});

// #441: the executor is shared by the finish hook and the hourly sweep; both
// pass `providerUnavailable` from the same chat row, so this covers both.
describe("executeReviewFromIntent — provider_unavailable (#441)", () => {
  const provider = {
    kind: "usage_limit" as const,
    window: "five_hour" as const,
    resetsAt: Date.UTC(2026, 9, 21, 18, 0),
  };

  // Card: protects=a provider-refused run names the provider cause instead of
  // "unparseable" and still never posts a review; fails_when=the notice says
  // "could not be read", a review is submitted, or workFailed is lost;
  // no_claim=how the chat row got its classification (handleDaemonEvent).
  it("names the provider cause on the notice, never a review", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: "",
      providerUnavailable: provider,
    });
    expect(res).toMatchObject({
      outcome: "degraded_comment",
      cause: "provider_unavailable",
      workFailed: true,
    });
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.body).toContain(
      "hit its five-hour usage limit; it resets at 18:00 UTC on 21 Oct.",
    );
  });

  // Card: protects=AC2, the generic notice an earlier pass left at HEAD is
  // corrected in place; fails_when=a second notice is created at the same
  // sha or the outcome reads as a duplicate; no_claim=a parsed verdict (the
  // classification is consulted only when nothing parsed).
  it("corrects an existing generic notice at HEAD in place", async () => {
    const github = makeGithub([]);
    await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: "",
    });
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: "",
      providerUnavailable: provider,
    });
    expect(res.outcome).toBe("degraded_comment");
    expect(github.createConversationComment).toHaveBeenCalledTimes(1);
    expect(github.updateConversationComment).toHaveBeenCalledTimes(1);
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.body).toContain("five-hour usage limit");
  });
});
