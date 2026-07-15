# P0.5 Chassis Triage — Consolidated Execution Plan

**Date:** 2026-07-15. Synthesized from the four audit-spike reports in this directory:
`ENV-HOSTING-AUDIT.md`, `QUARANTINE-MAP.md`, `TENANCY-AUTH-AUDIT.md`, `UAT-VALIDATION-MATRIX.md`.
Program plan: orch-agents `.planning/PLATFORM-CONVERGENCE-OVERVIEW.md` (v3, §8).
**Hard constraint:** the orch-agents prod VPS serves two live orgs and is frozen — all work
here targets the new environment only.

## Audit verdict roll-up

| Area | Verdict | Worst finding |
|---|---|---|
| Env/hosting | Self-host very feasible; no edge lock-in | `waitUntil` in ~18 files silently drops background work off-Vercel |
| Stripe/billing | Moderate | LLM-proxy credit gate 402s unconditionally when Stripe off — kills agent runs |
| PostHog | Easy | Hardcoded default project key phones home in prod |
| Upstash/Redis | Moderate | Fail-closed Redis calls inside sandbox-boot/queue-admission critical section |
| E2B/Daytona | Moderate | `E2B_API_KEY` required at boot; Docker provider hard-refused in production |
| Tenancy/auth | **L bordering XL** | No org plugin; no central scoping seam — ~96 hand-rolled userId predicates |
| Test baselines | Old: 3543 green. New: 1431 cases but zero on docker-provider/broadcast/server-actions | 16 of 33 UAT cases uncovered |

## Work items (ordered)

**WI-1 — Leak/security neuters (first commit).**
PostHog: default key `phc_…` → `""` (`packages/env/src/apps-www.ts:82`); `TELEMETRY_ENABLED`
flag + no-op client at `getPostHogServer()` (`apps/www/src/lib/posthog-server.ts`); guard
client `posthog.init`. Confirm-or-disable `IS_ANTHROPIC_DOWN_*` side service.

**WI-2 — Boot unblockers (Docker-only, SaaS-free boot).**
(a) `E2B_API_KEY` optional in env schema; (b) allow `docker` provider in production
(`packages/sandbox/src/provider.ts:21-30` guard); (c) R2 → any S3 endpoint (MinIO) — client
already supports `R2_ENDPOINT`; (d) Redis: `ENABLE_REDIS` flag + in-memory/no-op proxy at
`apps/www/src/lib/redis.ts`, and fail-OPEN handling at the three hot sites
(`sandbox-resource.ts:59-61`, `startAgentMessage.ts:145-151`, `process-queued-thread.ts:26`).

**WI-3 — Billing quarantine.**
(a) LLM-proxy credit gates (4 proxy routes) behind `isStripeConfigured()` — fail open when
off; (b) concurrency cap: `MAX_CONCURRENT_TASKS_PER_USER` env override in
`subscription-tiers.ts` (neutral default, no paid tier required); (c) sandbox-size and
automation-count tier gates get neutral env defaults; (d) peripheral billing UI renders
disabled; Stripe webhook/cron routes unmounted when off. Billing code is NOT deleted —
it returns in a later version of the multi-tenant product.

**WI-4 — Hosting decoupling.**
(a) `waitUntil` shim → Next `after()` (18 files, mechanical) — durable-job migration to
Hatchet tracked as the real fix in P2; (b) `vercel.json` crons → Hatchet schedules hitting
the same `Bearer CRON_SECRET` endpoints (interim: loop script); (c) broadcast: PartyKit →
Workers/`wrangler deploy` (low-medium, no architectural blocker); (d) docker-compose for
Postgres 16 + Redis(+http shim) + www + broadcast; `drizzle-kit push` init.

**WI-5 — Tenancy foundation (the big one; starts here, continues as its own workstream).**
(a) ADR: tenant-scoping enforcement — Postgres RLS vs tenant-scoped repository accessor
(recommendation: RLS or accessor BEFORE any predicate sweep; DB-enforced not
review-enforced); (b) enable Better Auth `organization` plugin (+member/invitation tables,
`session.activeOrganizationId`); (c) schema sweep: `organizationId` on the 14 flagged
tables; drop the 4 `*_DEPRECATED` tables; (d) query sweep: ~96 model sites onto the seam;
(e) org-scope the apiKey/daemon-token resolver (`{userId, organizationId}`); (f) admin
split: platform-admin (`user.role`) vs org-admin (`member.role`); org-level feature flags.
Exit: **C10 cross-org isolation smoke test passes** (blocks all later phases).

**WI-6 — Characterization tests before touching untested hot spots.**
docker-provider (P5a target, 0 tests), broadcast relay (0 tests), the server-actions on the
task-create/queue path. New glue follows our conventions; existing vitest suites stay.

**WI-7 — CI bring-up + checklist.**
tsc-check + vitest in CI for the chassis; then run the C1–C12 "triage done" checklist from
`UAT-VALIDATION-MATRIX.md`. C4–C11 require dependencies installed (currently
permission-blocked — operator must clear `pnpm install`, ideally `--ignore-scripts` first).

## Plan reconciliations
- XState stays in `apps/www` (11 tests cover the machine). The v2 "no XState" rule applied
  to the old harvest-into-orch-agents direction; the no-new-formalisms rule now applies to
  migrated orch-agents packages instead.
- Dual-path feature-flag cutover (old P2b) superseded by org-level blue/green between the
  frozen VPS and the new environment (plan §8.0).

## Open items for the operator
1. Clear `pnpm install` in this repo (blocks WI-6/WI-7 verification, C4–C11).
2. Product name (TRADEMARKS.md bars "Terragon"; workspace name "automata-platform" is a
   placeholder).
3. WI-5 ADR choice: RLS vs repository accessor (recommendation will follow with the ADR).

## Follow-up work items (post-batch-1, discovered by validation)

- **WI-8: webhook endpoints must not 5xx on business rejections.** The GitHub mention probe
  (f7974bc) showed /api/webhooks/github returns HTTP 500 when the repo-access gate rejects a
  mention (dummy creds). GitHub marks 5xx deliveries failed and retries; business rejections
  (repo not installed, unmapped user) should fast-ack 2xx with a structured skip log —
  orch-agents' gateway semantics. Audit slack webhook for the same. Small, high-value before
  any real GitHub App points at the platform.
