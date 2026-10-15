import path from "node:path";
import { fileURLToPath } from "node:url";

import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./files";
import { readLedger } from "./ledger";
import {
  applyMigrations,
  markApplied,
  MigrationError,
  planMigrations,
} from "./runner";
import {
  createFreshDb,
  migrationsDir,
  silentLogger,
  type FreshDb,
} from "./test-db";

const REPO_MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../deploy/migrations",
);

const dbs: FreshDb[] = [];

async function freshDb(): Promise<FreshDb> {
  const db = await createFreshDb();
  dbs.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.drop()));
});

async function applyDir(
  c: pg.Client,
  dir: string,
  options: { lockTimeout?: string } = {},
) {
  const files = loadMigrations(dir);
  const plan = planMigrations(files, await readLedger(c));
  return applyMigrations(c, plan, {
    appliedBy: "test@0",
    logger: silentLogger(),
    ...options,
  });
}

async function scalar<T>(c: pg.Client, sql: string): Promise<T> {
  const result = await c.query(sql);
  return Object.values(result.rows[0] ?? {})[0] as T;
}

describe("deploy/migrations on a fresh database", () => {
  it("applies all five, records five rows, and a re-run is a no-op", async () => {
    const db = await freshDb();
    const c = await db.connect();

    const first = await applyDir(c, REPO_MIGRATIONS);
    expect(first.applied).toEqual([
      "0000-baseline",
      "2026-08-04-better-auth-1.6-apikey-rename",
      "2026-09-02-165-retire-app-side-rows",
      "2026-10-08-organization-environment",
      "2026-10-14-environment-org-unique",
    ]);
    const ledger = await readLedger(c);
    expect(ledger).toHaveLength(5);
    expect(ledger.every((row) => row.mode === "applied")).toBe(true);
    expect(ledger.every((row) => row.appliedBy === "test@0")).toBe(true);

    // The schema the code reads is there.
    expect(
      await scalar<number>(
        c,
        `SELECT count(*)::int FROM information_schema.columns
          WHERE table_name = 'organization' AND column_name = 'is_personal'`,
      ),
    ).toBe(1);
    expect(
      await scalar<number>(
        c,
        `SELECT count(*)::int FROM pg_indexes
          WHERE indexname IN ('environment_org_user_repo_unique', 'environment_user_global_unique')`,
      ),
    ).toBe(2);

    const second = await applyDir(c, REPO_MIGRATIONS);
    expect(second.applied).toEqual([]);
    expect(await readLedger(c)).toHaveLength(5);
  });

  it("refuses the baseline on a database that already has tables", async () => {
    const db = await freshDb();
    const c = await db.connect();
    await c.query("CREATE TABLE existing (id int)");

    await expect(applyDir(c, REPO_MIGRATIONS)).rejects.toThrow(
      /refusing to apply the baseline .* 1 table\(s\)/,
    );
    expect(await readLedger(c)).toEqual([]);
  });
});

