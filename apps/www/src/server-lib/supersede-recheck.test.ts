import { describe, it, beforeEach, expect, vi } from "vitest";
import { db } from "@/lib/db";
import { thread as threadTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { hatchetDispatchEnabled } from "@/agent/hatchet/dispatch";
import {
  createTestUser,
  createTestThread,
  createTestOrg,
  createTestRemoteRun,
} from "@terragon/shared/model/test-helpers";
import { createReviewAutomation } from "@/agent/hatchet/__fixtures__/review-thread";
import {
  buildPrKey,
  upsertDesiredHead,
} from "@terragon/shared/model/supersede-recheck";
import { User } from "@terragon/shared";
import { maybeRecheckOnComplete } from "./supersede-recheck";

/**
 * #125 C5 recheck reconciliation: exactly one re-dispatch per
 * (prKey, desiredHeadSha), no loops, OFF by default.
 */
vi.mock("@/agent/hatchet/dispatch", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    hatchetDispatchEnabled: vi.fn(
      actual.hatchetDispatchEnabled as (t: unknown) => boolean,
    ),
  };
});

describe("maybeRecheckOnComplete (#125 C5)", () => {
  let user: User;
  let orgId: string;
  let automationId: string;
  const REPO = "be-automata/automata";
  const PR = 42;

  beforeEach(async () => {
    user = (await createTestUser({ db })).user;
    orgId = await createTestOrg({ db });
    automationId = await createReviewAutomation({ userId: user.id, orgId });
  });

  const prKey = () => buildPrKey({ orgId, repoFullName: REPO, prNumber: PR });

  async function finishedRun({
    reviewedSha,
    policy,
    recheckOnComplete,
    externalId,
  }: {
    reviewedSha: string;
    policy: "complete-run-discard" | "newest-wins";
    recheckOnComplete: boolean;
    externalId: string;
  }) {
    const { threadId } = await createTestRemoteRun({
      db,
      userId: user.id,
      organizationId: orgId,
      prNumber: PR,
      externalId,
      repoFullName: REPO,
      status: "complete",
      reviewedSha,
      automationId,
      snapshot: { policy, recheckOnComplete },
    });
    return threadId;
  }

  const push = (sha: string, seconds: number, deliveryId: string) =>
    upsertDesiredHead({
      db,
      prKey: prKey(),
      sha,
      webhookAt: new Date(Date.UTC(2026, 7, 24, 10, 0, seconds)),
      deliveryId,
    });

  function recorder() {
    const calls: { deliveryId: string; prNumber: number }[] = [];
    const dispatch = async (a: { deliveryId: string; prNumber: number }) => {
      calls.push({ deliveryId: a.deliveryId, prNumber: a.prNumber });
    };
    return { calls, dispatch };
  }

  it("discard + recheck ON + pushes during the run ⇒ exactly ONE re-dispatch for the final head; a terminal for the same head re-dispatches nothing (AC1)", async () => {
    await push("sha-1", 0, "d1");
    const threadId = await finishedRun({
      reviewedSha: "sha-1",
      policy: "complete-run-discard",
      recheckOnComplete: true,
      externalId: "ext-1",
    });
    // Three rapid pushes while the run was executing.
    await push("sha-2", 1, "d2");
    await push("sha-3", 2, "d3");
    await push("sha-4", 3, "d4");
    const { calls, dispatch } = recorder();
    // Two terminal writers race (finish hook + sweep): one recheck.
    const [a, b] = await Promise.all([
      maybeRecheckOnComplete({ threadId, dispatch }),
      maybeRecheckOnComplete({ threadId, dispatch }),
    ]);
    expect([a.rechecked, b.rechecked].filter(Boolean)).toHaveLength(1);
    expect(calls).toEqual([
      { deliveryId: `recheck:${prKey()}:sha-4`, prNumber: PR },
    ]);
    // The recheck run reviews sha-4 and finishes: nothing newer → no loop.
    const recheckThread = await finishedRun({
      reviewedSha: "sha-4",
      policy: "complete-run-discard",
      recheckOnComplete: true,
      externalId: "ext-2",
    });
    const r = await maybeRecheckOnComplete({
      threadId: recheckThread,
      dispatch,
    });
    expect(r).toEqual({ rechecked: false, reason: "head-already-reviewed" });
    expect(calls).toHaveLength(1);
    // A push DURING the recheck ⇒ exactly one more reconciliation.
    await push("sha-5", 4, "d5");
    const again = await maybeRecheckOnComplete({
      threadId: recheckThread,
      dispatch,
    });
    expect(again.rechecked).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.deliveryId).toBe(`recheck:${prKey()}:sha-5`);
  });

  it("a claim whose dispatch throws is released: the head can still be rechecked by a later terminal", async () => {
    const threadId = await finishedRun({
      reviewedSha: "sha-1",
      policy: "complete-run-discard",
      recheckOnComplete: true,
      externalId: "ext-throw",
    });
    await push("sha-9", 1, "d9");
    const boom = async () => {
      throw new Error("automation trigger down");
    };
    // never-throws boundary: reports, does not propagate…
    const failed = await maybeRecheckOnComplete({ threadId, dispatch: boom });
    expect(failed.rechecked).toBe(false);
    // …and the ledger row was given back, so the next terminal re-dispatches.
    const { calls, dispatch } = recorder();
    const again = await maybeRecheckOnComplete({ threadId, dispatch });
    expect(again).toEqual({ rechecked: true, reason: "dispatched" });
    expect(calls).toEqual([
      { deliveryId: `recheck:${prKey()}:sha-9`, prNumber: PR },
    ]);
  });

  it("recheck OFF ⇒ zero re-dispatch (AC2); non-discard policies ⇒ zero", async () => {
    await push("sha-1", 0, "d1");
    const off = await finishedRun({
      reviewedSha: "sha-1",
      policy: "complete-run-discard",
      recheckOnComplete: false,
      externalId: "ext-off",
    });
    const nw = await finishedRun({
      reviewedSha: "sha-1",
      policy: "newest-wins",
      recheckOnComplete: true,
      externalId: "ext-nw",
    });
    await push("sha-2", 1, "d2");
    const { calls, dispatch } = recorder();
    expect(
      (await maybeRecheckOnComplete({ threadId: off, dispatch })).rechecked,
    ).toBe(false);
    expect(
      (await maybeRecheckOnComplete({ threadId: nw, dispatch })).rechecked,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("zero-read bail decides 'remote' with dispatch's gate: a docker-provider thread is a remote review run under HATCHET_ENABLED and not otherwise", async () => {
    // Production stamps the local-default provider ("docker") on every thread
    // and dispatches remotely via HATCHET_ENABLED; a bare provider check would
    // bail here forever and the recheck would never fire in prod.
    const threadId = await finishedRun({
      reviewedSha: "aaa",
      policy: "complete-run-discard",
      recheckOnComplete: true,
      externalId: "ext-gate",
    });
    await db
      .update(threadTable)
      .set({ sandboxProvider: "docker" })
      .where(eq(threadTable.id, threadId));
    const pre = {
      userId: user.id,
      organizationId: orgId,
      githubRepoFullName: REPO,
      githubPRNumber: PR,
      automationId,
      sandboxProvider: "docker",
      reviewedSha: "aaa",
    };
    const { calls, dispatch } = recorder();
    vi.mocked(hatchetDispatchEnabled).mockReturnValueOnce(false);
    expect(
      (await maybeRecheckOnComplete({ threadId, thread: pre, dispatch }))
        .reason,
    ).toBe("not-a-review-run");
    vi.mocked(hatchetDispatchEnabled).mockReturnValueOnce(true);
    expect(
      (await maybeRecheckOnComplete({ threadId, thread: pre, dispatch }))
        .reason,
    ).not.toBe("not-a-review-run");
    expect(calls).toHaveLength(0); // no newer head recorded → nothing to recheck
  });

  it("a legacy (no snapshot) or non-review thread never rechecks", async () => {
    const plain = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    const { calls, dispatch } = recorder();
    expect(
      (await maybeRecheckOnComplete({ threadId: plain.threadId, dispatch }))
        .reason,
    ).toBe("not-a-review-run");
    expect(calls).toHaveLength(0);
  });
});
