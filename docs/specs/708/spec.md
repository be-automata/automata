# #708 — feat(cells): gate cells per org, not only per user

Parent: #634. Decisions OD-1 / OD-2 taken by the owner on 2026-11-19 (see the issue).

## Why

Cells are gated by `cellsEnabledForUser` (OpenSandbox configured AND the per-user flag
`opensandboxCells`). Automation runs run as the automation's owner, and on production one account
owns the automations of every org, so the per-user flag moves every org onto cells at once. During
the #656 UAT (2026-11-19) the flag had to be flipped in short windows for that reason. This adds an
org-level gate so the rollout goes org by org.

## Ground truth (verified at `origin/main` = `34c43ad8`, 2026-11-19)

| Claim                                                      | Where                                                                                                                                                                                                                  | Verified                    |
| :--------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------- |
| Gate is per user only                                      | `apps/www/src/server-lib/compute/cell-gate.ts:74-87` `cellsEnabledForUser`                                                                                                                                             | yes                         |
| Caller 1: cell-plan route, gate runs before `org_required` | `apps/www/src/app/api/daemon/cell-plan/route.ts:102-105` (gate), `:130-131` (`org_required` from `thread.organizationId`)                                                                                              | yes                         |
| Caller 2: dispatch marker helper                           | `apps/www/src/agent/hatchet/dispatch.ts:806-823` `cellEligibleForUser` (dynamic import, catch → false, logs error name only)                                                                                           | yes                         |
| Marker call site                                           | `dispatch.ts:1210-1219` — `isPlainTaskRun && thread?.organizationId && (await cellEligibleForUser(userId))`                                                                                                            | yes                         |
| No other caller of `cellsEnabledForUser`                   | `grep -rn cellsEnabledForUser apps packages` → only the two above                                                                                                                                                      | yes                         |
| `organization` table, `is_personal` precedent              | `packages/shared/src/db/schema.ts:130-141`                                                                                                                                                                             | yes                         |
| Better Auth additionalField precedent                      | `apps/www/src/lib/auth.ts:322-335` (`isPersonal`, `input: false`)                                                                                                                                                      | yes                         |
| Org model helpers                                          | `packages/shared/src/model/organizations.ts` (`getOrganizationById`, ...)                                                                                                                                              | yes; no cells helper exists |
| No org admin page exists                                   | `apps/www/src/app/(sidebar)/(site-header)/internal/admin/` has no `organization*` route                                                                                                                                | yes                         |
| Admin page guard + test                                    | every admin `page.tsx` calls `getAdminUserOrThrow`; enforced by `.../internal/admin/admin.test.ts` (walks every `page.tsx`)                                                                                            | yes                         |
| Admin server-action guard                                  | `adminOnly` in `apps/www/src/lib/auth-server.ts:383-393`; precedent `apps/www/src/server-actions/admin/knowledge.ts` + `knowledge.test.ts`                                                                             | yes                         |
| Admin menu                                                 | `apps/www/src/components/admin/main.tsx` "Configuration" section                                                                                                                                                       | yes                         |
| Latest migration file                                      | `deploy/migrations/2026-11-21-agent-messages.sql` → new file must sort after it                                                                                                                                        | yes                         |
| Migration lint                                             | `deploy/lint-migrations.ts` (L2: NOT NULL needs DEFAULT; L5: ADD COLUMN needs IF NOT EXISTS)                                                                                                                           | yes                         |
| Schema gate                                                | `deploy/assert-schema-ready.ts` derives REQUIRED from schema.ts; `SINCE_NOTES` has `organization.is_personal` note at `:104-106`                                                                                       | yes                         |
| Existing tests touching the gate                           | `apps/www/src/app/api/daemon/cell-plan/route.test.ts` (mocks `getFeatureFlagForUser`; `org_required` test at `:497-507`; `cells_disabled` tests `:509-532`), `apps/www/src/agent/hatchet/dispatch-cell-marker.test.ts` | yes                         |
| README rollout step                                        | `packages/worker/deploy/README.md:1287-1289` "Rollout (R7)" — per-user flag only                                                                                                                                       | yes                         |
| `readOrgSettings()` in dispatch                            | reads per-repo review settings with an org default, not the org row — NOT used for the gate                                                                                                                            | yes                         |

