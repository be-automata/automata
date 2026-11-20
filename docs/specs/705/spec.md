# #705 — a cell gets the repo's egress allowlist and an opt-in package-registry bundle

Ticket: be-automata/automata#705 (parent #634). Decisions OD-1 and OD-2 are final (owner, 2026-11-19).
Branch `feat/705-cell-egress` off `origin/main` = `34c43ad8`.

## Ground truth (verified in this worktree at `34c43ad8`, 2026-11-19)

| Claim                                                                       | Where                                                                                                                                                                                                                       | Verified state                                                                                     |
| :-------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------- |
| cell-plan passes no egress refs                                             | `apps/www/src/app/api/daemon/cell-plan/route.ts:209` `egressRefs: []`, `:210` `egress: { brokerHost }`                                                                                                                      | true                                                                                               |
| cell-plan's first mutation is `openNextAttempt`                             | `route.ts:181-193`; every refusal above it is non-mutating (`:62-64` docblock)                                                                                                                                              | true                                                                                               |
| `buildCellCreatePlan` compiles AFTER the attempt opens                      | `route.ts:204` (inside the try after `openNextAttempt`), `packages/shared/src/model/cell-create-plan.ts:187` `compileCellEgress(input.egressRefs, input.egress)`                                                            | true: a compile error today would surface after the step mutation, so the route must pre-compile   |
| The plan refuses any wildcard entry                                         | `cell-create-plan.ts:188-190` `CellPlanError("egress_wildcard")`                                                                                                                                                            | true                                                                                               |
| The plan carries only the digest                                            | `cell-create-plan.ts:212` `egressDigest: set.digest` (bundles not on the plan)                                                                                                                                              | true                                                                                               |
| Platform bundle                                                             | `packages/shared/src/model/cell-egress.ts:87-92` (broker host + `api.anthropic.com`)                                                                                                                                        | true                                                                                               |
| Compiler deps take a catalog (default `{}`)                                 | `cell-egress.ts:48-52`, `:334-342`                                                                                                                                                                                          | true                                                                                               |
| Catalog key must equal bundle id; platform id cannot be overridden          | `cell-egress.ts:274-292`                                                                                                                                                                                                    | true                                                                                               |
| Deny wins; deny inside an allowed wildcard is `inexpressible`               | `cell-egress.ts:344-371`                                                                                                                                                                                                    | true                                                                                               |
| Cap is counted over the rendered list                                       | `cell-egress.ts:57` `CELL_EGRESS_MAX_ENTRIES = 100`, `:308-320`, `:405`                                                                                                                                                     | true                                                                                               |
| Non-443 port, IP literal, invalid host refuse with a `CellEgressError` code | `cell-egress.ts:59-73`, `:118-201`                                                                                                                                                                                          | true                                                                                               |
| OpenSandbox renderer                                                        | `cell-egress.ts:428-438` (default deny, one allow per name, trailing `{deny, ports:[80]}`)                                                                                                                                  | true                                                                                               |
| Box path reads the repo row                                                 | `apps/www/src/agent/hatchet/dispatch.ts:1000-1024` (`getRepoReviewSettingWithOrgDefault` → `egressPolicyFromRow(orgSettings?.rows.repo, "worker")`)                                                                         | true                                                                                               |
| Pure row → shape                                                            | `apps/www/src/server-lib/egress/resolve-egress-policy.ts:103-114`; `packages/shared/src/model/egress-policy.ts:121-145` `buildEgressPolicyShape` (null policy → null; `none` → system hosts only; invalid entry throws)     | true                                                                                               |
| Shape type                                                                  | `egress-policy.ts:20-24`                                                                                                                                                                                                    | true                                                                                               |
| Cell marker at dispatch                                                     | `dispatch.ts:1211-1219` (`isPlainTaskRun && organizationId && cellEligibleForUser`)                                                                                                                                         | true; no egress condition today                                                                    |
| Worker never falls back to the box on a plan refusal                        | `packages/worker/src/agent-run/cell-run.ts:273-281` (`CellPlanRefusedError`), `run-executor.ts:15-19` (executor chosen once by `input.cell`)                                                                                | true: AC 7 ("completes on the box path") therefore needs the dispatch not to mark an `ip_port` run |
| `cell_decision` table, seams `dispatch \| compile \| resume`                | `packages/shared/src/db/schema.ts:3237-3268` (`seam` at `:3257`)                                                                                                                                                            | true; `compile` is declared but unused                                                             |
| `insertCellDecision`                                                        | `packages/shared/src/model/execution-profiles.ts:138-146`                                                                                                                                                                   | true                                                                                               |
| Today's only writer is the dispatch shadow row                              | `apps/www/src/server-lib/compute/resolve-cell-decision.ts:281-396` (seam `dispatch`, written before any step exists)                                                                                                        | true                                                                                               |
| `repo_review_settings` egress columns                                       | `schema.ts:1594-1609` (`egress_policy`, `egress_allowlist`)                                                                                                                                                                 | true                                                                                               |
| Upsert patch + reset family list                                            | `packages/shared/src/model/repo-review-settings.ts:310-470` (patch, `set`), `:548-560` (`otherFamiliesPresent`)                                                                                                             | true                                                                                               |
| Review-settings API (per repo)                                              | `apps/www/src/app/api/review-settings/[owner]/[repo]/route.ts:90-290`; shared parse/DTO `review-settings-route-shared.ts:42-55`, `:261-345`                                                                                 | true; the org-default route does not take egress fields                                            |
| Thread row in cell-plan has the repo                                        | `apps/www/src/lib/daemon-thread-auth.ts:105` `getThreadMinimal` (all thread columns but large/chat ones, so `githubRepoFullName` is present)                                                                                | true                                                                                               |
| A package-registry bundle / production catalog                              | —                                                                                                                                                                                                                           | **does not exist** (`git grep "registries@" ` empty; no `cell-egress-catalog.ts`)                  |
| OpenSandbox IT harness                                                      | `packages/sandbox/src/providers/opensandbox-cell.integration.test.ts` (gated `OPENSANDBOX_IT=1`, `ALLOWED = "httpbin.org"`, `policy(...)` helper, AC-3 case at `:340`); sandbox must not import shared (`:128-131` comment) | true                                                                                               |
| Deploy README section                                                       | `packages/worker/deploy/README.md:1134` "## OpenSandbox cells (ADR-014, #656)"                                                                                                                                              | true                                                                                               |
| Latest migration file                                                       | `deploy/migrations/2026-11-21-agent-messages.sql`                                                                                                                                                                           | the new file must sort after it                                                                    |

