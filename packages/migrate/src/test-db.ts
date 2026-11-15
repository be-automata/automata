import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import {
  testDatabaseUrl,
  uniqueDbName,
} from "@terragon/dev-env/test-services-mode";

import type { MigrationLogger } from "./runner";

export interface FreshDb {
  url: string;
  connect(): Promise<pg.Client>;
  drop(): Promise<void>;
}

function adminUrl(): string {
  const url = process.env.MIGRATE_TEST_ADMIN_URL;
  if (!url) {
    throw new Error("MIGRATE_TEST_ADMIN_URL is unset; globalSetup did not run");
  }
  return url;
}

async function adminQuery(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** A new, empty database (name validated by uniqueDbName). */
export async function createFreshDb(): Promise<FreshDb> {
  const name = uniqueDbName();
  await adminQuery(`CREATE DATABASE "${name}"`);
  const url = testDatabaseUrl(adminUrl(), name);
  const clients: pg.Client[] = [];
  return {
    url,
    async connect() {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      clients.push(client);
      return client;
    },
    async drop() {
      await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
      await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}

/** A temp directory holding the given `{ filename: sql }` files. */
export function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "migrate-test-"));
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), sql);
  }
  return dir;
}

export function silentLogger(): MigrationLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
}

/** The busy runner's error message (`MigrationLockBusyError`), spelled out. */
export const BUSY_MESSAGE =
  "another migration run holds the lock (automata:schema_migrations); nothing was applied";

/** The first column of the first row. */
export async function scalar<T>(c: pg.Client, sql: string): Promise<T> {
  const result = await c.query(sql);
  return Object.values(result.rows[0] ?? {})[0] as T;
}

/** Polls `check` until it is true; fails the test (never falls through) on timeout. */
export async function waitUntil(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** True once some session of this database holds a granted advisory lock. */
export async function advisoryLockHeld(c: pg.Client): Promise<boolean> {
  return (
    (await scalar<number>(
      c,
      `SELECT count(*)::int FROM pg_locks
        WHERE locktype = 'advisory' AND granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    )) > 0
  );
}

export function invalidIndexCount(c: pg.Client): Promise<number> {
  return scalar<number>(
    c,
    "SELECT count(*)::int FROM pg_index WHERE NOT indisvalid",
  );
}
