import { describe, it, expect, vi } from "vitest";
import {
  executeReviewFromIntent,
  parseReviewBaseMarker,
  reviewBaseMarker,
} from "./execute-review-from-intent";
import type { GitHubReview } from "@terragon/review/state/review-github-client";
import type { ReviewWriterClient } from "./review-notice";
import { makeNoticeFake } from "./review-notice.fake";

/**
 * A retarget at an unchanged head is a NEW review, not a replay.
 *
 * When a stacked PR's parent merges, GitHub moves the child onto the parent's
 * base: the diff changes, the head sha does not. The single writer's
 * idempotency was keyed on (headSha, verdict), so the retarget run's review
 * was dropped as a duplicate of the earlier one at the same sha. A run that
 * knows its base (the thread's `reviewBase` stamp) now writes a hidden base
 * marker and keys "same review" on it.
 *
 * protects: the retarget run's review reaches the PR and supersedes the
 *   earlier-base review; a redelivery of either run still posts nothing.
 * fails_when: a retarget same-verdict review is skipped, a redelivery
 *   double-posts, a pre-marker review is double-posted, or a run that
 *   reviewed a base the PR has left supersedes the fresh review.
 * no_claim: the webhook routing (handlers-retarget.test.ts owns that).
 */

const BOT = "automata-ai-bot[bot]";
const REPO = "o/r";
const PR = 481;
const HEAD = "a".repeat(40);

function makeStatefulGithub(opts: { commentsDismissable?: boolean } = {}) {
  const reviews: GitHubReview[] = [];
  let nextId = 1;
  const push = (state: GitHubReview["state"], body: string) => {
    reviews.push({
      id: nextId++,
      user: { login: BOT },
      state,
      submittedAt: new Date().toISOString(),
      dismissedAt: null,
      commitId: HEAD,
      body,
    });
  };
  const client: ReviewWriterClient & { reviews: GitHubReview[] } = {
    ...makeNoticeFake(BOT),
    reviews,
    listReviews: vi.fn(async () => reviews),
    submitReview: vi.fn(async (_repo, _pr, verdict, body) => {
      push(verdict === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED", body);
    }),
    submitReviewWithComments: vi.fn(async (_repo, _pr, _sha, event, body) => {
      push(
        event === "APPROVE"
          ? "APPROVED"
          : event === "REQUEST_CHANGES"
            ? "CHANGES_REQUESTED"
            : "COMMENTED",
        body,
      );
    }),
    dismissReview: vi.fn(async (_repo, _pr, id) => {
      const r = reviews.find((x) => x.id === id);
      if (!r) return;
      // GitHub refuses to dismiss a COMMENT review.
      if (r.state === "COMMENTED" && !opts.commentsDismissable) {
        throw new Error("Can not dismiss a commented pull request review");
      }
      r.dismissedAt = new Date().toISOString();
    }),
    postInlineComment: vi.fn(async () => {}),
  };
  return client;
}

function fenced(obj: unknown): string {
  return `Review complete.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;
}

const APPROVE = fenced({ verdict: "approve", commit: HEAD, summary: "LGTM." });

function run(
  github: ReviewWriterClient,
  reviewBase: string | null,
  liveBase: string | null,
  terminalText = APPROVE,
  isDraft = false,
) {
  return executeReviewFromIntent({
    github,
    repoFullName: REPO,
    prNumber: PR,
    botLogin: BOT,
    currentHeadSha: HEAD,
    terminalText,
    isDraft,
    reviewBase,
    liveBase,
  });
}

const active = (reviews: GitHubReview[]) =>
  reviews.filter((r) => r.dismissedAt === null);

describe("retarget at an unchanged head", () => {
  it("is not deduped against the earlier-base review: it posts and supersedes it", async () => {
    const github = makeStatefulGithub();
    // The review the stacked PR got while its base was the parent branch.
    expect(await run(github, "feat/parent", "feat/parent")).toMatchObject({
      outcome: "posted",
    });
    // Parent merged; GitHub retargeted the child onto main. Same head, same
    // verdict, a different diff.
    expect(await run(github, "main", "main")).toMatchObject({
      outcome: "posted",
      verdict: "approve",
    });
    expect(github.submitReview).toHaveBeenCalledTimes(2);
    const inForce = active(github.reviews);
    expect(inForce).toHaveLength(1);
    expect(parseReviewBaseMarker(inForce[0]!.body)).toBe("main");
  });

  it("a redelivery of the retarget run posts nothing", async () => {
    const github = makeStatefulGithub();
    await run(github, "feat/parent", "feat/parent");
    await run(github, "main", "main");
    expect(await run(github, "main", "main")).toEqual({
      outcome: "skipped_existing",
    });
    expect(github.submitReview).toHaveBeenCalledTimes(2);
  });

  it("a redelivery is still found when the earlier review could not be dismissed (a COMMENT)", async () => {
    const github = makeStatefulGithub({ commentsDismissable: false });
    const comment = fenced({
      verdict: "comment",
      commit: HEAD,
      summary: "Draft notes.",
      findings: [{ severity: "info", path: "a.ts", line: 1, body: "nit" }],
    });
    await run(github, "feat/parent", "feat/parent", comment, true);
    expect(await run(github, "main", "main", comment, true)).toMatchObject({
      outcome: "posted",
    });
    expect(await run(github, "main", "main", comment, true)).toEqual({
      outcome: "skipped_existing",
    });
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(2);
  });

  it("a run that reviewed a base the PR has since left never supersedes the fresh review", async () => {
    const github = makeStatefulGithub();
    await run(github, "main", "main");
    // The pre-retarget run finishes late: its base is no longer the PR's.
    expect(await run(github, "feat/parent", "main")).toEqual({
      outcome: "skipped_existing",
    });
    const inForce = active(github.reviews);
    expect(inForce).toHaveLength(1);
    expect(parseReviewBaseMarker(inForce[0]!.body)).toBe("main");
  });

  it("an unmarked review (posted before markers) counts as the same review: no double post across the deploy", async () => {
    const github = makeStatefulGithub();
    await run(github, null, null);
    expect(github.reviews[0]!.body).not.toContain("automata:review-base");
    expect(await run(github, "main", "main")).toEqual({
      outcome: "skipped_existing",
    });
  });

  it("a thread without the stamp keeps the (headSha, verdict) key exactly", async () => {
    const github = makeStatefulGithub();
    await run(github, "feat/parent", "feat/parent");
    expect(await run(github, null, "main")).toEqual({
      outcome: "skipped_existing",
    });
  });
});

describe("review base marker", () => {
  it("round-trips a hostile branch name without closing the HTML comment", () => {
    const hostile = "x-->`\n<script>alert(1)</script> $(id)";
    const marker = reviewBaseMarker(hostile);
    expect(marker.indexOf("-->")).toBe(marker.length - 3);
    expect(marker).not.toContain("\n");
    expect(marker).not.toContain("<script>");
    expect(parseReviewBaseMarker(`verdict body\n\n${marker}`)).toBe(hostile);
  });

  it("an unmarked or malformed body has no base", () => {
    expect(parseReviewBaseMarker("LGTM")).toBeNull();
    expect(
      parseReviewBaseMarker("<!-- automata:review-base %E0%A4%A -->"),
    ).toBeNull();
  });
});
