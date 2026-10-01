import { describe, it, expect, vi } from "vitest";
import {
  DEGRADED_INTENT_MARKER,
  executeReviewFromIntent,
} from "./execute-review-from-intent";
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
 * These scenarios pin the guard AND the deliveries it must not eat: a
 * stale-but-first finding still reaches the PR, a lookup failure posts anyway,
 * and neither another bot's review, a dismissed review, nor an earlier run's
 * degraded "could not be parsed" silence counts as a verdict we already gave.
 * A lost first-and-only verdict is worse than a rare duplicate.
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

function reviewAt(
  commitId: string,
  over: Partial<GitHubReview> = {},
): GitHubReview {
  return {
    id: 99,
    user: { login: BOT },
    state: "COMMENTED",
    submittedAt: "2026-09-29T00:00:00Z",
    dismissedAt: null,
    commitId,
    body: "an earlier verdict",
    ...over,
  };
}

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
          m.includes("review lookup failed"),
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

  it("ONE listReviews round trip serves both the replay and supersession guards", async () => {
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_OLD,
    });

    expect(res).toMatchObject({ outcome: "posted_stale_comment" });
    expect(github.listReviews).toHaveBeenCalledTimes(1);
  });

  it("a review at that commit by a DIFFERENT bot does not suppress our delivery", async () => {
    const github = makeGithub([
      reviewAt(OLD, { user: { login: "some-other-bot[bot]" } }),
    ]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_OLD,
    });

    expect(res).toMatchObject({ outcome: "posted_stale_comment" });
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    expect(github.submitReviewWithComments.mock.calls[0]![2]).toBe(OLD);
  });

  it("a DISMISSED review at that commit does not suppress our delivery", async () => {
    // Intended: the primitive filters `dismissedAt === null`, and a dismissed
    // review is no longer in force — so the verdict is restored rather than lost.
    const github = makeGithub([
      reviewAt(OLD, {
        state: "DISMISSED",
        dismissedAt: "2026-09-29T01:00:00Z",
      }),
    ]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_OLD,
    });

    expect(res).toMatchObject({ outcome: "posted_stale_comment" });
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    expect(github.submitReviewWithComments.mock.calls[0]![2]).toBe(OLD);
  });

  it("a prior DEGRADED comment at that commit is silence, not a delivered verdict", async () => {
    // An earlier run at OLD produced no parseable intent and stamped the marked
    // COMMENT. A later run DID find something at OLD; dropping it as a "replay"
    // of that silence would lose a first-and-only finding — the #213 fix's own
    // worst outcome.
    const github = makeGithub([
      reviewAt(OLD, { body: `${DEGRADED_INTENT_MARKER}\n\n_Reason: x._` }),
    ]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_OLD,
    });

    expect(res).toMatchObject({ outcome: "posted_stale_comment" });
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    const body = github.submitReviewWithComments.mock.calls[0]![4];
    expect(body).toContain("Off-by-one in isAdult.");
  });
});

/**
 * #221 — the SAME defect at the OTHER guard.
 *
 * #213's refinement taught the replay guard that a degraded comment is silence,
 * not a delivery. The supersession probe, twenty-five lines further down, kept
 * reading the unfiltered list, so a degraded comment at live HEAD still counted
 * as a NEWER verdict and dropped a real one that merely arrived late. Both
 * guards now read one filtered `const`.
 */
