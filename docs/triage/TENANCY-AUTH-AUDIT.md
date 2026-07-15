# Tenancy + Auth Audit — terragon-oss chassis

Scope: assess the terragon-oss dump (`apps/www` + `packages/shared`) for adoption as a
**multi-tenant** SaaS chassis where the tenant boundary is the Better Auth `organization`
plugin (each org → a Hatchet tenant + org-scoped rows). Terragon is built **per-user**;
this audit locates the retrofit surface. Static analysis only.

Key source files:
- Schema: `packages/shared/src/db/schema.ts` (1165 lines, single file, 41 `pgTable`s)
- Auth config: `apps/www/src/lib/auth.ts`
- Auth guards / server-action wrappers: `apps/www/src/lib/auth-server.ts`
- Model/query layer: `packages/shared/src/model/*.ts`
- API routes: `apps/www/src/app/api/**/route.ts` (24 routes)
- ORPC CLI router: `apps/www/src/server/orpc/cli-router.ts`

---

## 1. Drizzle schema inventory (41 tables)

There is exactly **one** schema file. No RLS, no Postgres policies — all scoping is
application-level via explicit `where(eq(table.userId, userId))` filters.

### Better Auth core (managed by plugins)
| Table | Current scoping | Verdict |
|---|---|---|
| `user` | global identity (`role`, `banned`, `stripeCustomerId`) | **Stays global.** The org plugin adds `organization`/`member`/`invitation` tables; `user.role` (admin plugin) stays as a *platform* role, org-role moves to `member.role`. |
| `session` | user-scoped (`userId` FK) | **Stays user-scoped.** Org plugin adds `activeOrganizationId` to session — that column is the request-time tenant selector everything else keys off. |
| `account` | user-scoped (OAuth/social) | **Stays user-scoped** (identity, not tenant data). |
| `verification` | global/transient | **Stays global.** |
| `apikey` | user-scoped (`userId` FK) | **NEEDS org context.** This is the daemon/CLI token (see §3). Programmatic calls must resolve to an org; add `organizationId` (or scope via `member`). |

### Billing / usage
| Table | Current scoping | Verdict |
|---|---|---|
| `subscription` | `referenceId` = `user.id` today (join at `admin.ts`: `subscription.referenceId = user.id`) | **NEEDS org.** Better Auth stripe plugin already keys on `referenceId`; flip it to `organizationId`. Org-level billing is the whole point of tenancy. |
| `userStripePromotionCode` | user-scoped | Stays user-scoped (personal promo) — or org, low stakes. |
| `userCredits` | user-scoped ledger | **NEEDS organizationId.** Credits become an org-pooled balance. Central to billing. |
| `usageEvents` | user-scoped | **NEEDS organizationId.** Usage rolls up to the org (Hatchet tenant billing). Central. |
| `usageEventsAggCacheSku` | `userId` (no FK, cache) | **NEEDS organizationId** to match `usageEvents` rollup. |

### Task lifecycle (CORE — the product)
| Table | Current scoping | Verdict |
|---|---|---|
| `thread` | user-scoped (`userId` FK, ~11 indexes prefixed by `userId`) | **NEEDS organizationId.** The central task row. Every `user_id_*` composite index becomes `org_id_*` (or `org_id,user_id`). |
| `threadChat` | user-scoped (`userId` + `threadId`) | **NEEDS organizationId** (or inherit via `thread`). Central. |
| `threadVisibility` | thread-scoped (`threadId` unique, no userId) | **NEEDS org semantics.** `ThreadVisibility` enum (`repo`/private/…) must gain an org tier; "visible to org" replaces the implicit per-user default. |
| `githubPR` | repo-global (`repoFullName`+`number`, `threadId` nullable) | **NEEDS org** if repos are org-scoped — otherwise two orgs on the same repo collide on the `repo_number_unique` index. |
| `githubCheckRun` | thread-scoped | Inherits via `thread`; no own column strictly needed. |
| `claudeSessionCheckpoints` | thread-scoped | Inherits via `thread`. |
| `threadReadStatus` | user+thread | **Stays user-scoped** (personal read state), but lives inside an org. |
| `threadChatReadStatus` | user+thread+chat | **Stays user-scoped.** |
| `automations` | user-scoped (`userId` FK) | **NEEDS organizationId.** Org-owned automations/schedules. Central. |

### Repos / environments / credentials
| Table | Current scoping | Verdict |
|---|---|---|
| `environment` | user+repo (`user_id_repo_full_name` unique) | **NEEDS organizationId.** Per-org repo env/secrets/MCP config. The unique index becomes `org_id,repo`. Central to execution. |
| `agentProviderCredentials` | user-scoped (encrypted API keys/OAuth) | **DECISION + likely NEEDS org.** Today each user brings their own Claude/agent creds. Multi-tenant wants org-shared creds (a team key). Add `organizationId` (nullable → "user-personal vs org-shared"). Central to execution. |
| `claudeOAuthTokens_DEPRECATED`, `geminiAuth_DEPRECATED`, `ampAuth_DEPRECATED`, `openAIAuth_DEPRECATED` | user-scoped, **UNUSED** (superseded by `agentProviderCredentials`) | **Ignore / drop.** Do not retrofit. |

