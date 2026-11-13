import { createHash, randomBytes } from "node:crypto";

import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import { DB } from "../db";
import { cellBearer, cellEffect, cellStep } from "../db/schema";

/**
 * Durable authority for remote cells (ADR-014, "Remote cells cannot rely on the
 * worker heap"). A remote cell outlives the worker that started it, so the
 * broker keeps its state here. The six requirements map to:
 *
 *  1. bearer TTL bounded by the step timeout   → `mintBearer` refuses a longer TTL;
 *  2. revocation from the sweep                → `revokeAttempt`, recorded on the
 *                                                step so it also covers bearers
 *                                                that were never minted;
 *  3. an idempotency key on every effect       → `beginEffect` / `completeEffect`;
 *  4. an attempt fence                         → `openStep` (monotone lease) +
 *                                                the bearer check under the step
 *                                                lock in `beginEffect`;
 *  5. an effect budget per step                → reserved in `beginEffect`;
 *  6. a reconciler                             → uses `revokeAttempt` (L3 PR 3).
 *
 * Contract notes:
 *  - `stepKey` is the engine's identity for a step and is globally unique; a step
 *    is only ever re-opened by the same organization and thread.
 *  - Times (bearer expiry) use the database clock, never the caller's.
 *  - The effect budget for a remote-cell step is set by the caller (the broker
 *    routes, L3 PR 2, derive it from the run type); null means unlimited and is
 *    for box steps only.
 *  - A pending claim held by the CURRENT attempt is not recoverable within that
 *    attempt (a broker crash between begin and complete); a new attempt takes it
 *    over, and the reconciler (L3 PR 3) is the backstop.
 *
 * Behaviour proven first in spike 033 (scenarios s3, s4b, s4d).
 */

export type Refusal =
  | "unknown_bearer"
  | "revoked"
  | "expired"
  | "fenced"
  | "step_done"
  | "effect_budget_exhausted"
  | "effect_in_progress";

export interface BearerContext {
  stepKey: string;
  attempt: number;
  organizationId: string;
  threadId: string;
}

type Executor = Pick<DB, "select">;

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const effectKey = (stepKey: string, idempotencyKey: string) =>
  and(
    eq(cellEffect.stepKey, stepKey),
    eq(cellEffect.idempotencyKey, idempotencyKey),
  );

function assertPositiveInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

const isRevoked = (attempt: number, revokedThrough: number | null): boolean =>
  revokedThrough !== null && attempt <= revokedThrough;

/**
 * Take the lease for `attempt`. Creates the step on the first attempt; a newer
 * attempt replaces the current one. Re-opening with the attempt that already
 * holds the lease is a no-op success (a restarted worker re-opening its own
 * attempt). A stale or revoked attempt, a finished step, or a step that belongs
 * to another organization or thread is refused.
 */
export async function openStep({
  db,
  step,
}: {
  db: DB;
  step: {
    stepKey: string;
    organizationId: string;
    threadId: string;
    attempt: number;
    stepTimeoutMs: number;
    effectBudget: number | null;
  };
}): Promise<
  | { ok: true }
  | {
      ok: false;
      reason: "stale_attempt" | "step_done" | "conflict" | "revoked";
    }
> {
  assertPositiveInt("attempt", step.attempt);
  assertPositiveInt("stepTimeoutMs", step.stepTimeoutMs);
  if (
    step.effectBudget !== null &&
    (!Number.isInteger(step.effectBudget) || step.effectBudget < 0)
  ) {
    throw new RangeError("effectBudget must be null or a non-negative integer");
  }
  const rows = await db
    .insert(cellStep)
    .values({
      stepKey: step.stepKey,
      organizationId: step.organizationId,
      threadId: step.threadId,
      currentAttempt: step.attempt,
      stepTimeoutMs: step.stepTimeoutMs,
      effectBudget: step.effectBudget,
    })
    .onConflictDoUpdate({
      target: cellStep.stepKey,
      set: { currentAttempt: step.attempt },
      where: and(
        lt(cellStep.currentAttempt, step.attempt),
        isNull(cellStep.doneAt),
        or(
          isNull(cellStep.revokedThrough),
          lt(cellStep.revokedThrough, step.attempt),
        ),
        eq(cellStep.organizationId, step.organizationId),
        eq(cellStep.threadId, step.threadId),
      ),
    })
    .returning({ stepKey: cellStep.stepKey });
  if (rows[0]) return { ok: true };

  const existing = (
    await db
      .select({
        currentAttempt: cellStep.currentAttempt,
        doneAt: cellStep.doneAt,
        revokedThrough: cellStep.revokedThrough,
        organizationId: cellStep.organizationId,
        threadId: cellStep.threadId,
      })
      .from(cellStep)
      .where(eq(cellStep.stepKey, step.stepKey))
      .limit(1)
  )[0];
  if (
    !existing ||
    existing.organizationId !== step.organizationId ||
    existing.threadId !== step.threadId
  ) {
    return { ok: false, reason: "conflict" };
  }
  if (existing.doneAt) return { ok: false, reason: "step_done" };
  if (isRevoked(step.attempt, existing.revokedThrough)) {
    return { ok: false, reason: "revoked" };
  }
  if (existing.currentAttempt === step.attempt) return { ok: true };
  return { ok: false, reason: "stale_attempt" };
}

