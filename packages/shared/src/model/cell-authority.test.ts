import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { cellStep } from "../db/schema";
import {
  beginEffect,
  completeEffect,
  markStepDone,
  mintBearer,
  openStep,
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

async function newStep(effectBudget: number | null = null) {
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
      },
    });
  const bearer = async (attempt: number) => {
    const m = await mintBearer({ db, stepKey, attempt, ttlMs: STEP_TIMEOUT });
    if (!m.ok) throw new Error(m.reason);
    return m.token;
  };
  return { stepKey, open, bearer };
}

async function effectsUsed(stepKey: string): Promise<number> {
  const rows = await db
    .select({ used: cellStep.effectsUsed })
    .from(cellStep)
    .where(eq(cellStep.stepKey, stepKey));
  return rows[0]?.used ?? -1;
}

describe("cell authority (ADR-014 remote cells)", () => {
  it("lease is monotone: a newer attempt takes it, a stale redelivery never takes it back", async () => {
    const s = await newStep();
    expect(await s.open(1)).toEqual({ ok: true });
    expect(await s.open(2)).toEqual({ ok: true });
    expect(await s.open(1)).toEqual({ ok: false, reason: "stale_attempt" });
    expect(await s.open(2)).toEqual({ ok: false, reason: "stale_attempt" });
  });

  it("refuses a bearer whose TTL exceeds the step timeout, or for a fenced attempt", async () => {
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
    await s.open(2);
    expect(
      await mintBearer({ db, stepKey: s.stepKey, attempt: 1, ttlMs: 1000 }),
    ).toEqual({ ok: false, reason: "fenced" });
  });

  it("s4d: the attempt fence alone stops a zombie once a newer attempt holds the lease", async () => {
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

  it("s3: a redelivered attempt that repeats a key gets the stored result, not a second effect", async () => {
    const s = await newStep();
    await s.open(1);
    const first = await s.bearer(1);
    const go = await beginEffect({
      db,
      token: first,
      idempotencyKey: "push-main-abc123",
    });
    expect(go.kind).toBe("go");
    expect(
      await completeEffect({
        db,
        stepKey: s.stepKey,
        idempotencyKey: "push-main-abc123",
        attempt: 1,
        result: { pushed: "abc123" },
      }),
    ).toBe(true);
    await s.open(2);
    const second = await s.bearer(2);
    expect(
      await beginEffect({
        db,
        token: second,
        idempotencyKey: "push-main-abc123",
      }),
    ).toEqual({ kind: "replay", result: { pushed: "abc123" } });
    expect(await effectsUsed(s.stepKey)).toBe(1);
  });

  it("s4b: an effect budget of 1 lets one effect through and refuses the zombie's new keys", async () => {
    const s = await newStep(1);
    await s.open(1);
    const zombie = await s.bearer(1);
    const results = [];
    for (const k of ["e1", "e2", "e3", "e4", "e5", "e6"])
      results.push(
        (await beginEffect({ db, token: zombie, idempotencyKey: k })).kind,
      );
    expect(results).toEqual([
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
  });

  it("two concurrent requests with the same key: one runs, the other is told it is in progress", async () => {
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

  it("revoked and expired bearers are refused", async () => {
    const s = await newStep();
    await s.open(1);
    const t = await s.bearer(1);
    expect(
      await verifyBearer({
        db,
        token: t,
        now: new Date(Date.now() + STEP_TIMEOUT + 1),
      }),
    ).toEqual({ ok: false, reason: "expired" });
    expect(await revokeAttempt({ db, stepKey: s.stepKey, attempt: 1 })).toBe(1);
    expect(await verifyBearer({ db, token: t })).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(await verifyBearer({ db, token: "not-a-token" })).toEqual({
      ok: false,
      reason: "unknown_bearer",
    });
  });

  it("only the current attempt can finish the step; after that no bearer acts", async () => {
    const s = await newStep();
    await s.open(1);
    const zombie = await s.bearer(1);
    await s.open(2);
    const current = await s.bearer(2);
    expect(await markStepDone({ db, token: zombie })).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(await markStepDone({ db, token: current })).toEqual({ ok: true });
    expect(await markStepDone({ db, token: current })).toEqual({
      ok: false,
      reason: "step_done",
    });
    expect(
      await beginEffect({ db, token: current, idempotencyKey: "late" }),
    ).toEqual({ kind: "refused", reason: "step_done" });
  });
});
