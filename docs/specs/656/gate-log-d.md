# #656 PR-D gate log

Branch `feat/656-d-run-end`, stacked on `feat/656-c-cell-plan` (d9e7acbc). Run from the worktree root.

| Gate                                                                                      | Result                  |
| :---------------------------------------------------------------------------------------- | :---------------------- |
| `tsc --noEmit` in `packages/shared`                                                       | exit 0                  |
| `tsc --noEmit` in `apps/www`                                                              | exit 0                  |
| `pnpm --filter @terragon/docs exec fumadocs-mdx`                                          | exit 0                  |
| `pnpm turbo tsc-check --force`                                                            | exit 0 (21 of 21 tasks) |
| `pnpm turbo lint --force`                                                                 | exit 0                  |
| `pnpm exec prettier --no-editorconfig --config .prettierrc --check` on every changed file | exit 0                  |

## Docker suites (run by the coordinator)

| Gate                                                                   | Result |
| :--------------------------------------------------------------------- | :----- |
| `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` |        |
| `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`    |        |

## Deviations

> Items 1 (`retired?: boolean`) and 2 (the re-export) were removed by the `/simplify` pass. Item 3 (the inlined alert helper) became `alertCellStepOnce`. from spec-d

- `DaemonTokenContext.retired` is optional (`retired?: boolean`): a required field broke hand-built contexts in route tests this PR does not own.
- `RETIRED_TOKEN_SUFFIX` and `isRetiredTokenName` live in `daemon-token-context.ts` and are re-exported from `daemon-token.ts`.
- The #652 ledger alert helper is inlined in `thread-status/route.ts` and `cell-teardown/route.ts`.

## Docker suites (outside the Claude sandbox, 2026-11-17)

| suite                                                              | exit | result                                          |
| :----------------------------------------------------------------- | :--: | :---------------------------------------------- |
| shared vitest                                                      |  0   | 1737 passed                                     |
| www vitest (first run)                                             |  1   | 25 failed, in two test files                    |
| www vitest (after the test fixes)                                  |  1   | 4574 passed, 5 failed, all matrix harness setup |
| matrix, context and the PR-D route tests (after the harness fixes) |  0   | 84/84                                           |
| `turbo lint --force`                                               |  0   |                                                 |

What the failures were, and how each was fixed:

- **Context tests:** `daemon-token-context.test.ts` compared the context exactly, and it now carries `retired: false`. The expectations were updated and a `retired: true` case was added.
- **Name length:** the matrix minted names longer than better-auth's 64-character limit. It now mints exactly as production does: name = `runKey`, mint, retire, then mint the live token under the same name. That is 43 characters with the test ids. Production's retire renames with SQL (`name || ':retired'`), so it never hits the plugin's length check.
- **Google and OpenRouter proxies:** they answer 503 before auth when their upstream key is unset, so the test now sets a fake key.
- **The three internal broadcast routes:** they fall back to a session lookup through `next/headers`, which the test setup stubs. They now get the `mockLoggedOutUser()` helper. The token still arrives through `X-Daemon-Token`, as it does in production.

## Refinement

No High findings: 1 Medium and 3 Low.

**Fixed:**

- **M1:** A session user could call better-auth's `/api/auth/api-key/update` on a key they own. That let them rename a retired token back, extend its expiry, or rewrite the metadata F1/F2 trust. `disabledPaths: ["/api-key/update"]` now blocks the HTTP route.
  - `git grep` finds no caller in apps or packages, client or server.
  - A real-auth test sends the owner's session to it: 404, and the row is unchanged. A control call to `/api-key/list` is not 404.
- **L1:** A failed retire answers 500 `cell_retire_failed`, so the worker retries; `finishStep` is idempotent. A test covers the throw (500), then the retry (200 `finished`, token retired).
- **L2:** The matrix gains `egress-event`, `run-staleness` and `run-credential-source`.

**Follow-up:** a retired token's already-open broadcast socket survives (`apps/broadcast/src/auth.ts:25-35`). That is unchanged from the old delete, and is recorded in spec-d's Risks.

**Gates after the fixes** (outside the Claude sandbox), all exit 0:

- www: 4585
- shared: 1737
- tsc, `tsc-check --force`, `lint --force`

## `/simplify`

**Applied:**

- One never-throwing `alertCellStepOnce` (`server-lib/cell-ops-alert.ts`) serves both routes. Both now log `skipped_unknown_attempt` for an unknown attempt.
- `isTransientOpsAlertFailure` is exported from `ops-alert.ts`.
- `CELL_MAX_ATTEMPTS` is exported and used in place of the three copies.
- One zod `cellAttemptSchema` validates the attempt in both routes.
- The dead `DaemonTokenContext.retired` field is deleted, so `isRetiredTokenName` in `verifyDaemonApiKey` is the only place the name is interpreted.
- An unused re-export and an unreachable fallback are deleted.

**Skipped:** moving the shared env and `extendSandboxLife` mocks into the test helpers, because that would edit other PRs' test files.

**Gates after the pass** (outside the Claude sandbox), all exit 0:

- www: 4584, including the real-auth refusal matrix
- shared: 1737
- tsc, `tsc-check --force`, `lint --force`

## Rebase onto main `39a663fa` (PR-C #685 and #688)

The rebase was clean. Gates after it, outside the Claude sandbox, all exit 0:

- frozen install, build, `tsc-check --force` (21/21), `lint --force`, prettier on the changed files;
- suites: shared 1752, www 4609.

## Roborev job 1268 (final range `39a663f..0fd3279`)

**Pass**, with one Low: spec-d's contract and this log's deviations still described pre-refinement behaviour. Fixed with a superseded block at the top of the contract, and notes on the deviations.
