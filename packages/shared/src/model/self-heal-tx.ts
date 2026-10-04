import { sql } from "drizzle-orm";

import type { DB } from "../db";

/** The transaction handle drizzle passes to a `db.transaction` callback. */
export type SelfHealTx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export interface SelfHealTxTimeouts {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}

/**
 * Per-transaction ceilings (RES-07). A self-heal hook runs inside a 30 s
 * waitUntil, so no single statement, lock wait or idle gap may eat that budget.
 */
export const SELF_HEAL_TX_TIMEOUTS: Readonly<SelfHealTxTimeouts> = {
  statementTimeoutMs: 3_000,
  lockTimeoutMs: 1_000,
  idleInTransactionTimeoutMs: 5_000,
};

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

function assertBounded(name: string, value: number): void {
  if (
    !Number.isInteger(value) ||
    value < MIN_TIMEOUT_MS ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `withSelfHealTx: ${name} must be an integer in [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}] ms, got ${String(value)}`,
    );
  }
}

/**
 * Run `fn` in a transaction whose statement, lock and idle-in-transaction
 * timeouts are bounded with SET LOCAL (scoped to this transaction only, so the
 * pooled session is unchanged afterwards). Overrides are validated BEFORE the
 * transaction opens. The values are validated integers, so interpolating them
 * with sql.raw cannot inject.
 */
export async function withSelfHealTx<T>(
  db: DB,
  fn: (tx: SelfHealTx) => Promise<T>,
  opts: Partial<SelfHealTxTimeouts> = {},
): Promise<T> {
  const t: SelfHealTxTimeouts = { ...SELF_HEAL_TX_TIMEOUTS, ...opts };
  assertBounded("statementTimeoutMs", t.statementTimeoutMs);
  assertBounded("lockTimeoutMs", t.lockTimeoutMs);
  assertBounded("idleInTransactionTimeoutMs", t.idleInTransactionTimeoutMs);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`SET LOCAL statement_timeout = '${t.statementTimeoutMs}ms'`),
    );
    await tx.execute(
      sql.raw(`SET LOCAL lock_timeout = '${t.lockTimeoutMs}ms'`),
    );
    await tx.execute(
      sql.raw(
        `SET LOCAL idle_in_transaction_session_timeout = '${t.idleInTransactionTimeoutMs}ms'`,
      ),
    );
    return fn(tx);
  });
}
