# #442 gate log

The gates ran on the branch after the merge, at `08c35080`
(`git merge --no-ff origin/main`, which brought in `a6996533`). They ran one at a time on
2026-11-17, and each command's exit code was recorded as observed.

| Gate                       | Command                                                                            | Exit | Observed                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------- |
| install                    | `CI=true pnpm install --frozen-lockfile --prefer-offline`                          | 0    | lockfile in sync                                                           |
| migration lint             | `node deploy/lint-migrations.ts deploy/migrations`                                 | 0    | `lint-migrations: OK — 24 file(s) linted, 5 grandfathered`                 |
| docs codegen               | `pnpm --filter @terragon/docs exec fumadocs-mdx`                                   | 0    |                                                                            |
| typecheck                  | `pnpm turbo tsc-check`                                                             | 0    | `Tasks: 21 successful, 21 total`                                           |
| lint                       | `pnpm turbo lint`                                                                  | 0    | `Tasks: 2 successful, 2 total`                                             |
| format                     | `pnpm turbo format-check`                                                          | 0    | `Tasks: 18 successful, 18 total`                                           |
| migrate tests              | `pnpm --filter @terragon/migrate exec vitest run --no-file-parallelism`            | 0    | 5 files, 45 tests passed                                                   |
| shared tests               | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`             | 0    | 99 files, 1752 tests passed                                                |
| www tests                  | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`                | 0    | 337 files passed (1 skipped), 4526 tests passed (9 skipped)                |
| schema-drift: apply to `a` | `DATABASE_URL=…/a pnpm exec tsx deploy/migrate.ts --apply` (Postgres 18 in Docker) | 0    | includes `2026-11-20-credential-unavailable`                               |
| schema-drift: second apply | same command again                                                                 | 0    | `applied 0 migration(s)` (no-op)                                           |
| schema-drift: push `b`     | `DATABASE_URL=…/b pnpm -C packages/shared exec drizzle-kit push --force`           | 0    |                                                                            |
| schema-drift: compare      | `pnpm exec tsx deploy/schema-drift.ts --a …/a --b …/b`                             | 0    | `compared 1532 objects … schema drift: none (0 allowlisted difference(s))` |

The worker suite was not run: `packages/worker` is not touched by this change.

## Review passes

| Pass         | Result                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| validate     | round 1 BLOCK: legacy threads never record the id, because every production thread is a legacy thread. Round 2 PASS_WITH_WARNINGS, with five phases.                             |
| refinement   | 7 findings, none blocking. Applied: the dispatch clear before the trigger, NULL on any resolution error, the worker-plane guard, the unmarked-row guard arm, and tests for each. |
| /simplify    | Applied: one `recordDeliveredCredential` wrapper, the clear run in parallel with `resolveHatchetConfig`, a type-guard helper, and a required Claude `credentialId`.              |
| roborev 1262 | Pass. One low finding: the spec had drifted from the code. Fixed in `5ceb4d73`.                                                                                                  |
| roborev 1263 | Pass. One low finding: no test of real source ids. Fixed in `abd21678`.                                                                                                          |
| roborev 1264 | Pass. No issues.                                                                                                                                                                 |