Already done (do not redo): the compiler, renderer, cap, guard, cell_decision table, the dispatch shadow row.

## Design

### 1. Storage (OD-2)

- `repo_review_settings.cell_egress_registries boolean` (nullable, no default; NULL or false = off).
  Drizzle `cellEgressRegistries: boolean("cell_egress_registries")` beside `egressAllowlist`.
- Migration `deploy/migrations/2026-11-22-repo-cell-egress-registries.sql`, `-- migrate:expand`,
  `ALTER TABLE "repo_review_settings" ADD COLUMN IF NOT EXISTS "cell_egress_registries" boolean;`
- `upsertRepoReviewSetting` patch gains `cellEgressRegistries?: boolean | null`; the reset's
  `otherFamiliesPresent` includes it (a row holding only this opt-in survives a tolerance reset).
- API: the per-repo PUT accepts `cellEgressRegistries` (boolean or null; anything else 400) through
  `parseEgressPatch`; the DTO returns it. No UI (out of scope).

### 2. Catalog (`packages/shared/src/model/cell-egress-catalog.ts`, new)

- `CELL_EGRESS_REGISTRIES_BUNDLE = "automata/registries@1"`, allow (no wildcards, no deny), exactly:
  `registry.npmjs.org`, `registry.yarnpkg.com` (npm/yarn); `pypi.org`, `files.pythonhosted.org`
  (PyPI); `pub.dev`, `pub.dartlang.org` (pub); `repo.maven.apache.org`, `repo1.maven.org` (Maven
  Central); `plugins.gradle.org`, `plugins-artifacts.gradle.org`, `services.gradle.org`,
  `downloads.gradle.org` (Gradle plugin portal + wrapper distributions); `crates.io`,
  `index.crates.io`, `static.crates.io` (crates.io); `proxy.golang.org`, `sum.golang.org` (Go).
  17 hosts. Multi-tenant storage hosts (`storage.googleapis.com`, S3) are deliberately excluded.
