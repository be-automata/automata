import { randomUUID } from "node:crypto";

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { env } from "@terragon/env/pkg-shared";
import { cellKeyId } from "@terragon/types/cell";
import { createDb, type DB } from "../db";
import { cellBearer, cellEffect, cellStep } from "../db/schema";
import {
  beginEffect,
  completeEffect,
  deadCellAttempts,
  finishStep,
  markStepDone,
  mintBearer,
  openNextAttempt,
  openStep,
  releaseEffect,
  revokeAttempt,
  stampSeen,
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
  const open = (attempt: number, ref: string | null = allowedRef) =>
    openStep({
      db,
      step: {
        stepKey,
        organizationId,
        threadId,
        attempt,
        stepTimeoutMs: STEP_TIMEOUT,
        effectBudget,
        allowedRef: ref,
      },
    });
  const bearer = async (attempt: number) => {
    const m = await mintBearer({ db, stepKey, attempt, ttlMs: STEP_TIMEOUT });
    if (!m.ok) throw new Error(m.reason);
    return m.token;
  };
  const step = {
    stepKey,
    organizationId,
    threadId,
    stepTimeoutMs: STEP_TIMEOUT,
    effectBudget,
    allowedRef,
  };
  const next = () => openNextAttempt({ db, step });
  const owner = { stepKey, organizationId, threadId };
  return { stepKey, organizationId, threadId, owner, step, open, next, bearer };
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
    const reopen = s.open;
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

// ---------------------------------------------------------------------------
// #656 PR-A: the lease and the server-assigned attempt
// ---------------------------------------------------------------------------

const STALE_MS = 5 * 60_000;

async function row(stepKey: string) {
  const r = (
    await db
      .select({
        currentAttempt: cellStep.currentAttempt,
        revokedThrough: cellStep.revokedThrough,
        doneAt: cellStep.doneAt,
        lastSeenAt: cellStep.lastSeenAt,
        fresh: sql<boolean>`${cellStep.lastSeenAt} > now() - interval '1 minute'`,
      })
      .from(cellStep)
      .where(eq(cellStep.stepKey, stepKey))
  )[0];
  if (!r) throw new Error("no step row");
  return r;
}

/**
 * Ages a STAMPED lease by 10 minutes. A NULL lease (a row opened by the old
 * openStep, before the migration) stays NULL: backdating must not invent a stamp.
 */
async function backdate(stepKey: string) {
  await db
    .update(cellStep)
    .set({ lastSeenAt: sql`${cellStep.lastSeenAt} - interval '10 minutes'` })
    .where(and(eq(cellStep.stepKey, stepKey), isNotNull(cellStep.lastSeenAt)));
}

/**
 * Holds the step's row lock in a transaction that COMMITS on release. A write
 * that throws rejects at once (the test fails instead of waiting forever for a
 * lock that was never taken); callers release in `finally`.
 */
async function holdAndCommit(
  write: (tx: Pick<DB, "update">) => Promise<unknown>,
) {
  let locked!: () => void;
  let failed!: (error: unknown) => void;
  let release!: () => void;
  const lockedP = new Promise<void>((res, rej) => {
    locked = res;
    failed = rej;
  });
  const releasedP = new Promise<void>((r) => (release = r));
  const done = db.transaction(async (tx) => {
    try {
      await write(tx);
    } catch (error) {
      failed(error);
      throw error;
    }
    locked();
    await releasedP;
  });
  // Surfaced through lockedP; awaiting `done` still sees the rejection.
  done.catch(() => undefined);
  await lockedP;
  return { release, done };
}

/** Below the 5 s test timeout, so a statement that never blocks fails the test. */
const BLOCK_WAIT_MS = 3000;

async function waitUntilBlocked(): Promise<void> {
  const deadline = Date.now() + BLOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const r = await db.execute(
      sql`select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and datname = current_database()
            and query ilike '%last_seen_at%'`,
    );
    if (Number(r.rows[0]?.n) >= 1) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("statement never blocked on the row lock");
}

describe("#656 PR-A openNextAttempt", () => {
  it("1 opens 1 with a lease, then 2, and fences attempt 1", async () => {
    const s = await newStep(null, null);
    expect(await s.next()).toEqual({ ok: true, attempt: 1 });
    expect((await row(s.stepKey)).fresh).toBe(true);
    const b1 = await s.bearer(1);
    expect(await s.next()).toEqual({ ok: true, attempt: 2 });
    const v = await verifyBearer({ db, token: b1 });
    expect(v).toMatchObject({ ok: false, reason: "fenced" });
    expect(
      await mintBearer({
        db,
        stepKey: s.stepKey,
        attempt: 1,
        ttlMs: STEP_TIMEOUT,
      }),
    ).toMatchObject({ ok: false, reason: "fenced" });
  });

  it("2 concurrent opens get consecutive attempts", async () => {
    const s = await newStep(null, null);
    const rs = await Promise.all(Array.from({ length: 8 }, () => s.next()));
    const attempts = rs
      .map((r) => (r.ok ? r.attempt : -1))
      .sort((a, b) => a - b);
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await row(s.stepKey)).currentAttempt).toBe(8);
  });

  it("3 a finished step refuses a new attempt (finishStep and markStepDone)", async () => {
    const s = await newStep(null, null);
    await s.next();
    expect(await finishStep({ db, ...s.owner })).toBe(true);
    expect(await s.next()).toEqual({ ok: false, reason: "step_done" });
    expect((await row(s.stepKey)).currentAttempt).toBe(1);

    const t = await newStep(null, null);
    await t.next();
    expect(await markStepDone({ db, token: await t.bearer(1) })).toEqual({
      ok: true,
    });
    expect(await t.next()).toEqual({ ok: false, reason: "step_done" });
    expect((await row(t.stepKey)).currentAttempt).toBe(1);
  });

  it("4 revocation does not block the next attempt", async () => {
    const s = await newStep(null, null);
    await s.next();
    await revokeAttempt({ db, stepKey: s.stepKey, attempt: 1 });
    expect(await s.next()).toEqual({ ok: true, attempt: 2 });
  });

  it("5 another org, thread or allowedRef is a conflict and changes nothing", async () => {
    const s = await newStep(null, "refs/heads/feat/x");
    await s.next();
    const other = await createTestOrg({ db });
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({ db, userId: user.id });
    for (const patch of [
      { organizationId: other },
      { threadId },
      { allowedRef: "refs/heads/feat/y" },
      { allowedRef: null },
    ]) {
      expect(
        await openNextAttempt({ db, step: { ...s.step, ...patch } }),
      ).toEqual({ ok: false, reason: "conflict" });
    }
    expect((await row(s.stepKey)).currentAttempt).toBe(1);
  });

  it("6a a committing finishStep write blocks the open, which then sees step_done", async () => {
    const s = await newStep(null, null);
    await s.next();
    const holder = await holdAndCommit((tx) =>
      tx
        .update(cellStep)
        .set({
          revokedThrough: sql`${cellStep.currentAttempt}`,
          doneAt: sql`now()`,
        })
        .where(eq(cellStep.stepKey, s.stepKey)),
    );
    const open = s.next();
    try {
      await waitUntilBlocked();
    } finally {
      holder.release();
    }
    await holder.done;
    expect(await open).toEqual({ ok: false, reason: "step_done" });
    expect((await row(s.stepKey)).currentAttempt).toBe(1);
  });

  it("6c a lock holder whose write throws rejects instead of hanging the suite", async () => {
    const s = await newStep(null, null);
    await s.next();
    await expect(
      holdAndCommit(async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    expect(await s.next()).toEqual({ ok: true, attempt: 2 });
  });

  it("6b the 1000th attempt opens, the 1001st is refused", async () => {
    const s = await newStep(null, null);
    await s.next();
    await db
      .update(cellStep)
      .set({ currentAttempt: 999 })
      .where(eq(cellStep.stepKey, s.stepKey));
    expect(await s.next()).toEqual({ ok: true, attempt: 1000 });
    expect(await s.next()).toEqual({ ok: false, reason: "attempt_limit" });
  });

  it("6c a re-open with other effectBudget/stepTimeoutMs keeps the stored values", async () => {
    const s = await newStep(null, null);
    await s.next();
    await openNextAttempt({
      db,
      step: { ...s.step, effectBudget: 7, stepTimeoutMs: 999 },
    });
    const r = (
      await db
        .select({
          budget: cellStep.effectBudget,
          timeout: cellStep.stepTimeoutMs,
          attempt: cellStep.currentAttempt,
        })
        .from(cellStep)
        .where(eq(cellStep.stepKey, s.stepKey))
    )[0];
    expect(r).toEqual({ budget: null, timeout: STEP_TIMEOUT, attempt: 2 });
  });

  it("7 validation errors match openStep", async () => {
    const s = await newStep(null, null);
    await expect(
      openNextAttempt({ db, step: { ...s.step, stepTimeoutMs: 0 } }),
    ).rejects.toThrow(RangeError);
    await expect(
      openNextAttempt({ db, step: { ...s.step, effectBudget: -1 } }),
    ).rejects.toThrow("effectBudget must be null or a non-negative integer");
    await expect(
      openNextAttempt({ db, step: { ...s.step, allowedRef: "feat/x" } }),
    ).rejects.toThrow("allowedRef must be null or a refs/heads/ branch ref");
  });
});

describe("#656 PR-A stampSeen", () => {
  it("8 stamps the current attempt and moves a backdated lease forward", async () => {
    const s = await newStep(null, null);
    await s.next();
    await backdate(s.stepKey);
    expect((await row(s.stepKey)).fresh).toBe(false);
    expect(await stampSeen({ db, stepKey: s.stepKey, attempt: 1 })).toBe(true);
    expect((await row(s.stepKey)).fresh).toBe(true);
  });

  it("9 a fenced attempt's stamp does not renew the lease", async () => {
    const s = await newStep(null, null);
    await s.next();
    await s.next();
    await backdate(s.stepKey);
    expect(await stampSeen({ db, stepKey: s.stepKey, attempt: 1 })).toBe(false);
    expect((await row(s.stepKey)).fresh).toBe(false);
    const dead = await deadCellAttempts({
      db,
      keys: [{ stepKey: s.stepKey, attempt: 2 }],
      staleMs: STALE_MS,
    });
    expect(dead).toEqual(
      new Set([cellKeyId({ stepKey: s.stepKey, attempt: 2 })]),
    );
  });

  it("10 a revoked, done or unknown step is not stamped", async () => {
    const r = await newStep(null, null);
    await r.next();
    await revokeAttempt({ db, stepKey: r.stepKey, attempt: 1 });
    expect(await stampSeen({ db, stepKey: r.stepKey, attempt: 1 })).toBe(false);
    const d = await newStep(null, null);
    await d.next();
    await finishStep({ db, ...d.owner });
    expect(await stampSeen({ db, stepKey: d.stepKey, attempt: 1 })).toBe(false);
    expect(
      await stampSeen({ db, stepKey: `nope-${randomUUID()}`, attempt: 1 }),
    ).toBe(false);
  });

  it("11 a stamp blocked behind a committing fence returns false", async () => {
    const s = await newStep(null, null);
    await s.next();
    const holder = await holdAndCommit((tx) =>
      tx
        .update(cellStep)
        .set({ currentAttempt: 2, lastSeenAt: sql`now()` })
        .where(eq(cellStep.stepKey, s.stepKey)),
    );
    const stamp = stampSeen({ db, stepKey: s.stepKey, attempt: 1 });
    try {
      await waitUntilBlocked();
    } finally {
      holder.release();
    }
    await holder.done;
    expect(await stamp).toBe(false);
    expect((await row(s.stepKey)).currentAttempt).toBe(2);
  });

  it("10a a NULL lease is never granted by a stamp", async () => {
    const s = await newStep();
    await s.open(1);
    expect(await stampSeen({ db, stepKey: s.stepKey, attempt: 1 })).toBe(false);
    expect((await row(s.stepKey)).lastSeenAt).toBeNull();
  });

  it("rejects a non-positive attempt", async () => {
    await expect(stampSeen({ db, stepKey: "x", attempt: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("#656 PR-A finishStep", () => {
  it("12 revokes through the current attempt, sets done_at once, and is idempotent", async () => {
    const s = await newStep(null, null);
    await s.next();
    const b = await s.bearer(1);
    expect(await finishStep({ db, ...s.owner })).toBe(true);
    const first = await row(s.stepKey);
    expect(first.revokedThrough).toBe(1);
    expect(first.doneAt).not.toBeNull();
    expect((await verifyBearer({ db, token: b })).ok).toBe(false);
    expect(await finishStep({ db, ...s.owner })).toBe(true);
    expect((await row(s.stepKey)).doneAt).toEqual(first.doneAt);
    // Another org or thread's key is not finished.
    const other = await newStep(null, null);
    expect(
      await finishStep({
        db,
        ...s.owner,
        organizationId: other.organizationId,
      }),
    ).toBe(false);
    expect(await finishStep({ db, ...s.owner, threadId: other.threadId })).toBe(
      false,
    );
  });

  it("12a finish-before-open leaves a tombstone, so a late open is step_done", async () => {
    const s = await newStep(null, null);
    expect(await finishStep({ db, ...s.owner })).toBe(true);
    const r = await row(s.stepKey);
    expect(r.currentAttempt).toBe(0);
    expect(r.doneAt).not.toBeNull();
    expect(await s.next()).toEqual({ ok: false, reason: "step_done" });
    expect(
      await openNextAttempt({
        db,
        step: { ...s.step, allowedRef: "refs/heads/feat/x" },
      }),
    ).toEqual({ ok: false, reason: "step_done" });
    expect((await row(s.stepKey)).currentAttempt).toBe(0);
    expect(await stampSeen({ db, stepKey: s.stepKey, attempt: 1 })).toBe(false);
  });
});

describe("#656 PR-A deadCellAttempts", () => {
  async function matrix() {
    const fresh = await newStep(null, null);
    await fresh.next();
    const fenced = await newStep(null, null);
    await fenced.next();
    await fenced.next();
    const revoked = await newStep(null, null);
    await revoked.next();
    await revokeAttempt({ db, stepKey: revoked.stepKey, attempt: 1 });
    const done = await newStep(null, null);
    await done.next();
    await finishStep({ db, ...done.owner });
    const stale = await newStep(null, null);
    await stale.next();
    await backdate(stale.stepKey);
    const nul = await newStep();
    await nul.open(1);
    const unknown = `nope-${randomUUID()}`;
    const k = (stepKey: string, attempt: number) => ({ stepKey, attempt });
    const keys = [
      k(fresh.stepKey, 1),
      k(fenced.stepKey, 1),
      k(revoked.stepKey, 1),
      k(done.stepKey, 1),
      k(stale.stepKey, 1),
      k(nul.stepKey, 1),
      k(unknown, 1),
      k(fresh.stepKey, 2),
      k(fenced.stepKey, 1),
    ];
    return { keys, k, fenced, revoked, done, stale };
  }

  it("13 returns exactly the dead set, once each, in input order", async () => {
    const m = await matrix();
    const dead = await deadCellAttempts({
      db,
      keys: m.keys,
      staleMs: STALE_MS,
    });
    expect(dead).toEqual(
      new Set([
        cellKeyId(m.k(m.fenced.stepKey, 1)),
        cellKeyId(m.k(m.revoked.stepKey, 1)),
        cellKeyId(m.k(m.done.stepKey, 1)),
        cellKeyId(m.k(m.stale.stepKey, 1)),
      ]),
    );
  });

  it("14 staleMs null keeps the backdated current attempt", async () => {
    const m = await matrix();
    const dead = await deadCellAttempts({ db, keys: m.keys, staleMs: null });
    expect(dead).toEqual(
      new Set([
        cellKeyId(m.k(m.fenced.stepKey, 1)),
        cellKeyId(m.k(m.revoked.stepKey, 1)),
        cellKeyId(m.k(m.done.stepKey, 1)),
      ]),
    );
  });

  it("15 input bounds", async () => {
    expect(await deadCellAttempts({ db, keys: [], staleMs: STALE_MS })).toEqual(
      new Set(),
    );
    const key = { stepKey: "x", attempt: 1 };
    await expect(
      deadCellAttempts({
        db,
        keys: [{ ...key, attempt: 0 }],
        staleMs: STALE_MS,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      deadCellAttempts({ db, keys: [key], staleMs: Number.NaN }),
    ).rejects.toThrow(RangeError);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ stepKey: `k-${i}`, attempt: 1 }));
    await expect(
      deadCellAttempts({ db, keys: many(1001), staleMs: STALE_MS }),
    ).rejects.toThrow(RangeError);
    expect(
      await deadCellAttempts({ db, keys: many(1000), staleMs: STALE_MS }),
    ).toEqual(new Set());
  });

  it("15a a database error propagates", async () => {
    const broken = {
      select: () => {
        throw new Error("db down");
      },
    } as unknown as DB;
    await expect(
      deadCellAttempts({
        db: broken,
        keys: [{ stepKey: "x", attempt: 1 }],
        staleMs: STALE_MS,
      }),
    ).rejects.toThrow("db down");
  });
});

describe("#656 PR-A openStep lease", () => {
  it("16 advancing over a stamped row clears last_seen_at, and the attempt is kept", async () => {
    const s = await newStep();
    await s.open(1);
    await db
      .update(cellStep)
      .set({ lastSeenAt: sql`now() - interval '10 minutes'` })
      .where(eq(cellStep.stepKey, s.stepKey));
    await s.open(2);
    expect((await row(s.stepKey)).lastSeenAt).toBeNull();
    expect(
      await deadCellAttempts({
        db,
        keys: [{ stepKey: s.stepKey, attempt: 2 }],
        staleMs: STALE_MS,
      }),
    ).toEqual(new Set());
  });
});
