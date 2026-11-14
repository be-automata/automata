# Spec #609 — remote-cell push tokens: workflows:write only for orgs that opt in

Source of truth: GitHub issue be-automata/automata#609 (body below, as published 2026-11-14 after the open-decisions walk; decision record `Verdict: READY` in the run state). Branch `feat/609-workflows-opt-in` off main `2b0ab177`.

## Ground truth (verified in this worktree at write time; planner probe)

- Exists: `getWriteInstallationToken`, `WRITE_OPTIONAL_PERMISSIONS = { workflows: "write" }` (`packages/shared/src/github-app.ts` ~:401-430), tests at `github-app.test.ts` ~:178, :208-230, positional call ~:418.
- Exists: write mint on both legs in `packages/cell-broker/src/git.ts` (POST ~:624, advert ~:783); `TokenMinter` in `packages/cell-broker/src/common.ts:20`; `mintFailureResponse` maps mint errors to 502 (`common.ts:43-58`).
- Exists: `organizationReviewSettings` (`packages/shared/src/db/schema.ts:1698`, PK `organization_id`, nullable switches); model `packages/shared/src/model/organization-review-settings.ts`; route `apps/www/src/app/api/org-review-settings/route.ts` (GET any member, PUT `isOrgAdmin` :33-35; PUT requires `blockTolerance` today :90; PostHog capture :128); `route.test.ts` mocks model and db.
- Exists: UI under `apps/www/src/components/settings/review-tolerance/`, mounted from `apps/www/src/components/settings/tab/review.tsx:242`; test pattern `org-draft-default-card.test.tsx` (`renderToStaticMarkup`); queries `apps/www/src/queries/org-review-settings-queries.ts`.
- Exists: `deploy/PILOT-RUNBOOK.md:1683` states the old workflows behaviour (to rewrite).
- `@octokit/auth-app@8.0.1` cache key includes the permission set (`dist-src/cache.js`), so AC7 holds by construction.
- Does NOT exist yet: column `cell_workflow_write`, `allowWorkflowWrite` dep, the UI card, the migration.

## Amendments (override the ticket text below where they differ)

1. **AC4:** a failed settings read answers 500 `internal_error` with **no token minted and no claim** (the read happens before the mint, which happens before `beginEffect`; the advert leg never claims). The settings read has its own try, separate from the mint try, so it is not mapped to 502 by `mintFailureResponse`.
2. **UAT T0:** the opt-in change is checked as the route's PostHog event (no event table, per OD1), not DB rows.
3. **No red typecheck between phases:** `getWriteInstallationToken(owner, repo, opts?: { allowWorkflows?: boolean; knownInstallationId?: number })` — `allowWorkflows` defaults to false, so existing callers compile and get the safe default in phase B already.
4. **Broker types:** a new `WriteTokenMinter = (owner, repo, opts: { allowWorkflows: boolean }) => Promise<{ token: string }>`; the read `TokenMinter` and gh.ts are untouched.
5. **PUT contract:** `/api/org-review-settings` PUT accepts `blockTolerance` and/or `cellWorkflowWrite` (at least one; `cellWorkflowWrite` must be boolean or null); "null clears, never delete the row" stays; each field change emits its own PostHog event.

6. **Push-leg order (validate fix 2):** command section → probe/400 check → **settings read** (own try; on failure `drop(section.reader)` then `internalError(...)` → 500) → write-token mint → probe pass-through → `beginEffect`. The zero-command probe POST also reads the setting (it mints a write token). No claim exists before `beginEffect`, so amendment 12 of #606 holds.
7. **Advert leg (validate fix 3):** `allowWorkflowWrite` is called only when `leg === "receive-pack-advert"`, in its own try before the shared mint try; never for upload-pack (test asserts it is not called).
8. **Resolver:** `isCellWorkflowWriteEnabled(row) = row?.cellWorkflowWrite === true` (missing row, NULL, false → off).
9. **Migration:** `-- migrate:expand` + `ALTER TABLE "organization_review_settings" ADD COLUMN IF NOT EXISTS "cell_workflow_write" boolean;` (precedent `2026-10-23-knowledge-org-controls.sql`); drizzle `boolean("cell_workflow_write")`, no default.
10. **Route tests:** PUT `cellWorkflowWrite` alone; both fields; non-boolean → 400; non-admin with `cellWorkflowWrite` → 403 before validation; absent field → patch has no `cellWorkflowWrite` key; the "neither field" case keeps 400. Update the route header doc (it says blockTolerance only).
11. **AC7 test:** mint with `allowWorkflows: true` (granted) then without on the same repo → two token POSTs, the second without `workflows`.

## Phases (validated; cap 5 files)

