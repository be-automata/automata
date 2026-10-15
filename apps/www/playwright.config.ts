import path from "node:path";
import { pathToFileURL } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { E2E_BASE_URL, E2E_PORT } from "./e2e/e2e-env";

/**
 * Two-org browser suite. Run it through `pnpm e2e` (e2e/run.ts), which
 * provisions the database, seeds the world and sets the env this config
 * hands to `next start`; running `playwright test` directly has no database.
 */
const egressGuard = pathToFileURL(
  path.join(__dirname, "e2e/support/egress-guard.mjs"),
).href;

export default defineConfig({
  testDir: "./e2e/specs",
  testMatch: "**/*.e2e.ts",
  // The specs share one server, one GitHub delay knob and one database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // node + the Next bin directly: a `pnpm exec` wrapper would also load the
    // egress guard and could itself reach the registry.
    command: `node ./node_modules/next/dist/bin/next start -p ${E2E_PORT}`,
    url: `${E2E_BASE_URL}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      NODE_ENV: "production",
      NODE_OPTIONS: `--import ${egressGuard}`,
    },
  },
});
