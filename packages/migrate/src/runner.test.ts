import path from "node:path";
import { fileURLToPath } from "node:url";

import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./files";
import { readLedger } from "./ledger";
import {
  ADVISORY_LOCK_KEY,
  applyMigrations,
  markApplied,
  MigrationError,
  MigrationLockBusyError,
  planMigrations,
} from "./runner";
import {
  advisoryLockHeld,
  BUSY_MESSAGE,
  createFreshDb,
  invalidIndexCount,
  migrationsDir,
  scalar,
  silentLogger,
  waitUntil,
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

/** Collects the server notices (e.g. "you don't own a lock") a client receives. */
function collectNotices(c: pg.Client): string[] {
  const notices: string[] = [];
  c.on("notice", (notice) => notices.push(notice.message ?? ""));
  return notices;
}

describe("deploy/migrations on a fresh database", () => {
  it("applies all ten, records ten rows, and a re-run is a no-op", async () => {
    const db = await freshDb();
    const c = await db.connect();

    const first = await applyDir(c, REPO_MIGRATIONS);
    expect(first.applied).toEqual([
      "0000-baseline",
      "2026-08-04-better-auth-1.6-apikey-rename",
      "2026-09-02-165-retire-app-side-rows",
      "2026-10-08-organization-environment",
      "2026-10-14-environment-org-unique",
      "2026-10-19-knowledge-plane",
      "2026-10-22-queued-at",
      "2026-10-22-review-rerun",
      "2026-10-23-knowledge-org-controls",
      "2026-10-24-knowledge-op-fingerprint-index",
      "2026-10-25-knowledge-updated-at",
      "2026-10-26-delivery-loop",
      "2026-10-27-hatchet-tenant-binding",
      "2026-11-01-better-auth-1-7-columns",
      "2026-11-02-github-repo-org-binding",
      "2026-11-02-review-mode-on-update",
      "2026-11-05-knowledge-reconcile",
      "2026-11-10-execution-profile-cell-decision",
      "2026-11-10-execution-profile-seed-automata-box",
      "2026-11-13-addon-call-receiver",
      "2026-11-13-cell-broker-authority",
      "2026-11-14-org-cell-workflow-write",
      "2026-11-15-cell-step-allowed-ref",
    ]);
    const ledger = await readLedger(c);
    expect(ledger).toHaveLength(23);
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
    expect(
      await scalar<number>(
        c,
        `SELECT count(*)::int FROM information_schema.columns
          WHERE table_name = 'organization_review_settings' AND column_name = 'knowledge_engine'`,
      ),
    ).toBe(1);

    const second = await applyDir(c, REPO_MIGRATIONS);
    expect(second.applied).toEqual([]);
    expect(await readLedger(c)).toHaveLength(23);
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
    // The failure still released the advisory lock on this healthy session.
    expect(await advisoryLockHeld(c)).toBe(false);
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

  it.each([
    ["a starts first", true],
    ["b starts first", false],
  ])(
    "two racing runners, %s: the loser is busy, the winner applies every file once",
    async (_label, aFirst) => {
      const db = await freshDb();
      const monitor = await db.connect();
      const a = await db.connect();
      const b = await db.connect();
      const [winner, loser] = aFirst ? [a, b] : [b, a];
      const loserNotices = collectNotices(loser);
      // 001 blocks on `gate`, which this session holds, so the winner holds the
      // advisory lock for as long as the test wants (no sleeps to race).
      await monitor.query("CREATE TABLE gate (id int)");
      await monitor.query("BEGIN");
      await monitor.query("LOCK TABLE gate IN ACCESS EXCLUSIVE MODE");
      const dir = migrationsDir({
        "001.sql":
          "-- migrate:lock-timeout=30s\nLOCK TABLE gate IN SHARE MODE;\nCREATE TABLE once (id int);",
        "002.sql": "INSERT INTO once VALUES (1);",
      });

      const winning = applyDir(winner, dir);
      let result: Awaited<typeof winning>;
      try {
        await waitUntil("the winner's advisory lock", () =>
          advisoryLockHeld(monitor),
        );
        const error = await applyDir(loser, dir).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MigrationLockBusyError);
        expect((error as Error).message).toBe(BUSY_MESSAGE);
      } finally {
        await monitor.query("ROLLBACK");
        result = await winning;
      }

      expect(result.applied).toEqual(["001", "002"]);
      expect(await readLedger(winner)).toHaveLength(2);
      expect(
        await scalar<number>(winner, "SELECT count(*)::int FROM once"),
      ).toBe(1);
      // A busy runner never unlocks a lock it does not own.
      expect(loserNotices.filter((m) => /own/i.test(m))).toEqual([]);
    },
  );

  /**
   * Production shape, ordered deterministically: a writer holds a table lock
   * open, runner A's CIC waits on it, runner B arrives, and only then does the
   * writer commit. A runner that blocks B on the advisory lock makes the CIC
   * wait on B's virtual xid as the last waiter, so Postgres kills the CIC and
   * leaves an INVALID index.
   */
  async function productionRace() {
    const db = await freshDb();
    const monitor = await db.connect();
    const writer = await db.connect();
    const a = await db.connect();
    const b = await db.connect();
    const files = {
      "001.sql": "CREATE TABLE items (id int, x int);",
      "002.sql":
        "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS items_x ON items (x);\n",
    };
    // Only the CIC file is pending, as on production.
    await applyDir(a, migrationsDir({ "001.sql": files["001.sql"] }));
    const dir = migrationsDir(files);
    const bPid = await scalar<number>(b, "SELECT pg_backend_pid()");

    await writer.query("BEGIN");
    await writer.query("LOCK TABLE items IN ROW EXCLUSIVE MODE");
    let writerOpen = true;
    try {
      const first = applyDir(a, dir, { lockTimeout: "120s" });
      first.catch(() => undefined);
      await waitUntil(
        "runner A's CIC waiting on the writer's lock",
        async () =>
          (
            await monitor.query(
              `SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND pid <> pg_backend_pid()
                  AND query ILIKE '%CREATE INDEX CONCURRENTLY%'`,
            )
          ).rows.length > 0,
      );

      let secondSettled = false;
      const second = applyDir(b, dir, { lockTimeout: "120s" });
      second.then(
        () => (secondSettled = true),
        () => (secondSettled = true),
      );
      // Finished (busy) or, on a runner that waits, blocked on the advisory
      // lock for longer than deadlock_timeout. B's one deadlock check must run
      // before the cycle exists, so that A's CIC is the later waiter and the
      // victim.
      await waitUntil("runner B finished or waiting", async () => {
        if (secondSettled) {
          return true;
        }
        const waiting = await monitor.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE pid = $1 AND wait_event = 'advisory'
              AND now() - query_start >
                  2 * current_setting('deadlock_timeout')::interval`,
          [bPid],
        );
        return waiting.rows.length > 0;
      });
      await writer.query("COMMIT");
      writerOpen = false;

      const settled = await Promise.allSettled([first, second]);
      return { monitor, settled };
    } finally {
      if (writerOpen) {
        await writer.query("ROLLBACK");
      }
    }
  }

  it("production shape: exactly one runner applies the CIC, the other is busy, and no index is left invalid", async () => {
    const { monitor, settled } = await productionRace();
    expect(await invalidIndexCount(monitor)).toBe(0);
    const winners = settled.filter(
      (r) => r.status === "fulfilled" && r.value.applied.includes("002"),
    );
    expect(winners).toHaveLength(1);
    const losers = settled.filter((r) => r.status === "rejected");
    expect(losers).toHaveLength(1);
    const reason = (losers[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(MigrationLockBusyError);
    expect((reason as Error).message).toBe(BUSY_MESSAGE);
    expect((await readLedger(monitor)).map((r) => r.id)).toEqual([
      "001",
      "002",
    ]);
    expect(
      await scalar<number>(
        monitor,
        `SELECT count(*)::int FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'items_x' AND i.indisvalid`,
      ),
    ).toBe(1);
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

  it("a busy markApplied writes no ledger row and does not create the ledger", async () => {
    const db = await freshDb();
    const holder = await db.connect();
    const c = await db.connect();
    const notices = collectNotices(c);
    const files = loadMigrations(
      migrationsDir({ "001.sql": "CREATE TABLE marked_only (id int);" }),
    );
    await holder.query("SELECT pg_advisory_lock(hashtext($1))", [
      ADVISORY_LOCK_KEY,
    ]);

    await expect(
      markApplied(c, files, ["001"], "test@0", silentLogger()),
    ).rejects.toBeInstanceOf(MigrationLockBusyError);

    expect(
      await scalar<string | null>(c, "SELECT to_regclass('schema_migrations')"),
    ).toBe(null);
    expect(notices.filter((m) => /own/i.test(m))).toEqual([]);
  });
});
