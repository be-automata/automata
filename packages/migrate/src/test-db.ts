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