| Phase | Files                                                                                                                                                                                                                                                                 | ACs                   |
| :---- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------- |
| A     | new `deploy/migrations/2026-11-14-org-cell-workflow-write.sql`, `packages/shared/src/db/schema.ts`, `packages/shared/src/model/organization-review-settings.ts` (patch field + `isCellWorkflowWriteEnabled`), its test                                                | AC1 storage, AC5 data |
| B     | `packages/shared/src/github-app.ts` (optional `allowWorkflows`, default false), `github-app.test.ts` (rewrite + AC7 cache test), `packages/cell-broker/src/common.ts` (add `WriteTokenMinter` type only)                                                              | AC1, AC2, AC7         |
| C     | `packages/cell-broker/src/git.ts`, `apps/www/src/app/api/cell/git/[...path]/route.ts`, `apps/www/src/server-lib/cell-broker/git-push.test.ts`, `git-read.test.ts`, `real-git.test.ts`                                                                                 | AC3, AC4, AC6         |
| D     | `apps/www/src/app/api/org-review-settings/route.ts`, its `route.test.ts`                                                                                                                                                                                              | AC5 API               |
| E     | `apps/www/src/queries/org-review-settings-queries.ts`, new `apps/www/src/components/settings/review-tolerance/cell-workflow-write-card.tsx` + `.test.tsx`, `apps/www/src/components/settings/tab/review.tsx`, `deploy/PILOT-RUNBOOK.md` (rewrite :1683-1685; OD3/OD4) | AC5 UI, OD3, OD4      |

Gates: `pnpm turbo tsc-check`, `pnpm turbo lint`, `node deploy/lint-migrations.ts`, the package vitest runs with `--no-file-parallelism` (shared/www need docker Postgres), prettier `--no-editorconfig --config .prettierrc`. After the PR: file the OD3 follow-up issue.

---

# Remote-cell push tokens: `workflows: write` only for orgs that opt in

#608 (L3 PR 2 of #606) mints the cell push token with `workflows: write` whenever the installation grants it. A design review found the escalation: a prompt-injected remote cell can push a `.github/workflows/` change, and CI then runs it with the repo's secrets. GitHub's own Copilot cloud agent does not run Actions on its PRs until a human with write access approves them. This ticket makes the default token never carry `workflows`, adds an explicit per-org opt-in, and must land before L3 PR 4 turns `CELL_BROKER_ENABLED` on.

## Reality check on be-automata/automata@2b0ab177

| Fact                                                                                                                                                                                                                                | Where                                                                                              |
| :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------- |
| `WRITE_OPTIONAL_PERMISSIONS = { workflows: "write" }`                                                                                                                                                                               | `packages/shared/src/github-app.ts:401`                                                            |
| `getWriteInstallationToken(owner, repo, knownInstallationId?)` always passes it as `optional`, with `onPermissionsReadFailure: "fail"`                                                                                              | `github-app.ts:414-430`                                                                            |
| An optional permission is added whenever granted                                                                                                                                                                                    | `github-app.ts:269-273` (in `mintRepoInstallationToken`, `:230`)                                   |
| Tests pin the current behaviour ("adds workflows:write when the installation grants it")                                                                                                                                            | `packages/shared/src/github-app.test.ts:178`, `:208-230`                                           |
| `TokenMinter = (owner, repo) => Promise<{token}>`: no org, no options                                                                                                                                                               | `packages/cell-broker/src/common.ts:20`                                                            |
| Write token minted on the receive-pack advert leg and the push POST                                                                                                                                                                 | `packages/cell-broker/src/git.ts:783`, `:624`                                                      |
| The org is already at hand: `BearerContext.organizationId`, from `resolveCellStep`/`authorizeCellRequest`, passed to `handlePush` as `context`                                                                                      | `packages/shared/src/model/cell-authority.ts:48-53`, `common.ts:119`, `git.ts:772`                 |
| Route wires `mintWriteToken: getWriteInstallationToken`                                                                                                                                                                             | `apps/www/src/app/api/cell/git/[...path]/route.ts:21`                                              |
| Feature flags are global plus **per user** (`feature_flags`, `user_feature_flags`), not per org                                                                                                                                     | `packages/shared/src/db/schema.ts:1158`, `:1173`                                                   |
| Per-org governance row: `organization_review_settings` (PK `organization_id`; nullable switches resolved in code, e.g. the knowledge-engine kill switch), written via `/api/org-review-settings` (GET any member, PUT `isOrgAdmin`) | `packages/shared/src/db/schema.ts:1698`; `apps/www/src/app/api/org-review-settings/route.ts:33-35` |
| Per-org precedent: `organization_environment` + `organization_environment_event` write log; writes gated by `isOrgAdmin`                                                                                                            | `schema.ts:1763`, `:1786`; `apps/www/src/server-actions/organization-environment-variables.ts:31`  |
| A 2xx report-status `ng` is stored as final unless every reason matches `TRANSIENT_NG` (lock/timeout/"try again")                                                                                                                   | `git.ts:299-319`, `:495-499`, `storeOutcome` `:353`                                                |

