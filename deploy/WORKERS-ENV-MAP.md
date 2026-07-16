# Workers control-plane env map (Automata pilot)

Every env var the **control plane** (`apps/www` + `apps/broadcast`) needs on
Cloudflare Workers, with how the operator supplies it. Produced by the step-1
deployability investigation. The operator wires secrets themselves — this session
cannot read the current VPS `.env` (permission-denied).

## How Workers env differs from the VPS (read first)

Three delivery mechanisms, and picking the wrong one silently breaks the app:

1. **`wrangler secret put NAME`** — runtime server secrets (available as `env.NAME`
   / `process.env.NAME` in the Worker). Use for everything server-side:
   `DATABASE_URL`, `BETTER_AUTH_SECRET`, GitHub App keys, AI keys, etc.
2. **Build-time vars (`NEXT_PUBLIC_*`)** — inlined into the client bundle **at
   `next build`**, NOT at runtime. `wrangler secret put` does **nothing** for these.
   They must be present in the **build environment** (locally: the shell/`.env`
   loaded during `opennextjs-cloudflare build`; on Workers Builds: the
   "Build variables and secrets" section). Changing one requires a **rebuild+redeploy**.
3. **Bindings** (`wrangler.jsonc`) — R2 buckets, Durable Objects, KV. Declared in
   config, not as secrets. R2 via a native binding needs **no** access keys.

Classes used below:
- **[operator-secret]** — reuse the value from the current VPS/orch-agents env
  (GitHub App, AI keys, R2 S3 token). `wrangler secret put`.
- **[new-generated]** — mint fresh for the pilot (`openssl rand -hex 32`).
  `wrangler secret put`.
