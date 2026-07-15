import {
  SetupResult,
  setupTestContainers,
  teardownTestContainers,
} from "@terragon/dev-env/test-global-setup";
import path from "path";
import { execSync } from "child_process";
import { sql } from "drizzle-orm";
import { createDb, DB } from "./db";
import { seedFeatureFlags } from "./model/feature-flags";

let setupResult: SetupResult;

// Sentinel tables that MUST exist after a successful schema push. If any is
// missing, `drizzle-kit push` silently skipped statements (e.g. an interactive
// prompt auto-declined in a non-TTY, or a concurrent run corrupted the schema)
// and the suite would otherwise fail later with confusing missing-relation / FK
// errors. Failing here turns that into one loud, unambiguous error.
const REQUIRED_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "feature_flags",
  "user_feature_flags",
  "automations",
  "organization",
  "member",
  "invitation",
  "thread",
  "thread_chat",
  "subscription",
  "github_check_run",
];

async function verifySchemaApplied(db: DB): Promise<void> {
  const rows = (await db.execute(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  )) as unknown as { rows: Array<{ table_name: string }> };
  const present = new Set(rows.rows.map((r) => r.table_name));
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  if (missing.length > 0) {
    throw new Error(
      `Schema push incomplete: ${missing.length} required table(s) missing after drizzle-kit push: ` +
        `${missing.join(", ")}. Present tables: ${present.size}. ` +
        `This indicates drizzle-kit push skipped statements or the test database was corrupted ` +
        `by a concurrent run. Aborting so the failure is unambiguous.`,
    );
  }
}

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

    const db = createDb(setupResult.DATABASE_URL);

    // Fail loudly if the push did not produce the full schema.
    await verifySchemaApplied(db);

    // Seed the baseline feature-flag rows the suite assumes exist. In test mode
    // `getFeatureFlags` does not auto-create flags, so a schema-only database
    // makes any flag-by-name read (e.g. setUserFeatureFlagOverride) throw
    // `Feature flag "X" does not exist`.
    console.log("Seeding feature flags into test database...");
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