### Slack
| Table | Current scoping | Verdict |
|---|---|---|
| `slackInstallation` | workspace-global (`teamId` unique) | **NEEDS org link.** A Slack workspace maps to an org; add `organizationId` so mentions route to the right tenant. |
| `slackAccount` | user+team | **Stays user-scoped** (links a user identity to Slack). |
| `slackSettings` | user+team | Stays user-scoped (or org default). |

### Feature flags / admin / access
| Table | Current scoping | Verdict |
|---|---|---|
| `featureFlags` | global definitions (`name`, `defaultValue`, `globalOverride`) | **Stays global.** |
| `userFeatureFlags` | per-user override (`userId`+`featureFlagId` unique) | **NEEDS a per-org sibling.** Add `orgFeatureFlags(organizationId, featureFlagId, value)` and insert an org level in resolution (see §4). |
| `accessCodes` | invite codes (`createdByUserId`) | Stays global/admin — but org invites should migrate to the org plugin's `invitation` table. |

### Global / marketing / personal-log (no tenant retrofit)
| Table | Scoping | Verdict |
|---|---|---|
| `waitlist`, `onboardingQuestionnaire`, `allowedSignups`, `reengagementEmails` | email-keyed, pre-signup | **Stay global.** |
| `onboardingCompletionEmails` | user-scoped log | Stays user-scoped. |
| `feedback` | user-scoped | Stays user-scoped (personal). |
| `userSettings` | user-scoped prefs | **Stays user-scoped**; some fields (default visibility, branch prefix) may later gain org defaults. |
| `userFlags` | user-scoped UI state | Stays user-scoped. |
| `userInfoServerSide` | user-scoped server state | Stays user-scoped. |

### Tally
- **NEEDS organizationId (or org retrofit): 14** — `apikey`, `subscription`, `userCredits`,
  `usageEvents`, `usageEventsAggCacheSku`, `thread`, `threadChat`, `threadVisibility`,
  `githubPR`, `automations`, `environment`, `agentProviderCredentials`, `slackInstallation`,
  `userFeatureFlags` (new sibling).
- **Inherit via parent thread (no own column): 3** — `githubCheckRun`,
  `claudeSessionCheckpoints`, (and `threadChat` if you choose inheritance over a column).
- **Stays user-scoped: 13** — `session`, `account`, `slackAccount`, `slackSettings`,
  `threadReadStatus`, `threadChatReadStatus`, `userSettings`, `userFlags`,
  `userInfoServerSide`, `onboardingCompletionEmails`, `feedback`, `userStripePromotionCode`,
  `user` (identity).
- **Stays global: 6** — `verification`, `featureFlags`, `waitlist`,
  `onboardingQuestionnaire`, `allowedSignups`, `reengagementEmails`, `accessCodes`
  (admin/global).
- **Deprecated / drop (do not retrofit): 4** — the four `*_DEPRECATED` credential tables.
- **Added by the org plugin: ~3–4** — `organization`, `member`, `invitation` (+ `team` if
  enabled), plus `session.activeOrganizationId`.

---

## 2. Better Auth setup & authorization pattern

**Config (`apps/www/src/lib/auth.ts`):** `betterAuth()` with drizzle adapter (pg). Plugins
enabled: **`admin()`, `bearer()`, `apiKey()`, `magicLink()`, and conditionally the Stripe
plugin.** Social provider: GitHub. Account access/refresh/id tokens are AES-encrypted in a
`databaseHooks.account.before` hook.

> **The `organization` plugin is NOT present.** Every "organization" string in the codebase
> is `ClaudeOrganizationType` (Claude Max/subscription tier) — unrelated to Better Auth
> tenancy. This is a greenfield add, not a reconfigure.

**Session shape:** `{ session, user }` from `auth.api.getSession()`. `session` carries
`impersonatedBy` (admin plugin). No active-org concept. 60-day expiry.

**Authorization pattern — per-call, hand-rolled, NOT central middleware:**
- `apps/www/src/middleware.ts` does **no auth** — it only moves an `access_code` query param
  into a cookie for 3 public paths. There is no route-level auth gate in middleware.
- Enforcement lives in `auth-server.ts` helpers + wrappers:
  - `getUserIdOrNull` / `getUserIdOrRedirect` / `getUserInfoOrRedirect` (page + RSC guards).
  - `userOnlyAction(cb, opts)` — wraps a server action, injects `userId` from session,
    throws `Unauthorized` if none. **This is the dominant pattern.**
  - `adminOnlyAction` / `getAdminUserOrThrow` — `user.role === "admin"`.
  - `getUserIdOrNullFromDaemonToken(request)` — API-key path (see §3).
  - `validInternalRequestOrThrow` — shared-secret (`X-Terragon-Secret`) for internal routes.
- ~**245** call sites use one of these guards across `apps/www/src`.

