# #610 gate log

All commands were run from the worktree root on 2026-11-14. Docker Postgres and port-binding suites ran unsandboxed. Every command below exited 0.

## Final gates (at 0a26145e)

| Command                                                                                                                                         | Exit | Result                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm turbo tsc-check --force`                                                                                                                  | 0    | 21/21 tasks                                                                                                      |
| `pnpm turbo lint --force`                                                                                                                       | 0    |                                                                                                                  |
| `pnpm exec prettier --no-editorconfig --config .prettierrc --check <changed files>`                                                             | 0    |                                                                                                                  |
| `node deploy/lint-migrations.ts`                                                                                                                | 0    | 18 files linted                                                                                                  |
| `pnpm --filter @terragon/utils exec vitest run --no-file-parallelism`                                                                           | 0    | 117 tests, including the type-level fence test (mutation-checked: tsc exits 2 when `no_ref_fence` is added back) |
| `pnpm --filter @terragon/migrate exec vitest run --no-file-parallelism`                                                                         | 0    | 41 tests (count pinned at 23)                                                                                    |
| `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`                                                                          | 0    | 1460 tests (full suite)                                                                                          |
| `pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/cell-broker`                                                  | 0    | 135 tests, including the 6 real-git cases                                                                        |
| `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/git-broker.test.ts src/agent-run/receive-pack-refs.test.ts` | 0    | 38 tests (worker unchanged)                                                                                      |

## Schema drift (CI job reproduced locally)

The job ran on Postgres 18 in Docker:

1. `deploy/migrate.ts --apply` on database a: applied 23 migrations.
2. A second run on database a: applied 0 migrations.
3. `drizzle-kit push --force` on database b: exit 0.
4. `deploy/schema-drift.ts --a a --b b`: compared 1489 objects in each database.

Result: **schema drift: none (0 allowlisted differences)**. `drift-allowlist.json` is unchanged.

## Not green locally

`pnpm turbo format-check` exits 1 locally, on files this branch does not touch (for example `packages/env`). The local `~/.editorconfig` uses tabs, and turbo's format-check reads it. The repo's prettier config passes on every changed file. CI, which has no `~/.editorconfig`, is the authority.

## Review passes

- Validate: PASS_WITH_WARNINGS. Fixes F1–F4 are folded into the spec.
- Refinement: `isBranchRef` now refuses U+FFFD and lone surrogates.
- `/simplify`:
  - the null fence moved into `checkRefFence`;
  - test fixtures are shared.
- roborev, three rounds:
  - round 1: two low findings (spec contract wording; the worker type still listed `no_ref_fence`);
  - round 2: one low finding (the overload did not actually narrow the type);
  - round 3: pass, no issues.
