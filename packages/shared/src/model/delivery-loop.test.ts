import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { nanoid } from "nanoid";

import { createDb } from "../db";
import {
  abandonDeliveryFixCycle,
  acquireDeliveryLease,
  bindDeliveryFixCycleThread,
  enrollDeliveryPr,
  findOpenDeliveryPrs,
  getDeliveryPr,
  listDeliveryFixCycles,
  recordShadowFixCycle,
  releaseDeliveryLease,
  settleDeliveryFixCycle,
  startDeliveryFixCycle,
  transitionDeliveryPr,
} from "./delivery-loop";
import { DELIVERY_FIX_CAP } from "./delivery-loop-settings";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "./test-helpers";

const db = createDb(env.DATABASE_URL!);

describe("#509 delivery loop ledger", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  let organizationId: string;
  let userId: string;
  let threadId: string;
  let repoFullName: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    organizationId = await createTestOrg({ db });
    threadId = (await createTestThread({ db, userId })).threadId;
    repoFullName = `Acme/Widgets-${nanoid(6)}`;
  });

  async function enroll(headSha: string | null = "sha-1") {
    return await enrollDeliveryPr(db, {
      organizationId,
      repoFullName,
      prNumber: 7,
      issueNumber: 3,
      headRef: "automata/task-abcd1234",
      baseRef: "main",
      headSha,
      deliveryThreadId: threadId,
      automationId: "auto-1",
      now,
    });
  }

  it("enrolls once in awaiting_ci with a lowercased repo; a second enroll returns the same row", async () => {
    const first = await enroll();
    expect(first.created).toBe(true);
    expect(first.row).toMatchObject({
      phase: "awaiting_ci",
      repoFullName: repoFullName.toLowerCase(),
      cyclesUsed: 0,
      headSeenAt: now,
    });
    const second = await enroll("sha-other");
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.headSha).toBe("sha-1");
  });

  it("finds open rows by PR number, head sha and head ref, never terminal ones", async () => {
    const { row } = await enroll();
    expect(
      (await findOpenDeliveryPrs(db, { repoFullName, prNumber: 7 })).map(
        (r) => r.id,
      ),
    ).toEqual([row.id]);
    expect(
      (await findOpenDeliveryPrs(db, { repoFullName, headSha: "sha-1" })).map(
        (r) => r.id,
      ),
    ).toEqual([row.id]);
    expect(
      (
        await findOpenDeliveryPrs(db, {
          repoFullName,
          headRef: "automata/task-abcd1234",
        })
      ).map((r) => r.id),
    ).toEqual([row.id]);
    expect(
      await transitionDeliveryPr(db, {
        id: row.id,
        expectedPhase: "awaiting_ci",
        expectedHeadSha: "sha-1",
        patch: { phase: "merged" },
      }),
    ).toBe(true);
    expect(
      await findOpenDeliveryPrs(db, { repoFullName, prNumber: 7 }),
    ).toEqual([]);
  });

  it("the CAS refuses a stale phase or a stale head and changes nothing", async () => {
    const { row } = await enroll();
    expect(
      await transitionDeliveryPr(db, {
        id: row.id,
        expectedPhase: "awaiting_review",
        expectedHeadSha: "sha-1",
        patch: { phase: "merge_ready" },
      }),
    ).toBe(false);
    expect(
      await transitionDeliveryPr(db, {
        id: row.id,
        expectedPhase: "awaiting_ci",
        expectedHeadSha: "sha-2",
        patch: { phase: "merge_ready" },
      }),
    ).toBe(false);
    expect((await getDeliveryPr(db, row.id))?.phase).toBe("awaiting_ci");
  });

  it("the CAS matches a null head with null", async () => {
    const { row } = await enroll(null);
    expect(
      await transitionDeliveryPr(db, {
        id: row.id,
        expectedPhase: "awaiting_ci",
        expectedHeadSha: null,
        patch: { headSha: "sha-9" },
      }),
    ).toBe(true);
  });

  it("the lease is exclusive until released or lapsed", async () => {
    const { row } = await enroll();
    expect(await acquireDeliveryLease(db, row.id, now)).toBe(true);
    expect(await acquireDeliveryLease(db, row.id, now)).toBe(false);
    const lapsed = new Date(now.getTime() + 61_000);
    expect(await acquireDeliveryLease(db, row.id, lapsed)).toBe(true);
    await releaseDeliveryLease(db, row.id, lapsed);
    expect((await getDeliveryPr(db, row.id))?.evaluatedAt).toEqual(lapsed);
    expect(await acquireDeliveryLease(db, row.id, lapsed)).toBe(true);
  });

  it("starts one cycle per head: a second start at the same head is a duplicate and spends nothing", async () => {
    const { row } = await enroll();
    const started = await startDeliveryFixCycle(db, {
      deliveryPrId: row.id,
      expectedPhase: "awaiting_ci",
      headSha: "sha-1",
      trigger: "ci",
      reviewId: null,
      failingChecks: ["check"],
    });
    expect(started.kind).toBe("started");
    const after = await getDeliveryPr(db, row.id);
    expect(after).toMatchObject({ phase: "fixing", cyclesUsed: 1 });
    expect(
      await startDeliveryFixCycle(db, {
        deliveryPrId: row.id,
        expectedPhase: "fixing",
        headSha: "sha-1",
        trigger: "ci",
        reviewId: null,
        failingChecks: [],
      }),
    ).toEqual({ kind: "duplicate" });
    expect((await getDeliveryPr(db, row.id))?.cyclesUsed).toBe(1);
  });

  it("refuses a start when the row moved (stale) and when the cap is spent", async () => {
    const { row } = await enroll();
    expect(
      await startDeliveryFixCycle(db, {
        deliveryPrId: row.id,
        expectedPhase: "awaiting_review",
        headSha: "sha-1",
        trigger: "review",
        reviewId: 1,
        failingChecks: [],
      }),
    ).toEqual({ kind: "stale" });
    for (let k = 1; k <= DELIVERY_FIX_CAP; k++) {
      const head = `sha-${k}`;
      const current = await getDeliveryPr(db, row.id);
      expect(
        await transitionDeliveryPr(db, {
          id: row.id,
          expectedPhase: current!.phase,
          expectedHeadSha: current!.headSha,
          patch: { phase: "awaiting_review", headSha: head },
        }),
      ).toBe(true);
      expect(
        (
          await startDeliveryFixCycle(db, {
            deliveryPrId: row.id,
            expectedPhase: "awaiting_review",
            headSha: head,
            trigger: "review",
            reviewId: k,
            failingChecks: [],
          })
        ).kind,
      ).toBe("started");
    }
    await transitionDeliveryPr(db, {
      id: row.id,
      expectedPhase: "fixing",
      expectedHeadSha: `sha-${DELIVERY_FIX_CAP}`,
      patch: { phase: "awaiting_review", headSha: "sha-next" },
    });
    expect(
      await startDeliveryFixCycle(db, {
        deliveryPrId: row.id,
        expectedPhase: "awaiting_review",
        headSha: "sha-next",
        trigger: "review",
        reviewId: 99,
        failingChecks: [],
      }),
    ).toEqual({ kind: "cap_reached", cyclesUsed: DELIVERY_FIX_CAP });
  });

  it("a cycle walks dispatching -> running -> pushed, each step once", async () => {
    const { row } = await enroll();
    const started = await startDeliveryFixCycle(db, {
      deliveryPrId: row.id,
      expectedPhase: "awaiting_ci",
      headSha: "sha-1",
      trigger: "ci",
      reviewId: null,
      failingChecks: [],
    });
    if (started.kind !== "started") throw new Error("expected a started cycle");
    const cycleThread = (await createTestThread({ db, userId })).threadId;
    expect(
      await bindDeliveryFixCycleThread(db, {
        cycleId: started.cycle.id,
        threadId: cycleThread,
      }),
    ).toBe(true);
    expect(
      await bindDeliveryFixCycleThread(db, {
        cycleId: started.cycle.id,
        threadId: cycleThread,
      }),
    ).toBe(false);
    expect(
      await settleDeliveryFixCycle(db, {
        cycleId: started.cycle.id,
        state: "pushed",
        resultHeadSha: "sha-2",
        now,
      }),
    ).toBe(true);
    expect(
      await settleDeliveryFixCycle(db, {
        cycleId: started.cycle.id,
        state: "no_push",
        resultHeadSha: null,
        now,
      }),
    ).toBe(false);
    const [cycle] = await listDeliveryFixCycles(db, row.id);
    expect(cycle).toMatchObject({
      state: "pushed",
      threadId: cycleThread,
      resultHeadSha: "sha-2",
    });
  });

  it("abandoning a dispatching cycle refunds it and restores the phase; a running one is not refunded", async () => {
    const { row } = await enroll();
    const started = await startDeliveryFixCycle(db, {
      deliveryPrId: row.id,
      expectedPhase: "awaiting_ci",
      headSha: "sha-1",
      trigger: "ci",
      reviewId: null,
      failingChecks: [],
    });
    if (started.kind !== "started") throw new Error("expected a started cycle");
    expect(
      await abandonDeliveryFixCycle(db, {
        cycleId: started.cycle.id,
        restorePhase: "awaiting_ci",
        reason: "thread create failed",
        now,
      }),
    ).toBe(true);
    expect(await getDeliveryPr(db, row.id)).toMatchObject({
      phase: "awaiting_ci",
      cyclesUsed: 0,
      lastReason: "thread create failed",
    });
    expect(
      await abandonDeliveryFixCycle(db, {
        cycleId: started.cycle.id,
        restorePhase: "awaiting_ci",
        reason: "again",
        now,
      }),
    ).toBe(false);
  });

  it("shadow cycles spend nothing, dedupe per head, and never collide with a later live cycle", async () => {
    const { row } = await enroll();
    const shadow = {
      deliveryPrId: row.id,
      headSha: "sha-1",
      trigger: "ci" as const,
      reviewId: null,
      failingChecks: [],
    };
    expect(await recordShadowFixCycle(db, shadow)).toBe(true);
    expect(await recordShadowFixCycle(db, shadow)).toBe(false);
    expect(await getDeliveryPr(db, row.id)).toMatchObject({
      phase: "awaiting_ci",
      cyclesUsed: 0,
    });
    await transitionDeliveryPr(db, {
      id: row.id,
      expectedPhase: "awaiting_ci",
      expectedHeadSha: "sha-1",
      patch: { headSha: "sha-2" },
    });
    const live = await startDeliveryFixCycle(db, {
      deliveryPrId: row.id,
      expectedPhase: "awaiting_ci",
      headSha: "sha-2",
      trigger: "ci",
      reviewId: null,
      failingChecks: [],
    });
    expect(live.kind).toBe("started");
    expect(
      (await listDeliveryFixCycles(db, row.id)).map((c) => [
        c.cycleNo,
        c.state,
      ]),
    ).toEqual([
      [1, "shadow"],
      [2, "dispatching"],
    ]);
    expect((await getDeliveryPr(db, row.id))?.cyclesUsed).toBe(1);
  });

  it("a live start at the SAME head a shadow cycle recorded converts that row into the live cycle", async () => {
    const { row } = await enroll();
    expect(
      await recordShadowFixCycle(db, {
        deliveryPrId: row.id,
        headSha: "sha-1",
        trigger: "ci",
        reviewId: null,
        failingChecks: ["old"],
      }),
    ).toBe(true);
    const live = await startDeliveryFixCycle(db, {
      deliveryPrId: row.id,
      expectedPhase: "awaiting_ci",
      headSha: "sha-1",
      trigger: "review+ci",
      reviewId: 42,
      failingChecks: ["lint"],
    });
    expect(live.kind).toBe("started");
    const cycles = await listDeliveryFixCycles(db, row.id);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({
      cycleNo: 1,
      triggerHeadSha: "sha-1",
      state: "dispatching",
      trigger: "review+ci",
      reviewId: 42,
      failingChecks: ["lint"],
    });
    expect(await getDeliveryPr(db, row.id)).toMatchObject({
      phase: "fixing",
      cyclesUsed: 1,
    });
    expect(
      await startDeliveryFixCycle(db, {
        deliveryPrId: row.id,
        expectedPhase: "fixing",
        headSha: "sha-1",
        trigger: "ci",
        reviewId: null,
        failingChecks: [],
      }),
    ).toEqual({ kind: "duplicate" });
  });

  it("concurrent shadow writers on different heads and a live start all land, with distinct cycle numbers", async () => {
    const { row } = await enroll();
    const heads = ["sha-a", "sha-b", "sha-c", "sha-d"];
    const results = await Promise.all([
      ...heads.map((headSha) =>
        recordShadowFixCycle(db, {
          deliveryPrId: row.id,
          headSha,
          trigger: "ci",
          reviewId: null,
          failingChecks: [],
        }),
      ),
      startDeliveryFixCycle(db, {
        deliveryPrId: row.id,
        expectedPhase: "awaiting_ci",
        headSha: "sha-1",
        trigger: "ci",
        reviewId: null,
        failingChecks: [],
      }),
    ]);
    expect(results.slice(0, heads.length)).toEqual([true, true, true, true]);
    expect((results[heads.length] as { kind: string }).kind).toBe("started");
    const cycles = await listDeliveryFixCycles(db, row.id);
    expect(cycles.map((c) => c.cycleNo)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(cycles.map((c) => c.triggerHeadSha)).size).toBe(5);
  });
});
