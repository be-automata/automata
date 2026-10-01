import { describe, it, expect, vi } from "vitest";
import { executeReviewFromIntent } from "./execute-review-from-intent";
import type {
  GitHubReview,
  ReviewGitHubClient,
  ReviewLogger,
} from "@terragon/review/state/review-github-client";

/**
 * #213 — a worker restart must not re-post a PR's whole verdict history.
 *
 * The worker's lease can end without a clean ack; the redelivered task re-parses
 * the SAME persisted terminal text, so the intent names the SAME commit. The
 * pre-existing supersession probe only asks whether a bot review sits at LIVE
 * head, which is false both for a replay and for a late first delivery — so on
 * 2026-09-29 one restart re-posted twelve already-delivered verdicts onto PR
 * #208 in 63 seconds. The guard under test asks instead whether we already have
 * a non-dismissed review AT `emitted.commit`.
 *
 * These five scenarios pin the guard AND the two behaviours it must not eat:
 * a stale-but-first finding still reaches the PR, and a lookup failure posts
 * anyway (a lost first-and-only verdict is worse than a rare duplicate).
 */

const BOT = "automata-ai-bot[bot]";
const REPO = "o/r";
const PR = 208;
const HEAD = "head-sha";
const OLD = "old-sha";

// Copied from execute-review-from-intent.test.ts (module-local there; that file
// is not owned by this ticket, so it is not refactored to export them).
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

/** A github client whose state advances as reviews are submitted (like real GitHub). */
function makeStatefulGithub(headSha: string, bot: string) {
  const reviews: GitHubReview[] = [];
  let nextId = 1;
  const push = (
    state: GitHubReview["state"],
    commitId: string,
    body: string,
  ) => {
    reviews.push({
      id: nextId++,
      user: { login: bot },
      state,
      submittedAt: new Date().toISOString(),
      dismissedAt: null,
      commitId,
      body,
    });
  };
  const client: ReviewGitHubClient & { reviews: GitHubReview[] } = {
    reviews,
    listReviews: vi.fn(async () => reviews),
    submitReview: vi.fn(async (_repo, _pr, verdict, body) => {
      push(
        verdict === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED",
        headSha,
        body,
      );
    }),
    submitReviewWithComments: vi.fn(async (_repo, _pr, sha, event, body) => {
      const state =
        event === "APPROVE"
          ? "APPROVED"
          : event === "REQUEST_CHANGES"
            ? "CHANGES_REQUESTED"
            : "COMMENTED";
      push(state, sha, body);
    }),
    dismissReview: vi.fn(async (_repo, _pr, id) => {
      const r = reviews.find((x) => x.id === id);
      if (r) r.dismissedAt = new Date().toISOString();
    }),
    postInlineComment: vi.fn(async () => {}),
  };
  return client;
}

function makeLogger(): ReviewLogger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function loggedMessages(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls.map((c) => String(c[0]));
}

const RC_AT_OLD = fenced({
  verdict: "request_changes",
  commit: OLD,
  summary: "Off-by-one in isAdult.",
  findings: [{ severity: "error", path: "a.ts", line: 3, body: "use >=" }],
});

describe("#213 replay guard — a redelivered run does not re-post a delivered verdict", () => {
  it("the same (thread, commit) delivered twice posts exactly ONE review", async () => {
    const github = makeStatefulGithub(HEAD, BOT);
    const logger = makeLogger();
    const opts = {
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_OLD,
      logger,
    };

    const first = await executeReviewFromIntent(opts);
    const second = await executeReviewFromIntent(opts); // simulated redelivery

    expect(first).toMatchObject({ outcome: "posted_stale_comment" });
    expect(second).toEqual({
      outcome: "skipped_duplicate_at_commit",
      commit: OLD,
    });
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);

    const active = github.reviews.filter((r) => r.dismissedAt === null);
    expect(active).toHaveLength(1);
    expect(active[0]!.commitId).toBe(OLD);

    expect(
      loggedMessages(logger.info).some((m) =>
        m.includes("replay of an already-delivered verdict"),
      ),
    ).toBe(true);

    // Strengthened past the DoD: ten further redeliveries reproduce the #208
    // shape (twelve deliveries of one verdict in 63 seconds) and still add
    // nothing to the PR.
    for (let i = 0; i < 10; i++) {
      expect(await executeReviewFromIntent(opts)).toEqual({
        outcome: "skipped_duplicate_at_commit",
        commit: OLD,
      });
    }
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    expect(github.reviews.filter((r) => r.dismissedAt === null)).toHaveLength(1);
  });

  it("a stale-but-first delivery still reaches the PR as a COMMENT", async () => {
    const github = makeGithub([]); // nothing at OLD, nothing at HEAD
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: fenced({
        verdict: "request_changes",
        commit: OLD,
        summary: "Unbounded retry loop in the credential pull.",
        findings: [
          { severity: "error", path: "pull.ts", line: 42, body: "cap it" },
        ],
      }),
    });

    expect(res).toMatchObject({
      outcome: "posted_stale_comment",
      intendedVerdict: "request_changes",
    });
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    const call = github.submitReviewWithComments.mock.calls[0]!;
    expect(call[2]).toBe(OLD);
    expect(call[3]).toBe("COMMENT");
    // The stale body is `<preamble> + execIntent.body`, and execIntent.body is
    // the intent's SUMMARY (findings travel in `comments`, which line 209 passes
    // as []). Asserting the summary — not a finding body — is deliberate.
    expect(call[4]).toContain("has since advanced");
    expect(call[4]).toContain("Unbounded retry loop in the credential pull.");
    expect(github.submitReview).not.toHaveBeenCalled();
  });

  it("a fresh verdict at the current head posts the real verdict, unchanged", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: fenced({
        verdict: "request_changes",
        commit: HEAD,
        summary: "Off-by-one in isAdult.",
        findings: [{ severity: "error", path: "a.ts", line: 3, body: "use >=" }],
      }),
    });

    expect(res).toEqual({ outcome: "posted", verdict: "request_changes" });
    expect(github.submitReview).toHaveBeenCalledTimes(1);
    expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
  });

  it("a failing replay lookup posts anyway (duplicate risk accepted, lost verdict not)", async () => {
    for (const rejection of [
      new Error("gh 502"),
      Object.assign(new Error("Not Found"), { status: 404 }),
    ]) {
      const github = makeGithub([]);
      github.listReviews.mockRejectedValue(rejection);
      const logger = makeLogger();

      const res = await executeReviewFromIntent({
        github,
        repoFullName: REPO,
        prNumber: PR,
        botLogin: BOT,
        currentHeadSha: HEAD,
        terminalText: RC_AT_OLD,
        logger,
      });

      expect(res).toMatchObject({ outcome: "posted_stale_comment" });
      expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
      expect(github.submitReviewWithComments.mock.calls[0]![2]).toBe(OLD);
      expect(
        loggedMessages(logger.warn).some((m) =>
          m.includes("replay lookup failed"),
        ),
      ).toBe(true);
    }
  });

  it("a stale intent is never a formal verdict (guard 1 regression)", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: fenced({
        verdict: "approve",
        commit: OLD,
        summary: "LGTM — no blocking issues.",
        findings: [],
      }),
    });

    expect(res.outcome).toBe("posted_stale_comment");
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    expect(github.submitReviewWithComments.mock.calls[0]![3]).toBe("COMMENT");
  });
});
