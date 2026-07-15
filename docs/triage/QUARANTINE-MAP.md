# Deferred-Services Quarantine Map

**Scope:** entanglement map for the four DEFERRED services in the terragon-oss chassis
(`automata-platform`) — **Stripe/billing/credits, PostHog, Upstash/Redis, E2B/Daytona**.

These services are **not deleted** — they ship in later versions of the multi-tenant
product. Each must be quarantined behind a flag/interface with a **neutral default that
never blocks the core task lifecycle** (task create → queue → sandbox boot → agent run → PR)
when the service is unconfigured.

**Method:** static analysis only (no `pnpm install`, no package scripts).

## Verdict summary

| Service | Quarantine difficulty | Worst entanglement |
|---|---|---|
| Stripe / billing / credits | **Moderate** | LLM proxy credit gate returns HTTP 402 unconditionally — not behind `isStripeConfigured()` |
| PostHog | **Easy** | Single factory choke point, but a **hardcoded default project key** ships telemetry to the OSS author in prod |
| Upstash / Redis | **Moderate** | `withSandboxResource` + rate-limit `getRemaining` are Redis calls **inside the agent-run / queue-admission critical section, fail-closed** |
| E2B / Daytona (sandbox) | **Moderate** | `E2B_API_KEY: str()` is **required at boot with no default** → app won't start; `docker` provider is **hard-blocked outside test/dev** |

**Call-site classification legend:** CORE-BLOCKING (must be neutralized for v1) ·
PERIPHERAL (UI upsell/settings — render disabled) · ISOLATED (webhook/cron/proxy route —
can simply not be mounted).

---

## 1. Stripe / billing / credits — MODERATE

Two independent subsystems: **subscription tiers** (gate access + per-user concurrency)
and **credits** (gate LLM spend). The tier subsystem already fails open; the credit
subsystem does **not**.

### 1a. Env / boot — already safe
`packages/env/src/apps-www.ts:104-108`: all `STRIPE_*` vars are `str({ allowEmpty: true,
default: "" })`. App boots with Stripe unset. No change needed.

### 1b. `isStripeConfigured()` fallback — the existing neutral default
`apps/www/src/server-lib/stripe.ts:4-19` returns `false` when `STRIPE_SECRET_KEY` /
`STRIPE_WEBHOOK_SECRET` / price IDs are missing.
`apps/www/src/lib/subscription.ts:32-38` — `getAccessInfoForUser()` short-circuits to
`{ tier: "core" }` when `!isStripeConfigured()`. **This is the neutral default the tier
gates rely on:** with Stripe off, every user is `core`, never `none`, so all `tier ===
"none"` gates auto-pass.

### 1c. Tier gates on the task lifecycle — CORE-BLOCKING, already neutralized
All read `getAccessInfoForUser()`, so all pass when Stripe is off:
- `apps/www/src/server-lib/new-thread-shared.ts:91-94` — `createThread`: `if (tier ===
  "none") throw`. **This is the main task-create gate.**
- `apps/www/src/server-actions/new-thread.ts:47-48` — server action guard.
- `apps/www/src/server-lib/follow-up.ts:37-38,130-131` — follow-up messages.
- `apps/www/src/server-lib/automations.ts:149-150,201-224` — automation dispatch.
- `apps/www/src/app/api/webhooks/github/handle-app-mention.ts:95,530` — GitHub `@`-mention
  intake (ISOLATED webhook, but shares the same tier gate).

### 1d. Subscription-tiered per-user concurrency cap — CORE-BLOCKING (queue admission) ⚠️ hotspot
`apps/www/src/lib/subscription-tiers.ts`:
- `:8-20` hardcodes `productionMaxConcurrentTasks = 3`, `proMaxConcurrentTasks = 10`; no env override.
- `:52-56` `getMaxConcurrentTaskCountForTier` — `pro` → 10, else → 3.
- `:94-99` `getMaxConcurrentTaskCountForUser` → reads tier via `getAccessInfoForUser`.

Enforced at **two** admission points:
- **Queue drain:** `apps/www/src/server-lib/process-queued-thread.ts:21-36` —
  `concurrencyLimitReached: activeThreadCount >= maxConcurrentTasks` decides whether a
  queued thread is dequeued.
- **Direct start:** `apps/www/src/agent/msg/startAgentMessage.ts:143-176` — same check
  before starting a thread.

