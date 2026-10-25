import type { Octokit } from "octokit";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import type { ThreadSourceMetadata } from "@terragon/shared";
import { deliveryFixCycles } from "@terragon/shared/db/schema";
import {
  bindDeliveryFixCycleThread,
  enrollDeliveryPr,
  getDeliveryPr,
  listDeliveryFixCycles,
  startDeliveryFixCycle,
  type DeliveryFixCycleRow,
} from "@terragon/shared/model/delivery-loop";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import {
  DELIVERY_DISPATCH_STALE_MS,
  DELIVERY_RUN_STALE_MS,
  handleDeliveryCycleFinish,
  reconcileStaleDeliveryCycles,
} from "./cycle-finish";

const NOW = new Date("2026-10-26T12:00:00Z");

function github(headSha: string): Octokit {
  return {
    rest: {
      pulls: { get: async () => ({ data: { head: { sha: headSha } } }) },
    },
  } as unknown as Octokit;
}

describe("#509 delivery fix-cycle finish", () => {
  let userId: string;
  let deliveryPrId: string;
  let cycle: DeliveryFixCycleRow;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    const organizationId = await createTestOrg({ db });
    const deliveryThread = (await createTestThread({ db, userId })).threadId;
    deliveryPrId = (
      await enrollDeliveryPr(db, {
        organizationId,
        repoFullName: `acme/widgets-${nanoid(6)}`,
        prNumber: 12,
        issueNumber: 4,
        headRef: "automata/task-abcd1234",
        baseRef: "main",
        headSha: "H1",
        deliveryThreadId: deliveryThread,
        automationId: "auto-1",
        now: NOW,
      })
    ).row.id;
    const started = await startDeliveryFixCycle(db, {
      deliveryPrId,
      expectedPhase: "awaiting_ci",
      headSha: "H1",
      trigger: "ci",
      reviewId: null,
      failingChecks: ["test"],
    });
    if (started.kind !== "started") throw new Error("expected a started cycle");
    cycle = started.cycle;
  });

  async function cycleThread(stamped = true): Promise<string> {
    const stamp: ThreadSourceMetadata = {
      type: "automation-skill",
      skillName: "issue-delivery",
      contentSha: "sha",
      source: "db-version",
      ...(stamped
        ? {
            delivery: {
              deliveryPrId,
              cycleNo: cycle.cycleNo,
              headSha: "H1",
              issueNumber: 4,
            },
          }
        : {}),
    };
    const threadId = (
      await createTestThread({
        db,
        userId,
        overrides: { sourceMetadata: stamp },
      })
    ).threadId;
    await bindDeliveryFixCycleThread(db, { cycleId: cycle.id, threadId });
    return threadId;
  }

  function deps(headSha: string) {
    const evaluate = vi.fn(async () => undefined);
    return {
      evaluate,
      deps: {
        db,
        octokitFor: async () => github(headSha),
        evaluate,
        now: () => NOW,
      },
    };
  }

  it("a cycle whose push moved the head settles as pushed, then the PR is evaluated", async () => {
    const threadId = await cycleThread();
    const d = deps("H2");
    await handleDeliveryCycleFinish({ userId, threadId, deps: d.deps });
    expect((await listDeliveryFixCycles(db, deliveryPrId))[0]).toMatchObject({
      state: "pushed",
      resultHeadSha: "H2",
      finishedAt: NOW,
    });
    expect(d.evaluate).toHaveBeenCalledWith({ deliveryPrId });
  });

  it("a cycle that left the head where it was settles as no_push", async () => {
    const threadId = await cycleThread();
    await handleDeliveryCycleFinish({
      userId,
      threadId,
      deps: deps("H1").deps,
    });
    expect((await listDeliveryFixCycles(db, deliveryPrId))[0]).toMatchObject({
      state: "no_push",
      resultHeadSha: null,
    });
  });

  it("any other thread is a no-op", async () => {
    const threadId = await cycleThread(false);
    const d = deps("H2");
    await handleDeliveryCycleFinish({ userId, threadId, deps: d.deps });
    expect(d.evaluate).not.toHaveBeenCalled();
    expect((await listDeliveryFixCycles(db, deliveryPrId))[0]?.state).toBe(
      "running",
    );
  });

  it("the sweep abandons and refunds a cycle that never got a thread", async () => {
    await db
      .update(deliveryFixCycles)
      .set({
        createdAt: new Date(NOW.getTime() - DELIVERY_DISPATCH_STALE_MS - 1),
      })
      .where(eq(deliveryFixCycles.id, cycle.id));
    const result = await reconcileStaleDeliveryCycles(deps("H1").deps);
    expect(result.abandoned).toBeGreaterThanOrEqual(1);
    expect((await listDeliveryFixCycles(db, deliveryPrId))[0]?.state).toBe(
      "abandoned",
    );
    expect(await getDeliveryPr(db, deliveryPrId)).toMatchObject({
      phase: "awaiting_ci",
      cyclesUsed: 0,
    });
  });

  it("the sweep settles a running cycle past the hard cap whose finish was missed", async () => {
    await cycleThread();
    await db
      .update(deliveryFixCycles)
      .set({ createdAt: new Date(NOW.getTime() - DELIVERY_RUN_STALE_MS - 1) })
      .where(eq(deliveryFixCycles.id, cycle.id));
    const d = deps("H3");
    const result = await reconcileStaleDeliveryCycles(d.deps);
    expect(result.settled).toBeGreaterThanOrEqual(1);
    expect((await listDeliveryFixCycles(db, deliveryPrId))[0]).toMatchObject({
      state: "pushed",
      resultHeadSha: "H3",
    });
    expect(d.evaluate).toHaveBeenCalledWith({ deliveryPrId });
  });

  it("a fresh running cycle is left alone by the sweep", async () => {
    await cycleThread();
    // created_at is the database's now(), so the sweep runs on the real clock.
    await reconcileStaleDeliveryCycles({
      ...deps("H3").deps,
      now: () => new Date(),
    });
    expect((await listDeliveryFixCycles(db, deliveryPrId))[0]?.state).toBe(
      "running",
    );
  });
});
