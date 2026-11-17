import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { DB } from "../db";
import { controlEffects } from "../db/schema";

/**
 * Exactly-once control-plane effects (#652). An effect that leaves Automata (a
 * Drive upload, a run summary post) runs once even when the worker dies in the
 * middle of it: the ledger records an intent first, the target carries the
 * effect key as its marker, and a redelivery that finds an intent left behind
 * looks for the marker before applying again.
 *
 * Not `cell_effect` (it requires a cell step and a bearer) and not
 * `audit_effects` (GitHub actions, lease based, no marker reconcile).
 */

export type RunEffectOutcome = "applied" | "reconciled" | "already_done";

/** The system an effect lands in. Injected: the ledger never imports one. */
export interface EffectTarget<P> {
  /** Performs the effect; `key` must travel with it as its marker. */
  apply(key: string, payload: P): Promise<void>;
  /** True when an effect carrying `key` as its marker already exists. */
  findByMarker(key: string): Promise<boolean>;
}

export interface EffectKeyParts {
  mission: string;
  step: string;
  effect: string;
  outputDigest: string;
}

export interface RunEffectInput<P> extends EffectKeyParts {
  /** The root handle, never a transaction: the intent must commit on its own. */
  db: DB;
  target: EffectTarget<P>;
  organizationId: string;
  payload: P;
  /** How long a delivery waits behind the key's lock. Default 10 s. */
  lockTimeoutMs?: number;
  /** Ends the session of a holder that hangs inside `apply`. Default 60 s. */
  idleInTransactionTimeoutMs?: number;
}

export class ControlEffectKeyCollisionError extends Error {
  constructor(public readonly key: string) {
    super(`control effect key ${key} is already held by a different effect`);
    this.name = "ControlEffectKeyCollisionError";
  }
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
const KEY_LENGTH = 16;

/**
 * `sha256(mission|step|effect|outputDigest)` as hex, first 16 chars. Each part
 * must be non-empty and free of `|`, so two different tuples never join alike.
 */
export function effectKey(parts: EffectKeyParts): string {
  const values = [parts.mission, parts.step, parts.effect, parts.outputDigest];
  for (const value of values) {
    if (value === "" || value.includes("|")) {
      throw new RangeError(
        "effect key parts must be non-empty and not contain |",
      );
    }
  }
  return createHash("sha256")
    .update(values.join("|"))
    .digest("hex")
    .slice(0, KEY_LENGTH);
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

type LedgerRow = typeof controlEffects.$inferSelect;

function sameEffect(row: LedgerRow, input: RunEffectInput<unknown>): boolean {
  return (
    row.organizationId === input.organizationId &&
    row.mission === input.mission &&
    row.step === input.step &&
    row.effect === input.effect &&
    row.outputDigest === input.outputDigest
  );
}

/** Insert the intent as its own statement; true when this call created it. */
async function insertIntent(
  db: DB,
  key: string,
  input: RunEffectInput<unknown>,
): Promise<boolean> {
  const rows = await db
    .insert(controlEffects)
    .values({
      key,
      organizationId: input.organizationId,
      mission: input.mission,
      step: input.step,
      effect: input.effect,
      outputDigest: input.outputDigest,
    })
    .onConflictDoNothing({ target: controlEffects.key })
    .returning({ key: controlEffects.key });
  return rows.length > 0;
}

/**
 * Run `target.apply` for this (mission, step, effect, output) exactly once.
 *
 * Precondition (the caller's, the ledger cannot check it): the output named by
 * `outputDigest` is already stored. The ledger keeps the digest, never the
 * output or the payload.
 *
 * The intent commits first. The effect then runs inside a transaction that
 * holds the key's row lock, so concurrent deliveries of one key take turns. The
 * lock is bounded: waiters give up after `lockTimeoutMs` (the intent stays and
 * the next delivery reconciles), and a holder that hangs or is partitioned loses
 * its session after `idleInTransactionTimeoutMs`; if that happens after `apply`
 * but before commit, the next delivery finds the marker and reconciles. A
 * failing `apply` or `findByMarker` propagates and leaves the intent.
 */
export async function runEffect<P>(
  input: RunEffectInput<P>,
): Promise<{ key: string; outcome: RunEffectOutcome }> {
  const lockMs = input.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const idleMs =
    input.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS;
  assertPositiveInt("lockTimeoutMs", lockMs);
  assertPositiveInt("idleInTransactionTimeoutMs", idleMs);
  const key = effectKey(input);
  const created = await insertIntent(input.db, key, input);
  const outcome = await input.db.transaction(async (tx) => {
    // set_config(..., true) is SET LOCAL: scoped to this transaction only.
    await tx.execute(
      sql`select set_config('lock_timeout', ${`${lockMs}ms`}, true), set_config('idle_in_transaction_session_timeout', ${`${idleMs}ms`}, true)`,
    );
    const [row] = await tx
      .select()
      .from(controlEffects)
      .where(eq(controlEffects.key, key))
      .for("update");
    if (!row)
      throw new Error(`control effect ${key} vanished after its intent`);
    if (!sameEffect(row, input)) throw new ControlEffectKeyCollisionError(key);
    if (row.doneAt) return "already_done" as const;
    const reconciled = !created && (await input.target.findByMarker(key));
    if (!reconciled) await input.target.apply(key, input.payload);
    await tx
      .update(controlEffects)
      .set({ doneAt: sql`now()`, reconciled })
      .where(eq(controlEffects.key, key));
    return reconciled ? ("reconciled" as const) : ("applied" as const);
  });
  return { key, outcome };
}
