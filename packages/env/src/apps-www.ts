import { envsafe, str, bool, num } from "envsafe";
import {
  devDefaultDatabaseUrl,
  devDefaultBetterAuthSecret,
  devDefaultCronSecret,
  devDefaultInternalSharedSecret,
  devDefaultIsAnthropicDownUrl,
  devDefaultIsAnthropicDownApiSecret,
  devDefaultBetterAuthUrl,
  devDefaultRedisUrl,
  devDefaultRedisToken,
} from "./common";

export const env = envsafe({
  DATABASE_URL: str({
    devDefault: devDefaultDatabaseUrl,
  }),
  // Optional in production: when unset, apps/www/src/lib/redis.ts falls back to an
  // in-memory single-node stand-in so a Redis-less deployment boots and fails open.
  REDIS_URL: str({
    devDefault: devDefaultRedisUrl,
    default: "",
    allowEmpty: true,
  }),
  REDIS_TOKEN: str({
    devDefault: devDefaultRedisToken,
    default: "",
    allowEmpty: true,
  }),
  BETTER_AUTH_SECRET: str({
    devDefault: devDefaultBetterAuthSecret,
  }),
  BETTER_AUTH_URL: str({
    devDefault: devDefaultBetterAuthUrl,
  }),
  IS_ANTHROPIC_DOWN_URL: str({
    devDefault: devDefaultIsAnthropicDownUrl,
  }),
  IS_ANTHROPIC_DOWN_API_SECRET: str({
    devDefault: devDefaultIsAnthropicDownApiSecret,
  }),
  // Used to authenticate internal request between services (eg. www -> broadcast)
  INTERNAL_SHARED_SECRET: str({
    devDefault: devDefaultInternalSharedSecret,
  }),
  // Vercel cron jobs
  CRON_SECRET: str({
    devDefault: devDefaultCronSecret,
  }),
  // Master key for encrypting sensitive user data at rest (e.g. user credentials)
  ENCRYPTION_MASTER_KEY: str({
    devDefault: "dev-encryption-master-key-32chars!!",
  }),

  // AI Providers
  ANTHROPIC_API_KEY: str(),
  OPENAI_API_KEY: str(),
  OPENROUTER_API_KEY: str({ allowEmpty: true, default: "" }),
  GOOGLE_AI_STUDIO_API_KEY: str({ allowEmpty: true, default: "" }),

  // Deprecated, use LOCALHOST_PUBLIC_DOMAIN instead
  NGROK_DOMAIN: str({ allowEmpty: true, default: "" }),
  LOCALHOST_PUBLIC_DOMAIN: str({ allowEmpty: true, default: "" }),

  // R2
  R2_ACCESS_KEY_ID: str(),
  R2_SECRET_ACCESS_KEY: str(),
  R2_ACCOUNT_ID: str(),
  R2_BUCKET_NAME: str(),
  R2_PRIVATE_BUCKET_NAME: str(),
  R2_PUBLIC_URL: str(),
  R2_ENDPOINT: str({ allowEmpty: true, default: "" }),

  // Sandbox providers
  E2B_API_KEY: str({ allowEmpty: true, default: "" }),
  DAYTONA_API_KEY: str({ default: "", allowEmpty: true }),
  // #114 Docker credential broker gate. "on" = brokered Docker sandboxes (the
  // installation token stays in a per-run sidecar; the guest holds only a
  // per-run bearer). Anything else (default "legacy-direct") = today's exact
  // raw-token behavior. Only affects the Docker provider; mirrors the worker's
  // WORKER_CREDENTIAL_BROKER opt-out semantics.
  SANDBOX_CREDENTIAL_BROKER: str({
    default: "legacy-direct",
    allowEmpty: true,
  }),

  // GitHub App
  GITHUB_CLIENT_ID: str(),
  GITHUB_CLIENT_SECRET: str(),
  NEXT_PUBLIC_GITHUB_APP_NAME: str({ devDefault: "" }),
  // The App bot's review author login for the ADR-036 review reconciler. Defaults
  // to `${NEXT_PUBLIC_GITHUB_APP_NAME}[bot]`; set explicitly when the app slug (the
  // GitHub `[bot]` login) differs from the display name (pilot: automata-ai-bot[bot]).
  GITHUB_BOT_LOGIN: str({ default: "", allowEmpty: true }),
  GITHUB_WEBHOOK_SECRET: str(),
  GITHUB_APP_ID: str(),
  GITHUB_APP_PRIVATE_KEY: str(),
  // Deployment-level kill-switch for ALL GitHub side effects (pilot).
  // Default TRUE for back-compat: existing prod/self-host behave as before. When
  // FALSE, every GitHub-processing path is forced into shadow behavior (thread
  // rows created + dashboard-visible, but no agent boot and no comments/checks/
  // reviews/reactions) regardless of per-installation mode. The pilot Workers
  // deployment sets this FALSE until the pilot binding is verified in shadow.
  GITHUB_SIDE_EFFECTS_ENABLED: bool({ default: true }),
  // ADR-036: the single-writer review channel (emit-only agent → control-plane
  // posts exactly once at finish, with the per-repo tolerance floor + a grace-period
  // sweep backstop) is now UNCONDITIONAL — the former REVIEW_SINGLE_WRITER flag was
  // retired once the deployed skill went emit-only (the flag-off "agent posts
  // directly" path was unwired and posted nothing). GITHUB_SIDE_EFFECTS_ENABLED still
  // gates ALL GitHub mutation. (The orphaned REVIEW_SINGLE_WRITER worker secret, if
  // still set, is now unread and can be deleted.)

  // Execution plane — Hatchet (ADR-003). When HATCHET_ENABLED, a booting thread
  // dispatches to the Hatchet `agent-run` workflow (remote worker) instead of the
  // in-process sandbox. All optional: unset/false = today's in-process behavior
  // exactly (nullable-safe). HATCHET_API_URL is the engine's REST base reached
  // through the cloudflared tunnel — it CHANGES per quick-tunnel run, so it is an
  // env/secret, never hardcoded. HATCHET_API_TOKEN is the tenant-scoped Bearer
  // token for the REST trigger; HATCHET_TENANT_ID is the tenant path segment.
  HATCHET_ENABLED: bool({ default: false }),
  HATCHET_API_URL: str({ default: "", allowEmpty: true }),
  HATCHET_TENANT_ID: str({ default: "", allowEmpty: true }),
  HATCHET_API_TOKEN: str({ default: "", allowEmpty: true }),

  // Posthog
  NEXT_PUBLIC_POSTHOG_KEY: str({
    default: "",
    allowEmpty: true,
  }),
  NEXT_PUBLIC_POSTHOG_HOST: str({
    default: "https://us.i.posthog.com",
    allowEmpty: true,
  }),

  // Slack Integration
  SLACK_SIGNING_SECRET: str({ allowEmpty: true, default: "" }),
  SLACK_FEEDBACK_WEBHOOK_URL: str({ allowEmpty: true, default: "" }),
  SLACK_CLIENT_ID: str({ allowEmpty: true, default: "" }),
  SLACK_CLIENT_SECRET: str({ allowEmpty: true, default: "" }),

  // Port used by the CLI tool for auth
  CLI_PORT: num({ default: 8742 }),

  // Per-user resource caps (neutral defaults; no paid tier required to raise them).
  // Self-hosted operators override these when Stripe/subscription tiers are off.
  MAX_CONCURRENT_TASKS_PER_USER: num({ default: 3 }),
  MAX_AUTOMATIONS_PER_USER: num({ default: 20 }),

  // Others
  RESEND_API_KEY: str({ allowEmpty: true, default: "" }),
  DISABLE_ONE_TIME_TOKEN_SIGNIN: bool({ default: true }),

  // Email/password sign-in. Off by default (hosted deployments are OAuth-only).
  // Self-host turns this ON so a fresh instance can bootstrap the first account
  // without SMTP (magic link) or a GitHub OAuth handshake. See auth.ts.
  AUTH_EMAIL_PASSWORD_ENABLED: bool({ default: false }),

  // Stripe
  STRIPE_SECRET_KEY: str({ allowEmpty: true, default: "" }),
  STRIPE_WEBHOOK_SECRET: str({ allowEmpty: true, default: "" }),
  STRIPE_PRICE_CORE_MONTHLY: str({ allowEmpty: true, default: "" }),
  STRIPE_PRICE_PRO_MONTHLY: str({ allowEmpty: true, default: "" }),
  STRIPE_PRICE_CREDIT_PACK: str({ allowEmpty: true, default: "" }),

  // Loops (marketing email & events)
  LOOPS_API_KEY: str({ allowEmpty: true, default: "" }),
});
