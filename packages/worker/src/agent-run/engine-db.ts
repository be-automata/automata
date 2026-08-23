import { Pool } from "pg";

/**
 * Worker → engine-DB reach (#69 §3.0). The engine Postgres backing hatchet-lite
 * publishes NO host port by default (`docker-compose.hatchet.yml`), and the
 * worker is a host process, not a compose-network member — so this connection
 * is opt-in end to end: it only exists when an operator has (a) brought the
 * engine up with the `docker-compose.hatchet.maintenance.yml` overlay, which
 * publishes Postgres on `127.0.0.1` only, and (b) set
 * `HATCHET_ENGINE_DATABASE_URL` to point at it. Neither happens on a box that
 * only ever runs plain `hatchet:up`.
 *
 * This module is intentionally the ONLY place a `pg.Pool` is constructed for
 * the maintenance mechanisms — every consumer (scheduling-health.ts) is written
 * against the narrower `PgLike` interface so it is trivially unit-testable
 * against a fake, and so `scheduling-health.ts` itself never imports `pg`
 * (its purity contract for #128, §7.3).
 */

/** The minimal query surface every scheduling-health consumer depends on. */
export interface PgLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

/**
 * Per-maintenance-connection hygiene (§3.0): a maintenance tick must never hold
 * a lock for long or run away on a slow query — this is engine-internal state,
 * not application data, and the box's ONE agent-run slot depends on the engine
 * staying responsive.
 *
 * `SET LOCAL` is transaction-scoped (a warning-level no-op outside one), which
 * is why `withConnection`/`withAdvisoryLock` open an explicit transaction
 * before applying it — the settings then die with the COMMIT/ROLLBACK and can
 * never leak onto a pooled connection reused by someone else.
 */
const CONNECTION_HYGIENE_SQL = [
  "SET LOCAL statement_timeout = '5s'",
  "SET LOCAL lock_timeout = '1s'",
  "SET LOCAL idle_in_transaction_session_timeout = '10s'",
].join("; ");

/** Advisory lock key pair used to serialise maintenance ticks across launchd units (§3.4). */
export const MAINTENANCE_ADVISORY_LOCK = { classId: 16725, objId: 69 } as const;

export interface EngineDb extends PgLike {
  /**
   * Runs `fn` with the connection hygiene preamble applied and inside a
   * transaction so every remediation query's own re-checked `WHERE` runs
   * against a consistent snapshot. Connection is released afterward regardless
   * of outcome.
   */
  withConnection<T>(fn: (client: PgLike) => Promise<T>): Promise<T>;
  /**
   * Tries to acquire the single maintenance advisory lock for the duration of
   * `fn`. Returns `{ acquired: false }` immediately (no work performed) if
   * another process already holds it — this is what makes concurrent ticks
   * from two launchd units safe (§3.4, AC-10). The lock is released in a
   * `finally` inside the same connection/transaction that acquired it.
   */
  withAdvisoryLock<T>(
    fn: (client: PgLike) => Promise<T>,
  ): Promise<{ acquired: true; result: T } | { acquired: false }>;
  close(): Promise<void>;
}

/** Builds an EngineDb from a raw `pg.Pool`-shaped client. Exposed for tests that inject a fake pool. */
export function createEngineDbFromPool(pool: {
  connect(): Promise<{
    query: PgLike["query"];
    release(): void;
  }>;
  end(): Promise<void>;
}): EngineDb {
  return {
    async query(text, params) {
      const client = await pool.connect();
      try {
        return await client.query(text, params);
      } finally {
        client.release();
      }
    },
    async withConnection(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        try {
          await client.query(CONNECTION_HYGIENE_SQL);
          const result = await fn(client);
          await client.query("COMMIT");
          return result;
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // best-effort; connection is released either way
          }
          throw err;
        }
      } finally {
        client.release();
      }
    },
    async withAdvisoryLock(fn) {
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("BEGIN");
        inTransaction = true;
        await client.query(CONNECTION_HYGIENE_SQL);
        const lockResult = await client.query<{ pg_try_advisory_lock: boolean }>(
          "SELECT pg_try_advisory_lock($1::int, $2::int) AS pg_try_advisory_lock",
          [MAINTENANCE_ADVISORY_LOCK.classId, MAINTENANCE_ADVISORY_LOCK.objId],
        );
        const acquired = lockResult.rows[0]?.pg_try_advisory_lock === true;
        if (!acquired) {
          await client.query("ROLLBACK");
          inTransaction = false;
          return { acquired: false };
        }
        try {
          const result = await fn(client);
          // Session-level advisory locks survive COMMIT; the unlock below (or,
          // worst case, the pool releasing the session) drops the lock.
          await client.query("COMMIT");
          inTransaction = false;
          return { acquired: true, result };
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // best-effort
          }
          inTransaction = false;
          throw err;
        } finally {
          try {
            await client.query(
              "SELECT pg_advisory_unlock($1::int, $2::int)",
              [MAINTENANCE_ADVISORY_LOCK.classId, MAINTENANCE_ADVISORY_LOCK.objId],
            );
          } catch {
            // Best-effort: the connection is about to be released back to the
            // pool regardless, which also drops session-scoped advisory locks.
          }
        }
      } catch (err) {
        if (inTransaction) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // best-effort
          }
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * Pool options for the engine-DB reach, exported so tests can assert them.
 * `max: 2` — the maintenance loop is single-flight plus one connection of
 * headroom for an occasional direct query. `connectionTimeoutMillis` bounds
 * `pool.connect()` itself: the SET LOCAL statement/lock timeouts only apply
 * once a connection exists, so without this a routable-but-unresponsive engine
 * host (firewall drop, network partition) would hang `pool.connect()` — and
 * with it the awaited `bootTimeSlotReclaim` boot path — indefinitely (AC-14).
 */
export const ENGINE_DB_POOL_OPTIONS = {
  max: 2,
  connectionTimeoutMillis: 5_000,
} as const;

/**
 * Master gate (§3.0): returns `null` when `HATCHET_ENGINE_DATABASE_URL` is
 * unset, which is how every mechanism in this ticket stays an inert no-op on a
 * box that never opted in.
 */
export function createEngineDb(env: NodeJS.ProcessEnv = process.env): EngineDb | null {
  const connectionString = env.HATCHET_ENGINE_DATABASE_URL?.trim();
  if (!connectionString) {
    return null;
  }
  const pool = new Pool({ connectionString, ...ENGINE_DB_POOL_OPTIONS });
  return createEngineDbFromPool(pool);
}

/**
 * Resolves the tenant every maintenance query scopes to (§3.0 tenant-scope
 * invariant — a multi-tenant engine must never let one tenant's maintenance
 * touch another's rows). `HATCHET_ENGINE_TENANT_ID`, when set, wins outright;
 * otherwise falls back to the single row observed live (§2.6). Throws if
 * neither is available and the engine has zero or >1 tenants — an ambiguous
 * tenant must never be silently guessed for a mutating mechanism.
 */
export async function resolveTenantId(
  db: PgLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const explicit = env.HATCHET_ENGINE_TENANT_ID?.trim();
  if (explicit) {
    return explicit;
  }
  const result = await db.query<{ id: string }>('SELECT id FROM "Tenant"');
  if (result.rows.length === 1) {
    const id = result.rows[0]?.id;
    if (id) {
      return id;
    }
  }
  throw new Error(
    `resolveTenantId: expected exactly 1 tenant when HATCHET_ENGINE_TENANT_ID is unset, found ${result.rows.length}`,
  );
}
