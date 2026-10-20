import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { readLedger } from "./ledger";
import { createFreshDb, migrationsDir, type FreshDb } from "./test-db";

const PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CLI = path.resolve(PACKAGE_DIR, "../../deploy/migrate.ts");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], databaseUrl: string | undefined): CliResult {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTOR: "ci-bot" };
  delete env.DATABASE_URL;
  if (databaseUrl !== undefined) {
    env.DATABASE_URL = databaseUrl;
  }
  // `--import tsx` resolves from the cwd, where this package installs tsx.
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, ...args],
    {
      cwd: PACKAGE_DIR,
      env,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const dbs: FreshDb[] = [];

async function freshDb(): Promise<FreshDb> {
  const db = await createFreshDb();
  dbs.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.drop()));
});

describe("deploy/migrate.ts", () => {
  it("dry-runs by default, applies with --apply, then reports 0 pending", async () => {
    const db = await freshDb();

    const dry = runCli([], db.url);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("6 pending");
    expect(dry.stdout).toContain("pending  0000-baseline [baseline]");

    const apply = runCli(["--apply"], db.url);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("applied 6 migration(s)");

    const again = runCli(["--apply"], db.url);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("6 applied, 0 pending");
    expect(again.stdout).toContain("applied 0 migration(s)");

    const c = await db.connect();
    const ledger = await readLedger(c);
    expect(ledger).toHaveLength(6);
    expect(ledger[0]?.appliedBy).toMatch(/^ci-bot@/);
  });

  it("exits 1 when an applied file was edited, or its file is gone", async () => {
    const db = await freshDb();
    const dir = migrationsDir({
      "001.sql": "CREATE TABLE a (id int);",
      "002.sql": "CREATE TABLE b (id int);",
    });
    expect(runCli(["--apply", "--dir", dir], db.url).status).toBe(0);

    writeFileSync(path.join(dir, "001.sql"), "CREATE TABLE a (id bigint);");
    const drift = runCli(["--dir", dir], db.url);
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain("drift: 001");

    writeFileSync(path.join(dir, "001.sql"), "CREATE TABLE a (id int);");
    unlinkSync(path.join(dir, "002.sql"));
    const orphan = runCli(["--apply", "--dir", dir], db.url);
    expect(orphan.status).toBe(1);
    expect(orphan.stderr).toContain("orphan: ledger row 002");
  });

  it("--no-contract refuses a pending contract file and applies nothing", async () => {
    const db = await freshDb();
    const dir = migrationsDir({
      "001.sql": "CREATE TABLE a (id bigint);",
      "002.sql": "-- migrate:contract\nALTER TABLE a DROP COLUMN id;",
    });

    const refused = runCli(["--apply", "--no-contract", "--dir", dir], db.url);
    expect(refused.status).toBe(2);
    expect(refused.stdout).toContain("pending  002 [contract]");
    expect(refused.stderr).toContain(
      "refusing: pending contract migration(s) 002",
    );
    const c = await db.connect();
    expect(await readLedger(c)).toHaveLength(0);

    const applied = runCli(["--apply", "--dir", dir], db.url);
    expect(applied.status).toBe(0);
    expect(await readLedger(c)).toHaveLength(2);
  });

  it("--no-contract still applies expand-only plans", async () => {
    const db = await freshDb();
    const dir = migrationsDir({
      "001.sql": "-- migrate:expand\nCREATE TABLE a (id bigint);",
    });
    const result = runCli(["--apply", "--no-contract", "--dir", dir], db.url);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pending  001 [expand]");
    expect(result.stdout).toContain("applied 1 migration(s)");
  });

  it("--mark-applied writes mode='marked' and refuses unknown ids", async () => {
    const db = await freshDb();
    const dir = migrationsDir({
      "001.sql": "CREATE TABLE never_run (id int);",
    });

    const unknown = runCli(
      ["--mark-applied", "001", "999", "--dir", dir],
      db.url,
    );
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown migration id(s): 999");

    const marked = runCli(["--mark-applied", "001", "--dir", dir], db.url);
    expect(marked.status).toBe(0);
    expect(marked.stdout).toContain("1 applied, 0 pending");

    const c = await db.connect();
    const ledger = await readLedger(c);
    expect(ledger.map((r) => [r.id, r.mode])).toEqual([["001", "marked"]]);
    const table = await c.query("SELECT to_regclass('never_run') AS t");
    expect(table.rows[0]?.t).toBe(null);
  });

  it("refuses a pooler URL and an unset DATABASE_URL without printing the secret", () => {
    const pooler = runCli(
      [],
      "postgresql://owner:s3cret-pw@ep-quiet-pond-123456-pooler.us-east-2.aws.neon.tech/app",
    );
    expect(pooler.status).toBe(1);
    expect(pooler.stderr).toContain("connection pooler");
    expect(pooler.stderr + pooler.stdout).not.toContain("s3cret-pw");

    const unset = runCli([], undefined);
    expect(unset.status).toBe(1);
    expect(unset.stderr).toContain("DATABASE_URL is not set");
  });
});