With Stripe off everyone is `core` → cap is a **fixed 3**, not the "env-configured cap" the
multi-tenant design wants. **Neutral default:** make `DEFAULT_MAX_CONCURRENT_TASK_COUNT`
read an env var (e.g. `MAX_CONCURRENT_TASKS_PER_USER`, default 3) so a self-hosted operator
can raise it without a paid tier. Also gates sandbox size (`subscription-tiers.ts:22-50` —
`large` is pro-only) and automations count (`:58-69`).

### 1e. Credit gate on the LLM proxy — CORE-BLOCKING and **NOT** neutralized ⚠️ WORST BILLING ENTANGLEMENT
The BYOK/managed model proxies gate on credit balance **without** consulting
`isStripeConfigured()`:
- `apps/www/src/app/api/proxy/anthropic/[[...path]]/route.ts:424-436` —
  `const { balanceCents } = await getUserCreditBalance(...); if (balanceCents <= 0) return
  402 "Insufficient credits"`.
- Same pattern: `proxy/openai/[[...path]]/route.ts:317-329`,
  `proxy/google/[[...path]]/route.ts:359-371`, `proxy/openrouter/[[...path]]/route.ts:336+`.

Signup credits are granted **only inside the Stripe Better-Auth plugin**
(`apps/www/src/lib/auth.ts:32-44` — plugin array is empty when `!isStripeConfigured()`; the
`$10` grant script `packages/shared/scripts/grant-signup-bonuses.ts:16,76-81` is manual).
So with Stripe **off**, a fresh user has `balanceCents = 0` and **any agent LLM traffic
routed through the platform proxy is blocked with 402** — breaking the agent-run step of the
core loop. `getUserCreditBalance` (`packages/shared/src/model/credits.ts:51-83`) is pure
DB math, independent of Stripe config, so it never fails open.

**Why it's the worst:** it's the one billing site that sits on the critical path *and* was
not given the `isStripeConfigured` escape hatch the rest of the billing surface has.

### 1f. PERIPHERAL / ISOLATED billing surfaces (render-disabled / unmounted)
- Server actions: `server-actions/billing.ts`, `subscription.ts`, `credits.ts`,
  `credit-breakdown.ts`, `admin/subscriptions.ts`, `admin/stripe-coupons.ts` — settings/admin UI.
- `server-lib/stripe-credit-top-ups.ts`, `server-lib/credit-auto-reload.ts` — top-up flows.
- Stripe webhook (Better-Auth plugin route) — ISOLATED, unmounted when plugin array empty.
- `lib/subscription-plan-config.ts`, `lib/subscription-msgs.ts` — upsell copy.

### Quarantine mechanism — billing
1. **Keep** the `isStripeConfigured()` fallback (already correct for tiers).
2. **Fix 1e:** add a `BILLING_ENABLED` / `isStripeConfigured()` short-circuit **before** the
   `balanceCents <= 0` return in all four `proxy/*/route.ts` files (fail-open when billing
   off), **or** run v1 BYOK-only and leave the proxy routes unmounted (ISOLATED).
3. **Fix 1d:** env-configurable concurrency cap in `subscription-tiers.ts:17-20`.
4. UI/webhook/top-up surfaces (1f): render disabled / do not mount.

---

## 2. PostHog — EASY

### 2a. Env / boot — safe, but leaks by default
`packages/env/src/apps-www.ts:81-88`: `NEXT_PUBLIC_POSTHOG_KEY` has
`allowEmpty: true` **and a real hardcoded default key**
(`phc_ITvLHD24gmXmQ4IbWa9DqWJyQZNJweLW8vOTpT9WkjS`) plus a default host
`https://us.i.posthog.com`. App boots fine, but **in production the default key means
telemetry silently ships to the OSS author's PostHog project** unless overridden.

### 2b. Single factory choke point
`apps/www/src/lib/posthog-server.ts:7-29` — `getPostHogServer()` lazily builds one
`PostHog` client. `disabled: process.env.NODE_ENV !== "production" || !!process.env.CI`
(`:11`) — already a no-op outside prod. Every server call site goes through this one factory
(`getPostHogServer().capture(...)`), e.g. `agent/sandbox.ts:439-466` (sandbox timing),
`startAgentMessage.ts:302`, `process-queued-thread.ts:54-60` (queue status). Client side:
`instrumentation-client.ts`, `instrumentation.ts`, `next.config.ts` rewrites.

