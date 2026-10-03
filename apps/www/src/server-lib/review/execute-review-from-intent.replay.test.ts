import { describe, it, expect, vi } from "vitest";
import {
  DEGRADED_INTENT_MARKER,
  executeReviewFromIntent,
} from "./execute-review-from-intent";
import type {
  GitHubReview,
  ReviewLogger,
} from "@terragon/review/state/review-github-client";
import { reviewNoticeSha, type ReviewWriterClient } from "./review-notice";
import { makeNoticeFake } from "./review-notice.fake";

/**
 * #213 — a worker restart must not re-post a PR's whole verdict history.
 *
 * The worker's lease can end without a clean ack; the redelivered task re-parses
 * the SAME persisted terminal text, so the intent names the SAME commit. The
 * pre-existing supersession probe only asks whether a bot review sits at LIVE
 * head, which is false both for a replay and for a late first delivery — so on
 * 2026-09-29 one restart re-posted twelve already-delivered verdicts onto PR
 * #208 in 63 seconds. The guard under test asks instead whether we already have
 * a review AT `emitted.commit`, dismissed or not.
 *
 * These scenarios pin the guard AND the deliveries it must not eat: a
 * stale-but-first finding still reaches the PR, a lookup failure posts anyway,
 * and neither another bot's review nor an earlier run's degraded "could not be
 * parsed" silence counts as a verdict we already gave. A DISMISSED review of
 * ours does count: it was delivered, and the reconciler dismisses our older
 * verdicts on every run.
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
  const client: ReviewWriterClient & { reviews: GitHubReview[] } = {
    ...makeNoticeFake(bot),
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
    expect(github.reviews.filter((r) => r.dismissedAt === null)).toHaveLength(
      1,
    );
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
        findings: [
          { severity: "error", path: "a.ts", line: 3, body: "use >=" },
        ],
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

  it("a DISMISSED review at that commit was still delivered — the replay posts nothing", async () => {
    // The reconciler dismisses our older verdicts as the PR advances, so every
    // commit behind the newest reviewed one looks like this. Reading dismissal
    // as "never delivered" re-posted them from the hourly sweep.
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

    expect(res).toMatchObject({
      outcome: "skipped_duplicate_at_commit",
      commit: OLD,
    });
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
  });

  it("the sweep over a PR's older threads re-posts none of their dismissed verdicts", async () => {
    // Two pushes were reviewed and their verdicts dismissed by the reconciler;
    // HEAD has no verdict (its run never dispatched). The sweep runs the writer
    // once per older thread.
    const OLDER = "older-sha";
    const dismissed = {
      state: "DISMISSED",
      dismissedAt: "2026-10-03T20:35:00Z",
    } as const;
    const github = makeGithub([
      reviewAt(OLDER, { id: 1, ...dismissed }),
      reviewAt(OLD, { id: 2, ...dismissed }),
    ]);
    for (const commit of [OLDER, OLD]) {
      const res = await executeReviewFromIntent({
        github,
        repoFullName: REPO,
        prNumber: PR,
        botLogin: BOT,
        currentHeadSha: HEAD,
        terminalText: RC_AT_OLD.replace(OLD, commit),
      });
      expect(res).toMatchObject({ outcome: "skipped_duplicate_at_commit" });
    }

    expect(github.submitReview).not.toHaveBeenCalled();
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
    expect(github.comments).toHaveLength(0);
  });

  it("a DISMISSED verdict at HEAD means HEAD was served — an undelivered stale intent is superseded", async () => {
    const github = makeGithub([
      reviewAt(HEAD, {
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

    expect(res).toMatchObject({ outcome: "skipped_superseded" });
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
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
 * #220 — one no-verdict report per commit.
 *
 * The report used to be posted unconditionally. A thread re-driven through the
 * state machine (a redelivered run that restarts the agent, a resume, a follow-up
 * `system.message` taking complete → queued → working → working-done) makes the
 * finish hook fire legitimately, `extractTerminalAgentText` re-reads the PREVIOUS
 * run's unparseable text, and the report lands again at the same sha. Nothing
 * between the no-verdict early-return and GitHub stopped it.
 *
 * Dedup key: THE COMMIT, any reason. Since ADR-009 the report is a notice in
 * the PR conversation rather than a COMMENTED review, so the key is read from
 * the conversation. These pin both halves of it — that it is per-sha (not
 * per-PR), and that it is NOTICE-only and OURS-only, so neither a human quoting
 * the marker nor a real bot verdict can stand in for the notice we are deduping.
 */