- `CELL_EGRESS_CATALOG: CellEgressCatalog` = `{ [id]: bundle }` (frozen).
- `repoCellEgressBundle(repoFullName, entries)`: id `repo/<owner>__<name>@<d>` where `<d>` is the
  first 16 hex of sha256(canonicalJson(sorted entries)), repo lowercased; `allow: entries`.
- `cellEgressForRepo({ repoFullName, row })` → `{ level, refs, catalog }`:
  - `row` undefined, or `egressPolicy` null → level `null`, no repo bundle;
  - `none` → no repo bundle (the box allows system hosts only);
  - `domain` → operator entries (via `buildEgressPolicyShape(row, { systemHosts: [] })`, so the
    validation is the box's own) become one per-run repo bundle when non-empty;
  - `ip_port` → refusal `{ ok: false, code: "egress_level_unsupported" }` (OD-1);
  - an invalid stored policy → refusal `egress_compile_failed` / `invalid_policy` (results, not throws; simplify pass);
  - `cellEgressRegistries === true` adds the registries ref with no policy or `domain`; under
    `none` it is ignored (validator fix 2: the box reaches system hosts only, and a cell never
    reaches more than its box; with no policy the box enforces nothing, so nothing widens);
  - `catalog` = `CELL_EGRESS_CATALOG` plus the repo bundle.
    Pure: no env, no DB. System hosts are never copied in (the platform bundle carries them).
- `planCellEgressForRepo({ repoFullName, row, brokerHost })` → `{ ok: true, set, level, refs,
catalog }` or `{ ok: false, code, reason? }`: `cellEgressForRepo` + `compileCellEgress` + the
  wildcard check, so dispatch and cell-plan run one pure check (validator fix 1).

### 3. cell-plan (`route.ts`)

- Read the repo row with `getRepoReviewSetting({ db, organizationId, repoFullName: thread.githubRepoFullName })`
  in the existing `Promise.all`.
- After the profile guard and before `openNextAttempt`: `planCellEgressForRepo`:
  - refusal `egress_level_unsupported` → `409 { error: "egress_level_unsupported" }`;
  - `CellEgressError` → `409 { error: "egress_compile_failed", reason: <code> }`;
  - any wildcard entry → `409 { error: "egress_compile_failed", reason: "egress_wildcard" }` (the
    plan would refuse it after the step opened).
- `buildCellCreatePlan` gets `egressRefs: refs`, `egress: { brokerHost, catalog }` (shape unchanged).
- After a plan is built: one `cell_decision` row, seam `compile`, mode `shadow`, allowed true,
  reasons `[]`, `profileId` and `evidenceIds` from `profileRecordForPolicy`, input
  `{ kind: "cell_egress", stepKey, attempt, egress: { level, refs, bundles, digest } }` (`kind`
  marks it a record of the set, not a policy decision). Never throws (a failed insert is
  logged by name only; the plan is returned). `digest` equals `plan.egressDigest`.
  Why a `compile` row rather than editing the dispatch row: the dispatch row is written before a step
  or attempt exists and is the box path's; the compile seam is declared in the schema for this.

### 4. Dispatch (OD-1 / AC 7)

`cellMarker` also requires `planCellEgressForRepo(...).ok` (after the user is eligible, so the
flag-off path is unchanged), so an `ip_port` repo (OD-1) and a set the cell cannot express (a
wildcard, a non-443 port, over the cap) are never marked and run on the box (validator fix 1). A
failure of the check means "not marked", never a failed dispatch. Box egress (the `egressPolicy`
value on the input) is untouched.

### 5. Docs

`packages/worker/deploy/README.md`, OpenSandbox cells: a "What a cell may reach" subsection (platform
set; `domain` entries, 443 only, no wildcards, cap 100; `ip_port` stays on the box; the registries
opt-in with its host list and the upload/exfiltration caveat; the PUT to set it; the compile row).

### 6. OPENSANDBOX_IT

A case in `opensandbox-cell.integration.test.ts` with two cells: (a) the policy the compiler
renders for `{ broker: osbit.test, repo: [httpbin.org] }`: 200 on `https://httpbin.org/get`,
refusal on `http://httpbin.org/get`, on `https://registry.npmjs.org/left-pad` and on an off-list
host; (b) the registries set: 200 on `https://registry.npmjs.org/left-pad` and
`https://pypi.org/simple/six/` (the HTTP calls behind `npm view` and `pip download`, AC 3), refusal
off the list. The sandbox package cannot import shared, so both literals are pinned by shared unit
tests that render the same sets.

## Out of scope

Closed DNS / loopback model broker (#638); review runs in cells; a UI; `deploy/images/cell/` (#707);
a cell refused at cell-plan time does not fall back to the box (dispatch keeps the known cases
off the cell; a setting changed between dispatch and plan fails closed).

## Tests

- shared `cell-egress-catalog.test.ts`: catalog key = id for every bundle; registries renders under
  the cap with no wildcard and with the platform set; repo bundle compiles and its id is stable and
  content-addressed; deny wins over a repo/registries allow; `none`/no row → `[]`; `ip_port` throws;
  invalid stored policy → `invalid_policy`; `none` ignores registries; `planCellEgressForRepo`
  ok and each refusal; both IT literal pins.
- shared `repo-review-settings.test.ts`: the opt-in round-trips; a row with only the opt-in survives reset.
- www `cell-plan/route.test.ts`: domain row → plan allows the entry and the compile row carries
  `digest === plan.egressDigest` and `bundles`; no row → only broker + model + deny 80; registries
  opt-in → registry hosts in the policy; 99 entries → 409 `egress_compile_failed`/`too_many_entries`
  and `steps()` empty; `ip_port` → 409 `egress_level_unsupported`, `steps()` empty; wildcard →
  409 `{ error: "egress_compile_failed", reason: "egress_wildcard" }`, `steps()` empty.
- www `[owner]/[repo]/route.test.ts`: PUT `cellEgressRegistries: true` stored and returned; a
  string → 400.
- www `dispatch-cell-marker.test.ts`: `ip_port`, `*.example.com` and `example.com:8443` rows → no
  marker, `egressPolicy` still on the input; `domain [example.com]` → marker.
- www `review-settings/route.test.ts`: typed mock rows gain the column (tsc).
- Box path: `dispatch*.test.ts`, `resolve-egress-policy` tests unchanged and green (AC 6).

## Phases (≤ 5 files each)

1. Storage: `packages/shared/src/db/schema.ts`, `deploy/migrations/2026-11-22-repo-cell-egress-registries.sql`,
   `packages/shared/src/model/repo-review-settings.ts`, `packages/shared/src/model/repo-review-settings.test.ts`.
2. Catalog: `cell-egress-catalog.ts`, `cell-egress-catalog.test.ts`.
3. cell-plan: `apps/www/src/app/api/daemon/cell-plan/route.ts`, `route.test.ts`.
4. API: `review-settings-route-shared.ts`, `[owner]/[repo]/route.ts`, `[owner]/[repo]/route.test.ts`,
   `apps/www/src/app/api/review-settings/route.test.ts`.
5. Dispatch: `apps/www/src/agent/hatchet/dispatch.ts`, `dispatch-cell-marker.test.ts`.
6. Docs + IT: `packages/worker/deploy/README.md`, `packages/sandbox/src/providers/opensandbox-cell.integration.test.ts`.

## Validation

Validator (fresh agent, graded against the repo): **PASS_WITH_WARNINGS**, 5 required fixes, all
applied above (fix 1 dispatch gate on the full pre-compile; fix 2 `none` ignores registries; fix 3
AC 3 IT case; fix 4 one wildcard refusal shape; fix 5 phases split, list-route mock rows).

## Gates

`pnpm turbo tsc-check`, `pnpm turbo lint`, `node deploy/lint-migrations.ts`, shared and www vitest on
the touched files plus the box-path egress tests, `pnpm --filter @terragon/sandbox exec vitest run`
(the IT file skips without `OPENSANDBOX_IT=1`), prettier on changed files. `OPENSANDBOX_IT=1` needs a
real OpenSandbox server (dind): deferred to post-merge.
