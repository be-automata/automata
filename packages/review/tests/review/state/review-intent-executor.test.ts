/**
 * ADR-036 — review-intent executor (the dumb idempotent pipe). Ported from
 * orch-agents; adapted for the REQUIRED botLogin param (injected via the `exec`
 * helper) and the pure package import paths. Assertions are unchanged.
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

import {
  executeReviewIntent,
  type ReviewIntent,
} from "../../../src/review/state/review-intent-executor";
import type { GitHubReview } from "../../../src/review/state/review-github-client";

const BOT = "automata[bot]";
const REPO = "owner/repo";
const PR = 7;
const HEAD = "sha-head-1";

function botReviewAtHead(
  state: GitHubReview["state"] = "CHANGES_REQUESTED",
  id = 1,
): GitHubReview {
  return {
    id,
    user: { login: BOT },
    state,
    submittedAt: null,
    dismissedAt: null,
    commitId: HEAD,
    body: "",
  };
}

function makeGithub(reviews: GitHubReview[] = []) {
  // Explicit param signatures so `.mock.calls[i].arguments` is a correctly-typed
  // tuple (bare `async () => {}` infers an empty-tuple arguments → TS2493 on index).
  return {
    listReviews: mock.fn(
      async (_repo: string, _pr: number): Promise<GitHubReview[]> => reviews,
    ),
    submitReview: mock.fn(
      async (
        _repo: string,
        _pr: number,
        _verdict: "APPROVE" | "REQUEST_CHANGES",
        _body: string,
      ): Promise<void> => {},
    ),
    submitReviewWithComments: mock.fn(
      async (
        _repo: string,
        _pr: number,
        _sha: string,
        _verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
        _body: string,
        _comments: Array<{ path: string; line: number; body: string }>,
      ): Promise<void> => {},
    ),
    dismissReview: mock.fn(
      async (
        _repo: string,
        _pr: number,
        _id: number,
        _msg: string,
      ): Promise<void> => {},
    ),
    postInlineComment: mock.fn(
      async (
        _repo: string,
        _pr: number,
        _path: string,
        _line: number,
        _body: string,
        _sha: string,
      ): Promise<void> => {},
    ),
  };
}

/** Inject the required botLogin + the fixed repo/pr/head so tests stay terse. */
function exec(
  github: ReturnType<typeof makeGithub>,
  intent: ReviewIntent,
  extra: { postInlineComments?: boolean } = {},
) {
  return executeReviewIntent({
    github,
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    botLogin: BOT,
    intent,
    ...extra,
  });
}

const APPROVE: ReviewIntent = { verdict: "approve", body: "clean" };

describe("executeReviewIntent", () => {
  test("skips when a SAME-verdict bot review already exists at HEAD (idempotent)", async () => {
    const github = makeGithub([botReviewAtHead("APPROVED")]);
    const res = await exec(github, APPROVE);
    assert.deepEqual(res, { outcome: "skipped_existing" });
    assert.equal(github.submitReview.mock.calls.length, 0);
    assert.equal(github.submitReviewWithComments.mock.calls.length, 0);
    assert.equal(github.dismissReview.mock.calls.length, 0);
  });

  test("verdict UPGRADE: request_changes posts even when an APPROVED exists at HEAD, and supersedes it", async () => {
    const github = makeGithub([botReviewAtHead("APPROVED", 5)]);
    const res = await exec(github, {
      verdict: "request_changes",
      body: "fix the off-by-one",
    });
    assert.deepEqual(res, { outcome: "posted", verdict: "request_changes" });
    assert.deepEqual(github.submitReview.mock.calls[0].arguments, [
      REPO,
      PR,
      "REQUEST_CHANGES",
      "fix the off-by-one",
    ]);
    assert.equal(github.dismissReview.mock.calls.length, 1);
    assert.equal(github.dismissReview.mock.calls[0].arguments[2], 5);
  });

  test("a dismissed prior review at HEAD does not count → posts", async () => {
    const dismissed = {
      ...botReviewAtHead("APPROVED"),
      dismissedAt: "2024-01-01T00:00:00Z",
    };
    const github = makeGithub([dismissed]);
    const res = await exec(github, APPROVE);
    assert.equal(res.outcome, "posted");
    assert.equal(github.submitReview.mock.calls.length, 1);
  });

  test("posts APPROVE once when no review exists at HEAD", async () => {
    const github = makeGithub([]);
    const res = await exec(github, APPROVE);
    assert.deepEqual(res, { outcome: "posted", verdict: "approve" });
    assert.equal(github.submitReview.mock.calls.length, 1);
    assert.deepEqual(github.submitReview.mock.calls[0].arguments, [
      REPO,
      PR,
      "APPROVE",
      "clean",
    ]);
  });

  test("maps request_changes → REQUEST_CHANGES", async () => {
    const github = makeGithub([]);
    await exec(github, { verdict: "request_changes", body: "b" });
    assert.deepEqual(github.submitReview.mock.calls[0].arguments, [
      REPO,
      PR,
      "REQUEST_CHANGES",
      "b",
    ]);
  });

  test("comment verdict uses submitReviewWithComments (COMMENT, empty inline)", async () => {
    const github = makeGithub([]);
    const res = await exec(github, { verdict: "comment", body: "note" });
    assert.deepEqual(res, { outcome: "posted", verdict: "comment" });
    assert.equal(github.submitReview.mock.calls.length, 0);
    assert.deepEqual(github.submitReviewWithComments.mock.calls[0].arguments, [
      REPO,
      PR,
      HEAD,
      "COMMENT",
      "note",
      [],
    ]);
  });

  test("a different-commit bot review does NOT count as existing at HEAD → posts", async () => {
    const stale = { ...botReviewAtHead(), commitId: "old-sha" };
    const github = makeGithub([stale]);
    const res = await exec(github, APPROVE);
    assert.equal(res.outcome, "posted");
    assert.equal(github.submitReview.mock.calls.length, 1);
  });

  test("post failure surfaces as post_failed", async () => {
    const github = makeGithub([]);
    github.submitReview = mock.fn(async () => {
      throw new Error("gh 403");
    });
    const res = await exec(github, APPROVE);
    assert.equal(res.outcome, "post_failed");
    assert.match((res as { failureReason: string }).failureReason, /gh 403/);
  });

  test("idempotency-check failure still attempts the post (missed verdict is worse than rare dup)", async () => {
    const github = makeGithub([]);
    github.listReviews = mock.fn(async () => {
      throw new Error("list failed");
    });
    const res = await exec(github, APPROVE);
    assert.equal(res.outcome, "posted");
    assert.equal(github.submitReview.mock.calls.length, 1);
  });
});

