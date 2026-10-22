import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type { DBMessage } from "@terragon/shared/db/db-message";
import { reviewRerun } from "@terragon/shared/db/schema";
import {
  claimDueReviewReruns,
  planReviewRerun,
  REVIEW_RERUN_CLAIM_LEASE_MS,
  REVIEW_RERUN_MAX_ATTEMPTS,
} from "@terragon/shared/model/review-rerun";
import { buildPrKey } from "@terragon/shared/model/supersede-recheck";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { createReviewAutomation } from "@/agent/hatchet/__fixtures__/review-thread";
import {
  classifyRunFailure,
  createRerunPlanner,
  rerunDeliveryId,
  runReviewRerunDispatcher,
  type RerunDispatchArgs,
  type RerunPrState,
} from "./review-rerun";

const agent = (text: string, parent: string | null = null): DBMessage => ({
  type: "agent",
  parent_tool_use_id: parent,
  parts: [{ type: "text", text }],
});
const runError = (info: string): DBMessage => ({
  type: "error",
  error_type: "agent-generic-error",
  error_info: info,
});

describe("#107 classifyRunFailure — which no-verdict runs are infra failures", () => {
  it("a run with no messages at all died before the agent spoke", () => {
    expect(classifyRunFailure(null)).toEqual({ detail: null });
    expect(classifyRunFailure([])).toEqual({ detail: null });
  });

  it("a recorded run error after the agent's last message is a failure, with its text", () => {
    expect(
      classifyRunFailure([
        agent("Looking at the diff…"),
        runError("OOM killed"),
      ]),
    ).toEqual({ detail: "OOM killed" });
    expect(classifyRunFailure([runError("clone failed")])).toEqual({
      detail: "clone failed",
    });
  });

  it("the error text is redacted before it can reach a PR", () => {
    const failure = classifyRunFailure([
      runError("fatal: https://x-access-token:ghs_abcdefghijklmnop@github.com"),
    ]);
    expect(failure?.detail).not.toContain("ghs_abcdefghijklmnop");
  });

  it("an agent that answered after the error, or answered with no error, is NOT a failure", () => {
    expect(
      classifyRunFailure([runError("transient"), agent("Here is my review")]),
    ).toBeNull();
    expect(classifyRunFailure([agent("prose, no fence")])).toBeNull();
  });

  it("a sub-agent message is not the lead speaking", () => {
    expect(
      classifyRunFailure([agent("sub-agent narration", "tool-1")]),
    ).toEqual({ detail: null });
  });
});

