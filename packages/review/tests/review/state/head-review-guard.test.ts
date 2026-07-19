/**
 * Tests for findBotReviewAtHead — the all-states, at-HEAD, not-dismissed bot
 * review lookup. Ported from orch-agents; adapted for the pure package's REQUIRED
 * botLogin param (the original defaulted it via kernel/agent-identity; here every
 * call passes botLogin explicitly).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findBotReviewAtHead } from "../../../src/review/state/head-review-guard";
import type {
  GitHubReview,
  ReviewGitHubClient,
} from "../../../src/review/state/review-github-client";

const BOT = "automata-ai-bot[bot]";
const HEAD = "fb15616abc";

function fakeClient(
  reviews: GitHubReview[],
): Pick<ReviewGitHubClient, "listReviews"> {
  return {
    async listReviews() {
      return reviews;
    },
  };
}

function review(partial: Partial<GitHubReview>): GitHubReview {
  return {
    id: 1,
    user: { login: BOT },
    state: "COMMENTED",
    submittedAt: "2026-06-12T16:43:00Z",
    dismissedAt: null,
    commitId: HEAD,
    body: "",
    ...partial,
  };
}

describe("findBotReviewAtHead", () => {
  it("returns null on an empty review list", async () => {
    const result = await findBotReviewAtHead({
      github: fakeClient([]),
      repo: "a/b",
      prNumber: 1,
      headSha: HEAD,
      botLogin: BOT,
    });
    assert.equal(result, null);
  });

  it("matches a bot COMMENTED review at HEAD", async () => {
    const r = review({ id: 99, state: "COMMENTED", commitId: HEAD });
    const result = await findBotReviewAtHead({
      github: fakeClient([r]),
      repo: "a/b",
      prNumber: 1,
      headSha: HEAD,
      botLogin: BOT,
    });
    assert.equal(result?.id, 99);
  });

  it("matches a bot APPROVED review at HEAD", async () => {
    const r = review({ id: 7, state: "APPROVED", commitId: HEAD });
    const result = await findBotReviewAtHead({
      github: fakeClient([r]),
      repo: "a/b",
      prNumber: 1,
      headSha: HEAD,
      botLogin: BOT,
    });
    assert.equal(result?.id, 7);
  });

  it("matches a bot CHANGES_REQUESTED review at HEAD", async () => {
    const r = review({ id: 8, state: "CHANGES_REQUESTED", commitId: HEAD });
    const result = await findBotReviewAtHead({
      github: fakeClient([r]),
      repo: "a/b",
      prNumber: 1,
      headSha: HEAD,
      botLogin: BOT,
    });
    assert.equal(result?.id, 8);
  });

  it("rejects a review on a different commit", async () => {
    const r = review({ commitId: "OTHER_SHA" });
    const result = await findBotReviewAtHead({
      github: fakeClient([r]),
      repo: "a/b",
      prNumber: 1,
      headSha: HEAD,
      botLogin: BOT,
    });
    assert.equal(result, null);
  });

  it("rejects a review by a human author at HEAD", async () => {
    const r = review({ user: { login: "some-human" } });
    const result = await findBotReviewAtHead({
      github: fakeClient([r]),
      repo: "a/b",
      prNumber: 1,
      headSha: HEAD,
      botLogin: BOT,
    });
    assert.equal(result, null);
  });

  it("rejects a dismissed bot review at HEAD", async () => {
    const r = review({ dismissedAt: "2026-06-12T17:00:00Z" });
    const result = await findBotReviewAtHead({
      github: fakeClient([r]),
      repo: "a/b",
      prNumber: 1,
      headSha: HEAD,
      botLogin: BOT,
    });
    assert.equal(result, null);
  });

  it("returns null when headSha is empty", async () => {
    const r = review({ commitId: HEAD });
    const result = await findBotReviewAtHead({
      github: fakeClient([r]),
      repo: "a/b",
      prNumber: 1,
      headSha: "",
      botLogin: BOT,
    });
    assert.equal(result, null);
  });

  it("honors an explicit botLogin", async () => {
    const r = review({ user: { login: "other-bot[bot]" }, id: 5 });
    const result = await findBotReviewAtHead({
      github: fakeClient([r]),
      repo: "a/b",
      prNumber: 1,
      headSha: HEAD,
      botLogin: "other-bot[bot]",
    });
    assert.equal(result?.id, 5);
  });
});
