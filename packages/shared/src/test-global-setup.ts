import {
  SetupResult,
  setupTestContainers,
  teardownTestContainers,
} from "@terragon/dev-env/test-global-setup";
import path from "path";
import { execSync } from "child_process";
import { createDb } from "./db";
import { seedFeatureFlags } from "./model/feature-flags";

let setupResult: SetupResult;

export async function setup() {
  const start = Date.now();
  console.log("Starting test containers...");
  setupResult = await setupTestContainers();
  console.log(`Test containers started. (${Date.now() - start}ms)`);
  process.env.DATABASE_URL = setupResult.DATABASE_URL;
  process.env.REDIS_URL = setupResult.REDIS_HTTP_URL;
  process.env.REDIS_TOKEN = setupResult.REDIS_HTTP_TOKEN;

  // Applying drizzle schema to test database
  console.log("Applying drizzle schema to test database...");
  try {
    const result = execSync("pnpm drizzle-kit-push-test", {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        DATABASE_URL: setupResult.DATABASE_URL,
      },
    });
    console.log("Drizzle schema applied to test database.");
    console.log("Command output:", result.toString());

    // Seed the baseline feature-flag rows the suite assumes exist. In test mode
    // `getFeatureFlags` does not auto-create flags, so a schema-only database
    // makes any flag-by-name read (e.g. setUserFeatureFlagOverride) throw
    // `Feature flag "X" does not exist`.
    console.log("Seeding feature flags into test database...");
    const db = createDb(setupResult.DATABASE_URL);
    await seedFeatureFlags({ db });
    console.log("Feature flags seeded.");
  } catch (error) {
    console.error("Error applying drizzle schema to test database.");
    console.error(
      "Error message:",
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
}

export async function teardown() {
  await teardownTestContainers();
}
