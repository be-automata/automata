import { drizzle } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { Pool as NeonPool } from "@neondatabase/serverless";
import { sql, SQLWrapper } from "drizzle-orm";
import * as schema from "./schema";

/**
 * Pick the DB driver by environment:
 *   - `node-postgres` (TCP) — the default; used by the VPS/self-host runtime and
 *     the testcontainer harness against a local/containerized Postgres.
 *   - `neon-serverless` (WebSocket) — used on Cloudflare Workers (node-postgres
 *     does not run on workerd) and for the Neon Postgres target.
 *
 * Selection: explicit `DB_DRIVER=neon-serverless|node-postgres` wins; otherwise a
 * Neon-shaped connection string routes to neon-serverless. neon-serverless is used
 * (not neon-http) because the app relies on interactive `db.transaction()` — which
 * neon-http cannot do. Node 22+ and workerd both provide a global WebSocket, so no
 * `ws` polyfill is imported (keeping the Workers bundle free of node-only modules).
 */
function selectDriver(
  databaseUrl: string,
): "neon-serverless" | "node-postgres" {
  const explicit = process.env.DB_DRIVER;
  if (explicit === "neon-serverless" || explicit === "node-postgres") {
    return explicit;
  }
  return /neon\.tech|neon\.build|\.neon\./i.test(databaseUrl)
    ? "neon-serverless"
    : "node-postgres";
}

// The canonical DB type is the node-postgres drizzle instance created from a
// connection string (it carries the `$client` accessor the test harness uses).
// The neon-serverless instance is query/transaction-API-compatible for this
// codebase's usage and is cast to it.
function createNodePgDb(databaseUrl: string) {
  return drizzle(databaseUrl, { schema });
}

export type DB = ReturnType<typeof createNodePgDb>;

export function createDb(databaseUrl: string): DB {
  if (selectDriver(databaseUrl) === "neon-serverless") {
    const pool = new NeonPool({ connectionString: databaseUrl });
    return drizzleNeon(pool, { schema }) as unknown as DB;
  }
  return createNodePgDb(databaseUrl);
}

/**
 * Helper to explain a drizzle query.
 */
export async function explainQuery<T extends SQLWrapper>(db: DB, query: T) {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  try {
    // @ts-expect-error - toSQL is not a method on SQLWrapper
    console.log(query.toSQL());
  } catch {}
  const debugResult = await db.execute(sql`EXPLAIN ${query.getSQL()}`);
  console.debug(debugResult?.rows.map((row) => row["QUERY PLAN"]).join("\n"));
}
