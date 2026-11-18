import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { cellKeyId, type CellKey } from "@terragon/types/cell";
import { isBranchRef } from "@terragon/utils/receive-pack-refs";

import { DB } from "../db";
import { cellBearer, cellEffect, cellStep } from "../db/schema";
import { assertPositiveInt } from "../utils";
import { hashOpaqueToken, mintOpaqueToken } from "../utils/opaque-token";
import type { SelfHealTx } from "./self-heal-tx";

/**
 * Durable authority for remote cells (ADR-014, "Remote cells cannot rely on the
 * worker heap"). A remote cell outlives the worker that started it, so the
 * broker keeps its state here. The six requirements map to:
 *
 *  1. bearer TTL bounded by the step timeout   → `mintBearer` refuses a longer TTL;
 *  2. revocation from the sweep                → `revokeAttempt`, recorded on the
 *                                                step so it also covers bearers
 *                                                that were never minted;
 *  3. an idempotency key on every effect       → `beginEffect` / `completeEffect`
 *                                                (`releaseEffect` drops a claim that
 *                                                never got an answer);
 *  4. an attempt fence                         → `openNextAttempt` (server-assigned,
 *                                                monotone lease; `openStep` is the
 *                                                caller-chosen fixture form) + the
 *                                                bearer check under the step lock
 *                                                in `beginEffect`;
 *  5. an effect budget per step                → reserved in `beginEffect`;
 *  6. a reconciler                             → uses `revokeAttempt` and reads
 *                                                `deadCellAttempts` (#656).
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
  /** The one ref the step may push (`refs/heads/<name>`); null = it does not push. */
  allowedRef: string | null;
}

type Executor = Pick<DB, "select">;

const effectKey = (stepKey: string, idempotencyKey: string) =>
  and(
    eq(cellEffect.stepKey, stepKey),
    eq(cellEffect.idempotencyKey, idempotencyKey),
  );

const isRevoked = (attempt: number, revokedThrough: number | null): boolean =>
  revokedThrough !== null && attempt <= revokedThrough;

/** The most attempts one cell step may open. */
export const CELL_MAX_ATTEMPTS = 1000;
const DEAD_READ_MAX_KEYS = 1000;

function assertStepShape(step: {
  stepTimeoutMs: number;
  effectBudget: number | null;
  allowedRef: string | null;
}): void {
  assertPositiveInt("stepTimeoutMs", step.stepTimeoutMs);
  if (
    step.effectBudget !== null &&
    (!Number.isInteger(step.effectBudget) || step.effectBudget < 0)
  ) {
    throw new RangeError("effectBudget must be null or a non-negative integer");
  }
  if (step.allowedRef !== null && !isBranchRef(step.allowedRef)) {
    throw new RangeError("allowedRef must be null or a refs/heads/ branch ref");
  }
}

/**
 * Explains an empty upsert: the shared refusals in one order. Org/thread
 * mismatch (or a vanished row) is a `conflict`, then a done step (a
 * finishStep tombstone has no ref to compare), then an `allowedRef` mismatch.
 * Otherwise the row is returned for the caller's own tail.
 */
async function classifyMiss(
  db: DB,
  step: {
    stepKey: string;
    organizationId: string;
    threadId: string;
    allowedRef: string | null;
  },
): Promise<
  | { reason: "conflict" | "step_done" }
  | { currentAttempt: number; revokedThrough: number | null }
