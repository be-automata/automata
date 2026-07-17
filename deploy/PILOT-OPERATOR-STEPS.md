# Automata pilot — operator action list

Deploy is paused pending operator/billing actions that an agent can't perform.
Everything an agent could do is done (see status). No secret values appear here.

## Status (2026-07-17)

| Item | State |
|---|---|
| Neon schema | DONE — 44 tables pushed (direct endpoint) |
| R2 buckets | DONE — `automata`, `automata-private` created |
| broadcast Worker | LIVE — `https://automata-broadcast.dark-water-9247.workers.dev` (secrets set) |
| www Worker | **BLOCKED** — Workers Paid plan required (see #1) |
| Live smoke (signup write-proof) | pending www |
| Pilot mirror seed | pending www (needs the BeAutomata org the signup creates) |

## 1. Enable the Workers Paid plan (REQUIRED — blocks www)

The www Worker (OpenNext Next.js bundle) is **6.46 MiB gzipped**. The free plan
caps Worker scripts at **3 MiB**; the Paid plan ($5/mo) allows **10 MiB**, which
fits. Enable it here:
`https://dash.cloudflare.com/7f7b1207425deb9b2d7ea67b37406b01/workers/plans`

Once enabled, tell boot-coder — it will complete: deploy www → live smoke
(GET / + /login 200, real signup → 200 + session, Neon row check) → seed the
pilot mirror (shadow, installation 147206841).

## 2. Swap the 6 operator secrets on www (REQUIRED for GitHub/AI, not for the smoke)

The www Worker currently has **dummy** values for these (so it boots; the signup
smoke uses only auth+Neon, not these). The permission layer blocked reading them
from the orch-agents `.env`, so set the real values yourself. Run from
`apps/www/` **after** www is deployed (secret put needs the Worker to exist):

```bash
cd apps/www
wrangler secret put GITHUB_APP_ID            # numeric App id
wrangler secret put GITHUB_APP_PRIVATE_KEY   # PEM (paste; multiline ok via stdin)
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put OPENAI_API_KEY
```

Reuse the current orch-agents values (operator-authorized). The fresh
platform secrets (BETTER_AUTH_SECRET, ENCRYPTION_MASTER_KEY, GITHUB_WEBHOOK_SECRET,
INTERNAL_SHARED_SECRET, CRON_SECRET) are already minted and will be set by
boot-coder at www deploy — do NOT overwrite them.

## 3. R2 wiring (follow-up, not blocking)

Buckets exist. The app currently reaches R2 via the S3 API (`@aws-sdk/client-s3`
+ `R2_ENDPOINT`) with **dummy** R2 creds (R2 isn't exercised by the smoke). To
actually use object storage, either mint an R2 S3 API token and set
`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, or (preferred) refactor `packages/r2`
to the native R2 binding (`env.R2_BUCKET`) — a small code change, no token.

## 4. Add Checks permission to the App (REQUIRED for Check Runs)

The active-mode run hits `Resource not accessible by integration` on
list/create check-runs. Confirmed cause: the **automata-ai-bot** App's declared
permissions are `actions/contents/issues/pull_requests/repository_hooks: write`,
`metadata/repository_advisories/vulnerability_alerts: read` — **`checks` is
absent**. To publish GitHub Check Runs (the Verified-pillar surface), the operator
must, in the App settings
(`https://github.com/settings/apps/automata-ai-bot/permissions`):
add **Checks: Read and write**, save, then **re-approve the new permission on the
be-automata installation** (GitHub prompts the org owner to accept). Until then,
check-run publication is expected to fail — task creation/intake is unaffected.

## Runbook note (deploy lesson)

Never `source`/`set -a; . file` an env file whose values contain `&` (query
params, e.g. Neon pooler URLs) — bash treats `&` as a background operator and
the assignment silently fails, falling back to devDefaults (which once sent a
`drizzle-kit push` to the wrong local DB). Parse env files with `dotenv`/node,
never bash-source, for anything with URLs.