/**
 * Mint a bearer for the CURRENT attempt. The token is returned once; only its
 * hash is kept. Refused for a TTL above the step timeout, a fenced or revoked
 * attempt, and a finished step.
 */
export async function mintBearer({
  db,
  stepKey,
  attempt,
  ttlMs,
}: {
  db: DB;
  stepKey: string;
  attempt: number;
  ttlMs: number;
}): Promise<
  | { ok: true; token: string; expiresAt: Date }
  | {
      ok: false;
      reason:
        | "ttl_exceeds_step_timeout"
        | "fenced"
        | "unknown_step"
        | "step_done"
        | "revoked";
    }
> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("ttlMs must be a positive finite number");
  }
  const step = (
    await db
      .select({
        currentAttempt: cellStep.currentAttempt,
        stepTimeoutMs: cellStep.stepTimeoutMs,
        revokedThrough: cellStep.revokedThrough,
        doneAt: cellStep.doneAt,
      })
      .from(cellStep)
      .where(eq(cellStep.stepKey, stepKey))
      .limit(1)
  )[0];
  if (!step) return { ok: false, reason: "unknown_step" };
  if (step.doneAt) return { ok: false, reason: "step_done" };
  if (isRevoked(attempt, step.revokedThrough)) {
    return { ok: false, reason: "revoked" };
  }
  if (step.currentAttempt !== attempt) return { ok: false, reason: "fenced" };
  if (ttlMs > step.stepTimeoutMs) {
    return { ok: false, reason: "ttl_exceeds_step_timeout" };
  }
  const token = randomBytes(32).toString("base64url");
  const inserted = await db
    .insert(cellBearer)
    .values({
      tokenHash: hashToken(token),
      stepKey,
      attempt,
      expiresAt: sql`now() + make_interval(secs => ${ttlMs / 1000})`,
    })
    .returning({ expiresAt: cellBearer.expiresAt });
  const expiresAt = inserted[0]?.expiresAt;
  if (!expiresAt) throw new Error("bearer insert returned no row");
  return { ok: true, token, expiresAt };
}

/**
 * Resolve a bearer against its step. With `lock`, the step row is locked
 * (`FOR UPDATE`) for the rest of the caller's transaction, so a concurrent
 * `openStep`, `revokeAttempt` or `markStepDone` serializes behind it.
 */
async function resolveBearer(
  executor: Executor,
  token: string,
  lock: boolean,
): Promise<
  | {
      ok: true;
      context: BearerContext;
      effectBudget: number | null;
      effectsUsed: number;
    }
  | { ok: false; reason: Refusal }
> {
  const query = executor
    .select({
      stepKey: cellBearer.stepKey,
      attempt: cellBearer.attempt,
      expired: sql<boolean>`${cellBearer.expiresAt} <= now()`,
      currentAttempt: cellStep.currentAttempt,
      revokedThrough: cellStep.revokedThrough,
      doneAt: cellStep.doneAt,
      effectBudget: cellStep.effectBudget,
      effectsUsed: cellStep.effectsUsed,
      organizationId: cellStep.organizationId,
      threadId: cellStep.threadId,
    })
    .from(cellBearer)
    .innerJoin(cellStep, eq(cellStep.stepKey, cellBearer.stepKey))
    .where(eq(cellBearer.tokenHash, hashToken(token)))
    .limit(1);
  const row = (
    lock ? await query.for("update", { of: cellStep }) : await query
  )[0];
  if (!row) return { ok: false, reason: "unknown_bearer" };
  if (isRevoked(row.attempt, row.revokedThrough)) {
    return { ok: false, reason: "revoked" };
  }
  if (row.expired) return { ok: false, reason: "expired" };
  if (row.currentAttempt !== row.attempt)
    return { ok: false, reason: "fenced" };
  if (row.doneAt) return { ok: false, reason: "step_done" };
  return {
    ok: true,
    context: {
      stepKey: row.stepKey,
      attempt: row.attempt,
      organizationId: row.organizationId,
      threadId: row.threadId,
    },
    effectBudget: row.effectBudget,
    effectsUsed: row.effectsUsed,
  };
}

/** What a presented bearer may do right now, or why it may do nothing. */
export async function verifyBearer({
  db,
  token,
}: {
  db: DB;
  token: string;
}): Promise<
  { ok: true; context: BearerContext } | { ok: false; reason: Refusal }