> {
  const existing = (
    await db
      .select({
        currentAttempt: cellStep.currentAttempt,
        doneAt: cellStep.doneAt,
        revokedThrough: cellStep.revokedThrough,
        organizationId: cellStep.organizationId,
        threadId: cellStep.threadId,
        allowedRef: cellStep.allowedRef,
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
    return { reason: "conflict" };
  }
  if (existing.doneAt) return { reason: "step_done" };
  if (existing.allowedRef !== step.allowedRef) return { reason: "conflict" };
  return {
    currentAttempt: existing.currentAttempt,
    revokedThrough: existing.revokedThrough,
  };
}

/**
 * Take the lease for a CALLER-CHOSEN `attempt`. Creates the step on the first
 * attempt; a newer attempt replaces the current one. Re-opening with the attempt
 * that already holds the lease is a no-op success (a restarted worker re-opening
 * its own attempt). A stale or revoked attempt, a finished step, or a step that
 * belongs to another organization or thread is refused. It does not stamp the
 * lease: advancing clears `last_seen_at`, so a stale stamp never condemns the new
 * attempt. After #656 PR-C this is the fixture and spike primitive; production
 * opens through `openNextAttempt`, which chooses the attempt itself.
 *
 * Test-only: it does not clear `open_nonce`, so a nonce set by `openNextAttempt`
 * can still match after an `openStep` advance. Production opens through
 * `openNextAttempt`.
 *
 * `allowedRef` is the one ref (`refs/heads/<name>`) the step may push, or null
 * when it does not push. It is fixed for the life of the step: re-opening with a
 * different value (including null against a ref) is a `conflict`.
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
    allowedRef: string | null;
  };
}): Promise<
  | { ok: true }
  | {
      ok: false;
      reason: "stale_attempt" | "step_done" | "conflict" | "revoked";
    }
> {
  assertPositiveInt("attempt", step.attempt);
  assertStepShape(step);
  const rows = await db
    .insert(cellStep)
    .values({
      stepKey: step.stepKey,
      organizationId: step.organizationId,
      threadId: step.threadId,
      currentAttempt: step.attempt,
      stepTimeoutMs: step.stepTimeoutMs,
      effectBudget: step.effectBudget,
      allowedRef: step.allowedRef,
    })
    .onConflictDoUpdate({
      target: cellStep.stepKey,
      set: { currentAttempt: step.attempt, lastSeenAt: null },
      where: and(
        lt(cellStep.currentAttempt, step.attempt),
        isNull(cellStep.doneAt),
        or(
          isNull(cellStep.revokedThrough),
          lt(cellStep.revokedThrough, step.attempt),
        ),
        eq(cellStep.organizationId, step.organizationId),
        eq(cellStep.threadId, step.threadId),
        sql`${cellStep.allowedRef} IS NOT DISTINCT FROM ${step.allowedRef}`,
      ),
    })
    .returning({ stepKey: cellStep.stepKey });
  if (rows[0]) return { ok: true };

  const miss = await classifyMiss(db, step);
  if ("reason" in miss) return { ok: false, reason: miss.reason };
  if (isRevoked(step.attempt, miss.revokedThrough)) {
    return { ok: false, reason: "revoked" };
  }
  if (miss.currentAttempt === step.attempt) return { ok: true };
  return { ok: false, reason: "stale_attempt" };
}

const OPEN_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Open the next attempt of a step, numbered by the database (#656 R3): attempt 1
 * on first open, `current + 1` after. Stamps the lease (`last_seen_at = now()`).
 * Concurrent calls get distinct, consecutive attempts. Refused for a finished
 * step (`step_done`), another org/thread/`allowedRef` (`conflict`) and past
 * 1000 attempts (`attempt_limit`). Revocation does not block it: `finishStep`
 * is what ends a run. `stepTimeoutMs` and `effectBudget` are fixed at first open.
 *
 * Idempotent per `nonce` (#656 PR-C): a call whose `nonce` equals the nonce of
 * the open that made the current attempt returns that attempt, fences nothing,
 * does not count toward the cap, and answers `replayed: true` (the field is
 * absent otherwise). A nonce matches only the CURRENT attempt's open; a new
 * nonce advances the attempt and replaces the stored one. The caller mints the
 * replay's bearer with `mintBearer({ replaceOthers: { openSeq } })`, which kills
 * the earlier bearers of that attempt unless a newer open has happened. Every
 * open (advance or replay) bumps `open_seq` and returns it as `openSeq`. The open runs in one transaction under a
 * per-step advisory lock.
 */
export async function openNextAttempt({
  db,
  step,
}: {
  db: DB;
  step: {
    stepKey: string;
    organizationId: string;
    threadId: string;
    stepTimeoutMs: number;
    effectBudget: number | null;
    allowedRef: string | null;
    nonce: string;
  };
}): Promise<
  | { ok: true; attempt: number; openSeq: number; replayed?: true }
  | { ok: false; reason: "step_done" | "conflict" | "attempt_limit" }
> {
  assertStepShape(step);
  const { nonce } = step;
  if (!OPEN_NONCE_PATTERN.test(nonce)) {
    throw new RangeError("nonce must match ^[A-Za-z0-9_-]{16,64}$");
  }

  // RETURNING shows only the new row before Postgres 18, so the replay is read
  // first. The advisory lock serializes opens of one step, including the first
  // insert, which has no row to lock yet.
  const opened = await db.transaction(async (tx) => {
    await lockStep(tx, step.stepKey);
    const before = (
      await tx
        .select({ openNonce: cellStep.openNonce })
        .from(cellStep)
        .where(eq(cellStep.stepKey, step.stepKey))
        .for("update")
        .limit(1)
    )[0];
    const rows = await tx
      .insert(cellStep)
      .values({
        stepKey: step.stepKey,
        organizationId: step.organizationId,
        threadId: step.threadId,
        currentAttempt: 1,
        stepTimeoutMs: step.stepTimeoutMs,
        effectBudget: step.effectBudget,
        allowedRef: step.allowedRef,
        lastSeenAt: sql`now()`,
        openNonce: nonce,
        openSeq: 1,
      })
      .onConflictDoUpdate({
        target: cellStep.stepKey,
        set: {
          currentAttempt: sql`CASE WHEN ${cellStep.openNonce} = ${nonce} THEN ${cellStep.currentAttempt} ELSE ${cellStep.currentAttempt} + 1 END`,
          openNonce: nonce,
          openSeq: sql`${cellStep.openSeq} + 1`,
          lastSeenAt: sql`now()`,
        },
        where: and(
          isNull(cellStep.doneAt),
          eq(cellStep.organizationId, step.organizationId),
          eq(cellStep.threadId, step.threadId),
          sql`${cellStep.allowedRef} IS NOT DISTINCT FROM ${step.allowedRef}`,
          or(
            lt(cellStep.currentAttempt, CELL_MAX_ATTEMPTS),
            sql`${cellStep.openNonce} = ${nonce}`,
          ),
        ),
      })
      .returning({
        attempt: cellStep.currentAttempt,
        openSeq: cellStep.openSeq,
      });
    return {
      attempt: rows[0]?.attempt,
      openSeq: rows[0]?.openSeq,
      replayed: before !== undefined && before.openNonce === nonce,
    };
  });
  if (opened.attempt !== undefined && opened.openSeq !== undefined) {
    const { attempt, openSeq } = opened;
    return opened.replayed
      ? { ok: true, attempt, openSeq, replayed: true }
      : { ok: true, attempt, openSeq };
  }

  const miss = await classifyMiss(db, step);
  if ("reason" in miss) return { ok: false, reason: miss.reason };
  if (miss.currentAttempt >= CELL_MAX_ATTEMPTS) {
    return { ok: false, reason: "attempt_limit" };
  }
  // The upsert refused a row that classifyMiss reads as open, matching and
  // under the cap: a concurrent change between the two statements. Never
  // report it as attempt_limit.
  throw new Error(
    `openNextAttempt: step ${step.stepKey} was refused below the attempt cap (attempt ${miss.currentAttempt})`,
  );
}

/**
 * Renew the lease of `attempt` (database now()). True only when it is the
 * current attempt, neither revoked nor done, and already leased (a NULL lease
 * is never granted by a stamp: such a row is judged by revocation only). False
 * covers unknown, fenced, revoked, done and unleased steps: a fenced attempt's poll never
 * renews anything. Run as one autocommit statement, not inside a long transaction.
 */
export async function stampSeen({
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
    .set({ lastSeenAt: sql`now()` })
    .where(
      and(
        eq(cellStep.stepKey, stepKey),
        eq(cellStep.currentAttempt, attempt),
        isNull(cellStep.doneAt),
        isNotNull(cellStep.lastSeenAt),
        or(
          isNull(cellStep.revokedThrough),
          lt(cellStep.revokedThrough, attempt),
        ),
      ),
    )
    .returning({ stepKey: cellStep.stepKey });
  return rows.length > 0;
}

/**
 * Why a stamp was refused (#656 PR-E, Decision 12): `"superseded"` only when a
 * NEWER attempt exists (`current_attempt` > `attempt`), the one fact that fences
 * a worker; anything else (revoked through this attempt, done, no lease, an
 * unknown step) is `"refused"`. One read of `cell_step` by key, run only after
 * `stampSeen` returned false. `stampSeen`'s boolean contract is unchanged.
 */
export async function leaseRefusal({
  db,
  stepKey,
  attempt,
}: {
  db: DB;
  stepKey: string;
  attempt: number;
}): Promise<"superseded" | "refused"> {
  assertPositiveInt("attempt", attempt);
  const [row] = await db
    .select({ currentAttempt: cellStep.currentAttempt })
    .from(cellStep)
    .where(eq(cellStep.stepKey, stepKey))
    .limit(1);
  return row !== undefined && row.currentAttempt > attempt
    ? "superseded"
    : "refused";
}

/** Placeholder timeout of a done tombstone: it is never minted against. */
const TOMBSTONE_TIMEOUT_MS = 1;

/**
 * The run is over (the terminal read, #656 R1): every attempt is revoked and
 * the step is done. Idempotent. A step that was never opened gets a done
 * tombstone (`current_attempt` 0), so a late `openNextAttempt` returns
 * `step_done`. False only when the key belongs to another org or thread.
 */
export async function finishStep({
  db,
  stepKey,
  organizationId,
  threadId,
}: {
  db: DB;
  stepKey: string;
  organizationId: string;
  threadId: string;
}): Promise<boolean> {
  const rows = await db
    .insert(cellStep)
    .values({
      stepKey,
      organizationId,
      threadId,
      currentAttempt: 0,
      stepTimeoutMs: TOMBSTONE_TIMEOUT_MS,
      revokedThrough: 0,
      doneAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: cellStep.stepKey,
      set: {
        revokedThrough: sql`greatest(coalesce(${cellStep.revokedThrough}, 0), ${cellStep.currentAttempt})`,
        doneAt: sql`coalesce(${cellStep.doneAt}, now())`,
      },
      where: and(
        eq(cellStep.organizationId, organizationId),
        eq(cellStep.threadId, threadId),
      ),
    })
    .returning({ stepKey: cellStep.stepKey });
  return rows.length > 0;
}

/**
 * The `stepKey#attempt` ids (`cellKeyId`) positively known dead, the shape the
 * reconciler's isDead consumes (#656 scope 7).
 * Unknown steps, NULL leases and attempts above the current one are kept.
 * `staleMs: null` disables the lease rule. Throws on a database error (the
 * reconciler catches it and reaps expired only).
 */
export async function deadCellAttempts({
  db,
  keys,
  staleMs,
}: {
  db: DB;
  keys: readonly CellKey[];
  staleMs: number | null;
}): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  if (keys.length > DEAD_READ_MAX_KEYS) {
    throw new RangeError(`keys must not exceed ${DEAD_READ_MAX_KEYS}`);
  }
  for (const key of keys) assertPositiveInt("attempt", key.attempt);
  if (staleMs !== null && !(Number.isFinite(staleMs) && staleMs > 0)) {
    throw new RangeError("staleMs must be null or a positive finite number");
  }
  const stale =
    staleMs === null
      ? sql<boolean>`false`
      : sql<boolean>`${cellStep.lastSeenAt} IS NOT NULL AND ${cellStep.lastSeenAt} < now() - make_interval(secs => ${staleMs / 1000}::double precision)`;
  const rows = await db
    .select({
      stepKey: cellStep.stepKey,
      currentAttempt: cellStep.currentAttempt,
      revokedThrough: cellStep.revokedThrough,
      done: sql<boolean>`${cellStep.doneAt} IS NOT NULL`,
      stale,
    })
    .from(cellStep)
    .where(inArray(cellStep.stepKey, [...new Set(keys.map((k) => k.stepKey))]));
  const byStep = new Map(rows.map((r) => [r.stepKey, r]));
  const dead = new Set<string>();
  for (const key of keys) {
    const row = byStep.get(key.stepKey);
    if (!row) continue;
    if (
      isRevoked(key.attempt, row.revokedThrough) ||
      row.currentAttempt > key.attempt ||
      row.done ||
      (key.attempt === row.currentAttempt && row.stale)
    ) {
      dead.add(cellKeyId(key));
    }
  }
  return dead;
}

/** The per-step lock `openNextAttempt` (with a nonce) and `mintBearer` (replacing) share. */
const lockStep = (executor: Pick<DB, "execute">, stepKey: string) =>
  executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${stepKey}))`);

/**
 * Mint a bearer for the CURRENT attempt. The token is returned once; only its
 * hash is kept. Refused for a TTL above the step timeout, a fenced or revoked
 * attempt, and a finished step.
 *
 * `replaceOthers` (#656 PR-C) makes one live bearer per attempt atomic: in one
 * transaction, under the step's advisory lock (the open's key), it deletes the
 * attempt's other bearers and inserts the new one. It carries the `openSeq` its
 * own open returned: once a newer open has happened (`open_seq` moved on) the
 * mint is refused as `superseded`, with no delete and no insert, so a slow
 * earlier request cannot kill the bearer its retry handed out. Concurrent
 * replays end with exactly one live bearer, the newest open's.
 */
export async function mintBearer({
  db,
  stepKey,
  attempt,
  ttlMs,
  replaceOthers,
}: {
  db: DB;
  stepKey: string;
  attempt: number;
  ttlMs: number;
  replaceOthers?: { openSeq: number };
}): Promise<
  | { ok: true; token: string; expiresAt: Date }
  | {
      ok: false;
      reason:
        | "ttl_exceeds_step_timeout"
        | "fenced"
        | "unknown_step"
        | "step_done"
        | "revoked"
        | "superseded";
    }
> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("ttlMs must be a positive finite number");
  }
  const mint = async (tx: DB | SelfHealTx) => {
    const step = (
      await tx
        .select({
          currentAttempt: cellStep.currentAttempt,
          stepTimeoutMs: cellStep.stepTimeoutMs,
          revokedThrough: cellStep.revokedThrough,
          doneAt: cellStep.doneAt,
          openSeq: cellStep.openSeq,
        })
        .from(cellStep)
        .where(eq(cellStep.stepKey, stepKey))
        .limit(1)
    )[0];
    if (!step) return { ok: false, reason: "unknown_step" } as const;
    if (step.doneAt) return { ok: false, reason: "step_done" } as const;
    if (isRevoked(attempt, step.revokedThrough)) {
      return { ok: false, reason: "revoked" } as const;
    }
    if (step.currentAttempt !== attempt) {
      return { ok: false, reason: "fenced" } as const;
    }
    if (ttlMs > step.stepTimeoutMs) {
      return { ok: false, reason: "ttl_exceeds_step_timeout" } as const;
    }
    if (replaceOthers) {
      if (step.openSeq !== replaceOthers.openSeq) {
        return { ok: false, reason: "superseded" } as const;
      }
      await tx
        .delete(cellBearer)
        .where(
          and(eq(cellBearer.stepKey, stepKey), eq(cellBearer.attempt, attempt)),
        );
    }
    const token = mintOpaqueToken();
    const inserted = await tx
      .insert(cellBearer)
      .values({
        tokenHash: hashOpaqueToken(token),
        stepKey,
        attempt,
        expiresAt: sql`now() + make_interval(secs => ${ttlMs / 1000})`,
      })
      .returning({ expiresAt: cellBearer.expiresAt });
    const expiresAt = inserted[0]?.expiresAt;
    if (!expiresAt) throw new Error("bearer insert returned no row");
    return { ok: true, token, expiresAt } as const;
  };
  if (!replaceOthers) return mint(db);
  return db.transaction(async (tx) => {
    await lockStep(tx, stepKey);
    return mint(tx);
  });
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
      allowedRef: cellStep.allowedRef,
    })
    .from(cellBearer)
    .innerJoin(cellStep, eq(cellStep.stepKey, cellBearer.stepKey))
    .where(eq(cellBearer.tokenHash, hashOpaqueToken(token)))
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
      allowedRef: row.allowedRef,
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

/**
 * Drop the pending claim of `attempt` on a key whose effect never got an
 * answer (the transient-failure path of the broker push route, #606,
 * amendment 4), so an identical retry can claim afresh and spend a new unit.
 * Only an unanswered claim of exactly that attempt is deleted; a completed
 * effect stays, and `effects_used` is never refunded. It takes the same
 * `cell_step` row lock as `beginEffect`, so it serializes with a takeover: a
 * release after a newer attempt took the claim over matches nothing and
 * returns false.
 */
export async function releaseEffect({
  db,
  stepKey,
  idempotencyKey,
  attempt,
}: {
  db: DB;
  stepKey: string;
  idempotencyKey: string;
  attempt: number;
}): Promise<boolean> {
  assertPositiveInt("attempt", attempt);
  return db.transaction(async (tx) => {
    await tx
      .select({ stepKey: cellStep.stepKey })
      .from(cellStep)
      .where(eq(cellStep.stepKey, stepKey))
      .for("update");
    const rows = await tx
      .delete(cellEffect)
      .where(
        and(
          effectKey(stepKey, idempotencyKey),
          eq(cellEffect.attempt, attempt),
          isNull(cellEffect.result),
        ),
      )
      .returning({ key: cellEffect.idempotencyKey });
    return rows.length === 1;
  });
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
