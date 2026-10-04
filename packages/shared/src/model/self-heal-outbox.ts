import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import type { DB } from "../db";
import {
  auditEffects,
  auditRuns,
  selfHealBreaker,
  selfHealBreakerEvent,
} from "../db/schema";
import type { AuditEffectRow } from "./audit-findings";
import { withSelfHealTx, type SelfHealTx } from "./self-heal-tx";

/**
 * Effects outbox (OUTBOX-01): GitHub side effects an audit run decided on are
 * durable intent, keyed (run_id, fingerprint, action), drained under a lease so
 * two drainers never apply one effect. Postgres only; no isolate memory.
 *
 * MULTI-TENANT (ADR-001): every function takes `organizationId` except the ones
 * listed in UNFENCED_SELF_HEAL_MODEL_FUNCTIONS (self-heal-breaker.ts).
 */

export type EffectAction = AuditEffectRow["action"];

export interface EffectInput {
  findingId?: string | null;
  fingerprint: string;
  action: EffectAction;
  payload?: unknown;
}

/** Wait before attempt 2, 3, 4, 5; the 5th failure is terminal. */
export const OUTBOX_BACKOFF_MS: readonly number[] = [
  120_000, 600_000, 3_600_000, 21_600_000,
];

/** Total attempts before an effect is 'failed'. */
export const OUTBOX_MAX_ATTEMPTS = OUTBOX_BACKOFF_MS.length + 1;

const EFFECT_RETENTION_MS = 30 * 86_400_000;
const RUN_RETENTION_MS = 90 * 86_400_000;
const JITTER_MAX = 0.3;

export async function enqueueEffects({
  db,
  organizationId,
  repoFullName,
  runId,
  effects,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  runId: string;
  effects: EffectInput[];
  now?: Date;
}): Promise<number> {
  if (effects.length === 0) return 0;
  return withSelfHealTx(db, async (tx) => {
    const rows = await tx
      .insert(auditEffects)
      .values(
        effects.map((e) => ({
          organizationId,
          repoFullName: repoFullName.toLowerCase(),
          runId,
          findingId: e.findingId ?? null,
          fingerprint: e.fingerprint,
          action: e.action,
          payload: e.payload ?? null,
          status: "pending" as const,
          pendingSince: now,
          nextAttemptAt: now,
        })),
      )
      .onConflictDoNothing({
        target: [
          auditEffects.runId,
          auditEffects.fingerprint,
          auditEffects.action,
        ],
      })
      .returning({ id: auditEffects.id });
    return rows.length;
  });
}

/** Due = pending, attempt time reached, no live lease. */
function dueWhere(now: Date) {
  return and(
    eq(auditEffects.status, "pending"),
    lte(auditEffects.nextAttemptAt, now),
    or(isNull(auditEffects.leaseUntil), lt(auditEffects.leaseUntil, now)),
  );
}

/**
 * UNFENCED: the cron drainer works across orgs. Rows whose org has a
 * github_write breaker with a future rate_limited_until are not due (the
 * Retry-After horizon, honoured across isolates). The exclusion is org-wide:
 * the breaker row is the only per-installation state and a row carries no
 * installation id. Returned rows carry organizationId; callers re-fence.
 */
export async function claimDueEffects({
  db,
  now = new Date(),
  limit = 20,
  leaseMs = 60_000,
}: {
  db: DB;
  now?: Date;
  limit?: number;
  leaseMs?: number;
}): Promise<AuditEffectRow[]> {
  return withSelfHealTx(db, async (tx) => {
    const picked = await tx
      .select({ id: auditEffects.id })
      .from(auditEffects)
      .where(
        and(
          dueWhere(now),
          notRateLimited(tx, now, auditEffects.organizationId),
        ),
      )
      .orderBy(auditEffects.nextAttemptAt, auditEffects.id)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (picked.length === 0) return [];
    return tx
      .update(auditEffects)
      .set({ leaseUntil: new Date(now.getTime() + leaseMs) })
      .where(
        inArray(
          auditEffects.id,
          picked.map((r) => r.id),
        ),
      )
      .returning();
  });
}

/**
 * NOT EXISTS a github_write breaker for the org with a future horizon. Built
 * with the query builder so the Date goes through the column's encoder (a raw
 * sql param is serialised in the process timezone and mis-compares against a
 * timestamp-without-tz column).
 */
function notRateLimited(
  tx: SelfHealTx,
  now: Date,
  org: string | typeof auditEffects.organizationId,
) {
  return notExists(
    tx
      .select({ one: sql`1` })
      .from(selfHealBreaker)
      .where(
        and(
          eq(selfHealBreaker.organizationId, org),
          eq(selfHealBreaker.scopeKind, "github_write"),
          gt(selfHealBreaker.rateLimitedUntil, now),
        ),
      ),
  );
}

/** Fenced variant for the run-finish hook: drains one run's due effects. */
export async function claimDueEffectsForRun({
  db,
  organizationId,
  runId,
  now = new Date(),
  leaseMs = 60_000,
  limit = 20,
}: {
  db: DB;
  organizationId: string;
  runId: string;
  now?: Date;
  leaseMs?: number;
  limit?: number;
}): Promise<AuditEffectRow[]> {
  return withSelfHealTx(db, async (tx) => {
    const picked = await tx
      .select({ id: auditEffects.id })
      .from(auditEffects)
      .where(
        and(
          eq(auditEffects.organizationId, organizationId),
          eq(auditEffects.runId, runId),
          dueWhere(now),
          notRateLimited(tx, now, organizationId),
        ),
      )
      .orderBy(auditEffects.nextAttemptAt, auditEffects.id)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (picked.length === 0) return [];
    return tx
      .update(auditEffects)
      .set({ leaseUntil: new Date(now.getTime() + leaseMs) })
      .where(
        and(
          eq(auditEffects.organizationId, organizationId),
          inArray(
            auditEffects.id,
            picked.map((r) => r.id),
          ),
        ),
      )
      .returning();
  });
}

