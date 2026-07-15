# ENV / Hosting Coupling Audit — terragon-oss chassis

Static analysis only (no install/run). Scope: environment/config inventory + hosting coupling for adopting the terragon-oss dump as a self-hosted SaaS chassis.

Repo: pnpm + turbo monorepo. Apps: `www` (Next.js 15, the product), `broadcast` (PartyKit realtime), `docs` (Fumadocs), `cli` (Terry CLI). Env is centralized in `packages/env` (`@terragon/env`) via `envsafe`, but a second tier of vars is read directly through `process.env` in the CLI, daemon, and sandbox packages.

---

## 1. Environment variable inventory

Classification: **OURS** = needed for self-host (keep). **DEFERRED** = 3rd-party SaaS to quarantine behind a flag, not delete. **STUB** = hosting/platform-specific, replace or drop. **UNKNOWN** = purpose unclear.

### Core app vars (`packages/env/src/apps-www.ts`, validated by envsafe)

| Var | Read in | Configures | Class |
|---|---|---|---|
| `DATABASE_URL` | `apps-www.ts`, `pkg-shared.ts`, `drizzle.config.ts` | Postgres connection (drizzle) | OURS |
| `REDIS_URL` | `apps/www/src/lib/redis.ts` | Redis (via `@upstash/redis` HTTP client) | OURS* |
| `REDIS_TOKEN` | `apps/www/src/lib/redis.ts` | Redis HTTP auth token | OURS* |
| `BETTER_AUTH_SECRET` | better-auth (`lib/auth.ts`) | Session/JWT signing | OURS |
| `BETTER_AUTH_URL` | better-auth; `pkg-shared.getPublicAppUrl` | Canonical app URL for auth | OURS |
| `INTERNAL_SHARED_SECRET` | `pkg-shared.ts`, broadcast `auth.ts` | www↔broadcast service auth | OURS |
| `CRON_SECRET` | 4 cron routes (`api/internal/cron/*`) | Bearer auth on cron endpoints | OURS (driver moves to Hatchet) |
| `ENCRYPTION_MASTER_KEY` | credential encryption at rest | AES master key for user secrets | OURS |
| `ANTHROPIC_API_KEY` | AI provider | Claude API | OURS |
| `OPENAI_API_KEY` | AI provider | OpenAI API | OURS |
| `OPENROUTER_API_KEY` | AI provider (optional, default "") | OpenRouter | OURS (opt) |
| `GOOGLE_AI_STUDIO_API_KEY` | AI provider (optional) | Google AI | OURS (opt) |
| `R2_ACCESS_KEY_ID` | `packages/r2/r2.ts` (S3 client) | Object storage creds | OURS |
| `R2_SECRET_ACCESS_KEY` | `packages/r2` | " | OURS |
| `R2_ACCOUNT_ID` | `packages/r2` | R2 endpoint derivation | OURS |
| `R2_BUCKET_NAME` | `packages/r2` | Private/attachment bucket | OURS |
| `R2_PRIVATE_BUCKET_NAME` | `packages/r2` | Second bucket | OURS |
| `R2_PUBLIC_URL` | `packages/r2` | Public CDN base URL | OURS |
| `R2_ENDPOINT` | `packages/r2` (optional) | S3 endpoint override | OURS |
| `GITHUB_CLIENT_ID` | GitHub OAuth | GitHub App OAuth | OURS |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth | " | OURS |
| `GITHUB_APP_ID` | GitHub App | App auth | OURS |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App | PEM signing key | OURS |
| `GITHUB_WEBHOOK_SECRET` | webhook verify | HMAC on inbound webhooks | OURS |
| `NEXT_PUBLIC_GITHUB_APP_NAME` | client | App install link | OURS |
| `CLI_PORT` | CLI auth callback (default 8742) | Local CLI OAuth port | OURS |
| `DISABLE_ONE_TIME_TOKEN_SIGNIN` | auth (default true) | Feature toggle | OURS |
| `E2B_API_KEY` | sandbox E2BProvider; broadcast `sandbox.ts` | E2B remote sandboxes | **DEFERRED** |
| `DAYTONA_API_KEY` | DaytonaProvider (optional) | Daytona sandboxes | **DEFERRED** |
| `NEXT_PUBLIC_POSTHOG_KEY` | `instrumentation.ts` + ~10 server-lib files | Product analytics | **DEFERRED** |
| `NEXT_PUBLIC_POSTHOG_HOST` | analytics | PostHog host | **DEFERRED** |
| `STRIPE_SECRET_KEY` | `server-lib/stripe*.ts` | Billing | **DEFERRED** |
| `STRIPE_WEBHOOK_SECRET` | stripe webhook route | Billing webhook | **DEFERRED** |
| `STRIPE_PRICE_CORE_MONTHLY` | billing | Price ID | **DEFERRED** |
| `STRIPE_PRICE_PRO_MONTHLY` | billing | Price ID | **DEFERRED** |
| `STRIPE_PRICE_CREDIT_PACK` | billing | Price ID | **DEFERRED** |
| `RESEND_API_KEY` | `packages/transactional`, auth email | Transactional email | **DEFERRED** |
| `LOOPS_API_KEY` | `lib/loops.ts` | Marketing email/events | **DEFERRED** |
| `SLACK_SIGNING_SECRET` | slack webhook | Slack app | **DEFERRED** |
| `SLACK_CLIENT_ID` | slack oauth | " | **DEFERRED** |
| `SLACK_CLIENT_SECRET` | slack oauth | " | **DEFERRED** |
| `SLACK_FEEDBACK_WEBHOOK_URL` | feedback relay | " | **DEFERRED** |
| `IS_ANTHROPIC_DOWN_URL` | `server-lib/internal-request.ts` | Anthropic-status side service | **DEFERRED/UNKNOWN** |
| `IS_ANTHROPIC_DOWN_API_SECRET` | `internal-request.ts` | Auth for that service | **DEFERRED/UNKNOWN** |
| `NGROK_DOMAIN` (deprecated) | dev tunnel | Local public domain | STUB (dev) |
| `LOCALHOST_PUBLIC_DOMAIN` | dev tunnel (replaces NGROK) | Local public domain | STUB (dev) |