describe("#107 re-run planner + dispatcher", () => {
  const REPO = "be-automata/automata";
  const PR = 42;
  const HEAD = "sha-head";
  let userId: string;
  let orgId: string;
  let automationId: string;
  const t0 = new Date("2026-10-22T12:00:00Z");

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgId = await createTestOrg({ db });
    automationId = await createReviewAutomation({ userId, orgId });
  });

  const prKey = () => buildPrKey({ orgId, repoFullName: REPO, prNumber: PR });

  async function failedReviewThread(): Promise<string> {
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: {
        organizationId: orgId,
        automationId,
        githubRepoFullName: REPO,
        githubPRNumber: PR,
        reviewedSha: HEAD,
      },
    });
    return threadId;
  }

  function deps(pr: Partial<RerunPrState> = {}, started = true) {
    const dispatch = vi.fn(async (_args: RerunDispatchArgs) => started);
    const readPr = vi.fn(async () => ({
      open: true,
      headSha: HEAD,
      verdictAtHead: false,
      ...pr,
    }));
    return { db, dispatch, readPr, now: () => new Date(t0.getTime() + 61_000) };
  }

  const rowOf = async (failedThreadId: string) =>
    (
      await db
        .select()
        .from(reviewRerun)
        .where(eq(reviewRerun.failedThreadId, failedThreadId))
    )[0];

  it("no planner for a thread that cannot be re-dispatched", () => {
    expect(
      createRerunPlanner({
        db,
        threadId: "t",
        organizationId: null,
        automationId,
        repoFullName: REPO,
        prNumber: PR,
      }),
    ).toBeUndefined();
    expect(
      createRerunPlanner({
        db,
        threadId: "t",
        organizationId: orgId,
        automationId: null,
        repoFullName: REPO,
        prNumber: PR,
      }),
    ).toBeUndefined();
  });

  it("re-dispatches a due re-run once, for the same PR and head, with a distinct delivery id", async () => {
    const threadId = await failedReviewThread();
    const plan = await createRerunPlanner({
      db,
      threadId,
      organizationId: orgId,
      automationId,
      repoFullName: REPO,
      prNumber: PR,
      now: () => t0,
    })!(HEAD);
    expect(plan).toEqual({ defer: true, attempt: 1, decision: "scheduled" });

    const d = deps();
    // Not due yet: nothing happens.
    const early = await runReviewRerunDispatcher({
      ...d,
      now: () => new Date(t0.getTime() + 10_000),
    });
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(early.dispatched).toBe(0);

    await runReviewRerunDispatcher(d);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect(d.dispatch.mock.calls[0]![0]).toEqual({
      userId,
      automationId,
      repoFullName: REPO,
      prNumber: PR,
      deliveryId: rerunDeliveryId({
        prKey: prKey(),
        headSha: HEAD,
        attempt: 1,
      }),
      expectedHeadSha: HEAD,
    });
    expect((await rowOf(threadId))?.state).toBe("dispatched");

    // A second tick finds nothing to do: exactly once.
    await runReviewRerunDispatcher(d);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ open: false }, "pr_closed"],
    [{ headSha: "sha-newer" }, "head_moved"],
    [{ verdictAtHead: true }, "verdict_exists"],
  ] as const)("skips (never dispatches) when %o", async (pr, reason) => {
    const threadId = await failedReviewThread();
    await planReviewRerun({
      db,
      prKey: prKey(),
      headSha: HEAD,
      failedThreadId: threadId,
      now: t0,
    });
    const d = deps(pr);
    await runReviewRerunDispatcher(d);
    expect(d.dispatch).not.toHaveBeenCalled();
    const row = await rowOf(threadId);
    expect(row).toMatchObject({ state: "skipped", outcomeReason: reason });
    // A skipped re-run still owns the head: the failed run keeps deferring.
    expect(
      await planReviewRerun({
        db,
        prKey: prKey(),
        headSha: HEAD,
        failedThreadId: threadId,
      }),
    ).toMatchObject({ kind: "already_handed_off", defer: true });
  });

  it("a refused dispatch settles failed, so the failed run's next pass posts the notice", async () => {
    const threadId = await failedReviewThread();
    await planReviewRerun({
      db,
      prKey: prKey(),
      headSha: HEAD,
      failedThreadId: threadId,
      now: t0,
    });
    const d = deps({}, false);
    const counts = await runReviewRerunDispatcher(d);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
    expect(await rowOf(threadId)).toMatchObject({
      state: "failed",
      outcomeReason: "dispatch_refused",
    });
    expect(
      await planReviewRerun({
        db,
        prKey: prKey(),
        headSha: HEAD,
        failedThreadId: threadId,
      }),
    ).toMatchObject({ kind: "dispatch_failed", defer: false });
  });

  it("a tick that died between claim and dispatch: the next tick past the lease expires the claim, never re-dispatches, and the failed run posts its notice", async () => {
    const threadId = await failedReviewThread();
    const planner = createRerunPlanner({
      db,
      threadId,
      organizationId: orgId,
      automationId,
      repoFullName: REPO,
      prNumber: PR,
      now: () => t0,
    })!;
    await planner(HEAD);
    // The dying tick: it claims, then the process is gone before dispatch.
    const claimAt = new Date(t0.getTime() + 61_000);
    const dead = (await claimDueReviewReruns({ db, now: claimAt })).filter(
      (r) => r.failedThreadId === threadId,
    );
    expect(dead).toHaveLength(1);

    // A tick inside the lease leaves the claim alone and dispatches nothing.
    const d = deps();
    const inside = await runReviewRerunDispatcher({
      ...d,
      now: () => new Date(claimAt.getTime() + 60_000),
    });
    expect(inside.expired).toBe(0);
    expect((await rowOf(threadId))?.state).toBe("claimed");

    // Past the lease: expired to failed, still never dispatched.
    const past = await runReviewRerunDispatcher({
      ...d,
      now: () => new Date(claimAt.getTime() + REVIEW_RERUN_CLAIM_LEASE_MS),
    });
    expect(past.expired).toBeGreaterThanOrEqual(1);
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(await rowOf(threadId)).toMatchObject({
      state: "failed",
      outcomeReason: "claim_expired",
    });
    // The failed run's next no-verdict pass (the hourly sweep) gets "post".
    expect(
      await createRerunPlanner({
        db,
        threadId,
        organizationId: orgId,
        automationId,
        repoFullName: REPO,
        prNumber: PR,
      })!(HEAD),
    ).toMatchObject({ defer: false, decision: "dispatch_failed" });
  });

  it("a dispatch that throws settles failed and never escapes the cron", async () => {
    const threadId = await failedReviewThread();
    await planReviewRerun({
      db,
      prKey: prKey(),
      headSha: HEAD,
      failedThreadId: threadId,
      now: t0,
    });
    const d = deps();
    d.readPr.mockRejectedValueOnce(new Error("GitHub 502"));
    await expect(runReviewRerunDispatcher(d)).resolves.toBeDefined();
    expect(await rowOf(threadId)).toMatchObject({ state: "failed" });
  });

  it("end to end bound: original + MAX re-runs, then the planner says exhausted", async () => {
    let failed = await failedReviewThread();
    for (let attempt = 1; attempt <= REVIEW_RERUN_MAX_ATTEMPTS; attempt++) {
      const plan = await createRerunPlanner({
        db,
        threadId: failed,
        organizationId: orgId,
        automationId,
        repoFullName: REPO,
        prNumber: PR,
        now: () => t0,
      })!(HEAD);
      expect(plan).toMatchObject({ defer: true, attempt });
      const d = deps();
      await runReviewRerunDispatcher({
        ...d,
        now: () => new Date(t0.getTime() + 10 * 60_000),
      });
      expect(d.dispatch).toHaveBeenCalledTimes(1);
      // The re-run's own thread fails the same way.
      failed = await failedReviewThread();
    }
    const last = await createRerunPlanner({
      db,
      threadId: failed,
      organizationId: orgId,
      automationId,
      repoFullName: REPO,
      prNumber: PR,
    })!(HEAD);
    expect(last).toEqual({
      defer: false,
      attempts: REVIEW_RERUN_MAX_ATTEMPTS,
      decision: "exhausted",
    });
  });
});