> {
  const r = await resolveBearer(db, token, false);
  return r.ok ? { ok: true, context: r.context } : r;
}

/**
 * Revoke one attempt and every older one (the sweep's verdict that they are
 * dead). Recorded on the step, so it also covers bearers never minted. The
 * current attempt can be revoked too. It is capped at the current attempt, so a
 * future attempt is never revoked in advance.
 */
export async function revokeAttempt({
  db,
  stepKey,
  attempt,
}: {
  db: DB;
  stepKey: string;
  attempt: number;
}): Promise<boolean> {
  assertPositiveInt("attempt", attempt);
  const rows = await db
    .update(cellStep)
    .set({
      revokedThrough: sql`greatest(coalesce(${cellStep.revokedThrough}, 0), least(${attempt}::integer, ${cellStep.currentAttempt}))`,
    })
    .where(eq(cellStep.stepKey, stepKey))
    .returning({ stepKey: cellStep.stepKey });
  return rows.length === 1;
}

/**
 * Before performing an effect. In one transaction, with the step row locked by
 * the bearer check (so every call for a step runs one at a time):
 *  1. refuse an unknown, revoked, expired or fenced bearer, or a finished step;
 *  2. a completed key replays its stored result (no budget);
 *  3. a pending claim left by an OLDER attempt is taken over (no budget: the
 *     claim already spent its unit);
 *  4. a pending claim of this attempt is `effect_in_progress`;
 *  5. otherwise reserve one budget unit and claim the key.
 * The older attempt in (3) may have performed the effect before dying: that
 * window is at-least-once, and the effect's own key must tolerate it.
 */
export async function beginEffect({
  db,
  token,
  idempotencyKey,
}: {
  db: DB;
  token: string;
  idempotencyKey: string;
}): Promise<
  | { kind: "go"; context: BearerContext }
  | { kind: "replay"; result: Record<string, unknown> }
  | { kind: "refused"; reason: Refusal }
> {
  return db.transaction(async (tx) => {
    const bearer = await resolveBearer(tx, token, true);
    if (!bearer.ok) return { kind: "refused", reason: bearer.reason };
    const ctx = bearer.context;

    const existing = (
      await tx
        .select({ result: cellEffect.result, attempt: cellEffect.attempt })
        .from(cellEffect)
        .where(effectKey(ctx.stepKey, idempotencyKey))
        .limit(1)
    )[0];
    if (existing?.result) return { kind: "replay", result: existing.result };
    if (existing && existing.attempt < ctx.attempt) {
      await tx
        .update(cellEffect)
        .set({ attempt: ctx.attempt })
        .where(effectKey(ctx.stepKey, idempotencyKey));
      return { kind: "go", context: ctx };
    }
    if (existing) return { kind: "refused", reason: "effect_in_progress" };

    if (
      bearer.effectBudget !== null &&
      bearer.effectsUsed >= bearer.effectBudget
    ) {
      return { kind: "refused", reason: "effect_budget_exhausted" };
    }
    await tx
      .update(cellStep)
      .set({ effectsUsed: sql`${cellStep.effectsUsed} + 1` })
      .where(eq(cellStep.stepKey, ctx.stepKey));
    await tx
      .insert(cellEffect)
      .values({ stepKey: ctx.stepKey, idempotencyKey, attempt: ctx.attempt });
    return { kind: "go", context: ctx };
  });
}

/**
 * After performing an effect: store its result so a repeat of the key replays
 * it. Only the attempt that holds the claim can store it (a taken-over claim
 * refuses the older attempt). It takes no bearer: the broker route that calls it
 * has already verified the request's bearer with `beginEffect`.
 */
export async function completeEffect({
  db,
  stepKey,
  idempotencyKey,
  attempt,
  result,
}: {
  db: DB;
  stepKey: string;
  idempotencyKey: string;
  attempt: number;
  result: Record<string, unknown>;
}): Promise<boolean> {
  const rows = await db
    .update(cellEffect)
    .set({ result })
    .where(
      and(
        effectKey(stepKey, idempotencyKey),
        eq(cellEffect.attempt, attempt),
        isNull(cellEffect.result),
      ),
    )
    .returning({ key: cellEffect.idempotencyKey });
  return rows.length === 1;
}

/** The current attempt reports the step finished. A fenced (zombie) attempt is refused. */
export async function markStepDone({
  db,
  token,
}: {
  db: DB;
  token: string;
}): Promise<{ ok: true } | { ok: false; reason: Refusal }> {
  return db.transaction(async (tx) => {
    const bearer = await resolveBearer(tx, token, true);
    if (!bearer.ok) return { ok: false, reason: bearer.reason };
    await tx
      .update(cellStep)
      .set({ doneAt: sql`now()` })
      .where(eq(cellStep.stepKey, bearer.context.stepKey));
    return { ok: true };
  });
}