\* **REDIS is self-hostable today**: `packages/dev-env/docker-compose.yml` already runs `hiett/serverless-redis-http` in front of `redis:7-alpine`, exposing the Upstash-compatible HTTP API the `@upstash/redis` client expects. So the Upstash *client* is not a hard SaaS dependency — the HTTP shim covers self-host. Keep as OURS; no code change needed, only the shim in the compose stack.

### Public/runtime vars read directly via `process.env` (`packages/env/src/next-public.ts`)

| Var | Configures | Class |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Client-side app origin | OURS |
| `NEXT_PUBLIC_BROADCAST_URL` | PartyKit HTTP URL | OURS |
| `NEXT_PUBLIC_BROADCAST_HOST` | PartyKit WS host | OURS |
| `NEXT_PUBLIC_DOCS_URL` | Docs site link | OURS |
| `NEXT_PUBLIC_VERCEL_ENV` | `=== "preview"` branch-URL logic | **STUB (Vercel)** |
| `NEXT_PUBLIC_VERCEL_BRANCH_URL` | Preview deploy URL | **STUB (Vercel)** |

### Dev-env / tunnel vars (`packages/env/src/pkg-dev-env.ts`)

| Var | Configures | Class |
|---|---|---|
| `WWW_PORT` | Local dev port (3000) | OURS (dev) |
| `NGROK_DOMAIN`, `NGROK_AUTH_TOKEN` | ngrok tunnel | STUB (dev) |
| `CUSTOM_TUNNEL_COMMAND` | Alt tunnel (cloudflared) | STUB (dev) |

### Agent / daemon / CLI vars (direct `process.env`, run inside sandbox or CLI)

| Var | Read in | Configures | Class |
|---|---|---|---|
| `AMP_API_KEY` | `packages/daemon/src/amp.ts`, `agent/credentials.ts` | Amp agent provider | **DEFERRED** |
| `OPENCODE_API_KEY` | `packages/daemon/src/opencode.ts` | OpenCode agent provider | **DEFERRED** |
| `SANDBOX_PROVIDER` | provider selection | e2b/daytona/docker/mock switch | OURS (config) |
| `SANDBOX_IMAGE_TEST` | sandbox-image tests | Test toggle | OURS (test) |
| `IDLE_TIMEOUT_MS` | daemon | Sandbox idle TTL | OURS (config) |
| `TERRAGON_FEATURE_FLAGS` | `packages/daemon/src/daemon.ts` (JSON) | Feature flags into sandbox | OURS |
| `TERRAGON_WEB_URL` | `apps/cli` (build + runtime) | CLI → API base URL | OURS |
| `TERRY_NO_AUTO_UPDATE` / `TERRY_NO_UPDATE_CHECK` / `TERRY_SETTINGS_DIR` | CLI | CLI behavior/config dir | OURS |
| `NODE_ENV`, `CI`, `SHELL`, `NEXT_RUNTIME` | various | Standard runtime | OURS (std) |

