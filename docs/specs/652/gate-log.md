# #652 gate log

All commands were run from the worktree root on 2026-11-17, against local Docker Postgres (the shared
suite's throwaway database). First run on `db820fa4` (code) + `b6a30fdf` (spec text). On `287ea1a3`
(the pre-landing review fixes: the organization-scoped 32-hex effect key) the tsc, lint-migrations,
migrate, shared and deploy-test lanes were rerun under the ship evidence ledger with the same exits
and counts, and prettier was rechecked on the changed files. `287ea1a3` touched no schema, lockfile
or package with a lint task, so the install, lint and schema-drift rows stand from the first run.

| Command                                                                                              | Exit | Result                                          |
| ---------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------- |
| `CI=true pnpm install --frozen-lockfile --prefer-offline`                                            | 0    | lockfile up to date                             |
| `pnpm turbo tsc-check --force`                                                                       | 0    | 21/21 tasks                                     |
| `pnpm turbo lint --force`                                                                            | 0    | 2/2 tasks (`@terragon/shared` has no lint task) |
| `node deploy/lint-migrations.ts deploy/migrations`                                                   | 0    | 20 files                                        |
| `pnpm --filter @terragon/migrate exec vitest run --no-file-parallelism`                              | 0    | 45 tests                                        |
| `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`                               | 0    | 96 files, 1622 tests                            |
| `node --test 'deploy/*.test.ts'`                                                                     | 0    | 104 passed, 1 skipped                           |
| CI schema-drift steps locally (migrations → db a, `drizzle-kit push --force` → db b, `schema-drift`) | 0    | 1503 objects, drift: none                       |
| `pnpm exec prettier --no-editorconfig --check` on the changed files                                  | 0    |                                                 |

`pnpm turbo format-check` fails on this machine in packages outside this diff because a home-level
`~/.editorconfig` (not in the repo) makes prettier expect tabs; with `--no-editorconfig` every
changed file is clean.

**Coverage: not measured.** `@vitest/coverage-v8` is not a dependency of any package, and vitest
resolves the provider from its own install location, so it could not be loaded without changing
the repo's `node_modules` or lockfile.

## Acceptance criteria → tests

| AC  | Proven by                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `control-effects.crash.test.ts` › "AC1: killed after the intent, before the upload: uploaded exactly once after the restart" (the child prints `killing at before-apply`, then SIGKILLs itself)                                               |
| 2   | `control-effects.crash.test.ts` › "AC2: killed after the upload, before effect_done: reconciled by marker, nothing uploaded again" (row read back: `reconciled = true`, `done_at` set)                                                        |
| 3   | `control-effects.test.ts` › "AC3: two concurrent deliveries produce one effect" (the second delivery is observed waiting on the row lock) and `control-effects.crash.test.ts` › "AC3: two clean deliveries of the same output leave one file" |
| 4   | `control-effects.test.ts` › "AC4: a new digest is a new key and a second effect" and `control-effects.crash.test.ts` › "AC4: a changed output digest produces a second effect"                                                                |
| 5   | `control-effects.crash.test.ts` › "AC5: with reconcile disabled the same crash uploads a second copy" (two marker files)                                                                                                                      |

Verbose run of both files: 22/22 passed, exit 0 (on `287ea1a3`, inside the ledger's shared run:
17 + 5 = 22/22).

## Negative controls

- **AC 5** is the ticket's own: the same crash as AC 2 with a target whose `findByMarker` answers
  false leaves two files, so the drill reaches the window between the upload and `effect_done`.
- **Inherited idle timeout.** With `set_config('idle_in_transaction_session_timeout', '0', true)`
  removed from `runEffect`, "keeps the lock through an apply longer than an inherited
  idle-in-transaction timeout" fails (exit 1): a pool with a 200 ms inherited timeout loses the
  session during a 500 ms apply. Restored, it passes.