export async function markEffectApplied({
  db,
  organizationId,
  id,
  appliedAt = new Date(),
}: {
  db: DB;
  organizationId: string;
  id: string;
  appliedAt?: Date;
}): Promise<void> {
  await withSelfHealTx(db, async (tx) => {
    await tx
      .update(auditEffects)
      .set({
        status: "applied",
        appliedAt,
        leaseUntil: null,
        lastError: null,
      })
      .where(
        and(
          eq(auditEffects.id, id),
          eq(auditEffects.organizationId, organizationId),
        ),
      );
  });
}

export async function markEffectFailed({
  db,
  organizationId,
  id,
  error,
}: {
  db: DB;
  organizationId: string;
  id: string;
  /** Already redacted by the caller. */
  error: string;
}): Promise<void> {
  await withSelfHealTx(db, async (tx) => {
    await tx
      .update(auditEffects)
      .set({ status: "failed", leaseUntil: null, lastError: error })
      .where(
        and(
          eq(auditEffects.id, id),
          eq(auditEffects.organizationId, organizationId),
        ),
      );
  });
}

/**
 * Record a failed attempt. Attempts 1..4 reschedule on OUTBOX_BACKOFF_MS with
 * 0-30% jitter (`rand` in [0,1) injected for tests); the 5th is terminal.
 * Returns the resulting status.
 */
export async function markEffectRetry({
  db,
  organizationId,
  id,
  error,
  now = new Date(),
  rand = Math.random,
}: {
  db: DB;
  organizationId: string;
  id: string;
  /** Already redacted by the caller. */
  error: string;
  now?: Date;
  rand?: () => number;
}): Promise<"pending" | "failed"> {
  return withSelfHealTx(db, async (tx) => {
    const [row] = await tx
      .select({ attempts: auditEffects.attempts })
      .from(auditEffects)
      .where(
        and(
          eq(auditEffects.id, id),
          eq(auditEffects.organizationId, organizationId),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) return "failed";
    const attempts = row.attempts + 1;
    const base = OUTBOX_BACKOFF_MS[attempts - 1];
    if (base === undefined) {
      await tx
        .update(auditEffects)
        .set({
          status: "failed",
          attempts,
          leaseUntil: null,
          lastError: error,
        })
        .where(eq(auditEffects.id, id));
      return "failed";
    }
    const delay = Math.round(base * (1 + JITTER_MAX * rand()));
    await tx
      .update(auditEffects)
      .set({
        attempts,
        leaseUntil: null,
        lastError: error,
        nextAttemptAt: new Date(now.getTime() + delay),
      })
      .where(eq(auditEffects.id, id));
    return "pending";
  });
}

/** Fingerprints that already have a pending (possibly leased) create_issue. */
export async function listPendingCreateFingerprints({
  db,
  organizationId,
  repoFullName,
  limit = 1000,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  limit?: number;
}): Promise<Set<string>> {
  const rows = await db
    .select({ fingerprint: auditEffects.fingerprint })
    .from(auditEffects)
    .where(
      and(
        eq(auditEffects.organizationId, organizationId),
        eq(auditEffects.repoFullName, repoFullName.toLowerCase()),
        eq(auditEffects.action, "create_issue"),
        eq(auditEffects.status, "pending"),
      ),
    )
    .limit(limit);
  return new Set(rows.map((r) => r.fingerprint));
}

/**
 * UNFENCED retention sweep. Applied/failed outbox rows and breaker events
 * older than 30 days, finished audit runs older than 90 days, each in a
 * bounded batch. Pending rows are never pruned.
 */
export async function pruneSelfHealRows({
  db,
  now = new Date(),
  batch = 500,
}: {
  db: DB;
  now?: Date;
  batch?: number;
}): Promise<{ effects: number; events: number; runs: number }> {
  const effectCut = new Date(now.getTime() - EFFECT_RETENTION_MS);
  const runCut = new Date(now.getTime() - RUN_RETENTION_MS);
  return withSelfHealTx(db, async (tx) => {
    const effects = await tx
      .delete(auditEffects)
      .where(
        inArray(
          auditEffects.id,
          tx
            .select({ id: auditEffects.id })
            .from(auditEffects)
            .where(
              and(
                inArray(auditEffects.status, ["applied", "failed"]),
                lt(auditEffects.updatedAt, effectCut),
              ),
            )
            .limit(batch),
        ),
      )
      .returning({ id: auditEffects.id });
    const events = await tx
      .delete(selfHealBreakerEvent)
      .where(
        inArray(
          selfHealBreakerEvent.id,
          tx
            .select({ id: selfHealBreakerEvent.id })
            .from(selfHealBreakerEvent)
            .where(lt(selfHealBreakerEvent.createdAt, effectCut))
            .limit(batch),
        ),
      )
      .returning({ id: selfHealBreakerEvent.id });
    const runs = await tx
      .delete(auditRuns)
      .where(
        inArray(
          auditRuns.id,
          tx
            .select({ id: auditRuns.id })
            .from(auditRuns)
            .where(
              and(
                inArray(auditRuns.status, ["done", "failed"]),
                lt(auditRuns.finishedAt, runCut),
              ),
            )
            .limit(batch),
        ),
      )
      .returning({ id: auditRuns.id });
    return {
      effects: effects.length,
      events: events.length,
      runs: runs.length,
    };
  });
}
