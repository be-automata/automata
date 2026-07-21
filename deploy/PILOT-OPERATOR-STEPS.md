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

## 5. Hatchet execution-plane tunnel — NAMED tunnel (live)

The control plane (www on Workers) reaches the Hatchet engine through a **named
cloudflared tunnel**: `automata-hatchet` (id `73d79054-70f6-40f8-901a-d445eff83577`),
routing **`hatchet.beautomata.com → localhost:8888`**. `HATCHET_API_URL` = `https://hatchet.beautomata.com`
(a www Worker secret). Promoted from the ephemeral quick-tunnel before the ADR-036
parity block for stability. Its key advantage over the quick tunnel: the **hostname is
stable** — restarting the tunnel process reconnects to the same hostname, so NO re-secret
is needed.

Run it: `cloudflared tunnel run --url http://localhost:8888 automata-hatchet` (keep this
process alive on the engine box). Recovery if the tunnel PROCESS dies: just restart that
one command — the hostname and `HATCHET_API_URL` are unchanged. Verify with
`curl https://hatchet.beautomata.com/api/v1/meta` → 200. Credentials at
`~/.cloudflared/73d79054-*.json` (keep secret; delete the tunnel to revoke).

(Legacy ephemeral drill, if you ever fall back to a quick tunnel: `cloudflared tunnel
--url http://localhost:8888` → new `*.trycloudflare.com` URL → `wrangler secret put
HATCHET_API_URL` with it, no rebuild.)

## Runbook note (deploy lesson)

Never `source`/`set -a; . file` an env file whose values contain `&` (query
params, e.g. Neon pooler URLs) — bash treats `&` as a background operator and
the assignment silently fails, falling back to devDefaults (which once sent a
`drizzle-kit push` to the wrong local DB). Parse env files with `dotenv`/node,
never bash-source, for anything with URLs.

## 6. Phase-2: enable the single-writer review channel (`REVIEW_SINGLE_WRITER`)

ADR-036. The review agent runs with **no gh-write and no GitHub token**; it EMITS a
fenced-JSON verdict and the control-plane executor posts it exactly once. Enable it
in **policy-first order** — the box (skill + daemon policy) must be current BEFORE the
www flag flips, or a review run under the flag has no emit-skill / no executor.

```bash
# (a) Install/refresh the emit-only review skill on the daemon box (readable file —
#     the daemon claude -p does NOT auto-load skills; the instruction Reads this path).
mkdir -p ~/.claude/skills/github-ops
cp deploy/skills/github-ops/SKILL.md ~/.claude/skills/github-ops/SKILL.md

# (b) UPDATE the review automation instruction on already-onboarded repos.
#     REQUIRED and easy to miss: the seed is now idempotent (upserts the action), so
#     re-running it UPDATES the deployed automation row to the current inlined-contract
#     instruction. A create-only seed silently leaves a STALE instruction on an
#     existing repo (this shipped the old "prod skill: github-ops" text once and cost
#     two acceptance runs). Re-run the seed for every onboarded org/repo:
DATABASE_URL=postgres://... pnpm exec tsx deploy/seed-pilot-mirror.ts <orgSlug> <repoFullName> <installationId>
#     → expect "Updated automation action: Mirror: PR review (github-ops)".

# (c) Preflight on the box (fails closed if the skill is absent / wrong):
pnpm exec tsx deploy/review-single-writer-preflight.ts    # expect PASS / exit 0

# (d) Kickstart the worker so daemon+worker run current-HEAD phase-2 code
#     (run-worker.sh rebuilds the daemon dist on start):
launchctl kickstart -k com.automata.worker

# (e) Dark-deploy www (ships the executor/finish-wiring/sweep). SAFE-DARK: with the
#     flag unset=false every new path is a no-op (reconciler-only, today's behavior).
cd apps/www && (opennextjs-cloudflare build && wrangler deploy)
#     Bundle-verify: grep the built bundle for executeReviewFromIntent +
#     handleReviewEffectAtFinish (executor present) and confirm worker-entry.ts + the
#     4 triggers.crons survived the OpenNext build (the review sweep piggybacks the
#     hourly stalled-tasks cron).

# (f) FLIP the flag (runtime Worker secret, NO rebuild):
cd apps/www && wrangler secret put REVIEW_SINGLE_WRITER    # enter: true
#     Flip back: wrangler secret put REVIEW_SINGLE_WRITER → false (default is false).
```

`GITHUB_SIDE_EFFECTS_ENABLED=true` is still required for the executor to post (it
gates all GitHub mutation). A degraded/failed verdict fires the PostHog event
`review_single_writer_work_failed` + a `console.error`; wire a PostHog **alert** on
that event before relying on it to page (the code emits the signal; alerting is ops).
