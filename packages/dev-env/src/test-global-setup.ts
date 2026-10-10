import { execSync } from "child_process";
import path from "path";

import {
  DOCKER_ADMIN_URL,
  redactDatabaseUrl,
  resolveExternalTestServices,
  testDatabaseUrl,
  uniqueDbName,
} from "./test-services-mode";

export type SetupResult = {
  DATABASE_URL: string;
  REDIS_HTTP_URL: string;
  REDIS_HTTP_TOKEN: string;
};

const REDIS_HTTP_TOKEN = "redis_test_token";
const COMPOSE_FILE_DIR = path.join(__dirname, "..");

// Each vitest invocation gets its own throwaway database so that concurrent
// runs (multiple suites, multiple agents/CI jobs sharing this one long-lived
// Postgres) never corrupt each other. The previous approach dropped and
// recreated the shared `public` schema on every setup, so one run's
// `DROP SCHEMA public CASCADE` would delete another run's tables mid-flight —
// the source of nondeterministic FK violations, missing-relation errors, and
// "Unauthorized" failures across agents running the same commit.
let createdDb: { adminUrl: string; dbName: string } | null = null;

async function queryAdminDb(adminUrl: string, sql: string): Promise<void> {
  // Against the maintenance database: CREATE/DROP DATABASE cannot run inside a
  // transaction (a plain client query is autocommit) and must not target the
  // database being created/dropped.
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function startDockerServices(): Omit<SetupResult, "DATABASE_URL"> {
  console.log("Starting test containers...");
  // Start the containers using the pnpm script (this is idempotent).
  execSync("pnpm docker-up-tests", {
    cwd: COMPOSE_FILE_DIR,
    stdio: "inherit",
  });

  // Clear Redis data. NOTE: Redis is still shared across concurrent runs; the
  // Upstash layer is quarantined behind an in-memory fallback so this is not a
  // correctness hazard for the Postgres-backed suites, but per-run Redis
  // isolation is a follow-up if Redis-backed tests start flaking.
  try {
    execSync(`docker exec terragon_redis_test redis-cli FLUSHALL`, {
      stdio: "inherit",
    });
  } catch (error) {
    console.warn("Failed to clear Redis test data:", error);
  }
  return { REDIS_HTTP_URL: "http://localhost:18079", REDIS_HTTP_TOKEN };
}

export async function setupTestContainers(): Promise<SetupResult> {
  // TEST_DATABASE_ADMIN_URL set: no Docker. Postgres is an already-running
  // server reached as a CREATEDB role; Redis is a provided Upstash-compatible
  // HTTP endpoint or empty, which routes apps/www/src/lib/redis.ts to its
  // in-memory stand-in.
  const external = resolveExternalTestServices(process.env);
  let adminUrl: string;
  let redis: Omit<SetupResult, "DATABASE_URL">;
  if (external) {
    console.log(
      `TEST_DATABASE_ADMIN_URL is set: using external Postgres at ${redactDatabaseUrl(external.adminUrl)} (no docker compose)`,
    );
    if (!external.redisHttpUrl) {
      console.log(
        "TEST_REDIS_HTTP_URL is unset: Redis-backed code uses the in-memory stand-in",
      );
    }
    adminUrl = external.adminUrl;
    redis = {
      REDIS_HTTP_URL: external.redisHttpUrl,
      REDIS_HTTP_TOKEN: external.redisHttpToken,
    };
  } else {
    redis = startDockerServices();
    adminUrl = DOCKER_ADMIN_URL;
  }

  // Create an isolated, empty database for this run. Never touch the shared
  // `public` schema of the default database — concurrent runs live in it.
  const dbName = uniqueDbName();
  await queryAdminDb(adminUrl, `CREATE DATABASE "${dbName}";`);
  createdDb = { adminUrl, dbName };
  console.log(`Created isolated test database: ${dbName}`);

  return { DATABASE_URL: testDatabaseUrl(adminUrl, dbName), ...redis };
}

export async function teardownTestContainers(): Promise<void> {
  // Drop this run's isolated database. Containers (if any) stay up for fast
  // subsequent runs. WITH (FORCE) terminates lingering pooled connections.
  if (!createdDb) {
    return;
  }
  const { adminUrl, dbName } = createdDb;
  createdDb = null;
  try {
    await queryAdminDb(
      adminUrl,
      `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE);`,
    );
    console.log(`Dropped isolated test database: ${dbName}`);
  } catch (error) {
    console.warn(`Failed to drop test database ${dbName}:`, error);
  }
}
