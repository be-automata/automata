import { drizzle } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { Pool as NeonPool } from "@neondatabase/serverless";
import { sql, SQLWrapper } from "drizzle-orm";
import * as schema from "./schema";

/**
 * Pick the DB driver by environment:
 *   - `node-postgres` (TCP) — the default; used by the VPS/self-host runtime and
 *     the testcontainer harness against a local/containerized Postgres.
 *   - `neon-serverless` (WebSocket) — the Cloudflare Workers fallback when no
 *     Hyperdrive binding is configured, and the Neon Postgres target off Workers.
 *
 * On Workers with a Hyperdrive binding, apps/www calls `createDbFromHyperdrive`
 * instead (node-postgres over workerd TCP sockets through Hyperdrive).
 *
 * Selection: explicit `DB_DRIVER=neon-serverless|node-postgres` wins; otherwise a
 * Neon-shaped connection string routes to neon-serverless. neon-serverless is used
 * (not neon-http) because the app relies on interactive `db.transaction()` — which
 * neon-http cannot do. Node 22+ and workerd both provide a global WebSocket, so no
 * `ws` polyfill is imported (keeping the Workers bundle free of node-only modules).
 */
/** Max wait for a pooled connection before the checkout rejects (TMO-01). */
const DB_CONNECT_TIMEOUT_MS = 5000;

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
  // connectionTimeoutMillis: a saturated pool must fail a checkout fast, not
  // hang a 30s waitUntil (TMO-01). drizzle forwards `connection` to pg.Pool.
  return drizzle({
    connection: {
      connectionString: databaseUrl,
      connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    },
    schema,
  });
}

/**
 * Re-exported so callers OUTSIDE a workspace package — notably deploy/*.ts,
 * which has no package.json of its own — can build raw queries without a bare
 * `drizzle-orm` import. Such an import resolves only if drizzle-orm happens to
 * be hoisted to the repo-root node_modules; it is not a root dependency, so
 * that is an accident of the current install rather than a guarantee. Routing
 * through this module keeps the resolution rooted in packages/shared, which
 * genuinely depends on drizzle-orm. (#173 review.)
 */
export { sql } from "drizzle-orm";

export type DB = ReturnType<typeof createNodePgDb>;

/**
 * The rows of a raw `db.execute(...)` result. The node-postgres and
 * neon-serverless results both carry `rows`; anything else reads as no rows.
 */
export function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? [];
}

/**
 * A pg-style Pool re-emits an IDLE client's socket error as its own "error"
 * event, and an EventEmitter with no "error" listener throws. On Workers a
 * Neon WebSocket dropping (request teardown, Neon closing an idle socket)
 * surfaced as `Unhandled error. (Uncaught Error: Network connection lost.)`
 * after page loads, and could fail a render still in flight. The pool has
 * already removed the broken client when it emits, so the only job here is to
 * keep the event from throwing; queries in progress still get their own error.
 */
function onIdleConnectionError(error: unknown): void {
  console.warn(
    "[db] idle connection error (connection discarded):",
    error instanceof Error ? error.message : String(error),
  );
}

export function createDb(databaseUrl: string): DB {
  if (selectDriver(databaseUrl) === "neon-serverless") {
    const pool = new NeonPool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    });
    pool.on("error", onIdleConnectionError);
    return drizzleNeon(pool, { schema }) as unknown as DB;
  }
  const db = createNodePgDb(databaseUrl);
  db.$client.on("error", onIdleConnectionError);
  return db;
}

/**
 * Max sockets one request's pool may open to Hyperdrive. Workers cap a request
 * at 6 simultaneous outbound connections (fetch + TCP combined), so the pool
 * stays below that and leaves room for the request's own fetches.
 */
const HYPERDRIVE_POOL_MAX = 5;

/**
 * A node-postgres drizzle handle over a Cloudflare Hyperdrive binding's
 * `connectionString` (Workers only).
 *
 * Hyperdrive keeps warm, pooled connections next to the database and terminates
 * the client handshake at the edge, so a per-request client is cheap — the
 * Cloudflare-recommended pattern is to build a fresh client for EVERY request and
 * let Hyperdrive do the pooling. The caller must therefore never share the
 * returned handle across requests (workerd forbids cross-request I/O).
 *
 * A pg.Pool (not a single Client) backs it so `db.transaction()` checks out one
 * dedicated connection for the interactive transaction while other queries of
 * the same request keep running; Hyperdrive pools in transaction mode, so the
 * whole BEGIN…COMMIT stays on one origin connection.
 */
export function createDbFromHyperdrive(connectionString: string): DB {
  const db = drizzle({
    connection: {
      connectionString,
      connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
      max: HYPERDRIVE_POOL_MAX,
    },
    schema,
  });
  db.$client.on("error", onIdleConnectionError);
  return db;
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