### 2c. Classification — all PERIPHERAL
Every `capture()` is fire-and-forget telemetry wrapped around the core path, never awaited
in a way that blocks it (e.g. the sandbox-timing captures in `sandbox.ts:439/453` run after
the sandbox already succeeded/failed). No `capture()` sits on the synchronous critical path.
Nothing core-blocking.

### Quarantine mechanism — PostHog
Neuter the default key and gate the factory: in `posthog-server.ts:7-9`, return a no-op
stub when `NEXT_PUBLIC_POSTHOG_KEY` is empty (or add `disabled: !env.NEXT_PUBLIC_POSTHOG_KEY`
to the existing `disabled` expression), and **remove the hardcoded default** in
`env/apps-www.ts:82` (change to `default: ""`). Client-side rewrites in `next.config.ts` /
`instrumentation-client.ts` become inert with an empty key. One-file change; no core-path risk.

---

## 3. Upstash / Redis — MODERATE

### 3a. Env / boot — required in prod
`packages/env/src/apps-www.ts:18-23`: `REDIS_URL` / `REDIS_TOKEN` are `str({ devDefault })`
— i.e. **no prod default; required at boot in production**. Single client:
`apps/www/src/lib/redis.ts:4-7` — `new Redis({ url, token })` at import (no fallback, no
null guard).

### 3b. Uses, by criticality
- **Sandbox-resource lock — CORE-BLOCKING (agent-run critical section).** ⚠️ WORST REDIS ENTANGLEMENT
  `apps/www/src/agent/sandbox-resource.ts:46-81` — `withSandboxResource()` does
  `redis.pipeline().incr(...).expire(...).exec()` and **throws `"Failed to acquire sandbox
  resource"`** if the result is falsy (`:59-61`). It wraps the agent run at
  `startAgentMessage.ts:276`. If Redis is unconfigured/down the `exec()` rejects → the agent
  never runs. **Fails closed inside the core loop.**
- **Sandbox-creation rate limit — CORE-BLOCKING (queue admission).**
  `apps/www/src/lib/rate-limit.ts:15-40` (`sandboxCreationRateLimit`). Consumed at
  `process-queued-thread.ts:26,34-35` via `getRemaining()` →
  `sandboxCreationRateLimitReached: remaining === 0`, and at `startAgentMessage.ts:147`.
  A Redis failure rejects the `Promise.all`, erroring queue drain so **no thread is
  dequeued** — the queue silently stalls. `trackSandboxCreation` (`rate-limit.ts:31-40`)
  itself swallows over-limit, but `getRemaining` in the drain path does not.
- **Task-creation rate limits — PERIPHERAL-ish (fail-closed by `throw`).**
  `checkCliTaskCreationRateLimit` (`rate-limit.ts:92-103`, used `server/orpc/cli-router.ts`),
  `checkShadowBanTaskCreationRateLimit` (`:113-127`, used `new-thread-shared.ts:90` — but
  no-ops for non-shadow-banned users, `:115`), waitlist/onboarding limits (`:62-80`).
- **Sandbox hibernation bookkeeping — PERIPHERAL.** `sandbox-resource.ts:14-44,83-140`
  (`setTerminalActive`, `setActiveThreadChat`, `shouldHibernateSandbox`) — cost/idle
  management, not lifecycle-blocking.

### 3c. No existing fallback
`redis.ts` has **no** "no env configured" branch — it fails at import if envsafe let an
empty value through, and at call time if the endpoint is unreachable. Fail-closed everywhere.

### Quarantine mechanism — Redis
Introduce a **no-op / in-memory Redis facade** behind a flag (e.g. `REDIS_ENABLED` or
"URL present"): in `redis.ts`, when `REDIS_URL` is empty return an in-memory stub that
implements `incr`/`expire`/`get`/`set`/`sadd`/`srem`/`smembers`/`del`/`pipeline` (single-node
counters are correct for a single-tenant box). This makes `withSandboxResource` **fail-open**
(always acquire) and rate limiters effectively unlimited. Alternatively wrap `getRemaining` /
`withSandboxResource` to treat Redis errors as "allow". Env: relax `REDIS_URL`/`REDIS_TOKEN`
to `allowEmpty` in `env/apps-www.ts:18-23`. Moderate because the fix touches a shared client
used by a fail-closed critical-section lock, not just a settings page.

---

## 4. E2B / Daytona (sandbox providers) — MODERATE

