import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { cellBearer, cellEffect, cellStep } from "../db/schema";
import {
  beginEffect,
  completeEffect,
  markStepDone,
  mintBearer,
  openStep,
  releaseEffect,
  revokeAttempt,
  verifyBearer,
} from "./cell-authority";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "./test-helpers";

const db = createDb(env.DATABASE_URL!);
const STEP_TIMEOUT = 30 * 60_000;

async function newStep(
  effectBudget: number | null = null,
  allowedRef: string | null = "refs/heads/feat/x",
) {
  const organizationId = await createTestOrg({ db });
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({ db, userId: user.id });
  const stepKey = `run-${randomUUID()}/agent`;
  const open = (attempt: number) =>
    openStep({
      db,
      step: {
        stepKey,
        organizationId,
        threadId,
        attempt,
        stepTimeoutMs: STEP_TIMEOUT,
        effectBudget,
        allowedRef,
      },
    });
  const bearer = async (attempt: number) => {
    const m = await mintBearer({ db, stepKey, attempt, ttlMs: STEP_TIMEOUT });
    if (!m.ok) throw new Error(m.reason);
    return m.token;
  };
  return { stepKey, organizationId, threadId, open, bearer };
}

async function effectsUsed(stepKey: string): Promise<number> {
  const rows = await db
    .select({ used: cellStep.effectsUsed })
    .from(cellStep)
    .where(eq(cellStep.stepKey, stepKey));
  return rows[0]?.used ?? -1;
}

async function claimAttempt(stepKey: string, key: string): Promise<number> {
  const rows = await db
    .select({ attempt: cellEffect.attempt })
    .from(cellEffect)
    .where(
      and(eq(cellEffect.stepKey, stepKey), eq(cellEffect.idempotencyKey, key)),
    );
  return rows[0]?.attempt ?? -1;
}

