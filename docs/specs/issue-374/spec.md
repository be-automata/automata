# Spec — #374 Per-org Hatchet tenant map (#193 ticket 6, part A)

Source ticket: be-automata/automata#374 (body saved verbatim; never edited). Blocker #372 is CLOSED.

## Scope of this delivery run

Part **A** (per-org tenant map: schema, migration, resolver, call-site wiring, operator bind
script). Part **B** (engine-side `provision:tenant` CLI in `packages/worker`) is built only if the
clock allows after A; its live verification (AC 4) needs the box and is out of reach here.

## Ground truth (verified against this checkout, HEAD `8f9d76d`)

- `hatchetConfig()` is env-only: `apps/www/src/agent/hatchet/dispatch.ts:82-88`.
- `HatchetTriggerConfig {apiUrl, tenantId, apiToken}`: `apps/www/src/agent/hatchet/transport.ts:181-188`;
  `requireHatchetConfig` throws when any is empty (`transport.ts:194-206`).
- Call sites of the env config:
  - trigger: `dispatch.ts:128` (`triggerWithRetry`), self-heal bounded trigger + read-back `dispatch.ts:207`;
    both called around `dispatch.ts:1180-1192`; `recordHatchetRun` at `dispatch.ts:1234` (review runs only).
  - cancel on stop: `apps/www/src/server-lib/stop-thread.ts:40`.
  - sweep status/list: `apps/www/src/server-lib/supersede-sweep.ts:248-259` (inlines env, does not call `hatchetConfig()`).
  - fix reconcile list: `apps/www/src/server-lib/audit/fix-dispatch-reconcile.ts:160`.
  - self-heal drain list + cancel: `apps/www/src/app/api/self-heal/actions/route.ts:81-90`
    (`drainSelfHeal` in `server-lib/audit/self-heal-drain.ts`, `listRuns` at :207, `cancel(live)` at :227).
- `hatchet_run` table: `packages/shared/src/db/schema.ts:1893-1956`; no `tenant_id` column.
  Model `packages/shared/src/model/hatchet-run.ts` (`recordHatchetRun`).
- No `hatchet_tenant*` table exists (`grep -n hatchet_tenant packages/shared/src/db/schema.ts` → none).
- Encryption: `encryptValue`/`decryptValue` from `@terragon/utils/encryption`, key
  `env.ENCRYPTION_MASTER_KEY` (`packages/shared/src/model/agent-provider-credentials.ts:7`,
  `packages/env/src/apps-www.ts:51`).
- Org id in dispatch may be the synthetic `u:<userId>` (`dispatch.ts:988`): it can never have a
  binding row (FK to `organization.id`), so it resolves to env.
- Migrations: `deploy/migrations/YYYY-MM-DD-<slug>.sql`, `-- migrate:expand` header, `IF NOT EXISTS`
  (see `2026-10-22-queued-at.sql`); lint `node deploy/lint-migrations.ts`.
- Operator script shape: `deploy/bind-github-installation.ts`.
- **Already done:** engine hardening (`SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS: beautomata.com`) in
  `packages/worker/docker-compose.hatchet.prod.yml:75`, shipped by PR #377. Not redone here.

## Contract

### Table `hatchet_tenant_binding`

| column                     | type                                                   | notes                                          |
| :------------------------- | :----------------------------------------------------- | :--------------------------------------------- |
| `id`                       | text PK default `gen_random_uuid()`                    |                                                |
| `organization_id`          | text NOT NULL FK → `organization.id` ON DELETE CASCADE |                                                |
| `repo_full_name`           | text NOT NULL                                          | lowercase `owner/name`, or `'*'` = org default |
| `tenant_id`                | text NOT NULL                                          |                                                |
| `api_url`                  | text NULL                                              | NULL → `env.HATCHET_API_URL`                   |
| `api_token_encrypted`      | text NOT NULL                                          | `encryptValue(token, ENCRYPTION_MASTER_KEY)`   |
| `created_at`, `updated_at` | timestamp NOT NULL default now()                       |                                                |

Unique index `hatchet_tenant_binding_org_repo_unique` on `(organization_id, repo_full_name)`.

`hatchet_run.tenant_id text NULL` — the tenant the run was dispatched into; NULL = env tenant
(old rows).

Migration `deploy/migrations/2026-10-25-hatchet-tenant-binding.sql` (`migrate:expand`).

### Shared model `packages/shared/src/model/hatchet-tenant-binding.ts`

- `getHatchetTenantBindings({db, organizationId, repoFullName})` → rows whose repo is the
  normalized repo or `'*'` for that org.
- `getHatchetTenantBindingByTenant({db, organizationId, tenantId})` → row or undefined.
- `upsertHatchetTenantBinding({db, organizationId, repoFullName, tenantId, apiUrl, apiToken, encryptionKey})`
  — encrypts at write, upserts on the unique key.

### Resolver `apps/www/src/agent/hatchet/tenant-resolver.ts`