describe("#220 no-verdict dedup — one notice per commit", () => {
  const UNPARSEABLE = "I looked at it and it seems fine.";
  const NEW_HEAD = "new-head-sha";

  function silentRunOpts(
    github: ReviewWriterClient,
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
      // the no-verdict path actually publishes.
      reviewedSha: sha,
      ...(logger ? { logger } : {}),
    };
  }

  it("two silent deliveries at the SAME sha leave exactly ONE notice", async () => {
    const github = makeGithub([]);
    const logger = makeLogger();

    const first = await executeReviewFromIntent(silentRunOpts(github, HEAD));
    const second = await executeReviewFromIntent(
      silentRunOpts(github, HEAD, logger),
    );

    expect(first).toMatchObject({ outcome: "degraded_comment" });
    expect(second).toEqual({
      outcome: "skipped_duplicate_degrade_at_commit",
      cause: "unparseable",
      commit: HEAD,
      reason: expect.any(String),
      workFailed: true,
    });
    expect(github.createConversationComment).toHaveBeenCalledTimes(1);
    expect(github.comments).toHaveLength(1);
    expect(reviewNoticeSha(github.comments[0]!, BOT)).toBe(HEAD);
    expect(
      loggedMessages(logger.info).some((m) =>
        m.includes("a no-verdict notice already exists at this commit"),
      ),
    ).toBe(true);

    // The storm shape: ten further re-drives add nothing to the PR.
    for (let i = 0; i < 10; i++) {
      expect(
        (await executeReviewFromIntent(silentRunOpts(github, HEAD))).outcome,
      ).toBe("skipped_duplicate_degrade_at_commit");
    }
    expect(github.createConversationComment).toHaveBeenCalledTimes(1);
    expect(github.comments).toHaveLength(1);
    // And at no point did the silence become a review.
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
  });

  it("the key is PER-COMMIT: a new run at an advanced HEAD reports again, replacing the old notice", async () => {
    // `canSpeakForHead` withholds the notice whenever reviewedSha !== HEAD, so
    // this is only reachable via a NEW run DISPATCHED at the new sha — not by
    // re-running the old run against moved HEAD. Constructed that way on purpose.
    const github = makeGithub([]);

    const atOldHead = await executeReviewFromIntent(
      silentRunOpts(github, HEAD),
    );
    const atNewHead = await executeReviewFromIntent(
      silentRunOpts(github, NEW_HEAD),
    );

    expect(atOldHead).toMatchObject({ outcome: "degraded_comment" });
    expect(atNewHead).toMatchObject({ outcome: "degraded_comment" });
    expect(github.createConversationComment).toHaveBeenCalledTimes(2);
    // One LIVE notice per PR, about the newest commit without a verdict.
    expect(
      github.comments.map((comment) => reviewNoticeSha(comment, BOT)),
    ).toEqual([NEW_HEAD]);

    // And the new sha dedups on its own terms from then on.
    expect(
      (await executeReviewFromIntent(silentRunOpts(github, NEW_HEAD))).outcome,
    ).toBe("skipped_duplicate_degrade_at_commit");
    expect(github.createConversationComment).toHaveBeenCalledTimes(2);
  });

  it("a failing dedup lookup posts anyway (a lost notice is worse than a duplicate)", async () => {
    for (const rejection of [
      new Error("gh 502"),
      Object.assign(new Error("Not Found"), { status: 404 }),
    ]) {
      const github = makeGithub([]);
      github.listConversationComments.mockRejectedValue(rejection);
      const logger = makeLogger();

      const res = await executeReviewFromIntent(
        silentRunOpts(github, HEAD, logger),
      );

      expect(res).toMatchObject({
        outcome: "degraded_comment",
        workFailed: true,
      });
      expect(github.createConversationComment).toHaveBeenCalledTimes(1);
      expect(
        loggedMessages(logger.warn).some((m) =>
          m.includes("comment lookup failed (per-commit dedup)"),
        ),
      ).toBe(true);
    }
  });

  it("a failing notice post is still a workFailed outcome, never a throw", async () => {
    const github = makeGithub([]);
    github.createConversationComment.mockRejectedValue(new Error("gh 500"));
    const logger = makeLogger();

    const res = await executeReviewFromIntent(
      silentRunOpts(github, HEAD, logger),
    );

    expect(res).toMatchObject({
      outcome: "degraded_comment",
      workFailed: true,
    });
    expect(
      loggedMessages(logger.error).some((m) =>
        m.includes("no-verdict notice post ALSO failed"),
      ),
    ).toBe(true);
  });

  it("never suppresses a REAL verdict — the guard only ever gates the notice", async () => {
    // Our own notice sits at HEAD; this run DID parse a verdict there.
    const github = makeGithub([]);
    await executeReviewFromIntent(silentRunOpts(github, HEAD));
    expect(github.comments).toHaveLength(1);

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

  it("a LEGACY degraded review at HEAD does not suppress a real verdict either", async () => {
    // Posted before ADR-009; open PRs still carry them.
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
  });

  it("a HUMAN pasting the marker at that sha does NOT suppress our notice", async () => {
    // Pins the AUTHOR CHECK. The marker is public text; without the login
    // check a pasted copy would silence the bot's own notice at this commit —
    // and the bot could not delete a comment it does not own.
    const github = makeGithub([]);
    github.comments.push({
      id: 900,
      user: { login: "a-human" },
      body: `<!-- automata:review-notice sha=${HEAD} -->\nwhy did this fire?`,
    });

    const res = await executeReviewFromIntent(silentRunOpts(github, HEAD));

    expect(res).toMatchObject({ outcome: "degraded_comment" });
    expect(github.createConversationComment).toHaveBeenCalledTimes(1);
    expect(github.deleteConversationComment).not.toHaveBeenCalled();
    expect(github.comments).toHaveLength(2);
  });

  it("the bot QUOTING the marker mid-comment is not a notice", async () => {
    // The marker is matched as a PREFIX: an audit comment or a reply of ours
    // that merely mentions it must neither dedup a notice nor be deleted.
    const github = makeGithub([]);
    github.comments.push({
      id: 901,
      user: { login: BOT },
      body: `Earlier: <!-- automata:review-notice sha=${HEAD} --> was posted.`,
    });

    const res = await executeReviewFromIntent(silentRunOpts(github, HEAD));

    expect(res).toMatchObject({ outcome: "degraded_comment" });
    expect(github.deleteConversationComment).not.toHaveBeenCalled();
    expect(github.comments).toHaveLength(2);
  });

  it("a real BOT verdict at that sha does NOT suppress the notice (key is notice-only)", async () => {
    // The decided key is "a NOTICE of ours at this sha", not "any bot review at
    // this sha": a later silent run at a commit that already has a verdict is
    // still a failed run a reader should hear about once.
    const github = makeGithub([
      reviewAt(HEAD, { id: 13, state: "APPROVED", body: "LGTM" }),
    ]);

    const res = await executeReviewFromIntent(silentRunOpts(github, HEAD));

    expect(res).toMatchObject({ outcome: "degraded_comment" });
    expect(github.createConversationComment).toHaveBeenCalledTimes(1);
  });
});
