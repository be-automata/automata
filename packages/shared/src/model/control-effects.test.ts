import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { controlEffects } from "../db/schema";
import {
  ControlEffectKeyCollisionError,
  effectKey,
  runEffect,
  type EffectTarget,
} from "./control-effects";
import { createTestOrg } from "./test-helpers";

// Non-null: set by the shared globalSetup.
const db = createDb(env.DATABASE_URL!);

/** In-memory target: the marker set is the "remote" state. */
function memoryTarget() {
  const target = {
    applied: [] as string[],
    markers: new Set<string>(),
    failNextApply: false,
    failFind: false,
    gate: null as Promise<void> | null,
    signals: [] as AbortSignal[],
    honourSignal: false,
    async apply(key: string, payload: string, signal: AbortSignal) {
      target.signals.push(signal);
      if (target.gate) await target.gate;
      if (target.honourSignal) {
        await new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      }
      if (target.failNextApply) {
        target.failNextApply = false;
        throw new Error("apply failed");
      }
      target.applied.push(payload);
      target.markers.add(key);
    },
    async findByMarker(key: string) {
      if (target.failFind) throw new Error("find failed");
      return target.markers.has(key);
    },
  };
  return target satisfies EffectTarget<string>;
}

/** A promise with its resolver, for gating a step from the test. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Takes the row lock of `key` in its own transaction, runs `whileHeld`, then
 * holds it until `release()`; the transaction rolls back.
 */
async function holdLock(
  key: string,
  whileHeld: () => Promise<void> = async () => {},
) {
  const locked = deferred();
  const released = deferred();
  const done = db
    .transaction(async (tx) => {
      await tx
        .select()
        .from(controlEffects)
        .where(eq(controlEffects.key, key))
        .for("update");
      await whileHeld();
      locked.resolve();
      await released.promise;
      throw new Error("rollback");
    })
    .catch(() => undefined);
  await locked.promise;
  return { release: released.resolve, done };
}

async function newEffect(digest = "d1") {
  const organizationId = await createTestOrg({ db });
  const parts = {
    mission: `run-${randomUUID()}`,
    step: "summary",
    effect: "post",
    outputDigest: digest,
  };
  const key = effectKey(parts);
  const call = (target: EffectTarget<string>, extra = {}) =>
    runEffect({
      db,
      target,
      organizationId,
      payload: "body",
      ...parts,
      ...extra,
    });
  const seedIntent = async () => {
    await db.insert(controlEffects).values({
      key,
      organizationId,
      ...parts,
    });
  };
  return { organizationId, call, seedIntent, key };
}

/** Backends waiting on a lock (the delivery blocked behind a holder). */
async function lockWaiters(): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
  );
  return Number((result.rows[0] as { n: number }).n);
}

async function readRow(key: string) {
  const rows = await db
    .select()
    .from(controlEffects)
    .where(eq(controlEffects.key, key));
  return rows[0];
}

describe("effectKey", () => {
  const parts = { mission: "m", step: "s", effect: "e", outputDigest: "d" };

  it("is stable, 16 hex chars and sensitive to the digest", () => {
    expect(effectKey(parts)).toBe(effectKey({ ...parts }));
    expect(effectKey(parts)).toMatch(/^[0-9a-f]{16}$/);
    expect(effectKey({ ...parts, outputDigest: "d2" })).not.toBe(
      effectKey(parts),
    );
  });

  it("rejects an empty part and a part containing |", () => {
    expect(() => effectKey({ ...parts, step: "" })).toThrow(RangeError);
    expect(() => effectKey({ ...parts, mission: "a|b" })).toThrow(RangeError);
  });
});