- Pure `resolveHatchetConfigFromRows({rows, repoFullName, env, decrypt})`: repo row → `'*'` row →
  env `hatchetConfig()`. With no rows the returned object is **deep-equal to `hatchetConfig()`**.
  A row with an empty/non-string `tenant_id`, an empty token, a `repo_full_name` that is neither
  `'*'` nor a lowercase `owner/name`, or an `api_url` that is not `http(s)://` throws
  `HatchetTenantBindingError`. Decryption happens here (at use).
- `resolveHatchetConfig({db, organizationId, repoFullName})`: loads rows, calls the pure function.
  `organizationId` starting with `u:` or null → env without a query. No module-level cache.
- `resolveHatchetConfigForRun({db, organizationId, repoFullName, tenantId})`: for an existing run.
  `tenantId` null or equal to `env.HATCHET_TENANT_ID` → env; else the org's binding with that
  `tenant_id` (decrypted); none → throws (never looks in the wrong tenant).
- `resolveHatchetConfigForThread({db, threadId})`: thread's org + repo → `resolveHatchetConfig`.

### Call sites

- Dispatch: resolve once per dispatch from (thread org, thread repo); pass the config into
  `triggerWithRetry` and `triggerSelfHealBounded` (the read-back uses the same config); stamp
  `tenantId: config.tenantId` into `recordHatchetRun` (new optional param → `hatchet_run.tenant_id`).
- Stop: in-flight `hatchet_run` row → `resolveHatchetConfigForRun(row)`; else thread → `resolveHatchetConfigForThread`.
- Sweep: per claimed row, `resolveHatchetConfigForRun(row)`; injectable `deps` keep working.
- Fix reconcile + self-heal drain: `listRuns` resolves per `hint.threadId` via
  `resolveHatchetConfigForThread`; drain's `cancel` receives the thread id (signature
  `cancel(externalIds, threadId)`) and resolves the same way.

### Operator surface `deploy/bind-hatchet-tenant.ts`

`DATABASE_URL=… ENCRYPTION_MASTER_KEY=… HATCHET_TENANT_API_TOKEN=… pnpm exec tsx deploy/bind-hatchet-tenant.ts <orgSlug> <repo|'*'> <tenantId> [apiUrl]`
— token read from env (never argv, never logged); upserts via the shared model.

## Acceptance criteria (verbatim numbering from the ticket)

1. Resolver order unit-tested incl. malformed throws and no-rows = env byte-identical.
2. All call sites use the resolved config; `hatchet_run.tenant_id` stamped at dispatch.
3. Migration applies to a baseline DB; schema-drift green; assert-schema-ready passes.
4. `provision:tenant` live-engine verification. (box)
5. Provisioning CLI loopback-only by construction.
6. Public registration closed on the live engine. (box)
7. Epic AC 11 live two-org evidence. (box)

## Tests

- `apps/www/src/agent/hatchet/tenant-resolver.test.ts` (unit, pure function + `u:` short-circuit).
- Call-site wiring: existing `dispatch.test.ts`, `supersede-sweep` and drain/reconcile tests must stay green;
  add a sweep test asserting the per-row config is used when a row carries a bound tenant.
- Migration: `node deploy/lint-migrations.ts`; schema-drift is CI (needs Postgres).

## Gates (scoped)

- `pnpm --filter @terragon/shared exec tsc --noEmit`, `pnpm --filter @terragon/www exec tsc --noEmit`
- `pnpm --filter @terragon/www exec vitest run src/agent/hatchet/tenant-resolver.test.ts` (pure, no DB)
- `pnpm --filter @terragon/www exec eslint <changed files>`; `pnpm exec prettier --check <changed files>`
- `node deploy/lint-migrations.ts`
- DB-backed suites (www/shared) and schema-drift need Docker/Postgres → CI.

## Validator fixes (cycle 1, PASS_WITH_WARNINGS) — binding

- Sweep rule (iii) (`supersede-sweep.ts:452`, booting threads without a `hatchet_run` row) resolves its
  `listRuns` config with `resolveHatchetConfigForThread(t.id)`.
- `findSweepCandidates` (`packages/shared/src/model/hatchet-run.ts`) adds `tenantId` to its projection.
- Sweep test seam: `SweepDeps` gains optional `resolveRunConfig(row)` / `resolveThreadConfig(threadId)`;
  the default uses the resolver; a new test injects them and asserts the per-row config reaches
  `getAgentRunStatus`/`listAgentRunsForThread` (or the injected readers).
- Tests updated in the call-site phase: `server-actions/stop-thread.test.ts`,
  `app/api/self-heal/actions/route.test.ts` (mock `@/agent/hatchet/tenant-resolver`),
  `server-lib/audit/self-heal-drain.test.ts` (cancel gets `threadId`).
- Migration file is `deploy/migrations/2026-10-27-hatchet-tenant-binding.sql` (sorts after
  `2026-10-26-delivery-loop.sql`); timestamps match schema.ts (`timestamp` without time zone).
- `hatchet_run.tenant_id` is stamped for review runs (the only lane that writes `hatchet_run`);
  stop/drain/reconcile of other lanes resolve from the current binding — drain before unbinding.
- `resolveHatchetConfigForThread` selects `thread.organizationId, thread.githubRepoFullName` by id.
- Tests compare "no rows" against `hatchetConfig()` (vitest env `HATCHET_TENANT_ID=TENANT_TEST`).