## Scope

1. **Schema.** `organization.cellsEnabled: boolean("cells_enabled").notNull().default(false)` in
   `packages/shared/src/db/schema.ts`, commented like `isPersonal`.
2. **Migration.** `deploy/migrations/2026-11-22-organization-cells-enabled.sql`, header
   `-- migrate:expand`, one statement
   `ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "cells_enabled" boolean DEFAULT false NOT NULL;`
   (same shape as the `is_personal` add in `2026-10-14-environment-org-unique.sql:30`). Add a
   `SINCE_NOTES` entry `organization.cells_enabled` in `deploy/assert-schema-ready.ts`.
3. **Better Auth.** `cellsEnabled` additionalField in `apps/www/src/lib/auth.ts` with
   `type: "boolean", required: false, defaultValue: false, input: false` — the org
   create/update API cannot set it.
4. **Model helpers** in `packages/shared/src/model/organizations.ts`:
   - `getOrganizationCellsEnabled({ db, organizationId }): Promise<boolean>` — false when the row
     is missing.
   - `setOrganizationCellsEnabled({ db, organizationId, enabled }): Promise<boolean>` — true when
     a row was updated.
   - `listOrganizationsForAdmin({ db })` — id, name, slug, isPersonal, cellsEnabled, createdAt,
     ordered by name.
5. **Gate.** In `cell-gate.ts`, replace `cellsEnabledForUser` with
   `cellsEnabledForRun({ db, userId, organizationId }: { …; organizationId: string | null | undefined })`:
   false when `organizationId` is empty, false when not configured (no DB read), then the org
   row, then the user flag (short-circuit, so "env unset → flag not read" still holds).
6. **Callers.**
   - cell-plan: `cellsEnabledForRun({ db, userId: ctx.userId, organizationId: thread.organizationId })`
     in place of the current gate; stays first; still answers `cells_disabled` 404. The later
     `org_required` check stays (it narrows the type and is defence in depth).
   - dispatch: `cellEligibleForUser(userId)` → `cellEligibleForRun(userId, organizationId)`, passed
     the `thread.organizationId` the call site already checks; same catch-and-log behaviour.
7. **Admin.** Page `apps/www/src/app/(sidebar)/(site-header)/internal/admin/organizations/page.tsx`
   (server: `getAdminUserOrThrow`, `listOrganizationsForAdmin`) rendering a client component
   `apps/www/src/components/admin/organizations-cells.tsx` (table: name, slug, personal badge, a
   `Switch` for cells). Toggle calls `setOrganizationCellsEnabledAction({ organizationId, enabled })`
   in `apps/www/src/server-actions/admin/organization.ts`, wrapped in `adminOnly`; validates the
   input types; returns `{ ok: true } | { ok: false, error: "not_found" | "invalid_input" }`; logs
   `[admin:org-cells] { actorUserId, organizationId, enabled }` (ids and a boolean only). Menu
   entry "Organizations (cells)" under Configuration in `components/admin/main.tsx`.
8. **README.** Rewrite the "Rollout (R7)" bullet: cells run only when OpenSandbox is configured
   AND the user flag is on AND the run's org has `cells_enabled` (admin page
   `/internal/admin/organizations`); default off; roll out org by org; rollback = switch the org
   off (applies on the next dispatch / cell-plan, no deploy) or unset `OPENSANDBOX_URL`.

## Decision taken in the spec (validator: check it)

- **Org-less thread at cell-plan answers `cells_disabled` 404, not `org_required` 403.** The gate
  runs first ("off means off: 404"), and the ticket contract says `cellsEnabledForRun` is false
  for an org-less thread, so the gate now refuses it before the `org_required` check. The
  existing test at `route.test.ts:497-507` changes to expect 404 `cells_disabled`. Neither code
  mutates anything. The caller is the worker, which treats both as final refusals
  (`packages/worker/src/agent-run/cell-www-client.test.ts:88-95`); dispatch never marks an
  org-less thread (`dispatch.ts:1214-1217`), so no real run reaches this case, and nothing
  depends on `org_required` from cell-plan. Alternative (move `org_required` before
  the gate) would leak a non-404 when cells are off, contradicting the route's own comment.

## Out of scope

