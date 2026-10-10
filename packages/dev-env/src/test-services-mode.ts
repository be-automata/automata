/**
 * Pure helpers that decide where the Postgres/Redis-backed test suites get
 * their services from. Kept free of I/O so they can be unit-tested anywhere.
 *
 * - `docker` (default): `pnpm docker-up-tests` starts the compose stack and the
 *   per-run database is created through `docker exec … psql`.
 * - `external`: `TEST_DATABASE_ADMIN_URL` points at an already-running Postgres
 *   (e.g. a loopback-only cluster on a box without Docker). The per-run database
 *   is created/dropped over TCP with the `pg` client and nothing is started.
 */

export interface DockerTestServicesMode {
  kind: "docker";
}

export interface ExternalTestServicesMode {
  kind: "external";
  /** Maintenance-database URL for a role with CREATEDB. */
  adminUrl: string;
  /**
   * Upstash-compatible Redis HTTP endpoint. Empty means apps/www/src/lib/redis.ts
   * uses its in-memory stand-in (its `REDIS_URL` validator has `allowEmpty`).
   */
  redisHttpUrl: string;
  redisHttpToken: string;
}

export type TestServicesMode =
  | DockerTestServicesMode
  | ExternalTestServicesMode;

/** Exactly the shape `uniqueDbName()` generates; nothing else reaches SQL. */
const SAFE_TEST_DB_NAME = /^test_[a-z0-9_]{1,58}$/;

export function isSafeTestDbName(name: string): boolean {
  return SAFE_TEST_DB_NAME.test(name);
}

export function assertSafeTestDbName(name: string): void {
  if (!isSafeTestDbName(name)) {
    throw new Error(
      `Refusing to use test database name ${JSON.stringify(name)}: it must match ${SAFE_TEST_DB_NAME}`,
    );
  }
}

/** The URL with its password replaced, safe to print. */
export function redactDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.password) {
    url.password = "REDACTED";
  }
  return url.toString();
}

function parseAdminUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Never echo the raw value: it carries a password.
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
  return raw;
}

export function resolveTestServicesMode(
  env: Record<string, string | undefined>,
): TestServicesMode {
  const adminUrl = env.TEST_DATABASE_ADMIN_URL?.trim() ?? "";
  if (!adminUrl) {
    return { kind: "docker" };
  }
  const redisHttpUrl = env.TEST_REDIS_HTTP_URL?.trim() ?? "";
  const redisHttpToken = env.TEST_REDIS_HTTP_TOKEN?.trim() ?? "";
  if (redisHttpUrl && !redisHttpToken) {
    throw new Error(
      "TEST_REDIS_HTTP_URL is set but TEST_REDIS_HTTP_TOKEN is not",
    );
  }
  return {
    kind: "external",
    adminUrl: parseAdminUrl(adminUrl),
    redisHttpUrl,
    redisHttpToken,
  };
}

/**
 * The admin URL pointed at `dbName` instead of the maintenance database.
 * Credentials, host, port and query parameters (e.g. `sslmode`) are kept.
 */
export function testDatabaseUrl(adminUrl: string, dbName: string): string {
  assertSafeTestDbName(dbName);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}