describe("applyMigrations", () => {
  it("rolls a failing file back and writes no ledger row for it", async () => {
    const db = await freshDb();
    const c = await db.connect();
    const dir = migrationsDir({
      "001-ok.sql": "CREATE TABLE ok (id int);",
      "002-bad.sql": "CREATE TABLE half (id int);\nSELECT 1 / 0;",
      "003-never.sql": "CREATE TABLE never (id int);",
    });

    await expect(applyDir(c, dir)).rejects.toThrow(/division by zero/);
    expect((await readLedger(c)).map((r) => r.id)).toEqual(["001-ok"]);
    expect(await scalar<string | null>(c, "SELECT to_regclass('half')")).toBe(
      null,
    );
    expect(await scalar<string | null>(c, "SELECT to_regclass('never')")).toBe(
      null,
    );
  });

  it("refuses to run when an applied file was edited (drift)", async () => {
    const db = await freshDb();
    const c = await db.connect();
    await applyDir(c, migrationsDir({ "001.sql": "CREATE TABLE t (id int);" }));

    await expect(
      applyDir(
        c,
        migrationsDir({
          "001.sql": "CREATE TABLE t (id bigint);",
          "002.sql": "CREATE TABLE u (id int);",
        }),
      ),
    ).rejects.toThrow(/drift: 001/);
    expect(await scalar<string | null>(c, "SELECT to_regclass('u')")).toBe(
      null,
    );
  });

  it("trips lock_timeout against a held ACCESS EXCLUSIVE lock", async () => {
    const db = await freshDb();
    const c = await db.connect();
    const holder = await db.connect();
    await c.query("CREATE TABLE busy (id int)");
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE busy IN ACCESS EXCLUSIVE MODE");

    const started = Date.now();
    await expect(
      applyDir(
        c,
        migrationsDir({ "001.sql": "ALTER TABLE busy ADD COLUMN x int;" }),
        { lockTimeout: "300ms" },
      ),
    ).rejects.toMatchObject({ code: "55P03" });
    expect(Date.now() - started).toBeLessThan(5_000);
    await holder.query("ROLLBACK");
    expect(await readLedger(c)).toEqual([]);
  });

  it("serializes two concurrent runners: every file applies exactly once", async () => {
    const db = await freshDb();
    const a = await db.connect();
    const b = await db.connect();
    const dir = migrationsDir({
      "001.sql": "CREATE TABLE once (id int);\nSELECT pg_sleep(0.5);",
      "002.sql": "INSERT INTO once VALUES (1);",
    });

    const [ra, rb] = await Promise.all([applyDir(a, dir), applyDir(b, dir)]);
    const counts = [ra.applied.length, rb.applied.length].sort();
    expect(counts).toEqual([0, 2]);
    expect(await readLedger(a)).toHaveLength(2);
    expect(await scalar<number>(a, "SELECT count(*)::int FROM once")).toBe(1);
  });

  it("runs CREATE INDEX CONCURRENTLY from a no-transaction file", async () => {
    const db = await freshDb();
    const c = await db.connect();
    const dir = migrationsDir({
      "001.sql": "CREATE TABLE items (id int, x int);",
      "002.sql":
        "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS items_x ON items (x);\n",
    });

    const result = await applyDir(c, dir);
    expect(result.applied).toEqual(["001", "002"]);
    expect(
      await scalar<boolean>(
        c,
        `SELECT i.indisvalid FROM pg_index i
           JOIN pg_class cl ON cl.oid = i.indexrelid WHERE cl.relname = 'items_x'`,
      ),
    ).toBe(true);
    // Session settings were reset after the no-transaction file.
    expect(await scalar<string>(c, "SHOW lock_timeout")).toBe("0");
  });

  it("fails with a DROP INDEX CONCURRENTLY hint when a concurrent build leaves an invalid index", async () => {
    const db = await freshDb();
    const c = await db.connect();
    const dir = migrationsDir({
      "001.sql":
        "CREATE TABLE dupes (x int);\nINSERT INTO dupes VALUES (1), (1);",
      "002.sql":
        "-- migrate:no-transaction\nCREATE UNIQUE INDEX CONCURRENTLY dupes_x ON dupes (x);\n",
    });

    const error = await applyDir(c, dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toContain(
      "DROP INDEX CONCURRENTLY public.dupes_x;",
    );
    expect((await readLedger(c)).map((r) => r.id)).toEqual(["001"]);
  });
});

describe("markApplied", () => {
  it("records mode='marked' without running the file, and refuses unknown ids", async () => {
    const db = await freshDb();
    const c = await db.connect();
    const files = loadMigrations(
      migrationsDir({
        "001.sql": "CREATE TABLE marked_only (id int);",
        "002.sql": "CREATE TABLE later (id int);",
      }),
    );

    await expect(
      markApplied(c, files, ["001", "nope"], "test@0", silentLogger()),
    ).rejects.toThrow(/unknown migration id\(s\): nope/);

    expect(
      await markApplied(c, files, ["001"], "test@0", silentLogger()),
    ).toEqual(["001"]);
    const ledger = await readLedger(c);
    expect(ledger.map((r) => [r.id, r.mode])).toEqual([["001", "marked"]]);
    expect(
      await scalar<string | null>(c, "SELECT to_regclass('marked_only')"),
    ).toBe(null);

    // Marking again is a no-op; the next apply runs only 002.
    expect(
      await markApplied(c, files, ["001"], "test@0", silentLogger()),
    ).toEqual([]);
    const plan = planMigrations(files, await readLedger(c));
    expect(plan.pending.map((f) => f.id)).toEqual(["002"]);
  });
});