describe("executeReviewIntent — inline-comment flag (dedup the COMMENTED wrapper)", () => {
  const WITH_FINDINGS: ReviewIntent = {
    verdict: "request_changes",
    body: "Two items still open.",
    comments: [
      { path: "src/a.ts", line: 10, body: "unguarded null" },
      { path: "src/b.ts", line: 22, body: "missing await" },
    ],
  };

  test("flag OFF (default): folds findings into body, EXACTLY ONE review-creating call, zero inline comments", async () => {
    const github = makeGithub([]);
    const res = await exec(github, WITH_FINDINGS);
    assert.deepEqual(res, { outcome: "posted", verdict: "request_changes" });
    assert.equal(github.submitReview.mock.calls.length, 1);
    assert.equal(github.submitReviewWithComments.mock.calls.length, 0);
    assert.equal(github.postInlineComment.mock.calls.length, 0);
    const postedBody = github.submitReview.mock.calls[0].arguments[3] as string;
    assert.match(postedBody, /Two items still open\./);
    assert.match(postedBody, /`src\/a\.ts:10` — unguarded null/);
    assert.match(postedBody, /`src\/b\.ts:22` — missing await/);
  });

  test("folded body carries a severity tag per finding; untagged renders as info", async () => {
    const github = makeGithub([]);
    await exec(github, {
      verdict: "request_changes",
      body: "Findings below.",
      comments: [
        {
          path: "src/a.ts",
          line: 10,
          body: "unguarded null",
          severity: "warning",
        },
        { path: "src/b.ts", line: 22, body: "nit" },
      ],
    });
    const postedBody = github.submitReview.mock.calls[0].arguments[3] as string;
    assert.match(
      postedBody,
      /- \*\*\[warning\]\*\* `src\/a\.ts:10` — unguarded null/,
    );
    assert.match(postedBody, /- \*\*\[info\]\*\* `src\/b\.ts:22` — nit/);
  });

  test("flag ON: posts verdict review + one standalone inline comment per finding, body NOT folded", async () => {
    const github = makeGithub([]);
    const res = await exec(github, WITH_FINDINGS, { postInlineComments: true });
    assert.deepEqual(res, { outcome: "posted", verdict: "request_changes" });
    assert.equal(github.submitReview.mock.calls.length, 1);
    assert.equal(github.postInlineComment.mock.calls.length, 2);
    const postedBody = github.submitReview.mock.calls[0].arguments[3] as string;
    assert.equal(postedBody, "Two items still open.");
    assert.ok(!/`src\/a\.ts:10`/.test(postedBody));
  });

  test("flag OFF, comment verdict with findings: single submitReviewWithComments (empty inline), folded body", async () => {
    const github = makeGithub([]);
    const res = await exec(github, {
      verdict: "comment",
      body: "cannot verify",
      comments: [{ path: "src/c.ts", line: 3, body: "x" }],
    });
    assert.deepEqual(res, { outcome: "posted", verdict: "comment" });
    assert.equal(github.postInlineComment.mock.calls.length, 0);
    assert.equal(github.submitReviewWithComments.mock.calls.length, 1);
    const [, , , event, body, inline] =
      github.submitReviewWithComments.mock.calls[0].arguments;
    assert.equal(event, "COMMENT");
    assert.deepEqual(inline, []);
    assert.match(body as string, /`src\/c\.ts:3` — x/);
  });
});
