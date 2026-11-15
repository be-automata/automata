# #633 gate log

All commands were run from the worktree root on 2026-11-15, against local Docker Postgres. Every command exited 0.

| Command                                                                 | Exit | Result              |
| ----------------------------------------------------------------------- | ---- | ------------------- |
| `pnpm --filter @terragon/migrate exec vitest run --no-file-parallelism` | 0    | 45 tests, run twice |
| `pnpm turbo tsc-check --force`                                          | 0    |                     |
| `pnpm turbo lint --force`                                               | 0    |                     |
| `node deploy/lint-migrations.ts`                                        | 0    | 18 files            |
| prettier `--check` on changed files                                     | 0    |                     |

## Regression proof

The production-shape race runs as follows:

1. A writer holds a lock on the table.
2. Runner A's `CREATE INDEX CONCURRENTLY` starts and waits on that lock.
3. Runner B starts, and the test waits until B has waited on the advisory lock for more than `deadlock_timeout`.
4. The writer commits.

The test asserts these outcomes:

- `pg_index` has no `NOT indisvalid` rows;
- exactly one runner applied the file;
- the other runner wrote no ledger rows and ran no DDL.

Against `origin/main`'s `runner.ts` and `index.ts`, swapped in temporarily and restored with matching sha256, the test fails on every run: 5/5, then 3/3, then 1/1, each time with `expected 1 to be +0`, meaning one INVALID index was left. Against this branch it passes every time.

## Race matrix (T0)

The matrix ran on postgres:16-alpine and postgres:18-alpine, N=10 per start order, with `log_lock_waits` on and `deadlock_timeout=1s`. It covers these scenarios: empty database, CIC with a writer, CIC with a reader, CIC with no lock holder, and CIC during a dry run.

All 180 runs passed:

- 0 deadlocks;
- 0 INVALID indexes;
- exit codes were only 0 or 3, and every losing runner printed the exact lock message with no plan;
- every dry run exited 0.

## Review passes

- **Validate:** PASS_WITH_WARNINGS. Fixes W1–W5 are folded in.
- **Refinement and `/simplify`:**
  - a new test that a failed run releases the lock;
  - the poll helpers moved into `test-db.ts`;
  - one production-shape test instead of two.
- **roborev, four rounds, each "Pass".** Low findings fixed along the way:

  - an unlock error can no longer hide the original error;
  - the race tests always settle both runners;
  - AGENTS.md describes the lock once;
  - the warning is matched exactly;
  - the helpers take `ClientBase`;
  - local-environment details removed from the spec;
  - one symmetric race case instead of two.

  Left as notes:

  - the spec's T0 scripts came from the pre-implementation evaluation and are not in the repository;
  - the spec keeps superseded phase text, and its "Validate round 1" section overrides it.
