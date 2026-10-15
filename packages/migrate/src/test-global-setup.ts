import {
  setupTestContainers,
  teardownTestContainers,
} from "@terragon/dev-env/test-global-setup";

/**
 * One throwaway database per vitest run (docker compose test Postgres, or
 * TEST_DATABASE_ADMIN_URL). Tests connect to it only to CREATE/DROP their own
 * per-test databases (see test-db.ts), because most cases need an EMPTY one.
 */
export async function setup(): Promise<void> {
  const result = await setupTestContainers();
  process.env.MIGRATE_TEST_ADMIN_URL = result.DATABASE_URL;
}

export async function teardown(): Promise<void> {
  await teardownTestContainers();
}
