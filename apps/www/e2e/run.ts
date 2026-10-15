/**
 * Entry point for the Playwright two-org suite.
 *
 *   pnpm --filter @terragon/www e2e:build   # next build with the e2e env
 *   pnpm --filter @terragon/www e2e [playwright args]
 *
 * The run provisions everything BEFORE Playwright starts, because Playwright
 * may launch its webServer (`next start`) before globalSetup runs:
 *   1. a throwaway Postgres database (+ the test Redis) via @terragon/dev-env;
 *   2. the schema, with `drizzle-kit push`;
 *   3. the seeded world (e2e/support/seed.ts) and signed session cookies;
 * then runs `playwright test`, fails the run if the egress guard refused any
 * outbound call, and drops the database in `finally`.
 *
 * It never reads a .env file and never targets a hosted database: the only
 * database it touches is the one it just created.
 */
import { spawn, execSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  setupTestContainers,
  teardownTestContainers,
} from "@terragon/dev-env/test-global-setup";
import { createDb } from "@terragon/shared/db";
import { Pool } from "pg";

import { E2E_BASE_URL, e2eBuildEnv } from "./e2e-env";
import { seedTwoOrgWorld } from "./support/seed";
import { createSessionCookie, storageStateFor } from "./support/session";
import {
  AUTH_DIR,
  E2E_DIR,
  STATE_DIR,
  WORLD,
  WORLD_STATE_FILE,
  type WorldState,
} from "./support/world";

const WWW_DIR = path.resolve(E2E_DIR, "..");
const SHARED_DIR = path.resolve(WWW_DIR, "../../packages/shared");

interface EgressEntry {
  kind: string;
  url?: string;
  via?: string;
  method?: string;
}

function runChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: WWW_DIR, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** The e2e env on top of the caller's, minus anything that could misroute. */
function baseEnv(): NodeJS.ProcessEnv {
  // NODE_OPTIONS from the caller must not leak a loader into the server.
  // NODE_ENV is production everywhere: `next build`/`next start` force it
  // anyway, and envsafe then refuses to fall back to its dev defaults.
  const { NODE_OPTIONS: _nodeOptions, ...inherited } = process.env;
  return {
    ...inherited,
    ...e2eBuildEnv(),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

/**
 * `next build`/`next start` load these on their own and fill in every
 * variable the e2e env leaves unset — a developer's production file would
 * hand the suite real credentials. Refuse instead of guessing which keys.
 */
const NEXT_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
];

function assertNoNextEnvFiles(): void {
  const present = NEXT_ENV_FILES.filter((file) =>
    existsSync(path.join(WWW_DIR, file)),
  );
  if (present.length > 0) {
    throw new Error(
      `Refusing to run: apps/www has ${present.join(", ")}, which next would load into the e2e server. Run the suite from a checkout without them.`,
    );
  }
}

async function build(): Promise<number> {
  assertNoNextEnvFiles();
  return runChild("pnpm", ["run", "build"], baseEnv());
}

function readEgressLog(file: string): EgressEntry[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as EgressEntry);
}

async function seed(databaseUrl: string): Promise<WorldState> {
  console.log("[e2e] pushing schema to the throwaway database");
  execSync("pnpm drizzle-kit-push-test", {
    cwd: SHARED_DIR,
    env: { ...baseEnv(), DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });

  const db = createDb(databaseUrl);
  let seeded: Awaited<ReturnType<typeof seedTwoOrgWorld>>;
  try {
    seeded = await seedTwoOrgWorld(db);
  } finally {
    await (db.$client as unknown as { end: () => Promise<void> }).end();
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const [owner, outsider] = await Promise.all([
      createSessionCookie(pool, {
        userId: WORLD.users.owner.id,
        activeOrganizationId: WORLD.orgs.alpha.id,
      }),
      createSessionCookie(pool, {
        userId: WORLD.users.outsider.id,
        activeOrganizationId: WORLD.orgs.gamma.id,
      }),
    ]);
    mkdirSync(AUTH_DIR, { recursive: true });
    writeFileSync(
      path.join(AUTH_DIR, "owner.json"),
      JSON.stringify(storageStateFor(owner), null, 2),
    );
    writeFileSync(
      path.join(AUTH_DIR, "outsider.json"),
      JSON.stringify(storageStateFor(outsider), null, 2),
    );
  } finally {
    await pool.end();
  }

  mkdirSync(STATE_DIR, { recursive: true });
  const state: WorldState = {
    databaseUrl,
    controlFile: path.join(STATE_DIR, "control.json"),
    egressLog: path.join(STATE_DIR, "egress.log"),
    ...seeded,
  };
  writeFileSync(state.controlFile, JSON.stringify({ githubDelayMs: 0 }));
  writeFileSync(state.egressLog, "");
  writeFileSync(WORLD_STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

async function runSuite(playwrightArgs: string[]): Promise<number> {
  assertNoNextEnvFiles();
  const services = await setupTestContainers();
  try {
    const state = await seed(services.DATABASE_URL);
    // The App signs a JWT before each installation-token request; a real
    // RSA key (never registered anywhere) lets that code path run as is.
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      DATABASE_URL: services.DATABASE_URL,
      DB_DRIVER: "node-postgres",
      REDIS_URL: services.REDIS_HTTP_URL,
      REDIS_TOKEN: services.REDIS_HTTP_TOKEN,
      GITHUB_APP_PRIVATE_KEY: privateKey,
      E2E_CONTROL_FILE: state.controlFile,
      E2E_EGRESS_LOG: state.egressLog,
      E2E_GITHUB_FIXTURES: path.join(E2E_DIR, "fixtures/github"),
    };
    console.log(`[e2e] running playwright against ${E2E_BASE_URL}`);
    const code = await runChild(
      "pnpm",
      ["exec", "playwright", "test", ...playwrightArgs],
      env,
    );

    const egress = readEgressLog(state.egressLog);
    const blocked = egress.filter((entry) => entry.kind === "blocked");
    const unmatched = egress.filter(
      (entry) => entry.kind === "github-unmatched",
    );
    const served = egress.filter((entry) => entry.kind === "github").length;
    console.log(
      `[e2e] egress: ${served} GitHub call(s) served from fixtures, ${unmatched.length} without a fixture (404), ${blocked.length} refused`,
    );
    for (const entry of unmatched) {
      console.log(`[e2e]   no fixture: ${entry.method} ${entry.url}`);
    }
    if (blocked.length > 0) {
      for (const entry of blocked) {
        console.error(
          `[e2e]   REFUSED: ${entry.via} ${entry.method ?? ""} ${entry.url}`,
        );
      }
      console.error("[e2e] unexpected egress: failing the run");
      return code === 0 ? 1 : code;
    }
    return code;
  } finally {
    await teardownTestContainers();
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const code =
    command === "build"
      ? await build()
      : await runSuite(command === undefined ? [] : [command, ...rest]);
  process.exit(code);
}

main().catch((error: unknown) => {
  console.error("[e2e] run failed:", error);
  process.exit(1);
});