**Counts:** OURS ≈ 40 (incl. std/dev/config), DEFERRED ≈ 16, STUB ≈ 6, UNKNOWN ≈ 2 (the `IS_ANTHROPIC_DOWN_*` pair, likely a status side-service — treat as DEFERRED).

---

## 2. Vercel coupling

The product app (`apps/www`) is built for Vercel. Coupling points:

| Surface | File(s) | What breaks under node/systemd/container | Replacement effort |
|---|---|---|---|
| **`waitUntil` from `@vercel/functions`** | ~18 non-test files: all 4 `api/proxy/*` routes, `server-lib/{send-system-message,stop-thread,scheduled-thread,follow-up,handle-daemon-event,new-thread-shared}.ts`, `server-actions/{retry-thread,retry-git-checkpoint,draft-thread,admin/sandbox}.ts`, `agent/thread-resource.ts`, `agent/msg/startAgentMessage.ts`, `api/webhooks/slack/route.ts`, `api/internal/process-thread-queue/[userId]/route.tsx` | `@vercel/functions.waitUntil` no-ops/throws off-Vercel; background promises may be dropped when the request returns | **Medium/pervasive but mechanical.** Swap for Next `after()` from `next/server` (self-host-safe) or route the work into **Hatchet** as a durable job. This is the single biggest edit-surface. A shim (`waitUntil = (p)=>after(()=>p)`) unblocks fast; durable jobs are the real fix. |
| **`vercel.json` crons** | `apps/www/vercel.json` | 4 cron jobs (`stalled-tasks` hourly, `scheduled-tasks` 1m, `queued-tasks` 10m, `automations` 30m) don't run without Vercel Cron | **Low.** Hatchet owns cron. Point Hatchet schedules at the existing endpoints (they already auth via `Bearer CRON_SECRET`), or port the handler bodies to Hatchet workflows. Endpoints are plain Next route handlers — no Vercel API used inside. |
| **`vercel.json` functions maxDuration: 800** | `apps/www/vercel.json` | Vercel-only fn timeout config; ignored elsewhere | **None** — drop the file; long-running work should be Hatchet jobs anyway. |
| **`dev:cron` = `vercel-cron`** | `apps/www/package.json`, root `dev` script (`turbo dev dev:cron dev:stripe`) | `vercel-cron` dev tool reads `vercel.json` to fire crons locally | **Low** — replace with a local Hatchet dev scheduler or a simple loop hitting the endpoints. |
| **`NEXT_PUBLIC_VERCEL_ENV` / `NEXT_PUBLIC_VERCEL_BRANCH_URL`** | `packages/env/src/next-public.ts` (`publicAppUrl`) | Preview-URL branch logic is dead off-Vercel (falls through to `NEXT_PUBLIC_APP_URL`) | **None functionally** — leave or strip the preview branch. |
| **`next.config.ts` — `reactCompiler`, `serverActions.bodySizeLimit`, PostHog rewrites** | `apps/www/next.config.ts` | None Vercel-specific; rewrites proxy PostHog (DEFERRED); `images.remotePatterns` → `cdn.terragonlabs.com` | **None** — standard Next, runs under `next start`. Update the CDN hostname when R2/CDN domain changes. |
| **No edge runtime** | grep found **zero** `export const runtime = "edge"` | — | Good: everything is Node runtime already. Only `instrumentation.ts` branches on `NEXT_RUNTIME === "nodejs"` (safe). |

`apps/www` builds with `next build` and serves with `next start` — it is a standard Node Next.js server. There is **no** dependence on Vercel edge/middleware/geolocation. The realistic hosting target is a container running `next start` behind a reverse proxy, with Hatchet replacing Vercel Cron and (ideally) absorbing the `waitUntil` background work.

---

## 3. PartyKit (`apps/broadcast`)

