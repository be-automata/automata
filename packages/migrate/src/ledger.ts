import type { ClientBase } from "pg";

export const LEDGER_TABLE = "public.schema_migrations";

export type LedgerMode = "applied" | "marked";

export interface LedgerRow {
  id: string;
  checksum: string;
  appliedAt: Date;
  appliedBy: string;
  mode: LedgerMode;
}

/** Creates the ledger if it does not exist. Idempotent. */
export async function ensureLedger(c: ClientBase): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      applied_by text NOT NULL,
      mode text NOT NULL DEFAULT 'applied' CHECK (mode IN ('applied', 'marked'))
    )
  `);
}

export async function ledgerExists(c: ClientBase): Promise<boolean> {
  const result = await c.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [LEDGER_TABLE],
  );
  return result.rows[0]?.present === true;
}

/**
 * Ledger rows ordered by id. A database without the ledger reads as empty, so
 * a dry run never has to create it.
 */
export async function readLedger(c: ClientBase): Promise<LedgerRow[]> {
  if (!(await ledgerExists(c))) {
    return [];
  }
  const result = await c.query<{
    id: string;
    checksum: string;
    applied_at: Date;
    applied_by: string;
    mode: LedgerMode;
  }>(
    `SELECT id, checksum, applied_at, applied_by, mode FROM ${LEDGER_TABLE} ORDER BY id`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    checksum: row.checksum,
    appliedAt: row.applied_at,
    appliedBy: row.applied_by,
    mode: row.mode,
  }));
}

export async function insertLedgerRow(
  c: ClientBase,
  row: { id: string; checksum: string; appliedBy: string; mode: LedgerMode },
): Promise<void> {
  await c.query(
    `INSERT INTO ${LEDGER_TABLE} (id, checksum, applied_by, mode) VALUES ($1, $2, $3, $4)`,
    [row.id, row.checksum, row.appliedBy, row.mode],
  );
}
