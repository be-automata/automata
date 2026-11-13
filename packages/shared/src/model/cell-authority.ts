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
 *  2. revocation from the sweep                → `revokeAttempt`;
 *  3. an idempotency key on every effect       → `beginEffect` / `completeEffect`;
 *  4. an attempt fence                         → `openStep` (monotone lease) +
 *                                                `verifyBearer` (`fenced`);
 *  5. an effect budget per step                → reserved in `beginEffect`;
 *  6. a reconciler                             → uses `revokeAttempt` (separate PR).
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

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/**
 * Take the lease for `attempt`. Creates the step on the first attempt; a later
 * attempt replaces the current one only if it is newer, so a stale redelivery
 * can never take the lease back.
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
}): Promise<{ ok: true } | { ok: false; reason: "stale_attempt" }> {
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
      where: lt(cellStep.currentAttempt, step.attempt),
    })
    .returning({ stepKey: cellStep.stepKey });
  return rows[0] ? { ok: true } : { ok: false, reason: "stale_attempt" };
}

/** Mint a bearer for the CURRENT attempt. The token is returned once; only its hash is kept. */
export async function mintBearer({
  db,
  stepKey,
  attempt,
  ttlMs,
  now = new Date(),
}: {
  db: DB;
  stepKey: string;
  attempt: number;
  ttlMs: number;
  now?: Date;
}): Promise<
  | { ok: true; token: string; expiresAt: Date }
  | {
      ok: false;
      reason: "ttl_exceeds_step_timeout" | "fenced" | "unknown_step";
    }
> {
  const step = (
    await db
      .select({
        currentAttempt: cellStep.currentAttempt,
        stepTimeoutMs: cellStep.stepTimeoutMs,
      })
      .from(cellStep)
      .where(eq(cellStep.stepKey, stepKey))
      .limit(1)
  )[0];
  if (!step) return { ok: false, reason: "unknown_step" };
  if (step.currentAttempt !== attempt) return { ok: false, reason: "fenced" };
  if (ttlMs <= 0 || ttlMs > step.stepTimeoutMs) {
    return { ok: false, reason: "ttl_exceeds_step_timeout" };
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ttlMs);
  await db
    .insert(cellBearer)
    .values({ tokenHash: hashToken(token), stepKey, attempt, expiresAt });
  return { ok: true, token, expiresAt };
}

/** What a presented bearer may do right now, or why it may do nothing. */
export async function verifyBearer({
  db,
  token,
  now = new Date(),
}: {
  db: DB;
  token: string;
  now?: Date;
}): Promise<
  { ok: true; context: BearerContext } | { ok: false; reason: Refusal }
> {
  const row = (
    await db
      .select({
        stepKey: cellBearer.stepKey,
        attempt: cellBearer.attempt,
        expiresAt: cellBearer.expiresAt,
        revokedAt: cellBearer.revokedAt,
        currentAttempt: cellStep.currentAttempt,
        doneAt: cellStep.doneAt,
        organizationId: cellStep.organizationId,
        threadId: cellStep.threadId,
      })
      .from(cellBearer)
      .innerJoin(cellStep, eq(cellStep.stepKey, cellBearer.stepKey))
      .where(eq(cellBearer.tokenHash, hashToken(token)))
      .limit(1)
  )[0];
  if (!row) return { ok: false, reason: "unknown_bearer" };
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
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
  };
}

/** Revoke every bearer of one attempt (the sweep's first action). Returns how many it revoked. */
export async function revokeAttempt({
  db,
  stepKey,
  attempt,
  now = new Date(),
}: {
  db: DB;
  stepKey: string;
  attempt: number;
  now?: Date;
}): Promise<number> {
  const rows = await db
    .update(cellBearer)
    .set({ revokedAt: now })
    .where(
      and(
        eq(cellBearer.stepKey, stepKey),
        eq(cellBearer.attempt, attempt),
        isNull(cellBearer.revokedAt),
      ),
    )
    .returning({ tokenHash: cellBearer.tokenHash });
  return rows.length;
}

/**
 * Before performing an effect. Claims `idempotencyKey` for the step with a
 * create-only write and reserves one unit of the step's budget in the same
 * transaction, so two concurrent requests with the same key never both run the
 * effect. A key already completed answers `replay` with the stored result and
 * spends no budget.
 */
export async function beginEffect({
  db,
  token,
  idempotencyKey,
  now = new Date(),
}: {
  db: DB;
  token: string;
  idempotencyKey: string;
  now?: Date;
}): Promise<
  | { kind: "go"; context: BearerContext }
  | { kind: "replay"; result: Record<string, unknown> | null }
  | { kind: "refused"; reason: Refusal }
> {
  const verified = await verifyBearer({ db, token, now });
  if (!verified.ok) return { kind: "refused", reason: verified.reason };
  const ctx = verified.context;

  return db
    .transaction(async (tx) => {
      const claimed = await tx
        .insert(cellEffect)
        .values({ stepKey: ctx.stepKey, idempotencyKey, attempt: ctx.attempt })
        .onConflictDoNothing()
        .returning({ key: cellEffect.idempotencyKey });
      if (!claimed[0]) {
        const existing = (
          await tx
            .select({ result: cellEffect.result })
            .from(cellEffect)
            .where(
              and(
                eq(cellEffect.stepKey, ctx.stepKey),
                eq(cellEffect.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1)
        )[0];
        return existing?.result
          ? { kind: "replay" as const, result: existing.result }
          : { kind: "refused" as const, reason: "effect_in_progress" as const };
      }
      const reserved = await tx
        .update(cellStep)
        .set({ effectsUsed: sql`${cellStep.effectsUsed} + 1` })
        .where(
          and(
            eq(cellStep.stepKey, ctx.stepKey),
            eq(cellStep.currentAttempt, ctx.attempt),
            isNull(cellStep.doneAt),
            or(
              isNull(cellStep.effectBudget),
              lt(cellStep.effectsUsed, cellStep.effectBudget),
            ),
          ),
        )
        .returning({ used: cellStep.effectsUsed });
      if (!reserved[0]) {
        // Throwing rolls the claim back with the transaction: the key stays free.
        throw new BudgetExhausted();
      }
      return { kind: "go" as const, context: ctx };
    })
    .catch((e: unknown) => {
      if (e instanceof BudgetExhausted) {
        return {
          kind: "refused" as const,
          reason: "effect_budget_exhausted" as const,
        };
      }
      throw e;
    });
}

class BudgetExhausted extends Error {
  constructor() {
    super("effect budget exhausted for this step");
    this.name = "BudgetExhausted";
  }
}

/** After performing an effect: store its result so a repeat of the key replays it. */
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
        eq(cellEffect.stepKey, stepKey),
        eq(cellEffect.idempotencyKey, idempotencyKey),
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
  now = new Date(),
}: {
  db: DB;
  token: string;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; reason: Refusal }> {
  const verified = await verifyBearer({ db, token, now });
  if (!verified.ok) return { ok: false, reason: verified.reason };
  const rows = await db
    .update(cellStep)
    .set({ doneAttempt: verified.context.attempt, doneAt: now })
    .where(
      and(
        eq(cellStep.stepKey, verified.context.stepKey),
        eq(cellStep.currentAttempt, verified.context.attempt),
        isNull(cellStep.doneAt),
      ),
    )
    .returning({ stepKey: cellStep.stepKey });
  return rows[0] ? { ok: true } : { ok: false, reason: "step_done" };
}
