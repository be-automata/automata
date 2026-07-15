# ADR-001: Tenant-scoping enforcement — repository accessor now, RLS hardening later

- **Status:** Accepted
- **Date:** 2026-07-15
- **Context source:** `docs/triage/TENANCY-AUTH-AUDIT.md` (§1–§5), `docs/triage/P05-EXECUTION-PLAN.md` (WI-5)
- **Deciders:** P0.5 chassis-triage workstream
- **Supersedes / superseded by:** —

## Context

We are adopting the terragon-oss dump (`apps/www` + `packages/shared`) as a **multi-tenant**
SaaS chassis. The tenant boundary is the Better Auth `organization` (each org → a Hatchet
tenant + org-scoped rows). Terragon is built **per-user**; there is no organization concept
today.

The tenancy audit found the load-bearing risk is **not** the auth layer — Better Auth's
`organization` + `apiKey` plugins supply membership, invitations, active-org session state,
and org-scoped keys almost for free. The risk is the **query layer**:

- Isolation today is **application-level only**. There is **no RLS, no Postgres policy**, no
  repository base class, and no tenant-aware `db` wrapper. `packages/shared/src/db/schema.ts`
  is a single file of 41 `pgTable`s with zero policies.
- Ownership is enforced by **~96 hand-rolled `where(eq(table.userId, userId))` predicates**
  scattered across `packages/shared/src/model/*.ts` (e.g. `getThread` →
  `and(eq(thread.id, threadId), eq(thread.userId, userId))` at `threads.ts:416,567,669,884,971`).
- The guard layer (`apps/www/src/lib/auth-server.ts`: `userOnlyAction`, `getUserId*`,
  `getUserIdOrNullFromDaemonToken`) is **identity-only**. It hands a `userId` to a model
  function and trusts the model function to add the ownership predicate. Missing one predicate
  leaks across users today and will leak across **orgs** tomorrow.
- The db client is a single process-wide pooled Drizzle instance:
  `createDb(url) = drizzle(url, { schema })` over `node-postgres` (`packages/shared/src/db/index.ts`).
  Every request shares that pool; there is no per-request connection or transaction scoping.
- Tests run against a real Postgres **testcontainer**, schema applied by `drizzle-kit push`
  (`packages/shared/src/test-global-setup.ts`). `drizzle-kit push` manages **tables/columns/indexes
  only — it does not manage RLS policies or database roles.**

The retrofit that follows this decision is a **mechanical-but-wide sweep** across ~96 query
functions + 14 tables gaining `organizationId`. The single most important decision is **what
seam that sweep targets** — because correctness depends on not missing a predicate, and "did
every author remember it?" must stop being a code-review problem.

## Decision

Adopt a **hybrid, accessor-first** strategy:

1. **Now (blocks the sweep): introduce a tenant-scoped repository accessor** — the single seam
   the ~96-site sweep migrates onto. Model functions stop taking a bare `userId` and instead are
   reached through an accessor bound to a resolved `{ organizationId, userId }` tenant context, so
   the `organizationId` predicate is **structurally present** rather than hand-copied. The accessor
   is plain typed TypeScript over the existing Drizzle `db`; it requires **no** change to the
   pooled client, works unchanged against the testcontainer harness, and makes "forgot the tenant
   predicate" a **compile-time** shape error (a model call without a tenant context does not type).

2. **Later (defense in depth): add Postgres RLS as a hardening layer** once the accessor is proven
   and the app has been restructured for per-request transaction scoping. RLS keyed on a session
   GUC (`SET LOCAL app.current_org_id`) gives **DB-enforced** isolation that survives a raw query
   that bypasses the accessor — but it is deferred because it imposes real per-request transaction
   discipline and testing friction (below) that would slow the sweep if adopted first.

**Recommendation in three sentences:** Build the tenant-scoped repository accessor first and run
the whole predicate sweep onto it, because it is the DB-agnostic, testable seam that converts
tenant scoping from a per-call-site convention into a typed guarantee without disturbing the pooled
client or the testcontainer harness. Add Postgres RLS afterward as a second, DB-enforced layer once
the app is restructured for per-request `SET LOCAL` transaction scoping. Do **not** ship the
`organizationId` column sweep before at least one of these seams exists, or the long tail of
cross-tenant-leak bugs the audit warns about is guaranteed.

## Options considered

### Option A — Postgres RLS first (DB-enforced)

Enable `ROW LEVEL SECURITY` on each org-scoped table with a policy like
`USING (organization_id = current_setting('app.current_org_id'))`, and set the GUC per request.

- **Pro:** Strongest guarantee. A model function that forgets the predicate **cannot** leak —
  the database refuses the rows. Enforcement is centralized in the DB, not in ~96 call sites.
- **Con — connection model:** The current pool is shared process-wide. RLS needs the GUC set on
  the **same** connection that runs the query, so every request must either (a) run inside a
  transaction with `SET LOCAL app.current_org_id = $org` (Drizzle `db.transaction(...)`), or (b)
  check out a dedicated connection and `SET` it. `createDb` returns one shared instance today; this
  is a non-trivial restructure of how every route/action acquires `db`.