- **Deploy:** `partykit deploy` (`package.json` script); config in `partykit.json` (`main: src/server.ts`, extra party `sandbox: src/sandbox.ts`, `port 1999`, `compatibilityDate 2025-05-24`). Dev via `nodemon → tsx src/dev.ts`.
- **What it is:** a **stateless broadcast relay** (`options.hibernate = true`) plus a `SandboxParty` that bridges WebSocket connections to E2B/Daytona sandboxes.
- **Env needed (read from `lobby.env` / `room.env`, not `process.env`):** `INTERNAL_SHARED_SECRET` (via `src/auth.ts` `validateRequest`), `E2B_API_KEY`, `DAYTONA_API_KEY` (`src/sandbox.ts:239-240`). Its `.env.example` lists `NODE_ENV`, `BETTER_AUTH_URL`, `INTERNAL_SHARED_SECRET`, `E2B_API_KEY`.
- **Self-host on Cloudflare Workers:** **highly feasible.** PartyKit *is* Cloudflare Workers + Durable Objects under the hood, and the newer path is deploying PartyKit servers directly onto Workers (`partyserver` / wrangler) instead of the hosted PartyKit cloud. The server only uses standard `Party.Server` hooks (`onBeforeConnect`, `onRequest`, `room.broadcast`, hibernation) — all supported on Workers. Migration = provide a `wrangler.toml` with a Durable Object binding, adapt the entrypoint from `partykit deploy` to `wrangler deploy`, and move the three env vars into Worker secrets. The `sandbox` party's E2B/Daytona coupling is DEFERRED regardless of host. Low-to-medium effort; no architectural blocker.

---

## 4. Boot path — minimal local bring-up for `apps/www`

Required services and steps (from `packages/dev-env` + scripts):

1. **Postgres 16** — `packages/dev-env/docker-compose.yml` (`postgres:16-alpine`, db `terragon`, user/pass `postgres`). `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres` is the dev default (`common.ts`).
2. **Redis + HTTP shim** — same compose file: `redis:7-alpine` + `hiett/serverless-redis-http` (Upstash-compatible) on port 8079. Dev defaults `REDIS_URL=http://localhost:8079`, `REDIS_TOKEN=redis_dev_token`.
3. **Schema push** — no versioned migration folder; schema is pushed with **`drizzle-kit push`** (`packages/shared`: `drizzle-kit-push-dev`, schema `src/db/schema.ts`, dialect postgresql). There is **no seed script** found. Bring-up = push schema against the Postgres above.
4. **App** — `apps/www`: `next dev --turbo` (dev) or `next build` + `next start` (prod). Build also builds the `bundled` package first (`pnpm --filter bundled build && next build`).
5. **Broadcast** — `apps/broadcast` on port 1999 (needed for realtime; www points at it via `NEXT_PUBLIC_BROADCAST_URL/HOST`).
6. **Crons** — dev uses `vercel-cron` reading `vercel.json`; self-host uses Hatchet (or a loop) hitting `/api/internal/cron/*` with `Bearer CRON_SECRET`.
7. **Tunnel (dev only)** — ngrok or `CUSTOM_TUNNEL_COMMAND` (cloudflared) so remote sandboxes can call back to localhost. Not needed if sandboxes run locally via the **DockerProvider** (`packages/sandbox/src/providers/docker-provider.ts`, allowed in dev/test).

**Minimal docker-compose equivalent:** Postgres + Redis + serverless-redis-http (already written), plus the `www` container (`next start`) and a `broadcast` container. Then `drizzle-kit push` once at init. Secrets needed to boot at all (envsafe throws if unset, no devDefault): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, all six `R2_*`, `E2B_API_KEY`, and the five `GITHUB_*`. Everything else has a dev default or is optional. **To fully cut external SaaS for a first self-host boot, the load-bearing items are: swap `E2B_API_KEY` requirement for the DockerProvider, and provide an S3-compatible store for the `R2_*` vars (MinIO works — the client is `@aws-sdk/client-s3` with a configurable endpoint).**

---

## Notes / gaps

- `E2B_API_KEY` and the six `R2_*` vars are `str()` with **no default** → envsafe **hard-fails boot** if missing, even though a Docker sandbox provider and an S3-endpoint override both exist in code. Making E2B optional and R2 endpoint-configurable is the cleanest path to a SaaS-free first boot.
- No versioned SQL migrations (push-based schema) — fine for a chassis but worth noting for prod change management.
- The `IS_ANTHROPIC_DOWN_*` pair points at an undocumented side service (`server-lib/internal-request.ts`); treat as DEFERRED until its purpose is confirmed.
</content>
