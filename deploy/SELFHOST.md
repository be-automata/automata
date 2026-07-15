# Self-hosting the platform (SaaS-free boot)

A reproducible local bring-up of `apps/www` with **every third-party SaaS turned
off**: no Stripe, PostHog, E2B/Daytona, Resend, Loops, or Slack. Only the stateful
backing services (Postgres, Redis, object storage) run in containers; the app
processes run on the host.

**The full stack is five services**: `apps/www` + `apps/broadcast` (host processes)
and Postgres + Redis(+shim) + MinIO (containers). `apps/broadcast` is **not**
optional once you exercise auth/user-lifecycle — signup and other user hooks POST
to it, so a stack without it 500s on signup (see [Troubleshooting](#troubleshooting)).

Files:
- `deploy/docker-compose.selfhost.yml` — Postgres 16, Redis 7 + Upstash HTTP shim, MinIO (R2 stand-in).
- `deploy/selfhost.env.example` — the complete minimal env, every deferred service empty.

## What runs where

| Component | How it runs | Notes |
|---|---|---|
| Postgres 16 | container | `DATABASE_URL`; schema applied with `drizzle-kit push`. |
| Redis 7 + `serverless-redis-http` | container | `REDIS_URL`/`REDIS_TOKEN`. The shim exposes the Upstash-compatible HTTP API `@upstash/redis` expects. Leaving `REDIS_URL` empty is also valid — the app falls open to an in-memory single-node stand-in (`apps/www/src/lib/redis.ts`). |
| MinIO (+ one-shot bucket init) | container | S3-compatible store for the `R2_*` vars. `R2_ENDPOINT` points the `@aws-sdk/client-s3` client at MinIO. The init job creates both buckets and makes the public one anonymously readable. |
| **`apps/www`** | **host** (`next start`) | Not containerized here — `node_modules` was installed with `--ignore-scripts`, so a Docker image build of the app is out of scope for now. Run it on the host. |
| **`apps/broadcast`** | **host** (`partykit dev`) | PartyKit realtime relay on port 1999. **Required for auth/user-lifecycle**, not just live transcripts: signup and other user hooks POST to `/parties/main/user:<id>`, so with it down signup returns 500 (see [Troubleshooting](#troubleshooting)). The www app points at it via `NEXT_PUBLIC_BROADCAST_URL`/`_HOST`. Optional only for an anonymous `GET /`. |
| Crons | not run here | Vercel Cron is being replaced by Hatchet. The four `/api/internal/cron/*` endpoints auth via `Bearer CRON_SECRET` and can be driven by any scheduler. |

## Boot procedure

```bash
# 1. Copy and (optionally) edit the env. Every value ships as a safe throwaway.
cp deploy/selfhost.env.example deploy/selfhost.env

# 2. Bring up the backing services (Postgres, Redis+shim, MinIO).
docker compose -f deploy/docker-compose.selfhost.yml --env-file deploy/selfhost.env up -d

# 3. Apply the schema (no versioned migrations — push-based).
set -a; . deploy/selfhost.env; set +a
cd packages/shared && pnpm exec drizzle-kit push --config drizzle.config.ts && cd ../..

# 4. Start the broadcast relay (host process, port 1999) — required for
#    auth/user-lifecycle, not just live transcripts. Leave it running.
cd apps/broadcast && pnpm exec partykit dev &   # then cd back

# 5a. Boot the app for production (the real self-host path).
cd apps/www && pnpm exec next build && pnpm exec next start
# 5b. …or for development.
cd apps/www && pnpm exec next dev

# 6. Verify.
curl -i http://localhost:3000/
```

### Port collisions

Every published port in the compose file is overridable so the stack can coexist
with the dev stack (`packages/dev-env/docker-compose.yml`) or other local services:
`SELFHOST_POSTGRES_PORT` (5432), `SELFHOST_REDIS_PORT` (6379),
`SELFHOST_REDIS_HTTP_PORT` (8079), `SELFHOST_MINIO_PORT` (9000),
`SELFHOST_MINIO_CONSOLE_PORT` (9001). If you override a port, update the matching
URL in the env (`DATABASE_URL`, `REDIS_URL`, `R2_ENDPOINT`, `R2_PUBLIC_URL`).

## Upgrade / rebuild procedure

When advancing to a newer HEAD (e.g. the tenancy work landing new commits), rebuild
with **build → push → restart** — a restart alone runs the new app against a stale
schema. Keep broadcast (`:1999`) up throughout.

```bash
set -a; . deploy/selfhost.env; set +a          # env loaded for BOTH build and runtime

# 1. Build at the new HEAD (env must be present — envsafe validates at module load).
cd apps/www && pnpm exec next build && cd ../..

# 2. Push schema — REQUIRED whenever a commit adds or changes columns.
cd packages/shared && pnpm exec drizzle-kit push --config drizzle.config.ts && cd ../..

# 3. Restart the app (broadcast stays running).
cd apps/www && pnpm exec next start
```

**Why the push is not optional:** the app at HEAD queries columns the migration adds
(e.g. `thread.organization_id`, `environment.organization_id`); against a stale DB
those org-fenced queries 500 with `column ... does not exist`. The new org columns are
currently **nullable**, so `drizzle-kit push` applies cleanly over existing rows.

**Once the NOT-NULL org tightening lands**, `drizzle-kit push` alone will fail on
populated tables (existing rows have no org id). Run the backfill **between push and
restart** to stamp existing rows first:

```bash
# 2b. Only after org columns become NOT NULL:
cd packages/shared && pnpm exec tsx scripts/backfill-organizations.ts && cd ../..
```

## First-user bootstrap (headless)

> **`deploy/seed-selfhost.ts` is a dev/CI fixture bootstrap — real installs use the
> signup form.** With `AUTH_EMAIL_PASSWORD_ENABLED=true` (set in `selfhost.env.example`)
> a fresh box makes
> its first user through the normal `/login` email/password flow. This seed exists to
> mint users/orgs/sessions fast for CI fixtures and multi-org isolation probes, not to
> replace that path.

A headless flow still needs a shortcut when email/password is off: sign-up is disabled
by default, the magic-link route needs a real Resend key (it calls Resend's HTTP API,
not SMTP), and GitHub OAuth needs a browser handshake. `deploy/seed-selfhost.ts` seeds
authenticated user(s) + org(s) + session(s) straight into Postgres.

It works because better-auth's `bearer` plugin (enabled in `apps/www/src/lib/auth.ts`,
no `requireSignature`) signs a *raw* token itself — so a plain `session` row is
enough to authenticate with `Authorization: Bearer <session.token>`, with no
password and no cookie signing.

```bash
# Seeds 2 orgs (default), one owner each — covers cross-org isolation checks.
set -a; . deploy/selfhost.env; set +a
pnpm --filter @terragon/www exec tsx deploy/seed-selfhost.ts   # or: [orgCount]
```

It prints, per org, the user email, orgId, and a ready-to-use
`Authorization: Bearer <token>`. Verify:

```bash
curl -s -H "Authorization: Bearer <token>" http://localhost:3000/api/auth/get-session
# → {"session":{...,"activeOrganizationId":"org_selfhost_1"},"user":{...}}
```

Idempotent: user/org/member rows are deterministic per index and upserted; a fresh
session token is minted each run. The script imports the schema source directly
(not the `@terragon/shared/db` subpath export) because pnpm hoists a store copy
of that package whose exports map doesn't expose `./db` under tsx.

## First boot smoke (2026-07-15)

Ran end-to-end on macOS (Docker 29.4.0). Because 5432/6379/3000 were already taken
on the box, the stack was brought up on non-colliding ports
(`SELFHOST_POSTGRES_PORT=55432`, `SELFHOST_REDIS_PORT=56379`,
`SELFHOST_REDIS_HTTP_PORT=58079`, MinIO on 9000/9001, app on 3100) with the env's
`DATABASE_URL`/`REDIS_URL`/app URLs adjusted to match. Everything else was verbatim
from `selfhost.env.example`.

**Result: it boots and serves.** Production `next start` returned **HTTP 200** on
`GET /` (175 KB of real HTML, `<title>Terragon - Delegate coding tasks to AI
background agents</title>`) and on `GET /login` (a DB/auth-backed dynamic route).
Server stayed up well past 60s with zero error lines in the log; the only startup
notice was `Stripe is not configured - missing STRIPE_SECRET_KEY…`, i.e. the
deferred-SaaS-off path degrading gracefully rather than crashing.

Step-by-step:

| Step | Result |
|---|---|
| `docker compose … up -d` | All four services healthy; `minio-createbuckets` created `terragon` + `terragon-private` and set the public bucket to `download`. |
| Redis HTTP shim | `GET http://localhost:58079/` → 200. |
| `drizzle-kit push` | `Changes applied`; **40 tables** created in Postgres. |
| envsafe validation | Passed with the documented env — no missing-var failures. |
| `next start` → `GET /` | **HTTP 200**, HTML. |
| `next start` → `GET /login` | **HTTP 200** (proves DB + better-auth wired). |
| 60s stability | Still listening, no crash, no error lines. |

### Errors hit and how they were resolved

1. **`next dev` returns 500 on `/`** — `EvalError: Code generation from strings
   disallowed for this context`, thrown from the edge-runtime instrumentation
   bundle when the (trivial) edge middleware compiles. This is a **dev-mode only**
   webpack `eval`-devtool interaction with the Next.js edge runtime; it is
   unrelated to any self-host env var. The self-host path uses `next start`
   (production), where edge bundles don't use the `eval` devtool — and there the
   same `GET /` returns 200. **Resolution: use `next start`; dev-mode `/` 500 is a
   pre-existing chassis quirk, not a boot blocker.**

2. **`next build` fails the type gate at `apps/www/src/lib/auth-server.ts:35`** —
   `activeOrganizationId: string | null | undefined` not assignable to the
   schema-derived `Session` type's `string | null`. This is the seam between two
   files under concurrent edit during this work (`apps/www/src/lib/auth.ts`, which
   just added the better-auth `organization()` plugin, and
   `packages/shared/src/db/schema.ts`). **It is the tenancy agent's in-flight work,
   not a self-host defect**, so it was left untouched. To exercise the production
   runtime regardless, the type/lint gate was bypassed **temporarily** via
   `typescript.ignoreBuildErrors` in `next.config.ts` for the smoke build only —
   that change was reverted and is **not** committed. **Since resolved:** the
   org-plugin Session type reconciled in those two files, and `next build` now
   exits 0 with the type gate ON when the env is loaded (see [Build-time env
   requirement](#build-time-env-requirement-verified-2026-07-15)). The bypass is no
   longer needed for any purpose.

No self-host env fix was required — `selfhost.env.example` validated as-is.

## Chassis triage checklist — C2–C5 verdicts

| # | Step | Verdict | Evidence |
|---|---|---|---|
| C2 | Boots with no billing/analytics env | **PASS** | Stripe/PostHog/Loops/Resend/Slack all empty; app boots, logs "Stripe is not configured", lifecycle not blocked. |
| C3 | Dependency/security patch level | **NOT ASSESSED here** | Next 15.4.8 / React 19 build clean; `pnpm audit` not run (no install permitted this session). Track separately. |
| C4 | docker-compose boot | **PASS** | `docker-compose.selfhost.yml` brings up Postgres + Redis(+shim) + MinIO, all healthchecked green; app serves 200. (Hatchet not yet wired.) |
| C5 | Signup | **PARTIAL** | `/login` (the Better Auth entry) renders 200 against the compose Postgres, but a real self-serve signup can't complete on a SaaS-free box: email/password sign-up is disabled, magic-link needs a Resend key, GitHub OAuth needs a browser. The "First-user bootstrap" above seeds an authenticated user+org+session directly (verified via `/api/auth/get-session`), which unblocks downstream task/isolation checks; enabling a true self-serve signup path is an auth-config change (owned in `auth.ts`), out of this deploy scope. |

## Build-time env requirement (verified 2026-07-15)

`next build` evaluates route modules during page-data collection, which triggers envsafe
validation at module load — **a build without the runtime env present fails** with a
`Failed to collect page data for /api/internal/cron/...` error wrapping the envsafe banner.
Load the selfhost env (or CI equivalents) before building:

```bash
set -a; source deploy/selfhost.env.example; set +a   # or your real env file
pnpm --filter terragon-www build
```

Verified at HEAD (post org-plugin commits): with env loaded, `next build` exits 0 with the
type gate ON — the temporary `ignoreBuildErrors` bypass used during the first smoke is no
longer needed for any purpose. CI note (WI-7): the build job needs the full env var set,
not just test vars.

## Troubleshooting

**Signup returns HTTP 500 (`fetch failed` / `ECONNREFUSED` in the logs).** The
broadcast relay isn't running. A post-create user hook POSTs to
`/parties/main/user:<userId>` on `NEXT_PUBLIC_BROADCAST_URL` (port 1999); when
nothing is listening the hook throws and the signup response becomes 500 — even
though the `user` row is already committed. **Fix:** start `apps/broadcast`
(`cd apps/broadcast && pnpm exec partykit dev`) and retry; signup then returns 200
with a session. (`apps/broadcast` is one of the five stack services — it is not
optional once auth/user-lifecycle is exercised. A product-side fail-soft so signup
degrades gracefully when the relay is down is tracked separately.)

**`GET /` returns 500 only under `next dev`** (`EvalError: Code generation from
strings disallowed`). A dev-mode-only webpack `eval`-devtool interaction with the
Next edge runtime; `next start` (the real self-host path) serves 200. Use
`next start`.

**`next build` fails collecting page data with an envsafe banner.** The build
evaluates route modules, which triggers envsafe at module load — load the full env
before building (see [Build-time env requirement](#build-time-env-requirement-verified-2026-07-15)).