describe("cell authority (ADR-014 remote cells)", () => {
  it("AC1 lease is monotone: a newer attempt takes it, a stale redelivery never takes it back", async () => {
    const s = await newStep();
    expect(await s.open(1)).toEqual({ ok: true });
    expect(await s.open(2)).toEqual({ ok: true });
    expect(await s.open(1)).toEqual({ ok: false, reason: "stale_attempt" });
    // Re-opening by the attempt that holds the lease is a no-op success.
    expect(await s.open(2)).toEqual({ ok: true });
  });

  it("refuses to re-open a finished step, and a step key owned by another org or thread", async () => {
    const s = await newStep();
    await s.open(1);
    expect(await markStepDone({ db, token: await s.bearer(1) })).toEqual({
      ok: true,
    });
    expect(await s.open(2)).toEqual({ ok: false, reason: "step_done" });

    const t = await newStep();
    await t.open(1);
    const otherOrg = await createTestOrg({ db });
    expect(
      await openStep({
        db,
        step: {
          stepKey: t.stepKey,
          organizationId: otherOrg,
          threadId: t.threadId,
          attempt: 5,
          stepTimeoutMs: STEP_TIMEOUT,
          effectBudget: null,
          allowedRef: "refs/heads/feat/x",
        },
      }),
    ).toEqual({ ok: false, reason: "conflict" });
  });

  it("rejects invalid inputs", async () => {
    const s = await newStep();
    await expect(s.open(0)).rejects.toThrow(RangeError);
    await expect(
      openStep({
        db,
        step: {
          stepKey: s.stepKey,
          organizationId: s.organizationId,
          threadId: s.threadId,
          attempt: 1,
          stepTimeoutMs: STEP_TIMEOUT,
          effectBudget: -1,
          allowedRef: null,
        },
      }),
    ).rejects.toThrow(RangeError);
  });

  it("AC2 stores allowedRef, surfaces it on the bearer context, and keeps null as null", async () => {
    const s = await newStep(null, "refs/heads/automata/task-1a2b3c4d");
    await s.open(1);
    const v = await verifyBearer({ db, token: await s.bearer(1) });
    expect(v.ok && v.context.allowedRef).toBe(
      "refs/heads/automata/task-1a2b3c4d",
    );
    const n = await newStep(null, null);
    await n.open(1);
    const nv = await verifyBearer({ db, token: await n.bearer(1) });
    expect(nv.ok && nv.context.allowedRef).toBeNull();
  });

  it.each([
    "feat/x",
    "refs/tags/v1",
    "refs/heads/",
    "refs/heads/a..b",
    "refs/heads/a.lock",
    "refs/heads/a\u0007b",
    "refs/heads/-x",
    "refs/heads/HEAD",
  ])("AC2 openStep throws a RangeError for allowedRef %j", async (ref) => {
    const s = await newStep(null, ref);
    await expect(s.open(1)).rejects.toThrow(RangeError);
  });

  it("AC2 re-opening with a different allowedRef is a conflict, and the stored ref never changes", async () => {
    const s = await newStep(null, "refs/heads/feat/x");
    expect(await s.open(1)).toEqual({ ok: true });
    const reopen = (attempt: number, allowedRef: string | null) =>
      openStep({
        db,
        step: {
          stepKey: s.stepKey,
          organizationId: s.organizationId,
          threadId: s.threadId,
          attempt,
          stepTimeoutMs: STEP_TIMEOUT,
          effectBudget: null,
          allowedRef,
        },
      });
    expect(await reopen(1, "refs/heads/feat/y")).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(await reopen(2, "refs/heads/feat/y")).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(await reopen(2, null)).toEqual({ ok: false, reason: "conflict" });
    // The newer attempt with the same ref still takes the lease.
    expect(await reopen(2, "refs/heads/feat/x")).toEqual({ ok: true });
    const v = await verifyBearer({ db, token: await s.bearer(2) });
    expect(v.ok && v.context.allowedRef).toBe("refs/heads/feat/x");
  });

  it("AC2 refuses a bearer whose TTL exceeds the step timeout or for a fenced attempt, and throws on a TTL that is not a positive number", async () => {
    const s = await newStep();
    await s.open(1);
    expect(
      await mintBearer({
        db,
        stepKey: s.stepKey,
        attempt: 1,
        ttlMs: STEP_TIMEOUT + 1,
      }),
    ).toEqual({ ok: false, reason: "ttl_exceeds_step_timeout" });
    for (const ttlMs of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      await expect(
        mintBearer({ db, stepKey: s.stepKey, attempt: 1, ttlMs }),
      ).rejects.toThrow(RangeError);
    }
    await s.open(2);
    expect(
      await mintBearer({ db, stepKey: s.stepKey, attempt: 1, ttlMs: 1000 }),
    ).toEqual({ ok: false, reason: "fenced" });
  });

  it("AC3 refuses unknown, revoked and expired bearers; revocation is sticky", async () => {
    const s = await newStep();
    await s.open(1);
    const t = await s.bearer(1);
    expect((await verifyBearer({ db, token: t })).ok).toBe(true);
    // Expiry is judged by the database clock.
    await db
      .update(cellBearer)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(cellBearer.stepKey, s.stepKey));
    expect(await verifyBearer({ db, token: t })).toEqual({
      ok: false,
      reason: "expired",
    });
    const t2 = await s.bearer(1);
    expect(await revokeAttempt({ db, stepKey: s.stepKey, attempt: 1 })).toBe(
      true,
    );
    expect(await verifyBearer({ db, token: t2 })).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(
      await mintBearer({ db, stepKey: s.stepKey, attempt: 1, ttlMs: 1000 }),
    ).toEqual({ ok: false, reason: "revoked" });
    // A newer attempt is not affected by revoking an older one.
    await s.open(2);
    expect((await verifyBearer({ db, token: await s.bearer(2) })).ok).toBe(
      true,
    );
    expect(await verifyBearer({ db, token: "not-a-token" })).toEqual({
      ok: false,
      reason: "unknown_bearer",
    });
  });

  it("AC4 s4d: the attempt fence alone stops a zombie once a newer attempt holds the lease", async () => {
    const s = await newStep();
    await s.open(1);
    const zombie = await s.bearer(1);
    expect(
      (await beginEffect({ db, token: zombie, idempotencyKey: "push-a" })).kind,
    ).toBe("go");
    await s.open(2);
    expect(await verifyBearer({ db, token: zombie })).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(
      await beginEffect({ db, token: zombie, idempotencyKey: "push-b" }),
    ).toEqual({ kind: "refused", reason: "fenced" });
    expect(await effectsUsed(s.stepKey)).toBe(1);
  });

  it("AC3 revoking an attempt before it minted any bearer still sticks", async () => {
    const s = await newStep();
    await s.open(1);
    expect(await revokeAttempt({ db, stepKey: s.stepKey, attempt: 1 })).toBe(
      true,
    );
    expect(
      await mintBearer({ db, stepKey: s.stepKey, attempt: 1, ttlMs: 1000 }),
    ).toEqual({ ok: false, reason: "revoked" });
    // openStep refuses the revoked attempt up front, not one call later.
    expect(await s.open(1)).toEqual({ ok: false, reason: "revoked" });
    await expect(
      revokeAttempt({ db, stepKey: s.stepKey, attempt: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it("AC3 revoking a future attempt is capped at the current one and never blocks that attempt", async () => {
    const s = await newStep();
    await s.open(1);
    expect(await revokeAttempt({ db, stepKey: s.stepKey, attempt: 5 })).toBe(
      true,
    );
    expect(await s.open(2)).toEqual({ ok: true });
    expect((await verifyBearer({ db, token: await s.bearer(2) })).ok).toBe(
      true,
    );
  });

  it("AC4 a pending claim is never taken over by an attempt that was fenced in the meantime", async () => {
    const s = await newStep();
    await s.open(1);
    await beginEffect({
      db,
      token: await s.bearer(1),
      idempotencyKey: "pending",
    });
    await s.open(2);
    const second = await s.bearer(2);
    await s.open(3);
    expect(
      await beginEffect({ db, token: second, idempotencyKey: "pending" }),
    ).toEqual({ kind: "refused", reason: "fenced" });
    expect(await claimAttempt(s.stepKey, "pending")).toBe(1);
  });

  it("AC5 s3: a redelivered attempt that repeats a completed key gets the stored result, not a second effect", async () => {
    const s = await newStep();
    await s.open(1);
    const first = await s.bearer(1);
    expect(
      (await beginEffect({ db, token: first, idempotencyKey: "push-main" }))
        .kind,
    ).toBe("go");
    expect(
      await completeEffect({
        db,
        stepKey: s.stepKey,
        idempotencyKey: "push-main",
        attempt: 1,
        result: { pushed: "abc123" },
      }),
    ).toBe(true);
    await s.open(2);
    const second = await s.bearer(2);
    expect(
      await beginEffect({ db, token: second, idempotencyKey: "push-main" }),
    ).toEqual({ kind: "replay", result: { pushed: "abc123" } });
    expect(await effectsUsed(s.stepKey)).toBe(1);
  });

  it("AC6 s4b: an effect budget of 1 lets one effect through and refuses the zombie's new keys; a budget of 0 refuses the first", async () => {
    const s = await newStep(1);
    await s.open(1);
    const zombie = await s.bearer(1);
    const kinds: string[] = [];
    for (const k of ["e1", "e2", "e3", "e4", "e5", "e6"]) {
      kinds.push(
        (await beginEffect({ db, token: zombie, idempotencyKey: k })).kind,
      );
    }
    expect(kinds).toEqual([
      "go",
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
    ]);
    expect(
      await beginEffect({ db, token: zombie, idempotencyKey: "e2" }),
    ).toEqual({ kind: "refused", reason: "effect_budget_exhausted" });
    expect(await effectsUsed(s.stepKey)).toBe(1);

    const z = await newStep(0);
    await z.open(1);
    expect(
      await beginEffect({ db, token: await z.bearer(1), idempotencyKey: "x" }),
    ).toEqual({ kind: "refused", reason: "effect_budget_exhausted" });
  });

  it("AC7 two concurrent requests with the same key: exactly one runs", async () => {
    const s = await newStep();
    await s.open(1);
    const t = await s.bearer(1);
    const both = await Promise.all([
      beginEffect({ db, token: t, idempotencyKey: "same" }),
      beginEffect({ db, token: t, idempotencyKey: "same" }),
    ]);
    expect(both.map((b) => b.kind).sort()).toEqual(["go", "refused"]);
    expect(both.find((b) => b.kind === "refused")).toEqual({
      kind: "refused",
      reason: "effect_in_progress",
    });
    expect(await effectsUsed(s.stepKey)).toBe(1);
  });

  it("AC8 a pending claim from a dead attempt is taken over by the current attempt, without a second budget unit", async () => {
    const s = await newStep(1);
    await s.open(1);
    const dead = await s.bearer(1);
    expect(
      (await beginEffect({ db, token: dead, idempotencyKey: "push-x" })).kind,
    ).toBe("go");
    // Attempt 1 dies before completeEffect; the step is redelivered.
    await s.open(2);
    const next = await s.bearer(2);
    expect(
      (await beginEffect({ db, token: next, idempotencyKey: "push-x" })).kind,
    ).toBe("go");
    expect(await effectsUsed(s.stepKey)).toBe(1);
    expect(
      await completeEffect({
        db,
        stepKey: s.stepKey,
        idempotencyKey: "push-x",
        attempt: 1,
        result: { pushed: "late" },
      }),
    ).toBe(false);
    expect(
      await completeEffect({
        db,
        stepKey: s.stepKey,
        idempotencyKey: "push-x",
        attempt: 2,
        result: { pushed: "abc" },
      }),
    ).toBe(true);
    expect(
      await beginEffect({ db, token: next, idempotencyKey: "push-x" }),
    ).toEqual({ kind: "replay", result: { pushed: "abc" } });
  });

  it("AC9 only the current attempt can finish the step; after that no bearer acts, not even on its own pending key", async () => {
    const s = await newStep();
    await s.open(1);
    const zombie = await s.bearer(1);
    await s.open(2);
    const current = await s.bearer(2);
    expect(await markStepDone({ db, token: zombie })).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(
      (await beginEffect({ db, token: current, idempotencyKey: "pending" }))
        .kind,
    ).toBe("go");
    expect(await claimAttempt(s.stepKey, "pending")).toBe(2);
    expect(await markStepDone({ db, token: current })).toEqual({ ok: true });
    expect(
      await beginEffect({ db, token: current, idempotencyKey: "pending" }),
    ).toEqual({ kind: "refused", reason: "step_done" });
    expect(await markStepDone({ db, token: current })).toEqual({
      ok: false,
      reason: "step_done",
    });
    expect(
      await beginEffect({ db, token: current, idempotencyKey: "late" }),
    ).toEqual({ kind: "refused", reason: "step_done" });
  });

  describe("releaseEffect (#606 amendment 4)", () => {
    async function effectRows(stepKey: string, key: string): Promise<number> {
      const rows = await db
        .select({ key: cellEffect.idempotencyKey })
        .from(cellEffect)
        .where(
          and(
            eq(cellEffect.stepKey, stepKey),
            eq(cellEffect.idempotencyKey, key),
          ),
        );
      return rows.length;
    }

    it("drops an unanswered claim without refunding the unit, and an identical retry claims afresh (AC12)", async () => {
      const s = await newStep();
      await s.open(1);
      const token = await s.bearer(1);
      expect((await beginEffect({ db, token, idempotencyKey: "k" })).kind).toBe(
        "go",
      );
      expect(await effectsUsed(s.stepKey)).toBe(1);
      expect(
        await releaseEffect({
          db,
          stepKey: s.stepKey,
          idempotencyKey: "k",
          attempt: 1,
        }),
      ).toBe(true);
      expect(await effectRows(s.stepKey, "k")).toBe(0);
      expect(await effectsUsed(s.stepKey)).toBe(1);
      expect((await beginEffect({ db, token, idempotencyKey: "k" })).kind).toBe(
        "go",
      );
      expect(await effectsUsed(s.stepKey)).toBe(2);
    });

    it("leaves a completed effect alone", async () => {
      const s = await newStep();
      await s.open(1);
      const token = await s.bearer(1);
      await beginEffect({ db, token, idempotencyKey: "k" });
      await completeEffect({
        db,
        stepKey: s.stepKey,
        idempotencyKey: "k",
        attempt: 1,
        result: { status: 200 },
      });
      expect(
        await releaseEffect({
          db,
          stepKey: s.stepKey,
          idempotencyKey: "k",
          attempt: 1,
        }),
      ).toBe(false);
      expect(await beginEffect({ db, token, idempotencyKey: "k" })).toEqual({
        kind: "replay",
        result: { status: 200 },
      });
    });

    it("matches nothing for the wrong attempt, and rejects a non-positive attempt", async () => {
      const s = await newStep();
      await s.open(1);
      await beginEffect({
        db,
        token: await s.bearer(1),
        idempotencyKey: "k",
      });
      expect(
        await releaseEffect({
          db,
          stepKey: s.stepKey,
          idempotencyKey: "k",
          attempt: 2,
        }),
      ).toBe(false);
      expect(await effectRows(s.stepKey, "k")).toBe(1);
      await expect(
        releaseEffect({
          db,
          stepKey: s.stepKey,
          idempotencyKey: "k",
          attempt: 0,
        }),
      ).rejects.toThrow(RangeError);
    });

    it("after a takeover, the older attempt's release returns false and the claim stays with the newer attempt", async () => {
      const s = await newStep();
      await s.open(1);
      await beginEffect({
        db,
        token: await s.bearer(1),
        idempotencyKey: "k",
      });
      await s.open(2);
      expect(
        (
          await beginEffect({
            db,
            token: await s.bearer(2),
            idempotencyKey: "k",
          })
        ).kind,
      ).toBe("go");
      expect(
        await releaseEffect({
          db,
          stepKey: s.stepKey,
          idempotencyKey: "k",
          attempt: 1,
        }),
      ).toBe(false);
      expect(await claimAttempt(s.stepKey, "k")).toBe(2);
    });

    it("waits for a transaction that holds the step row lock", async () => {
      const s = await newStep();
      await s.open(1);
      await beginEffect({
        db,
        token: await s.bearer(1),
        idempotencyKey: "k",
      });
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: (() => void) | undefined;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = db.transaction(async (tx) => {
        await tx
          .select({ stepKey: cellStep.stepKey })
          .from(cellStep)
          .where(eq(cellStep.stepKey, s.stepKey))
          .for("update");
        locked?.();
        await gate;
      });
      await lockTaken;
      let settled = false;
      const pending = releaseEffect({
        db,
        stepKey: s.stepKey,
        idempotencyKey: "k",
        attempt: 1,
      }).then((v) => {
        settled = true;
        return v;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      release?.();
      await holder;
      expect(await pending).toBe(true);
    });
  });
});