describe("runEffect (#652 exactly-once control effects)", () => {
  it("applies once, then reports already_done without calling the target", async () => {
    const e = await newEffect();
    const target = memoryTarget();
    expect((await e.call(target)).outcome).toBe("applied");
    expect((await e.call(target)).outcome).toBe("already_done");
    expect(target.applied).toEqual(["body"]);
    const row = await readRow(e.key);
    expect(row?.doneAt).toBeInstanceOf(Date);
    expect(row?.reconciled).toBe(false);
  });

  it("reconciles an intent left behind when the marker is found", async () => {
    const e = await newEffect();
    const target = memoryTarget();
    await e.seedIntent();
    target.markers.add(e.key);
    expect((await e.call(target)).outcome).toBe("reconciled");
    expect(target.applied).toEqual([]);
    const row = await readRow(e.key);
    expect(row?.reconciled).toBe(true);
    expect(row?.doneAt).toBeInstanceOf(Date);
  });

  it("applies once when an intent was left and no marker exists", async () => {
    const e = await newEffect();
    const target = memoryTarget();
    await e.seedIntent();
    expect((await e.call(target)).outcome).toBe("applied");
    expect(target.applied).toEqual(["body"]);
    expect((await readRow(e.key))?.reconciled).toBe(false);
  });

  it("AC3: two concurrent deliveries produce one effect", async () => {
    const e = await newEffect();
    const target = memoryTarget();
    const gate = deferred();
    target.gate = gate.promise;
    const first = e.call(target);
    await vi.waitFor(() => expect(target.signals).toHaveLength(1));
    const second = e.call(target);
    await vi.waitFor(async () => expect(await lockWaiters()).toBe(1));
    gate.resolve();
    const results = await Promise.all([first, second]);
    expect(target.applied).toHaveLength(1);
    expect(results.map((r) => r.outcome)).toEqual(["applied", "already_done"]);
  });

  it("AC4: a new digest is a new key and a second effect", async () => {
    const first = await newEffect("d1");
    const target = memoryTarget();
    await first.call(target);
    const second = await first.call(target, {
      outputDigest: "d2",
      payload: "body2",
    });
    expect(second.outcome).toBe("applied");
    expect(second.key).not.toBe(first.key);
    expect(target.applied).toEqual(["body", "body2"]);
  });

  it("throws on a key collision before any target call", async () => {
    const e = await newEffect();
    const target = memoryTarget();
    await e.seedIntent();
    await db
      .update(controlEffects)
      .set({ effect: "other" })
      .where(eq(controlEffects.key, e.key));
    await expect(e.call(target)).rejects.toBeInstanceOf(
      ControlEffectKeyCollisionError,
    );
    expect(target.applied).toEqual([]);
  });

  it("leaves the intent when apply throws, and the next delivery applies", async () => {
    const e = await newEffect();
    const target = memoryTarget();
    target.failNextApply = true;
    await expect(e.call(target)).rejects.toThrow("apply failed");
    expect((await readRow(e.key))?.doneAt).toBeNull();
    expect((await e.call(target)).outcome).toBe("applied");
  });

  it("fails within lockTimeoutMs behind a held lock and keeps the intent", async () => {
    const e = await newEffect();
    const target = memoryTarget();
    await e.seedIntent();
    const holder = await holdLock(e.key);
    const started = Date.now();
    await expect(e.call(target, { lockTimeoutMs: 200 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
    holder.release();
    await holder.done;
    expect(target.applied).toEqual([]);
    expect((await readRow(e.key))?.doneAt).toBeNull();
  });

  it("rejects non-positive timeouts before touching the database", async () => {
    const e = await newEffect();
    for (const bad of [{ lockTimeoutMs: 0 }, { applyTimeoutMs: 0 }]) {
      await expect(e.call(memoryTarget(), bad)).rejects.toBeInstanceOf(
        RangeError,
      );
    }
    expect(await readRow(e.key)).toBeUndefined();
  });

  it("reconciles when a lock holder applied and rolled back while the delivery waited", async () => {
    const e = await newEffect();
    const target = memoryTarget();
    await e.seedIntent();
    const holder = await holdLock(e.key, () =>
      target.apply(e.key, "body", new AbortController().signal),
    );
    const delivery = e.call(target);
    await vi.waitFor(async () => expect(await lockWaiters()).toBe(1));
    holder.release();
    await holder.done;
    expect((await delivery).outcome).toBe("reconciled");
    expect(target.applied).toEqual(["body"]);
  });

  it("propagates a throwing findByMarker and leaves done_at null", async () => {
    const e = await newEffect();
    const target = memoryTarget();
    target.failFind = true;
    await expect(e.call(target)).rejects.toThrow("find failed");
    expect((await readRow(e.key))?.doneAt).toBeNull();
    expect(target.applied).toEqual([]);
  });

  it("hands apply a signal that aborts after applyTimeoutMs; the error propagates and the intent stays", async () => {
    const e = await newEffect();
    const target = memoryTarget();
    target.honourSignal = true;
    await expect(e.call(target, { applyTimeoutMs: 50 })).rejects.toBeDefined();
    expect(target.signals[0]?.aborted).toBe(true);
    expect((await readRow(e.key))?.doneAt).toBeNull();
  });
});