- **Con — testcontainer friction:** `drizzle-kit push` does not emit `CREATE POLICY` / `ALTER
  TABLE … ENABLE ROW LEVEL SECURITY`, so policies would need **hand-written raw-SQL migrations**
  outside the current push flow. Worse, the test (and app) DB role is the **table owner**, and
  owners **bypass RLS** unless `ALTER TABLE … FORCE ROW LEVEL SECURITY` is set **and** queries run
  as a **non-owning** application role. The testcontainer harness would need a dedicated app role
  and FORCE-RLS wiring before a single RLS test is meaningful — otherwise tests pass green while
  proving nothing.
- **Con — sequencing:** Adopting this first front-loads the connection restructure and the
  role/migration work before any predicate can be moved, stalling the sweep.

### Option B — Tenant-scoped repository accessor (app-level, typed)

A factory — `forTenant({ organizationId, userId })` — returns the model surface with the tenant
context bound, so callers cannot invoke a scoped query without providing an org. The
`organizationId` predicate is added **once, inside the accessor/model**, not at each call site.

- **Pro — typed & compile-enforced:** A scoped model call that lacks a tenant context is a type
  error. This is exactly the "convert did-every-author-remember into a guarantee" the audit asks
  for, at compile time.
- **Pro — zero infra disturbance:** Plain TypeScript over the existing pooled `db`. No connection
  restructure, no new DB role, no raw-SQL policy migrations. The testcontainer harness runs it
  **unchanged**, so every accessor path is directly unit-testable against real Postgres today.
- **Pro — incremental:** The ~96 sites migrate one model file at a time behind a stable seam; the
  guard layer changes shape only where it now threads `organizationId` alongside `userId` (resolved
  from `session.activeOrganizationId`).
- **Con — not DB-enforced:** A raw `db.select().from(thread)` that skips the accessor still
  bypasses scoping. The guarantee is "you must go through the accessor," enforced by types +
  review, not by the database. This is **far** stronger than today (one typed seam vs. 96 ad-hoc
  predicates) but weaker than RLS.

### Option C — Hybrid: accessor now, RLS hardening later (**chosen**)

Take Option B as the seam the sweep targets, then add Option A as a second enforcement layer once
the accessor is in place and the app is restructured for per-request `SET LOCAL`. The accessor
delivers the typed seam immediately without blocking on infra; RLS later closes the "raw query
bypass" gap with DB enforcement. The accessor's single choke point is also the natural place to
open the per-request transaction that RLS will require, so the accessor work is not thrown away —
it becomes the hook RLS binds to.

## Rollout order

1. **Auth + schema foundation (this work item, WI-5a/b):** enable the Better Auth `organization`
   plugin (+ `member`/`invitation` tables, `session.activeOrganizationId`); org-scope the
   apiKey/daemon-token resolver so it returns `{ userId, organizationId }`. No predicate changes yet.
2. **Additive columns:** add `organizationId` to the 14 flagged tables as **nullable**, backfill
   from each row's owning user's org, then index. Nullable-first keeps the app booting mid-migration.
3. **Build the accessor:** introduce `forTenant({ organizationId, userId })` and port **one**
   high-traffic model file (`threads.ts`) onto it end-to-end as the reference implementation.
4. **Sweep:** migrate the remaining ~96 model sites onto the accessor. Thread `organizationId`
   from `session.activeOrganizationId` through the guard layer alongside `userId`.
5. **Tighten:** flip `organizationId` to `NOT NULL` once backfill + sweep are complete; split
   admin checks (platform-admin `user.role` vs org-admin `member.role`) and add org-level feature
   flags.
6. **RLS hardening (later phase):** add a non-owning application DB role, `ENABLE`/`FORCE ROW
   LEVEL SECURITY` + `organization_id` policies via raw-SQL migrations, wire per-request
   `db.transaction` + `SET LOCAL app.current_org_id` at the accessor choke point, and extend the
   testcontainer harness to run as the app role so RLS tests are meaningful.

**Exit gate (from WI-5):** the **C10 cross-org isolation smoke test** passes — org A cannot read
org B's threads/environments/keys through any guarded path. This blocks all later phases.

## Consequences

- **Positive:** The predicate sweep gets a typed, testable seam before it starts, matching the
  audit's top de-risking recommendation. No disturbance to the pooled client or testcontainer
  harness now. RLS remains on the roadmap as DB-enforced defense in depth, and the accessor is the
  hook it will bind to — no rework.
- **Negative / residual risk:** Until RLS lands, isolation depends on all scoped reads going
  through the accessor; a raw `db` query bypasses it. Mitigations: a lint/review rule that flags
  direct `db` use in `model/*`, and the C10 smoke test as the standing regression guard.
- **Follow-ups:** `agentProviderCredentials.organizationId` nullable = "user-personal vs
  org-shared" (a genuine product decision, not just a retrofit); `githubPR` needs org scoping or two
  orgs on the same repo collide on `repo_number_unique`; `subscription.referenceId` flips from
  `user.id` to `organizationId`.
