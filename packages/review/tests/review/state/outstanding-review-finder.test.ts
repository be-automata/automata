/**
 * Tests for findOutstandingBotChangesRequested — most-recent non-dismissed bot
 * CHANGES_REQUESTED. Ported from orch-agents; adapted for the REQUIRED botLogin
 * param (every call passes it) and explicit `commitId: null` on fixtures (the
 * finder ignores commitId, but the pure type requires it).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findOutstandingBotChangesRequested } from "../../../src/review/state/outstanding-review-finder";
import type {
  GitHubReview,
  ReviewGitHubClient,
} from "../../../src/review/state/review-github-client";

const BOT = "automata-ai-bot[bot]";

function fakeClient(
  reviews: GitHubReview[],
): Pick<ReviewGitHubClient, "listReviews"> {
  return {
    async listReviews() {
      return reviews;
    },
  };
}

describe("findOutstandingBotChangesRequested", () => {
  it("returns null on empty list", async () => {
    const result = await findOutstandingBotChangesRequested({
      github: fakeClient([]),
      repo: "a/b",
      prNumber: 1,
      botLogin: BOT,
    });
    assert.equal(result, null);
  });

  it("returns the bot CHANGES_REQUESTED that is not dismissed", async () => {
    const reviews: GitHubReview[] = [
      { id: 1, user: { login: "someone-else" }, state: "CHANGES_REQUESTED", submittedAt: "2026-04-01T00:00:00Z", dismissedAt: null, commitId: null, body: "" },
      { id: 2, user: { login: BOT }, state: "CHANGES_REQUESTED", submittedAt: "2026-05-01T00:00:00Z", dismissedAt: null, commitId: null, body: "" },
    ];
    const result = await findOutstandingBotChangesRequested({
      github: fakeClient(reviews),
      repo: "a/b",
      prNumber: 1,
      botLogin: BOT,
    });
    assert.notEqual(result, null);
    assert.equal(result?.id, 2);
  });

  it("skips bot reviews that are already DISMISSED (state)", async () => {
    const reviews: GitHubReview[] = [
      { id: 1, user: { login: BOT }, state: "DISMISSED", submittedAt: "2026-05-01T00:00:00Z", dismissedAt: null, commitId: null, body: "" },
    ];
    const result = await findOutstandingBotChangesRequested({
      github: fakeClient(reviews),
      repo: "a/b",
      prNumber: 1,
      botLogin: BOT,
    });
    assert.equal(result, null);
  });

  it("skips bot reviews with non-null dismissedAt", async () => {
    const reviews: GitHubReview[] = [
      { id: 1, user: { login: BOT }, state: "CHANGES_REQUESTED", submittedAt: "2026-05-01T00:00:00Z", dismissedAt: "2026-05-02T00:00:00Z", commitId: null, body: "" },
    ];
    const result = await findOutstandingBotChangesRequested({
      github: fakeClient(reviews),
      repo: "a/b",
      prNumber: 1,
      botLogin: BOT,
    });
    assert.equal(result, null);
  });

  it("skips reviews from other users", async () => {
    const reviews: GitHubReview[] = [
      { id: 1, user: { login: "someone-else" }, state: "CHANGES_REQUESTED", submittedAt: "2026-05-01T00:00:00Z", dismissedAt: null, commitId: null, body: "" },
    ];
    const result = await findOutstandingBotChangesRequested({
      github: fakeClient(reviews),
      repo: "a/b",
      prNumber: 1,
      botLogin: BOT,
    });
    assert.equal(result, null);
  });

  it("returns the most recent of multiple bot CHANGES_REQUESTED reviews", async () => {
    const reviews: GitHubReview[] = [
      { id: 1, user: { login: BOT }, state: "CHANGES_REQUESTED", submittedAt: "2026-04-01T00:00:00Z", dismissedAt: null, commitId: null, body: "" },
      { id: 2, user: { login: BOT }, state: "CHANGES_REQUESTED", submittedAt: "2026-05-01T00:00:00Z", dismissedAt: null, commitId: null, body: "" },
      { id: 3, user: { login: BOT }, state: "CHANGES_REQUESTED", submittedAt: "2026-04-15T00:00:00Z", dismissedAt: null, commitId: null, body: "" },
    ];
    const result = await findOutstandingBotChangesRequested({
      github: fakeClient(reviews),
      repo: "a/b",
      prNumber: 1,
      botLogin: BOT,
    });
    assert.equal(result?.id, 2);
  });

  it("uses the configured bot login (a rename loses the prior review)", async () => {
    const reviews: GitHubReview[] = [
      { id: 1, user: { login: BOT }, state: "CHANGES_REQUESTED", submittedAt: "2026-04-01T00:00:00Z", dismissedAt: null, commitId: null, body: "" },
    ];
    const result = await findOutstandingBotChangesRequested({
      github: fakeClient(reviews),
      repo: "a/b",
      prNumber: 1,
      botLogin: "automata-bot[bot]", // renamed — no longer matches the old review's author
    });
    assert.equal(result, null);
  });

  it("honors a botLogin targeting a specific identity", async () => {
    const reviews: GitHubReview[] = [
      { id: 7, user: { login: "custom-bot[bot]" }, state: "CHANGES_REQUESTED", submittedAt: "2026-05-01T00:00:00Z", dismissedAt: null, commitId: null, body: "" },
    ];
    const result = await findOutstandingBotChangesRequested({
      github: fakeClient(reviews),
      repo: "a/b",
      prNumber: 1,
      botLogin: "custom-bot[bot]",
    });
    assert.equal(result?.id, 7);
  });
});
