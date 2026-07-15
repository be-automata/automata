import { execFileSync, execSync } from "child_process";
import path from "path";

export type SetupResult = {
  DATABASE_URL: string;
  REDIS_URL: string;
  REDIS_HTTP_URL: string;
  REDIS_HTTP_TOKEN: string;
};

const REDIS_HTTP_TOKEN = "redis_test_token";
const COMPOSE_FILE_DIR = path.join(__dirname, "..");
const POSTGRES_CONTAINER = "terragon_postgres_test";
const PG_SUPERUSER = "postgres";
const PG_HOST = "localhost";
const PG_PORT = "15432";

// Each vitest invocation gets its own throwaway database so that concurrent
// runs (multiple suites, multiple agents/CI jobs sharing this one long-lived
// compose Postgres) never corrupt each other. The previous approach dropped and
// recreated the shared `public` schema on every setup, so one run's
// `DROP SCHEMA public CASCADE` would delete another run's tables mid-flight —
// the source of nondeterministic FK violations, missing-relation errors, and
// "Unauthorized" failures across agents running the same commit.
let createdDbName: string | null = null;

function psqlOnMaintenanceDb(sql: string): void {
  // Run against the default `postgres` maintenance database via the container's
  // psql. Statements like CREATE/DROP DATABASE cannot run in a transaction and
  // must not target the database being created/dropped.
  execFileSync(
    "docker",
    [
      "exec",
      POSTGRES_CONTAINER,
      "psql",
      "-U",
      PG_SUPERUSER,
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { stdio: "inherit" },
  );
}

function uniqueDbName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  // Lowercase, <63 chars, valid identifier. PID + time + random keeps concurrent
  // runs on the same host from colliding.
  return `test_${process.pid}_${Date.now().toString(36)}_${rand}`.toLowerCase();
}

export async function setupTestContainers(): Promise<SetupResult> {
  console.log("Starting test containers...");
  // Start the containers using the pnpm script (this is idempotent).
  execSync("pnpm docker-up-tests", {
    cwd: COMPOSE_FILE_DIR,
    stdio: "inherit",
  });

  // Create an isolated, empty database for this run. Never touch the shared
  // `public` schema of the default database — concurrent runs live in it.
  const dbName = uniqueDbName();
  psqlOnMaintenanceDb(`CREATE DATABASE ${dbName};`);
  createdDbName = dbName;
  console.log(`Created isolated test database: ${dbName}`);

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

  return {
    DATABASE_URL: `postgresql://${PG_SUPERUSER}:postgres@${PG_HOST}:${PG_PORT}/${dbName}`,
    REDIS_URL: "redis://localhost:16379",
    REDIS_HTTP_URL: "http://localhost:18079",
    REDIS_HTTP_TOKEN,
  };
}

export async function teardownTestContainers(): Promise<void> {
  // Drop this run's isolated database. Containers stay up for fast subsequent
  // runs. WITH (FORCE) terminates any lingering pooled connections (PG 13+).
  if (!createdDbName) {
    return;
  }
  try {
    psqlOnMaintenanceDb(
      `DROP DATABASE IF EXISTS ${createdDbName} WITH (FORCE);`,
    );
    console.log(`Dropped isolated test database: ${createdDbName}`);
  } catch (error) {
    console.warn(`Failed to drop test database ${createdDbName}:`, error);
  } finally {
    createdDbName = null;
  }
}