**Consistency verdict: MEDIUM.** Authorization is *consistently entered* (almost everything
goes through `userOnlyAction`/`getUserId*`), but it is **identity-only, not ownership-scoped
at a central layer**. The guard hands a `userId` to a model function, and **the model
function is responsible for adding `and(eq(table.userId, userId))`**. Ownership is enforced
~96 times by hand in `packages/shared/src/model/*`. Examples of correct scoping:
`getThread` → `and(eq(thread.id, threadId), eq(thread.userId, userId))`
(`threads.ts:416,567,669,884,971`). The risk is that this is a **convention, not a
guarantee** — a model function that forgets the `userId` predicate leaks across users today,
and will leak across **orgs** tomorrow. There is no query builder or RLS that enforces the
tenant predicate.

**Routes reading userId then querying without an ownership guarantee:** the API surface is
mostly safe because it funnels through the same model helpers — but two classes to watch:
- `app/api/cli/[[...slug]]/route.ts` + `server/orpc/cli-router.ts`: auth middleware resolves
  `userId` from the daemon token, then passes `context.userId` into `getThreads`/`getThread`.
  Correct today, but the tenant predicate is again delegated to the model.
- `app/api/daemon-event/route.ts`: resolves `userId` from token, passes to
  `handleDaemonEvent` — the handler must itself constrain writes to that user's threads.

---

## 3. API keys / programmatic access

**Yes — a token mechanism already exists.** The Better Auth **`apiKey()` plugin is enabled**
(`auth.ts:276`), backed by the `apikey` table (hashed `key`, `prefix`, per-key rate-limit
fields, `permissions`, `metadata`, `userId` FK). Programmatic clients send it as the
**`X-Daemon-Token`** header; `getUserIdOrNullFromDaemonToken` calls
`auth.api.verifyApiKey({ body: { key } })` and returns `key.userId`. The CLI/daemon and the
oRPC CLI router both authenticate this way.

**Where org-scoping slots in:** the apiKey plugin already stores `metadata` and
`permissions` per key — the clean retrofit is to (a) stamp `organizationId` onto the key
(column or metadata) at creation, and (b) have `getUserIdOrNullFromDaemonToken` return
`{ userId, organizationId }` so the daemon path resolves a tenant directly instead of
inferring it from the user's active org. This is the natural seam for Better Auth's apiKey ×
organization interplay — no new mechanism required, just a tenant field on the existing key.

---

## 4. Admin & feature-flag surface

**Admin users:** determined solely by **`user.role === "admin"`** (Better Auth admin plugin
field on `user`). Guarded by `getAdminUserOrThrow` / `adminOnly*`. ~**178** references to
`role`/`adminOnly`/`getAdminUser` across `apps/www/src`. For multi-tenant this bifurcates:
**platform-admin** (stays `user.role`) vs **org-admin/owner** (becomes `member.role` via the
org plugin). Every `adminOnly` site must be triaged into one bucket.

**Feature flags:** three-level resolution (`feature-flags.ts`):
`featureFlags.defaultValue` → `featureFlags.globalOverride` → per-user `userFeatureFlags`
override. `getFeatureFlagsForUser({ userId })` merges global + the user's overrides.

**What changes for per-ORG flags:** insert an **org level** between global and user —
`defaultValue → globalOverride → orgFeatureFlags → userFeatureFlags`. Add an
`orgFeatureFlags(organizationId, featureFlagId, value)` table and thread `organizationId`
through `getFeatureFlagsForUser` (→ `getFeatureFlagsForOrgUser`). The per-user table stays
for individual overrides within an org.

---

## 5. Retrofit estimate

- **Tables needing `organizationId` (or org retrofit): 14** (+ ~3–4 new plugin tables,
  + 1 new `orgFeatureFlags`). 3 inherit via `thread`. 4 deprecated tables dropped.
- **Query sites needing org scoping: ~96** hand-rolled `userId` predicates in
  `packages/shared/src/model/*.ts` — **each must additionally (or instead) filter
  `organizationId`.** ~245 auth-guard call sites in the app change shape only if the guard
  signature grows an `organizationId` (recommended: return it from the session's
  `activeOrganizationId` and pass it down alongside `userId`).
- **No central query-scoping layer exists to hook.** Scoping is per-call-site convention.
  There is no repository base class, no Drizzle RLS, no tenant-aware `db` wrapper. This is
  the single biggest driver of cost and risk: the retrofit is a **mechanical-but-wide** sweep
  across ~96 query functions, and correctness depends on not missing one.

**Size: L (bordering XL).** Main driver: **the absence of any central tenant-scoping seam.**
The auth/plugin side is genuinely small — Better Auth's `organization` + `apiKey` plugins do
the heavy lifting for membership, invitations, active-org session state, and org-scoped keys,
so wiring tenancy *in principle* is a config + a few tables. What makes it L/XL is the
**~96-site hand-rolled query layer** plus ~178 admin checks and the billing/usage rollup
(subscription `referenceId`, credits, usage aggregation) all keyed on `userId` today. The
highest-leverage de-risking move before the sweep: introduce a **tenant-scoped `db` accessor
or a repository layer that requires `organizationId`** (or Postgres RLS keyed on a session
GUC), converting "did every author remember the predicate?" from a review problem into a
compile-time/DB-enforced guarantee. Without that seam, plan for a long tail of
cross-tenant-leak bugs.
