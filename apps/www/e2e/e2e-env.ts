/**
 * Environment for the Playwright suite: `next build` and `next start` both run
 * with NODE_ENV=production, so every required envsafe variable
 * (packages/env/src/apps-www.ts) must be present. Everything here is a
 * placeholder for a throwaway local stack — never a real credential, and no
 * value points at a hosted service. The egress guard
 * (e2e/support/egress-guard.mjs) fails the run if anything still tries to
 * leave localhost.
 */

export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

/** Better Auth signs session cookies with this; e2e/support/session.ts too. */
export const E2E_BETTER_AUTH_SECRET =
  "e2e-better-auth-secret-0123456789abcdef0123456789";

/** Encrypts seeded tokens and environment values (64 hex characters). */
export const E2E_ENCRYPTION_MASTER_KEY = "e2e0".repeat(16);

/** Platform Slack app, so the install button is enabled. Fake values. */
export const E2E_SLACK_CLIENT_ID = "e2e-slack-client-id";

/**
 * Variables `next build` needs. NEXT_PUBLIC_* values are inlined into the
 * client bundle, so the build must use the same app URL the server runs on.
 */
export function e2eBuildEnv(): Record<string, string> {
  return {
    NEXT_PUBLIC_APP_URL: E2E_BASE_URL,
    NEXT_PUBLIC_BROADCAST_URL: "http://localhost:1999",
    NEXT_PUBLIC_BROADCAST_HOST: "localhost:1999",
    NEXT_PUBLIC_GITHUB_APP_NAME: "e2e-app",
    NEXT_PUBLIC_POSTHOG_KEY: "",
    NEXT_PUBLIC_DOCS_URL: "http://localhost:3101",
    // Build-time placeholders; the run overrides DATABASE_URL and Redis.
    DATABASE_URL: "postgresql://build:build@localhost:5432/build",
    DB_DRIVER: "node-postgres",
    REDIS_URL: "",
    REDIS_TOKEN: "",
    BETTER_AUTH_SECRET: E2E_BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: E2E_BASE_URL,
    IS_ANTHROPIC_DOWN_URL: "http://localhost:3102",
    IS_ANTHROPIC_DOWN_API_SECRET: "e2e-isanthropicdown-secret",
    INTERNAL_SHARED_SECRET: "e2e-internal-shared-secret",
    CRON_SECRET: "e2e-cron-secret",
    ENCRYPTION_MASTER_KEY: E2E_ENCRYPTION_MASTER_KEY,
    ANTHROPIC_API_KEY: "e2e-anthropic-placeholder",
    OPENAI_API_KEY: "e2e-openai-placeholder",
    R2_ACCESS_KEY_ID: "e2e-r2-access-key",
    R2_SECRET_ACCESS_KEY: "e2e-r2-secret",
    R2_ACCOUNT_ID: "e2e-r2-account",
    R2_BUCKET_NAME: "e2e-bucket",
    R2_PRIVATE_BUCKET_NAME: "e2e-private-bucket",
    R2_PUBLIC_URL: "http://localhost:3103",
    R2_ENDPOINT: "http://localhost:3103",
    GITHUB_CLIENT_ID: "e2e-github-client-id",
    GITHUB_CLIENT_SECRET: "e2e-github-client-secret",
    GITHUB_WEBHOOK_SECRET: "e2e-github-webhook-secret",
    GITHUB_APP_ID: "1",
    // Replaced at run time by a freshly generated key (e2e/run.ts): the App
    // signs a JWT with it before every installation-token request.
    GITHUB_APP_PRIVATE_KEY: "e2e-placeholder",
    SLACK_CLIENT_ID: E2E_SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET: "e2e-slack-client-secret",
    SLACK_SIGNING_SECRET: "e2e-slack-signing-secret",
    // Never boot a sandbox or dispatch to an engine from the browser suite.
    HATCHET_ENABLED: "false",
    GITHUB_SIDE_EFFECTS_ENABLED: "false",
    CI: "true",
  };
}
