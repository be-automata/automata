import type { ClientBase } from "pg";

import type { MigrationFile } from "./files";
import { isValidDuration } from "./files";
import {
  ensureLedger,
  insertLedgerRow,
  LEDGER_TABLE,
  readLedger,
  type LedgerRow,
} from "./ledger";

/** Every runner instance takes this session advisory lock before touching the ledger. */
export const ADVISORY_LOCK_KEY = "automata:schema_migrations";

export interface MigrationLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface DriftEntry {
  id: string;
  /** Checksum recorded in the ledger. */
  expected: string;
  /** Checksum of the file on disk now. */
  actual: string;
}

export interface MigrationPlan {
  /** Every file on disk, in apply order. */
  files: MigrationFile[];
  /** Files with no ledger row, in apply order. */
  pending: MigrationFile[];
  /** Files whose ledger row matches their checksum. */
  applied: MigrationFile[];
  /** Files whose content changed after they were applied. */
  drift: DriftEntry[];
  /** Ledger rows with no file on disk. */
  orphans: LedgerRow[];
}

export interface ApplyOptions {
  appliedBy: string;
  lockTimeout?: string;
  statementTimeout?: string;
  logger: MigrationLogger;
}

export interface ApplyResult {
  applied: string[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export const DEFAULT_LOCK_TIMEOUT = "5s";
export const DEFAULT_STATEMENT_TIMEOUT = "120s";

export function planMigrations(
  files: MigrationFile[],
  ledger: LedgerRow[],
): MigrationPlan {
  const byId = new Map(ledger.map((row) => [row.id, row]));
  const fileIds = new Set(files.map((file) => file.id));
  const pending: MigrationFile[] = [];
  const applied: MigrationFile[] = [];
  const drift: DriftEntry[] = [];
  for (const file of files) {
    const row = byId.get(file.id);
    if (!row) {
      pending.push(file);
    } else if (row.checksum !== file.checksum) {
      drift.push({
        id: file.id,
        expected: row.checksum,
        actual: file.checksum,
      });
    } else {
      applied.push(file);
    }
  }
  const orphans = ledger.filter((row) => !fileIds.has(row.id));
  return { files, pending, applied, drift, orphans };
}

/** Human-readable reasons the plan must not be applied; empty when it is clean. */
export function planProblems(plan: MigrationPlan): string[] {
  return [
    ...plan.drift.map(
      (d) =>
        `drift: ${d.id} was applied with checksum ${d.expected} but the file is now ${d.actual}; ` +
        "applied migrations are immutable — add a new migration instead",
    ),
    ...plan.orphans.map(
      (o) =>
        `orphan: ledger row ${o.id} (${o.mode} by ${o.appliedBy}) has no file in the migrations directory`,
    ),
  ];
}

async function withAdvisoryLock<T>(
  c: ClientBase,
  fn: () => Promise<T>,
): Promise<T> {
  await c.query(`SELECT pg_advisory_lock(hashtext($1))`, [ADVISORY_LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await c.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
      ADVISORY_LOCK_KEY,
    ]);
  }
}

async function userRelationCount(c: ClientBase): Promise<number> {
  const result = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`,
  );
  return Number(result.rows[0]?.n ?? "0");
}

async function invalidIndexes(c: ClientBase): Promise<string[]> {
  const result = await c.query<{ name: string }>(
    `SELECT format('%I.%I', n.nspname, cl.relname) AS name
       FROM pg_index i
       JOIN pg_class cl ON cl.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE NOT i.indisvalid
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY 1`,
  );
  return result.rows.map((row) => row.name);
}

function invalidIndexError(id: string, names: string[]): MigrationError {
  const drops = names.map((name) => `  DROP INDEX CONCURRENTLY ${name};`);
  return new MigrationError(
    `${id}: left ${names.length} invalid index(es) behind (a failed or interrupted CONCURRENTLY build). ` +
      `No ledger row was written. Drop them, then re-run:\n${drops.join("\n")}`,
  );
}

function timeoutsFor(
  file: MigrationFile,
  options: ApplyOptions,
): { lockTimeout: string; statementTimeout: string } {
  const lockTimeout =
    file.headers.lockTimeout ?? options.lockTimeout ?? DEFAULT_LOCK_TIMEOUT;
  const statementTimeout =
    file.headers.statementTimeout ??
    options.statementTimeout ??
    DEFAULT_STATEMENT_TIMEOUT;
  for (const value of [lockTimeout, statementTimeout]) {
    if (!isValidDuration(value)) {
      throw new MigrationError(`invalid timeout ${JSON.stringify(value)}`);
    }
  }
  return { lockTimeout, statementTimeout };
}

async function applyTransactional(
  c: ClientBase,
  file: MigrationFile,
  options: ApplyOptions,
): Promise<void> {
  const { lockTimeout, statementTimeout } = timeoutsFor(file, options);
  await c.query("BEGIN");
  try {
    await c.query(
      `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`,
      [lockTimeout, statementTimeout],
    );
    await c.query(file.sql);
    await insertLedgerRow(c, {
      id: file.id,
      checksum: file.checksum,
      appliedBy: options.appliedBy,
      mode: "applied",
    });
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  }
}

async function applyNoTransaction(
  c: ClientBase,
  file: MigrationFile,
  options: ApplyOptions,
): Promise<void> {
  const { lockTimeout, statementTimeout } = timeoutsFor(file, options);
  await c.query(
    `SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)`,
    [lockTimeout, statementTimeout],
  );
  let failure: unknown = null;
  try {
    await c.query(file.sql);
  } catch (error) {
    failure = error;
  } finally {
    await c.query("RESET lock_timeout");
    await c.query("RESET statement_timeout");
  }
  // CREATE INDEX CONCURRENTLY leaves an INVALID index behind when it fails, and
  // `IF NOT EXISTS` on a later run silently keeps that invalid index. Check
  // either way, so neither case records the migration as done.
  const invalid = await invalidIndexes(c);
  if (invalid.length > 0) {
    if (failure) {
      const message =
        failure instanceof Error ? failure.message : String(failure);
      options.logger.error(`${file.id}: ${message}`);
    }
    throw invalidIndexError(file.id, invalid);
  }
  if (failure) {
    throw failure;
  }
  // Written after the statement: a crash in between re-runs the statement next
  // time, so a no-transaction migration must itself be idempotent.
  await insertLedgerRow(c, {
    id: file.id,
    checksum: file.checksum,
    appliedBy: options.appliedBy,
    mode: "applied",
  });
}

/**
 * Applies `plan.pending` in order under the advisory lock. The ledger is
 * re-read once the lock is held, so a runner that waited behind another one
 * applies only what is still pending (usually nothing). Stops at the first
 * failure; every file before it stays applied.
 */
export async function applyMigrations(
  c: ClientBase,
  plan: MigrationPlan,
  options: ApplyOptions,
): Promise<ApplyResult> {
  return withAdvisoryLock(c, async () => {
    await ensureLedger(c);
    const current = planMigrations(plan.files, await readLedger(c));
    const problems = planProblems(current);
    if (problems.length > 0) {
      throw new MigrationError(problems.join("\n"));
    }
    const lastApplied = current.applied.at(-1)?.id;
    const applied: string[] = [];
    for (const file of current.pending) {
      if (file.headers.baseline) {
        const count = await userRelationCount(c);
        if (count > 0) {
          throw new MigrationError(
            `${file.id}: refusing to apply the baseline to a database that already has ${count} table(s) in public; ` +
              `mark it instead: tsx deploy/migrate.ts --mark-applied ${file.id}`,
          );
        }
      }
      if (lastApplied && file.id < lastApplied) {
        options.logger.warn(
          `${file.id}: sorts before the already-applied ${lastApplied}; applying it out of order`,
        );
      }
      options.logger.info(
        `applying ${file.id}${file.headers.noTransaction ? " (no transaction)" : ""}`,
      );
      const started = Date.now();
      if (file.headers.noTransaction) {
        await applyNoTransaction(c, file, options);
      } else {
        await applyTransactional(c, file, options);
      }
      options.logger.info(`applied ${file.id} in ${Date.now() - started}ms`);
      applied.push(file.id);
    }
    return { applied };
  });
}

/**
 * Records migrations as already applied without running them (`mode =
 * 'marked'`): for adopting the ledger on a database migrated by hand. Unknown
 * ids are refused; ids already in the ledger with the same checksum are
 * skipped; ids in the ledger with a different checksum are refused.
 */
export async function markApplied(
  c: ClientBase,
  files: MigrationFile[],
  ids: string[],
  appliedBy: string,
  logger: MigrationLogger,
): Promise<string[]> {
  const byId = new Map(files.map((file) => [file.id, file]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new MigrationError(
      `--mark-applied: unknown migration id(s): ${unknown.join(", ")}`,
    );
  }
  return withAdvisoryLock(c, async () => {
    await ensureLedger(c);
    const ledger = new Map((await readLedger(c)).map((row) => [row.id, row]));
    const marked: string[] = [];
    await c.query("BEGIN");
    try {
      for (const id of ids) {
        const file = byId.get(id);
        if (!file) {
          continue;
        }
        const existing = ledger.get(id);
        if (existing) {
          if (existing.checksum !== file.checksum) {
            throw new MigrationError(
              `--mark-applied: ${id} is already in ${LEDGER_TABLE} with a different checksum`,
            );
          }
          logger.info(`${id}: already in the ledger, skipped`);
          continue;
        }
        await insertLedgerRow(c, {
          id,
          checksum: file.checksum,
          appliedBy,
          mode: "marked",
        });
        logger.info(`${id}: marked as applied`);
        marked.push(id);
      }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    }
    return marked;
  });
}
