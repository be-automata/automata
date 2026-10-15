import { afterEach, describe, expect, it } from "vitest";

import { ensureLedger } from "../ledger";
import { createFreshDb, type FreshDb } from "../test-db";
import { snapshotCatalog, type Catalog } from "./catalog";
import { diffCatalogs, type AllowEntry } from "./diff";

const dbs: FreshDb[] = [];

afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.drop()));
});

const BASE = `
  CREATE TYPE "status" AS ENUM ('open', 'closed');
  CREATE TABLE "thread" (
    "id" serial PRIMARY KEY,
    "status" "status" DEFAULT 'open' NOT NULL,
    "repo" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE TABLE "message" (
    "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "thread_id" integer NOT NULL REFERENCES "thread"("id") ON DELETE CASCADE,
    "body" text
  );
  CREATE INDEX "thread_repo_lower_index" ON "thread" (lower("repo"));
`;

/** Snapshots a fresh database built from BASE plus `extra`. */
async function catalogOf(extra = ""): Promise<Catalog> {
  const db = await createFreshDb();
  dbs.push(db);
  const client = await db.connect();
  await client.query(BASE + extra);
  return snapshotCatalog(client);
}

describe("snapshotCatalog", () => {
  it("captures columns, constraints, indexes, enums and sequences by name", async () => {
    const catalog = await catalogOf();
    const byKey = new Map(
      catalog.entries.map((e) => [`${e.kind}:${e.table}:${e.name}`, e]),
    );
    expect(byKey.get("column:thread:status")?.definition).toBe(
      "status | not null | default 'open'::status",
    );
    expect(byKey.get("column:message:id")?.definition).toContain("identity a");
    expect(
      byKey.get("constraint:message:message_thread_id_fkey")?.definition,
    ).toBe("FOREIGN KEY (thread_id) REFERENCES thread(id) ON DELETE CASCADE");
    expect(byKey.get("index:thread:thread_repo_lower_index")?.definition).toBe(
      "CREATE INDEX thread_repo_lower_index ON public.thread USING btree (lower(repo))",
    );
    expect(byKey.get("enum:null:status")?.definition).toBe("open, closed");
    expect(byKey.has("sequence:null:thread_id_seq")).toBe(true);
    // Sorted output: a stable report and a stable diff.
    const keys = catalog.entries.map((e) => `${e.kind}:${e.table}:${e.name}`);
    expect(keys).toEqual([...keys].sort((x, y) => x.localeCompare(y)));
  });

  it("leaves the migration ledger out", async () => {
    const db = await createFreshDb();
    dbs.push(db);
    const client = await db.connect();
    await ensureLedger(client);
    const catalog = await snapshotCatalog(client);
    expect(
      catalog.entries.filter((e) => e.table === "schema_migrations"),
    ).toEqual([]);
  });
});

describe("diffCatalogs against real databases", () => {
  it("reports a column only one side has", async () => {
    const [a, b] = await Promise.all([
      catalogOf(),
      catalogOf(`ALTER TABLE "thread" ADD COLUMN "archived" boolean;`),
    ]);
    const result = diffCatalogs(a, b, []);
    expect(result.diffs).toEqual([
      {
        kind: "column",
        table: "thread",
        name: "archived",
        change: "only-in-b",
        b: "boolean | null | default none",
      },
    ]);
  });

  it("reports an extra index", async () => {
    const [a, b] = await Promise.all([
      catalogOf(
        `CREATE INDEX "message_thread_index" ON "message" ("thread_id");`,
      ),
      catalogOf(),
    ]);
    const result = diffCatalogs(a, b, []);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatchObject({
      kind: "index",
      table: "message",
      name: "message_thread_index",
      change: "only-in-a",
    });
  });

  it("reports a default mismatch", async () => {
    const [a, b] = await Promise.all([
      catalogOf(),
      catalogOf(`ALTER TABLE "message" ALTER COLUMN "body" SET DEFAULT '';`),
    ]);
    const result = diffCatalogs(a, b, []);
    expect(result.diffs).toEqual([
      {
        kind: "column",
        table: "message",
        name: "body",
        change: "differs",
        a: "text | null | default none",
        b: "text | null | default ''::text",
      },
    ]);
  });

  it("treats identical schemas as clean, whatever the column order", async () => {
    // a declares "z" first inside CREATE TABLE; b appends it with ADD COLUMN,
    // the way a migration does. Same columns, different physical order.
    const sides = {
      a: `CREATE TABLE "ordered" ("z" text, "id" integer NOT NULL);`,
      b: `CREATE TABLE "ordered" ("id" integer NOT NULL);
          ALTER TABLE "ordered" ADD COLUMN "z" text;`,
    };
    const [left, right] = await Promise.all(
      [sides.a, sides.b].map(async (sql) => {
        const db = await createFreshDb();
        dbs.push(db);
        const client = await db.connect();
        await client.query(BASE + sql);
        const attnum = await client.query<{ attnum: number }>(
          `SELECT attnum FROM pg_attribute
            WHERE attrelid = 'public.ordered'::regclass AND attname = 'z'`,
        );
        return {
          catalog: await snapshotCatalog(client),
          attnum: attnum.rows[0]?.attnum,
        };
      }),
    );
    // Guard: the two sides really do differ in physical order.
    expect([left?.attnum, right?.attnum]).toEqual([1, 2]);
    const a = left?.catalog ?? { entries: [] };
    const b = right?.catalog ?? { entries: [] };
    expect(a.entries.some((e) => e.table === "ordered")).toBe(true);
    expect(diffCatalogs(a, b, [])).toEqual({
      diffs: [],
      allowed: [],
      unusedAllow: [],
    });
  });

  it("an allowlist entry absorbs its difference", async () => {
    const [a, b] = await Promise.all([
      catalogOf(),
      catalogOf(`ALTER TABLE "message" ALTER COLUMN "body" SET DEFAULT '';`),
    ]);
    const allow: AllowEntry[] = [
      {
        kind: "column",
        table: "message",
        name: "body",
        reason: "test: accepted default",
      },
    ];
    const result = diffCatalogs(a, b, allow);
    expect(result.diffs).toEqual([]);
    expect(result.unusedAllow).toEqual([]);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0]?.reason).toBe("test: accepted default");
  });

  it("a stale allowlist entry is reported", async () => {
    const [a, b] = await Promise.all([catalogOf(), catalogOf()]);
    const stale: AllowEntry = {
      kind: "index",
      table: "thread",
      name: "thread_repo_lower_index",
      reason: "test: no longer differs",
    };
    const result = diffCatalogs(a, b, [stale]);
    expect(result.diffs).toEqual([]);
    expect(result.unusedAllow).toEqual([stale]);
  });
});
