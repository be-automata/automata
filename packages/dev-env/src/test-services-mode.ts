/**
 * Pure helpers that decide where the Postgres/Redis-backed test suites get
 * their services from. Kept free of I/O so they can be unit-tested anywhere.
 *
 * Either way the per-run database is created and dropped over TCP with `pg`
 * through an admin (maintenance-database) URL:
 * - default: `pnpm docker-up-tests` starts the compose stack and the admin URL
 *   is its superuser, DOCKER_ADMIN_URL;
 * - external: `TEST_DATABASE_ADMIN_URL` points at an already-running Postgres
 *   (e.g. a loopback-only cluster on a box without Docker) as a CREATEDB role,
 *   and nothing is started.
 */

export const DOCKER_ADMIN_URL =
  "postgresql://postgres:postgres@localhost:15432/postgres";

export interface ExternalTestServices {
  /** Maintenance-database URL for a role with CREATEDB. */
  adminUrl: string;
  /**
   * Upstash-compatible Redis HTTP endpoint. Empty means apps/www/src/lib/redis.ts
   * uses its in-memory stand-in (its `REDIS_URL` validator has `allowEmpty`).
   */
  redisHttpUrl: string;
  redisHttpToken: string;
}

/** Exactly the shape `uniqueDbName()` generates; nothing else reaches SQL. */
const SAFE_TEST_DB_NAME = /^test_[a-z0-9_]{1,58}$/;

export function assertSafeTestDbName(name: string): void {
  if (!SAFE_TEST_DB_NAME.test(name)) {
    throw new Error(
      `Refusing to use test database name ${JSON.stringify(name)}: it must match ${SAFE_TEST_DB_NAME}`,
    );
  }
}

/**
 * A fresh per-run database name. Lowercase, <63 chars, valid identifier. PID +
 * time + random keeps concurrent runs on the same host from colliding. This is
 * the one place a name is made, so it is the one place it is validated.
 */
export function uniqueDbName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const name =
    `test_${process.pid}_${Date.now().toString(36)}_${rand}`.toLowerCase();
  assertSafeTestDbName(name);
  return name;
}

/** The URL with its password (userinfo or `password` param) hidden, safe to print. */
export function redactDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.password) {
    url.password = "REDACTED";
  }
  if (url.searchParams.has("password")) {
    url.searchParams.set("password", "REDACTED");
  }
  return url.toString();
}

/**
 * Validates a TEST_DATABASE_ADMIN_URL and returns it with an empty database
 * path defaulted to `/postgres`. Errors never echo the value: it carries a
 * password.
 */
function normalizeAdminUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("TEST_DATABASE_ADMIN_URL is not a valid URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(
      `TEST_DATABASE_ADMIN_URL must be a postgres:// or postgresql:// URL (got ${url.protocol})`,
    );
  }
  if (!url.hostname) {
    throw new Error("TEST_DATABASE_ADMIN_URL has no host");
  }
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/postgres";
  }
  return url.toString();
}

/** External services from env, or null for the default docker compose path. */
export function resolveExternalTestServices(
  env: Record<string, string | undefined>,
): ExternalTestServices | null {
  const adminUrl = env.TEST_DATABASE_ADMIN_URL?.trim() ?? "";
  if (!adminUrl) {
    return null;
  }
  const redisHttpUrl = env.TEST_REDIS_HTTP_URL?.trim() ?? "";
  const redisHttpToken = env.TEST_REDIS_HTTP_TOKEN?.trim() ?? "";
  if (redisHttpUrl && !redisHttpToken) {
    throw new Error(
      "TEST_REDIS_HTTP_URL is set but TEST_REDIS_HTTP_TOKEN is not",
    );
  }
  return {
    adminUrl: normalizeAdminUrl(adminUrl),
    redisHttpUrl,
    redisHttpToken,
  };
}

/**
 * The admin URL pointed at `dbName` instead of the maintenance database.
 * Credentials, host, port and query parameters (e.g. `sslmode`) are kept.
 */
export function testDatabaseUrl(adminUrl: string, dbName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}