### 4a. `ISandboxProvider` interface supports Docker-only — CONFIRMED
`packages/sandbox/src/types.ts:58-98` defines `ISandboxProvider` (`getSandboxOrNull`,
`getOrCreateSandbox`, `hibernateById`, `extendLife`) and `ISandboxSession`.
`packages/sandbox/src/providers/docker-provider.ts:227-...` — `DockerProvider implements
ISandboxProvider` fully (empty constructor; `getOrCreateSandbox` shells out to
`docker run`). Caveats: `extendLife` is an unimplemented TODO (`:~288`) and `hibernateById`
intentionally no-ops (`:~292`) — both are lifecycle *niceties*, not core-blocking.
**Docker can be the sole registered provider.**

### 4b. Two blockers to Docker-only in prod ⚠️ WORST SANDBOX ENTANGLEMENT
1. **Boot:** `packages/env/src/apps-www.ts:69` — `E2B_API_KEY: str()` is **required, no
   default, no `allowEmpty`** → envsafe **throws at startup** if unset. The app won't even
   boot Docker-only. (`DAYTONA_API_KEY:70` is already optional.)
2. **Runtime guard:** `packages/sandbox/src/provider.ts:21-30` — the factory
   `getSandboxProvider(provider)` **throws for `"docker"` unless `NODE_ENV` is
   `test`/`development`** (same for `"mock"`). So even if selected, Docker is refused in
   production.

### 4c. Provider selection — where the default lives
`apps/www/src/agent/sandbox.ts:391-425` — app-level `getSandboxProvider({ userSetting, ... })`
resolves the provider **string**: `NODE_ENV==="test"` → `"mock"`; `forceDaytonaSandbox`
feature flag → `"daytona"`; else `userSetting` where `"default"` → **`"e2b"`** (`:411-412`).
Called from `new-thread-shared.ts:179-183` and persisted on the thread
(`schema.ts:281,477`). The package factory `provider.ts:8-37` maps that string → instance
(static `import` of `E2BProvider` → `@e2b/code-interpreter`, but the import is module-load
only; `E2BProvider`'s constructor is empty and the E2B SDK reads `E2B_API_KEY` lazily at
`Sandbox.create()`, so importing it is harmless when E2B is unused).

### 4d. What breaks if E2B env is absent
- App **fails to boot** (4b-1) — hard stop, before any lifecycle runs.
- If that env check is relaxed but the selector still returns `"e2b"` (default), sandbox
  boot throws at `Sandbox.create()` (no API key).
- With both fixed and Docker selected, the core loop works; only `extendLife`/`hibernate`
  degrade (sandboxes won't auto-pause/extend — acceptable for v1 single-tenant).

### 4e. PERIPHERAL sandbox surfaces
`components/settings/tab/sandbox.tsx`, `sandbox-provider-selector.tsx`,
`settings/sandbox/page.tsx` (provider picker UI); `app/api/test/e2b/route.ts`,
`app/api/test/daytona/route.ts`, `packages/debug-scripts/{e2b,daytona}-ssh.ts` (ISOLATED
test/debug routes — do not mount); admin sandbox pages.

### Quarantine mechanism — sandbox
1. **Env:** relax `E2B_API_KEY` to `str({ allowEmpty: true, default: "" })`
   (`env/apps-www.ts:69`) so boot no longer depends on E2B.
2. **Factory:** in `packages/sandbox/src/provider.ts:21-30`, drop (or env-gate) the
   `NODE_ENV` restriction on `"docker"` so Docker is a first-class prod provider.
3. **Default selection:** in `apps/www/src/agent/sandbox.ts:410-412`, make `"default"` (and
   ideally the whole selector) honor an env var (e.g. `DEFAULT_SANDBOX_PROVIDER=docker`) so
   Docker is the neutral default when E2B/Daytona are unconfigured.
4. Provider UI + test routes (4e): render disabled / do not mount.
Interface swap is clean (`ISandboxProvider`); the work is the two guards, not the abstraction.

---

## Cross-cutting notes

- **Fail-open vs fail-closed is the real axis.** Billing tiers and PostHog already fail
  open; the **LLM-proxy credit gate (1e)** and **all Redis critical-section calls (3b)**
  fail closed on the core path — those are the two that will silently brick a Stripe-less /
  Redis-less deployment.
- **Boot-time env is a second gate.** Only `E2B_API_KEY` (4b-1) and `REDIS_URL`/`REDIS_TOKEN`
  (3a) are hard-required at startup among the four services; Stripe and PostHog are already
  boot-optional. Relaxing those three env entries is a prerequisite for any runtime quarantine.