- **[deploy-config]** — a value determined by the deployment (the Worker's own URL).
  Server ones via `wrangler secret put`; `NEXT_PUBLIC_*` ones are build vars.
- **[CF-binding]** — a `wrangler.jsonc` binding, not a secret.
- **[Neon]** — the Neon Postgres connection string.
- **[unset-by-design]** — leave empty; the app degrades (see notes). Do not set.

---

## apps/www (control-plane app)

### Required to boot / core function

| Var | Class | Mechanism | Notes |
|---|---|---|---|
| `DATABASE_URL` | **[Neon]** | secret | Neon Postgres URL. **See the DRIVER BLOCKER below — the current `node-postgres` driver does not run on workerd; this must move to `@neondatabase/serverless`.** |
| `BETTER_AUTH_SECRET` | **[new-generated]** | secret | `openssl rand -hex 32`. Session/JWT signing. |
| `BETTER_AUTH_URL` | **[deploy-config]** | secret | The Worker's public origin (e.g. `https://automata-www.<acct>.workers.dev` or the custom domain). |
| `ENCRYPTION_MASTER_KEY` | **[new-generated]** | secret | Exactly 32 bytes. AES master key for user credentials at rest. Fresh for a fresh DB; if migrating encrypted rows it must match the old key. |
| `INTERNAL_SHARED_SECRET` | **[new-generated]** | secret | www↔broadcast auth. **Must be identical** to the broadcast Worker's value. |
| `CRON_SECRET` | **[new-generated]** | secret | Bearer auth on `/api/internal/cron/*`. (Cron driver moves to Hatchet later.) |
| `AUTH_EMAIL_PASSWORD_ENABLED` | **[deploy-config]** | secret (`"true"`) | Set `true` so the pilot can create the first user via the `/login` email/password form (no SMTP/GitHub OAuth handshake needed). |
| `ANTHROPIC_API_KEY` | **[operator-secret]** | secret | From current VPS env. Gates real Claude calls. |
| `OPENAI_API_KEY` | **[operator-secret]** | secret | From current VPS env. |

### Public URLs — BUILD VARS (inlined at build, not runtime)

| Var | Class | Mechanism | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | **[deploy-config]** | **build var** | Same origin as `BETTER_AUTH_URL`. |
| `NEXT_PUBLIC_BROADCAST_URL` | **[deploy-config]** | **build var** | The broadcast Worker's HTTP origin. |
| `NEXT_PUBLIC_BROADCAST_HOST` | **[deploy-config]** | **build var** | The broadcast Worker's WS host (`host:port` / hostname). |
| `NEXT_PUBLIC_GITHUB_APP_NAME` | **[operator-secret]** | **build var** | The GitHub App's slug (for install links). |
| `NEXT_PUBLIC_DOCS_URL` | [unset-by-design] | build var | Optional; falls back to a default. |
| `NEXT_PUBLIC_VERCEL_ENV` / `NEXT_PUBLIC_VERCEL_BRANCH_URL` | [unset-by-design] | — | Vercel-only; dead off-Vercel. |

### Object storage (R2)

The current code (`packages/r2`) uses the **S3 API** (`@aws-sdk/client-s3` + `R2_ENDPOINT`),
so for step-1 parity these are **[operator-secret]** R2 S3 credentials. The
Workers-native path (recommended follow-up) is an **R2 bucket binding** — no keys,
but `packages/r2` must be refactored to use `env.<BINDING>` instead of the S3 client.

| Var | Class | Mechanism | Notes |
|---|---|---|---|
| `R2_ACCESS_KEY_ID` | **[operator-secret]** | secret | R2 S3 token. (Native binding = drop this.) |
| `R2_SECRET_ACCESS_KEY` | **[operator-secret]** | secret | " |
| `R2_ACCOUNT_ID` | **[operator-secret]** | secret | Cloudflare account id (endpoint derivation). |
| `R2_ENDPOINT` | **[deploy-config]** | secret | `https://<acct>.r2.cloudflarestorage.com` (real R2). |
| `R2_BUCKET_NAME` | **[deploy-config]** | secret | Real bucket name. |
| `R2_PRIVATE_BUCKET_NAME` | **[deploy-config]** | secret | Real private bucket name. |
| `R2_PUBLIC_URL` | **[deploy-config]** | secret | Public bucket base URL (r2.dev or custom domain). |
| *(follow-up)* `R2_BUCKET` binding | **[CF-binding]** | wrangler.jsonc | Native path: `"r2_buckets":[{ "binding":"R2_BUCKET","bucket_name":"..." }]`. |

### GitHub App (from current VPS — reused per pilot plan)

| Var | Class | Mechanism | Notes |
|---|---|---|---|
| `GITHUB_APP_ID` | **[operator-secret]** | secret | Reuse the current App. |
| `GITHUB_APP_PRIVATE_KEY` | **[operator-secret]** | secret | PEM (single-line escaped or multiline). |
| `GITHUB_CLIENT_ID` | **[operator-secret]** | secret | |
| `GITHUB_CLIENT_SECRET` | **[operator-secret]** | secret | |
| `GITHUB_WEBHOOK_SECRET` | **[new-generated]** | secret | **Pilot uses a FRESH secret** for the new repo-level webhook (do not reuse the prod App webhook secret; prod webhook URL stays pointed at prod — pilot = separate shadow-mode webhook). |

### Deferred SaaS — leave UNSET (app degrades gracefully)

| Var(s) | Class | Behavior when unset |
|---|---|---|
| `REDIS_URL`, `REDIS_TOKEN` | [unset-by-design] | In-memory fail-open stand-in (`apps/www/src/lib/redis.ts`). **On Workers this is PER-ISOLATE** — locks/rate-limits are effectively off (not shared across isolates). Acceptable for the pilot; Upstash later for shared state. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | [unset-by-design] | Billing disabled; lifecycle never blocks on credits. |
| `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` | [unset-by-design] | Analytics no-op (client `disabled`). |
| `E2B_API_KEY`, `DAYTONA_API_KEY` | [unset-by-design] | Execution plane is OFF-Workers (ADR-002 rev 2, customer boxes). |
| `RESEND_API_KEY` | [unset-by-design]* | Transactional/magic-link email off. *Set (operator-secret) only if you want magic-link signup instead of email/password.* |
| `LOOPS_API_KEY` | [unset-by-design] | Marketing events off. |
| `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_FEEDBACK_WEBHOOK_URL` | [unset-by-design] | Slack app off. |
| `OPENROUTER_API_KEY`, `GOOGLE_AI_STUDIO_API_KEY` | [unset-by-design] | Optional AI providers off. |
| `NGROK_DOMAIN`, `LOCALHOST_PUBLIC_DOMAIN` | [unset-by-design] | Dev tunnels; N/A on Workers. |
| `IS_ANTHROPIC_DOWN_URL`, `IS_ANTHROPIC_DOWN_API_SECRET` | [unset-by-design] | Undocumented status side-service; dummy/unset. |

### Optional config (have defaults)

`CLI_PORT` (N/A on Workers), `DISABLE_ONE_TIME_TOKEN_SIGNIN` (default true),
`MAX_CONCURRENT_TASKS_PER_USER` (3), `MAX_AUTOMATIONS_PER_USER` (20) — leave unset
unless overriding.

---

## apps/broadcast (broadcast Worker)

| Var | Class | Mechanism | Notes |
|---|---|---|---|
| `INTERNAL_SHARED_SECRET` | **[new-generated]** | secret | **Same value as www.** Channel-less auth for www's POSTs. |
| `NEXT_PUBLIC_APP_URL` (or `BETTER_AUTH_URL`) | **[deploy-config]** | secret | The www Worker origin — broadcast calls back to `www/api/internal/broadcast` to verify connection tokens. |
| `E2B_API_KEY`, `DAYTONA_API_KEY` | [unset-by-design] | secret | Only the `sandbox` party needs these (execution-plane, DEFERRED). The ported `main` broadcast party does not. |

Durable Object binding `Main` (`wrangler.jsonc`) — **[CF-binding]**, no secret.

---

## Minimal secret set to boot the pilot control plane

```
# apps/www — wrangler secret put (runtime)
DATABASE_URL                # Neon (after driver swap)
BETTER_AUTH_SECRET          # openssl rand -hex 32
BETTER_AUTH_URL             # the www Worker URL
ENCRYPTION_MASTER_KEY       # 32 bytes
INTERNAL_SHARED_SECRET      # openssl rand -hex 32 (shared with broadcast)
CRON_SECRET                 # openssl rand -hex 32
AUTH_EMAIL_PASSWORD_ENABLED # "true"
ANTHROPIC_API_KEY OPENAI_API_KEY
R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ACCOUNT_ID R2_ENDPOINT \
  R2_BUCKET_NAME R2_PRIVATE_BUCKET_NAME R2_PUBLIC_URL
GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET \
  GITHUB_WEBHOOK_SECRET   # fresh

# apps/www — BUILD vars (present at `next build` / Workers Builds build env)
NEXT_PUBLIC_APP_URL NEXT_PUBLIC_BROADCAST_URL NEXT_PUBLIC_BROADCAST_HOST \
  NEXT_PUBLIC_GITHUB_APP_NAME

# apps/broadcast — wrangler secret put
INTERNAL_SHARED_SECRET      # same as www
NEXT_PUBLIC_APP_URL         # www origin (token-verify callback)
```
