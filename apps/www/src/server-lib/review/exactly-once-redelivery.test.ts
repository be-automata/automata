import { describe, it, expect, vi } from "vitest";
import { executeReviewFromIntent } from "./execute-review-from-intent";
import type {
  GitHubReview,
  ReviewGitHubClient,
} from "@terragon/review/state/review-github-client";

/**
 * Enterprise-hardening #1 (Phase 1.4) — exactly-once GitHub review post under
 * at-least-once delivery. Mechanism #1 is `retries: 0` on the run task (worker
 * side); mechanism #2 (engine idempotency key) was DROPPED (amendment 1). This is
 * mechanism #3: PROVE the www single writer is idempotent when a redelivered /
 * duplicated terminal event fires the finish effect TWICE for the same review
 * thread — the second post must be a (HEAD, verdict)-idempotent no-op.
 *
 * We drive executeReviewFromIntent (the single writer that owns the idempotency
 * invariant) against a STATEFUL github whose listReviews reflects the review posted
 * by the first fire — exactly what a real second delivery would observe on GitHub.
 */

const BOT = "automata-ai-bot[bot]";
const REPO = "o/r";
const PR = 7;
const HEAD = "head-sha-abc";

function fenced(obj: unknown): string {
  return `Review complete.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;
}

const RC_AT_HEAD = fenced({
  verdict: "request_changes",
  commit: HEAD,
  summary: "Off-by-one in isAdult.",
  findings: [{ severity: "error", path: "a.ts", line: 3, body: "use >=" }],
});

const APPROVE_AT_HEAD = fenced({
  verdict: "approve",
  commit: HEAD,
  summary: "LGTM — no blocking issues.",
  findings: [],
});

/** A github client whose state advances as reviews are submitted (like real GitHub). */
function makeStatefulGithub(headSha: string, bot: string) {
  const reviews: GitHubReview[] = [];
  let nextId = 1;
  const push = (state: GitHubReview["state"], commitId: string, body: string) => {
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
      push(verdict === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED", headSha, body);
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

function activeReviews(github: { reviews: GitHubReview[] }): GitHubReview[] {
  return github.reviews.filter((r) => r.dismissedAt === null);
}

describe("review post is exactly-once under redelivery (#1 mechanism #3)", () => {
  it("firing the finish effect TWICE (request_changes) posts exactly ONE review", async () => {
    const github = makeStatefulGithub(HEAD, BOT);
    const opts = {
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: RC_AT_HEAD,
    };

    const first = await executeReviewFromIntent(opts);
    const second = await executeReviewFromIntent(opts); // simulated redelivery

    expect(first.outcome).toBe("posted");
    // The second fire observes the first's review at HEAD with the same verdict →
    // idempotent no-op (NOT a duplicate post).
    expect(second.outcome).toBe("skipped_existing");
    expect(github.submitReview).toHaveBeenCalledTimes(1);
    expect(activeReviews(github)).toHaveLength(1);
    expect(activeReviews(github)[0]!.state).toBe("CHANGES_REQUESTED");
  });

  it("firing the finish effect TWICE (approve) posts exactly ONE review", async () => {
    const github = makeStatefulGithub(HEAD, BOT);
    const opts = {
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: APPROVE_AT_HEAD,
    };

    const first = await executeReviewFromIntent(opts);
    const second = await executeReviewFromIntent(opts);

    expect(first.outcome).toBe("posted");
    expect(second.outcome).toBe("skipped_existing");
    expect(github.submitReview).toHaveBeenCalledTimes(1);
    expect(activeReviews(github)).toHaveLength(1);
    expect(activeReviews(github)[0]!.state).toBe("APPROVED");
  });
});