describe("#221 supersession guard — silence at HEAD does not supersede a verdict", () => {
  it("a DEGRADED comment at live HEAD does NOT supersede a real stale verdict", async () => {
    // The exact fixture: a real verdict computed at OLD, live HEAD is HEAD, a
    // degraded comment sits at HEAD left by a later run that produced nothing,
    // and there is no real review by us at HEAD. Without the fix the probe
    // matches that comment and returns skipped_superseded, losing the finding.
    const github = makeGithub([
      reviewAt(HEAD, {
        id: 7,
        body: `${DEGRADED_INTENT_MARKER}\n\n_Reason: no JSON intent block found._`,
      }),
    ]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_OLD,
    });

    expect(res).toMatchObject({ outcome: "posted_stale_comment" });
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    // Posted at the commit it was computed for, with the finding intact.
    expect(github.submitReviewWithComments.mock.calls[0]![2]).toBe(OLD);
    expect(github.submitReviewWithComments.mock.calls[0]![4]).toContain(
      "Off-by-one in isAdult.",
    );
  });

  it("a REAL review at live HEAD still supersedes the stale verdict", async () => {
    // The other direction, so the fix cannot be mistaken for "never supersede".
    // A genuine verdict at HEAD is newer and must still win.
    const logger = makeLogger();
    const github = makeGithub([reviewAt(HEAD, { id: 8, state: "APPROVED" })]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_OLD,
      logger,
    });

    expect(res).toMatchObject({ outcome: "skipped_superseded" });
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
    expect(loggedMessages(logger.info).join(" ")).toContain(
      "superseded by review at HEAD",
    );
  });
});

/**
 * #220 — one degraded comment per commit.
 *
 * `postDegradedComment` posted unconditionally. A thread re-driven through the
 * state machine (a redelivered run that restarts the agent, a resume, a follow-up
 * `system.message` taking complete → queued → working → working-done) makes the
 * finish hook fire legitimately, `extractTerminalAgentText` re-reads the PREVIOUS
 * run's unparseable text, and the warning lands again at the same sha. Nothing
 * between the degraded early-return and GitHub stopped it.
 *
 * Dedup key: THE COMMIT, any reason. These pin both halves of that — that the
 * key is per-sha (not per-PR), and that it is DEGRADED-only and OURS-only, so
 * neither a human quoting the marker nor a real bot verdict can stand in for the
 * warning we are deduping.
 */