Per-repo gating (OD-2); any eligibility change (lanes, agent, profile evidence); a CLI/API way
to set the flag; backfilling any org to true.

## Contract

- `cellsEnabledForRun` is false for an org-less thread.
- `cell-plan` answers `cells_disabled` (404) when the org is off.
- The org flag is read per call (no cache), so a toggle applies on the next dispatch / cell-plan.

## Acceptance criteria (from #708)

1. With the user flag on and org A enabled, a plain task run in org A gets the cell marker and a
   cell; a run in org B (same owner) stays on the box.
2. With the user flag off, no org gets cells.
3. With OpenSandbox unconfigured, no org gets cells.
4. The admin can switch an org on and off, and the change applies to the next dispatch without a
   deploy.
5. Existing per-user behaviour is unchanged when every org is enabled.

## Tests

- `apps/www/src/server-lib/compute/cell-gate.test.ts` (new, DB-backed): truth table configured ×
  user flag × org enabled, plus org-less (null/undefined) → false, missing org row → false, env
  off → no flag read.
- `cell-plan/route.test.ts`: beforeEach enables the test org; new "404 cells_disabled when the
  org is off" (no `cell_step` rows); org-less test updated per the decision above.
- `dispatch-cell-marker.test.ts`: beforeEach enables the org; new "org A enabled gets the marker,
  org B (same user) does not"; "toggling the org off removes the marker on the next dispatch".
- `packages/shared/src/model/organizations.test.ts`: default false, set/get round trip, set on a
  missing id returns false, list includes the field.
- `apps/www/src/server-actions/admin/organization.test.ts` (new): non-admin → `Unauthorized` and
  no write; admin toggles on/off; unknown id → `not_found`; bad input → `invalid_input`.
- `admin.test.ts` covers the new page's `getAdminUserOrThrow` automatically.
- `node deploy/lint-migrations.ts` on the new file.

## Risks / rollback

A wrong default would enable every org: column defaults to false and nothing backfills it.
Migration is additive (expand) and must reach prod before the www revision that reads it (the
migrate workflow does this on green main CI). Rollback: switch the org off, or unset
`OPENSANDBOX_URL`. Sensitive PR: a migration and a Better Auth field.

- Switching an org off mid-flight fails, it does not reroute: a run marked before the switch
  reaches cell-plan, gets `cells_disabled` 404 and fails closed (no box fallback), exactly as the
  user flag does today. The README says so.
- `input: false` blocks writes only: Better Auth's org read endpoints return `cellsEnabled` to
  org members. Acceptable (a boolean, no secret).

## Validator (2026-11-19): PASS_WITH_WARNINGS

RF1 applied (phase 2 holds the rename and both callers). W1-W3 applied above. Final phases:

1. `schema.ts`, migration `.sql`, `assert-schema-ready.ts`, `organizations.ts`, `organizations.test.ts`
2. `cell-gate.ts`, `cell-plan/route.ts`, `dispatch.ts`, `cell-plan/route.test.ts`, `dispatch-cell-marker.test.ts`
3. `cell-gate.test.ts`
4. `auth.ts`, `server-actions/admin/organization.ts`, `organization.test.ts`
5. `admin/organizations/page.tsx`, `components/admin/organizations-cells.tsx`, `components/admin/main.tsx`, `packages/worker/deploy/README.md`

## Phases (proposed; ≤5 files each)

1. Schema + migration + schema gate note + model helpers + model tests
   (`schema.ts`, migration `.sql`, `assert-schema-ready.ts`, `organizations.ts`,
   `organizations.test.ts`).
2. Gate + callers + tests (`cell-gate.ts`, `cell-gate.test.ts`, `cell-plan/route.ts`,
   `cell-plan/route.test.ts`, `dispatch.ts`) and `dispatch-cell-marker.test.ts` (6th file — split
   as 2a: gate + gate test + route + route test; 2b: dispatch + marker test).
3. Better Auth field + admin action + action test (`auth.ts`, `server-actions/admin/organization.ts`,
   `organization.test.ts`).
4. Admin UI + README (`admin/organizations/page.tsx`, `components/admin/organizations-cells.tsx`,
   `components/admin/main.tsx`, `packages/worker/deploy/README.md`).
