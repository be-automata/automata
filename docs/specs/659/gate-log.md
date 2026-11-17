# #659 gate log (final tree, f80f1454, 2026-11-17)

Every command was run from the worktree root on the final tree. Exit codes are real (`echo $?` after each).

| Gate | Command | Exit | Output |
|---|---|---|---|
| install | `pnpm install --frozen-lockfile --prefer-offline` | 0 | lockfile in sync |
| typecheck | `pnpm turbo tsc-check` | 0 | 21/21 tasks |
| lint | `pnpm turbo lint` | 0 | |
| format | `pnpm turbo format-check` | 0 | 18/18 tasks |
| migration lint | `node deploy/lint-migrations.ts` | 0 | `lint-migrations: OK — 20 file(s) linted, 5 grandfathered` |
| migrate tests | `pnpm --filter @terragon/migrate exec vitest run` | 0 | 45 passed |
| shared tests | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` | 0 | 96 files, 1672 tests passed |
| coverage | `pnpm --filter @terragon/shared run test:coverage -- src/model/agent-bus --coverage.include='src/model/agent-bus/**'` | 0 | capabilities.ts 100/100/100/100; agent-run.ts 100% lines and statements, 96.7% branches (the read-back `not_found` after a committed insert) |
| AC1 schema drift | postgres:18 throwaway container; `DATABASE_URL=$PG/a pnpm exec tsx deploy/migrate.ts --apply` (×2); `DATABASE_URL=$PG/b pnpm -C packages/shared exec drizzle-kit push --force`; `pnpm exec tsx deploy/schema-drift.ts --a $PG/a --b $PG/b` | 0 / 0 / 0 / 0 | `applied 25 migration(s)` (fresh), then `applied 0 migration(s)`; `compared 1510 objects in a (a) with 1510 in b (b)`, `schema drift: none (0 allowlisted difference(s))` |
| roborev (via roborev-guard) | `roborev-guard review --branch --wait` | 0 | job 1213: Pass, no findings (after rounds 1207, 1209, 1210, 1211, 1212) |

## Negative controls

- `createChildRun` parent lock: with `.for("update")` removed, "waits on a concurrent markBlocked of the parent and then refuses" fails (`expected true to be false`: the spawn did not wait).
- `ensureRootRun` parent lock: with `.for("share")` removed, "a child's root registration waits for its parent's registration in flight, then refuses" fails the same way.

## After rebasing on origin/main (eccb1aef; no migration or schema changes upstream)

`pnpm install --frozen-lockfile --prefer-offline` 0 · `pnpm turbo tsc-check` 0 · `pnpm turbo lint` 0 · `pnpm turbo format-check` 0 · shared vitest 0 (96 files, 1681 tests) · migrate vitest 0 (45 tests).
