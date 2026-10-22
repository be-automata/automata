import { describe, expect, it, vi } from "vitest";
import type { GitHubReview } from "@terragon/review/state/review-github-client";
import { executeReviewFromIntent } from "./execute-review-from-intent";
import type { ReviewWriterClient } from "./review-notice";
import { makeNoticeFake } from "./review-notice.fake";
import type { RerunPlan, RerunPlanner } from "./review-rerun";

/**
 * #107: the no-verdict path of the single writer (finish hook and sweep share
 * it) defers the notice to an automatic re-run when the run FAILED before a
 * verdict, and names the run's own error once the re-runs are spent.
 */

const BOT = "automata-ai-bot[bot]";
const REPO = "o/r";
const PR = 5;
const HEAD = "head-sha";

function makeGithub(reviews: GitHubReview[] = []) {
  return {
    ...makeNoticeFake(BOT),
    listReviews: vi.fn(async (_repo: string, _pr: number) => reviews),
    submitReview: vi.fn(async () => {}),
    submitReviewWithComments: vi.fn(async () => {}),
    dismissReview: vi.fn(async () => {}),
    postInlineComment: vi.fn(async () => {}),
  } satisfies ReviewWriterClient;
}

function planner(plan: RerunPlan) {
  return vi.fn<RerunPlanner>(async () => plan);
}

const FAILURE = { detail: "gh preflight timed out after 30s" };

function base(github: ReturnType<typeof makeGithub>) {
  return {
    github,
    repoFullName: REPO,
    prNumber: PR,
    botLogin: BOT,
    currentHeadSha: HEAD,
    reviewedSha: HEAD,
    // A run with no agent output at all: nothing parses.
    terminalText: "",
  };
}

describe("#107 — a failed run defers its notice to an automatic re-run", () => {
  it("defers: no notice, no review, workFailed, the planner asked for HEAD", async () => {
    const github = makeGithub();
    const planRerun = planner({
      defer: true,
      attempt: 1,
      decision: "scheduled",
    });
    const res = await executeReviewFromIntent({
      ...base(github),
      runFailure: FAILURE,
      planRerun,
    });
    expect(res).toEqual({
      outcome: "deferred_to_rerun",
      attempt: 1,
      reason: FAILURE.detail,
      workFailed: true,
    });
    expect(planRerun).toHaveBeenCalledWith(HEAD);
    expect(github.comments).toHaveLength(0);
    expect(github.submitReview).not.toHaveBeenCalled();
    expect(github.submitReviewWithComments).not.toHaveBeenCalled();
  });

  it("exhausted: the notice names the run's error and the re-run count, not 'no JSON intent block'", async () => {
    const github = makeGithub();
    const res = await executeReviewFromIntent({
      ...base(github),
      runFailure: FAILURE,
      planRerun: planner({
        defer: false,
        attempts: 2,
        decision: "exhausted",
      }),
    });
    expect(res).toMatchObject({
      outcome: "degraded_comment",
      cause: "run_failed",
      reason: FAILURE.detail,
    });
    expect(github.comments).toHaveLength(1);
    const body = github.comments[0]!.body;
    expect(body).toContain(
      "the review run failed before the agent produced a verdict: gh preflight timed out after 30s",
    );
    expect(body).toContain("re-ran the review automatically 2 times");
    expect(body).not.toContain("no JSON intent block");
  });

  it("a planner that throws costs nothing: the notice posts (fail-open to today's behaviour)", async () => {
    const github = makeGithub();
    const res = await executeReviewFromIntent({
      ...base(github),
      runFailure: { detail: null },
      planRerun: vi.fn<RerunPlanner>(async () => {
        throw new Error("db down");
      }),
    });
    expect(res).toMatchObject({
      outcome: "degraded_comment",
      cause: "run_failed",
    });
    expect(github.comments[0]!.body).toContain(
      "the review run failed before the agent produced a verdict.",
    );
    expect(github.comments[0]!.body).not.toContain("re-ran");
  });

  it("never re-runs an agent that answered: unable_to_review keeps its notice", async () => {
    const github = makeGithub();
    const planRerun = planner({
      defer: true,
      attempt: 1,
      decision: "scheduled",
    });
    const res = await executeReviewFromIntent({
      ...base(github),
      terminalText:
        '```json\n{"verdict":"unable_to_review","reason":"no diff access"}\n```',
      runFailure: FAILURE,
      planRerun,
    });
    expect(res).toMatchObject({
      outcome: "degraded_comment",
      cause: "agent_unable",
    });
    expect(planRerun).not.toHaveBeenCalled();
  });

  it("never re-runs a provider refusal (#441 keeps its notice)", async () => {
    const github = makeGithub();
    const planRerun = planner({
      defer: true,
      attempt: 1,
      decision: "scheduled",
    });
    const res = await executeReviewFromIntent({
      ...base(github),
      runFailure: FAILURE,
      providerUnavailable: { kind: "usage_limit", window: "weekly" },
      planRerun,
    });
    expect(res).toMatchObject({ cause: "provider_unavailable" });
    expect(planRerun).not.toHaveBeenCalled();
  });

  it("never re-runs for a head the run was not dispatched against (a newer run owns HEAD)", async () => {
    const github = makeGithub();
    const planRerun = planner({
      defer: true,
      attempt: 1,
      decision: "scheduled",
    });
    const res = await executeReviewFromIntent({
      ...base(github),
      reviewedSha: "older-sha",
      runFailure: FAILURE,
      planRerun,
    });
    expect(res.outcome).toBe("skipped_stale_degrade");
    expect(planRerun).not.toHaveBeenCalled();
  });

  it("never re-runs an abandoned run", async () => {
    const github = makeGithub();
    const planRerun = planner({
      defer: true,
      attempt: 1,
      decision: "scheduled",
    });
    const res = await executeReviewFromIntent({
      ...base(github),
      runAbandoned: true,
      runFailure: FAILURE,
      planRerun,
    });
    expect(res.outcome).toBe("skipped_stale_degrade");
    expect(planRerun).not.toHaveBeenCalled();
  });

  it("a run without a recorded failure keeps today's unparseable notice", async () => {
    const github = makeGithub();
    const planRerun = planner({
      defer: true,
      attempt: 1,
      decision: "scheduled",
    });
    const res = await executeReviewFromIntent({
      ...base(github),
      terminalText: "I looked around and it seems fine.",
      runFailure: null,
      planRerun,
    });
    expect(res).toMatchObject({
      outcome: "degraded_comment",
      cause: "unparseable",
    });
    expect(planRerun).not.toHaveBeenCalled();
  });

  it("a parsed verdict never consults the planner", async () => {
    const github = makeGithub();
    const planRerun = planner({
      defer: true,
      attempt: 1,
      decision: "scheduled",
    });
    const res = await executeReviewFromIntent({
      ...base(github),
      terminalText:
        '```json\n{"verdict":"approve","commit":"head-sha","summary":"LGTM"}\n```',
      runFailure: FAILURE,
      planRerun,
    });
    expect(res).toMatchObject({ outcome: "posted", verdict: "approve" });
    expect(planRerun).not.toHaveBeenCalled();
  });
});