describe("#220 degraded dedup — one 'could not be parsed' comment per commit", () => {
  const UNPARSEABLE = "I looked at it and it seems fine.";
  const NEW_HEAD = "new-head-sha";

  function degradeOpts(
    github: ReviewGitHubClient,
    sha: string,
    logger?: ReviewLogger,
  ) {
    return {
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: sha,
      terminalText: UNPARSEABLE,
      // The run was dispatched at this very sha, so `canSpeakForHead` holds and
      // the degraded path is actually reached.
      reviewedSha: sha,
      ...(logger ? { logger } : {}),
    };
  }

  it("two degraded deliveries at the SAME sha post exactly ONE comment", async () => {
    const github = makeStatefulGithub(HEAD, BOT);
    const logger = makeLogger();

    const first = await executeReviewFromIntent(degradeOpts(github, HEAD));
    const second = await executeReviewFromIntent(
      degradeOpts(github, HEAD, logger),
    );

    expect(first).toMatchObject({ outcome: "degraded_comment" });
    expect(second).toEqual({
      outcome: "skipped_duplicate_degrade_at_commit",
      commit: HEAD,
      reason: expect.any(String),
      workFailed: true,
    });
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]!.body).toContain(DEGRADED_INTENT_MARKER);
    expect(github.reviews[0]!.commitId).toBe(HEAD);
    expect(
      loggedMessages(logger.info).some((m) =>
        m.includes("a degraded COMMENT already exists at this commit"),
      ),
    ).toBe(true);

    // The storm shape: ten further re-drives add nothing to the PR.
    for (let i = 0; i < 10; i++) {
      expect(
        (await executeReviewFromIntent(degradeOpts(github, HEAD))).outcome,
      ).toBe("skipped_duplicate_degrade_at_commit");
    }
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    expect(
      github.reviews.filter((r) => r.body.includes(DEGRADED_INTENT_MARKER)),
    ).toHaveLength(1);
  });

  it("the key is PER-COMMIT: a new run at an advanced HEAD may warn again", async () => {
    // `canSpeakForHead` withholds the warning whenever reviewedSha !== HEAD, so
    // this is only reachable via a NEW run DISPATCHED at the new sha — not by
    // re-running the old run against moved HEAD. Constructed that way on purpose.
    const github = makeStatefulGithub(HEAD, BOT);

    const atOldHead = await executeReviewFromIntent(degradeOpts(github, HEAD));
    const atNewHead = await executeReviewFromIntent(
      degradeOpts(github, NEW_HEAD),
    );

    expect(atOldHead).toMatchObject({ outcome: "degraded_comment" });
    expect(atNewHead).toMatchObject({ outcome: "degraded_comment" });
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(2);
    expect(github.reviews.map((r) => r.commitId)).toEqual([HEAD, NEW_HEAD]);

    // And the new sha dedups on its own terms from then on.
    expect(
      (await executeReviewFromIntent(degradeOpts(github, NEW_HEAD))).outcome,
    ).toBe("skipped_duplicate_degrade_at_commit");
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(2);
  });

  it("a failing dedup lookup posts anyway (lost warning is worse than a duplicate)", async () => {
    for (const rejection of [
      new Error("gh 502"),
      Object.assign(new Error("Not Found"), { status: 404 }),
    ]) {
      const github = makeGithub([]);
      github.listReviews.mockRejectedValue(rejection);
      const logger = makeLogger();

      const res = await executeReviewFromIntent(
        degradeOpts(github, HEAD, logger),
      );

      expect(res).toMatchObject({
        outcome: "degraded_comment",
        workFailed: true,
      });
      expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
      expect(github.submitReviewWithComments.mock.calls[0]![2]).toBe(HEAD);
      expect(
        loggedMessages(logger.warn).some((m) =>
          m.includes("review lookup failed (degraded dedup guard)"),
        ),
      ).toBe(true);
    }
  });

  it("never suppresses a REAL verdict — the guard only ever gates the warning", async () => {
    // Our own degraded comment sits at HEAD; this run DID parse a verdict there.
    const github = makeGithub([
      reviewAt(HEAD, {
        id: 11,
        body: `${DEGRADED_INTENT_MARKER}\n\n_Reason: no JSON intent block found._`,
      }),
    ]);
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
        findings: [
          { severity: "error", path: "a.ts", line: 3, body: "use >=" },
        ],
      }),
      reviewedSha: HEAD,
    });

    expect(res).toEqual({ outcome: "posted", verdict: "request_changes" });
    expect(github.submitReview).toHaveBeenCalledTimes(1);
    expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
  });

  it("a HUMAN quoting the marker at that sha does NOT suppress our warning", async () => {
    // Pins the FILTER ORDER. `isDegradedComment` is a bare body match with no
    // author check; the safety comes from layering `findBotReviewAtHead`'s
    // login check AFTER it. Drop that layering and this human comment silences
    // the bot's own warning forever at this commit.
    const github = makeGithub([
      reviewAt(HEAD, {
        id: 12,
        user: { login: "a-human" },
        body: `Quoting the bot: ${DEGRADED_INTENT_MARKER} — why did this fire?`,
      }),
    ]);

    const res = await executeReviewFromIntent(degradeOpts(github, HEAD));

    expect(res).toMatchObject({ outcome: "degraded_comment" });
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    expect(github.submitReviewWithComments.mock.calls[0]![4]).toContain(
      DEGRADED_INTENT_MARKER,
    );
  });

  it("a real BOT verdict at that sha does NOT suppress the warning (key is degraded-only)", async () => {
    // The decided key is "a DEGRADED comment of ours at this sha", not "any bot
    // review at this sha". Passing the unfiltered list to findBotReviewAtHead
    // would widen it here and withhold a warning that belongs under the verdict.
    const github = makeGithub([
      reviewAt(HEAD, { id: 13, state: "APPROVED", body: "LGTM" }),
    ]);

    const res = await executeReviewFromIntent(degradeOpts(github, HEAD));

    expect(res).toMatchObject({ outcome: "degraded_comment" });
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    expect(github.submitReviewWithComments.mock.calls[0]![2]).toBe(HEAD);
  });
});
