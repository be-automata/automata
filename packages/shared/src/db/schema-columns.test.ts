import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createDb } from "./index";
import { listSchemaColumns, listSchemaUniqueIndexes } from "./schema-columns";

// The test database is pushed from schema.ts by test-global-setup, so it is the
// ground truth for what the derived lists must contain.
// Non-null: test-global-setup sets DATABASE_URL before any test file loads.
const db = createDb(process.env.DATABASE_URL!);

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

async function rowsOf<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

describe("schema-columns", () => {
  it("lists exactly the columns the pushed schema has", async () => {
    const rows = await rowsOf<{ table_name: string; column_name: string }>(
      sql`SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public'`,
    );
    const fromDb = rows.map((r) => `${r.table_name}.${r.column_name}`).sort();
    const derived = listSchemaColumns()
      .map((c) => `${c.table}.${c.column}`)
      .sort();
    expect(derived).toEqual(fromDb);
  });

  it("lists exactly the unique indexes the pushed schema has", async () => {
    const rows = await rowsOf<{ name: string }>(
      sql`SELECT c.relname AS name
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND i.indisunique AND NOT i.indisprimary`,
    );
    const fromDb = rows.map((r) => r.name).sort();
    expect([...listSchemaUniqueIndexes()].sort()).toEqual(fromDb);
  });

  it("includes the entries the hand-kept gate list used to name", () => {
    const columns = listSchemaColumns().map((c) => `${c.table}.${c.column}`);
    expect(columns).toContain("organization.is_personal");
    expect(columns).toContain("egress_events.mode");
    const indexes = listSchemaUniqueIndexes();
    expect(indexes).toContain("environment_org_user_repo_unique");
    expect(indexes).toContain("environment_user_global_unique");
  });
});
