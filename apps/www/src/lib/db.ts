import { createDb, type DB } from "@terragon/shared/db";
import { env } from "@terragon/env/apps-www";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Request-scoped database handle.
 *
 * The neon-serverless driver (used on Cloudflare Workers) holds a WebSocket that
 * is bound to the *request's* I/O context. A module-level singleton `db` shares
 * that one Pool across every request in the isolate — and workerd forbids using an
 * I/O object created by one request from another request. The symptom the operator
 * hit is the request hanging ("the runtime canceled this request because your code
 * had hung"), with the "a promise was resolved from a different request context"
 * warning as the tell. The `no_handle_cross_request_promise_resolution` compat flag
 * silences that warning class but does NOT make cross-request socket use legal, so
 * the hang survives it — the real fix is to never share the Pool across requests.
 *
 * So: on Workers we create ONE Pool per request, cached on that request's
 * ExecutionContext (a fresh object per request → a fresh Pool). workerd closes the
 * socket when the request's I/O context is torn down, so we do not `pool.end()`
 * ourselves (there is no safe "after the last query" hook to place it, and ending
 * early would break later queries in the same request).
 *
 * Off Workers (self-host/node/tests) getCloudflareContext() throws → we use a
 * long-lived singleton, which is correct: node-postgres' TCP pool is designed to be
 * shared and has no per-request I/O rule.
 */

let nodeSingleton: DB | undefined;
function offWorkersDb(): DB {
  if (!nodeSingleton) {
    nodeSingleton = createDb(env.DATABASE_URL);
  }
  return nodeSingleton;
}

const perRequestDb = new WeakMap<object, DB>();

function resolveDb(): DB {
  let ctx: object | undefined;
  try {
    // The request's ExecutionContext — a distinct object per request on Workers.
    ctx = getCloudflareContext().ctx as unknown as object | undefined;
  } catch {
    return offWorkersDb();
  }
  if (!ctx) {
    return offWorkersDb();
  }
  let db = perRequestDb.get(ctx);
  if (!db) {
    db = createDb(env.DATABASE_URL);
    perRequestDb.set(ctx, db);
  }
  return db;
}

/**
 * The shared `db` import used across the app. It is a proxy so the 165+ call sites
 * keep `import { db } from "@/lib/db"` unchanged while the underlying handle is
 * resolved per request (Workers) or once (off Workers).
 */
export const db: DB = new Proxy({} as DB, {
  get(_target, prop, receiver) {
    const target = resolveDb();
    const value = Reflect.get(target as object, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(_target, prop) {
    return prop in (resolveDb() as object);
  },
});
