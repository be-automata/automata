import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

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

const db = createDb(env.DATABASE_URL!);

/** In-memory target: the marker set is the "remote" state. */
function memoryTarget(): EffectTarget<string> & {
  applied: string[];
  markers: Set<string>;
  failNextApply: boolean;
} {
  const target = {
    applied: [] as string[],
    markers: new Set<string>(),
    failNextApply: false,
    async apply(key: string, payload: string) {
      if (target.failNextApply) {
        target.failNextApply = false;
        throw new Error("apply failed");
      }
      target.applied.push(payload);
      target.markers.add(key);
    },
    async findByMarker(key: string) {
      return target.markers.has(key);
    },
  };
  return target;
}

async function newEffect(digest = "d1") {
  const organizationId = await createTestOrg({ db });
  const parts = {
    mission: `run-${randomUUID()}`,
    step: "summary",
    effect: "post",
    outputDigest: digest,
  };
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
      key: effectKey(parts),
      organizationId,
      ...parts,
    });
  };
  return { organizationId, parts, call, seedIntent, key: effectKey(parts) };
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
    const results = await Promise.all([e.call(target), e.call(target)]);
    expect(target.applied).toHaveLength(1);
    expect(results.map((r) => r.outcome).sort()).toEqual([
      "already_done",
      "applied",
    ]);
  });

  it("AC4: a new digest is a new key and a second effect", async () => {
    const first = await newEffect("d1");
    const target = memoryTarget();
    await first.call(target);
    const second = await runEffect({
      db,
      target,
      organizationId: first.organizationId,
      payload: "body2",
      ...first.parts,
      outputDigest: "d2",
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
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await tx
        .select()
        .from(controlEffects)
        .where(eq(controlEffects.key, e.key))
        .for("update");
      locked();
      await held;
    });
    await isLocked;
    const started = Date.now();
    await expect(e.call(target, { lockTimeoutMs: 200 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
    release();
    await holder;
    expect(target.applied).toEqual([]);
    expect((await readRow(e.key))?.doneAt).toBeNull();
  });

  it("rejects non-positive timeouts before touching the database", async () => {
    const e = await newEffect();
    await expect(
      e.call(memoryTarget(), { lockTimeoutMs: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(await readRow(e.key)).toBeUndefined();
  });
});