**Rejection without the opt-in.** GitHub answers such a push with report-status `ng <ref> refusing to allow a GitHub App to create or update workflow ... without workflows permission` (exact wording and 200 status **not verified** against live GitHub). It does not match `TRANSIENT_NG`, so the broker **stores** it and replays it on an identical retry (same `oldSha newSha ref` key, `git.ts:112`). For an org that has not opted in, that is right: the answer is deterministic. The edge case: if an admin opts in mid-step, the identical push keeps replaying the stored refusal, and the cell has to push a new commit. Accepted; see OD4.

## Decisions (settled 2026-11-14 by the owner/TL)

- **OD1 — storage:** a nullable `cell_workflow_write boolean` column on `organization_review_settings` (additive migration; NULL or false = off, resolved in code like the knowledge-engine switch). No new table.
- **OD2 — who:** org admins and owners, through the existing `isOrgAdmin` gate of `/api/org-review-settings`, with a warning in the settings UI that the switch lets remote cells change CI workflow files.
- **OD3 — workflows a cell triggers indirectly:** documented in the PR, the runbook and onboarding (keep CI secrets in environments with required reviewers; scope `push` triggers so agent branches do not receive them), plus a follow-up issue to evaluate a broker-side check. Not built here.
- **OD4 — stale refusal after a mid-step opt-in:** accepted and documented; GitHub's workflows refusal stays stored (deterministic for a non-opted org).
- **OD5 — permissions read fails:** the push token keeps failing closed (502, no claim) whether or not the org opted in.
- **OD-0 — review:** sensitive PR (migration + token permissions); explicit TL review before merge.

## Contract

- `getWriteInstallationToken(owner, repo, { allowWorkflows, knownInstallationId? })`: `workflows: write` goes into `optional` only when `allowWorkflows === true`. With the opt-in, it is still added only if the installation grants it.
- `GitBrokerDeps` gains `allowWorkflowWrite(organizationId): Promise<boolean>`. The broker calls it with `context.organizationId` on both write legs and passes the result to the minter (the `TokenMinter` write signature gains an options argument). `@terragon/cell-broker` stays host-agnostic: it never reads org settings itself.
- The www route implements `allowWorkflowWrite` by reading `organization_review_settings.cell_workflow_write` for the cell's org (NULL/false → false). A failed settings read returns 500 `internal_error` before any mint or claim. It never mints on a guess.
- The setting is off by default (NULL), exposed on `/api/org-review-settings` (GET: any member; PUT: org admins/owners) and in the org settings UI with a warning. The change is recorded by the route's existing analytics event; no new audit table (OD1).

## Acceptance Criteria

- **AC1** With no setting row, or the setting off, the minted permission set is exactly `{contents: write, metadata: read}`, even when the installation grants `workflows: write`.
- **AC2** With the setting on, `workflows: write` is requested only when the installation grants it. When the installation does not, the token is the AC1 set (no failure).
- **AC3** Both write legs (advert `git.ts:783`, POST `git.ts:624`) use the cell's own `organizationId`. A cell in org A never gets org B's setting.
- **AC4** A failed settings read returns 500 and mints nothing; no claim is taken (amendment 1).
- **AC5** Only an org admin or owner can change the setting (`isOrgAdmin` on PUT `/api/org-review-settings`; a member gets 403). GET returns the current value to any member, and the settings UI shows it with the warning.
- **AC6** A workflow-file push without the opt-in reaches the cell as GitHub's `ng`, and the broker stores and replays it (tested with a canned report-status).
- **AC7** The token cache never serves a workflows token to an org that is not opted in. Today auth-app keys its cache by permission set; a test pins this.

## Tests

- `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/github-app.test.ts`: rewrite `:178`, `:208-230` for AC1/AC2/AC7.
- `pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/cell-broker`: `git-push.test.ts` and `git-read.test.ts` for AC3/AC4/AC6.
- `pnpm turbo tsc-check`, `pnpm turbo lint`.
- The column: a new `deploy/migrations/YYYY-MM-DD-org-cell-workflow-write.sql` (`-- migrate:expand`), `node deploy/lint-migrations.ts`, the CI `schema-drift` job; `apps/www/src/app/api/org-review-settings/route.test.ts` for AC5.

## Open decisions

All settled (see Decisions above). None remains open.

## UAT

- **T0 (local):** run the gates above. In a dev DB, toggle the setting as an admin and as a non-admin, and check the event rows.
- **T1a (CI):** green `ci.yml`, including `schema-drift` and migration lint.
- The routes stay off (`CELL_BROKER_ENABLED=false`, `packages/env/src/apps-www.ts:109`) until L3 PR 4. A live push of a workflow file against GitHub happens there, not here.
