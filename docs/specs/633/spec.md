# #633 spec: concurrent `migrate.ts --apply` must not deadlock on a CREATE INDEX CONCURRENTLY file

## Ticket

Two `deploy/migrate.ts --apply` runs against one Postgres deadlock whenever a `-- migrate:no-transaction` CIC file is pending. Usually one runner dies with `deadlock detected`. Sometimes both exit 1 and leave an INVALID index that needs a manual drop. On production, this happens when a manual run overlaps the CI `migrate.yml` run. The advisory lock that should make a second runner safe is what causes the deadlock.

### Ticket: Reality check on be-automata/automata@c5e25f07

| Claim                                                                                                                    | Where                                                             |
| :----------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------- |
| The lock is a blocking `pg_advisory_lock(hashtext('automata:schema_migrations'))`, with no try variant                   | `packages/migrate/src/runner.ts:14,106-118`                       |
| The CLI plans before it takes the lock, then re-reads the ledger under the lock                                          | `deploy/migrate.ts:156,178`; `runner.ts:249-251`                  |
| One session runs everything                                                                                              | `packages/migrate/src/client.ts`                                  |
| No-transaction files run in autocommit. An invalid-index check follows them and throws a `DROP INDEX CONCURRENTLY` hint. | `runner.ts:194-236`                                               |
| The CIC file uses `CREATE INDEX CONCURRENTLY IF NOT EXISTS`                                                              | `deploy/migrations/2026-10-24-knowledge-op-fingerprint-index.sql` |
| `migrate.yml` already has `concurrency: migrate-production`, `cancel-in-progress: false`                                 | `.github/workflows/migrate.yml:48-50`                             |
| The concurrency test has no CIC file                                                                                     | `packages/migrate/src/runner.test.ts:194-208`                     |
| AGENTS.md says the lock "serializes concurrent runners"                                                                  | `AGENTS.md:139-140`                                               |

### Ticket: Reproduction (spike 062, Postgres 16)

1. Create an empty database.
2. Start two `pnpm exec tsx deploy/migrate.ts --apply` runs at the same moment against it.
3. Result: deadlocked in **4/4** runs.
   - 3 runs: A applied all 23 files; B printed its plan, then `migrate: deadlock detected`, and exited 1.
   - 1 run: both exited 1, and `knowledge_op_claim_evidence_fingerprint_index` stayed INVALID until a manual `DROP INDEX CONCURRENTLY`.
   - The ledger stayed correct every time.
4. Control: the same race with the `runner.test.ts` fixture (no CIC) gave 2 + 0 applied, both exit 0 (2/2).

### Ticket: Root cause (confirmed 2026-11-15 with lock captures, Postgres 16 and 18)

1. B blocks inside `SELECT pg_advisory_lock(...)`. That running statement owns a virtual xid and holds a snapshot (`backend_xmin` set).
2. A holds the lock and runs CIC. CIC waits for every transaction older than its phase start, and B's waiting statement is one of them. The pg16 capture shows A's CIC waiting on vxid `6/8`, which is B's. The server log shows the CIC first waiting on an in-flight writer, then on B's vxid, then `deadlock detected`.
3. A waits on B and B waits on A. **Postgres kills the session that started waiting last.**
   - **Empty database (the original repro):** B is already waiting when the CIC starts, so B is killed. B exits 1 and A finishes, and the index ends up valid.
   - **Production shape:** only the CIC file is pending, and the CIC is already waiting on live writes when a second runner arrives. The CIC is killed and the index stays INVALID. B then takes the lock and re-runs the file, `IF NOT EXISTS` skips the invalid index, and the invalid-index check exits 1. **Both runners exit 1.**

**Measured with the current runner** (N counts both start orders):

| Scenario                                                                 | pg16                                 | pg18                                                                     |
| :----------------------------------------------------------------------- | :----------------------------------- | :----------------------------------------------------------------------- |
| Empty database                                                           | 12/12 deadlock, 0 INVALID            | 6/12 deadlock (the other 6 ran in sequence; 23 files apply in under 1 s) |
| Only the CIC pending, a second runner arrives while it waits on a writer | **12/12 both exit 1, INVALID index** | **12/12 both exit 1, INVALID index**                                     |
| Only the CIC pending, traffic is a reader with no table lock (or none)   | 0/24                                 | 0/24                                                                     |
| Dry runs during the CIC                                                  | 0 stalls, 0 deadlocks                | same                                                                     |

**Exposure.**

- `concurrency: migrate-production` serialises GitHub runs only. A manual `--apply` with the direct URL (`AGENTS.md:120-122`) can overlap the CI run.
- An INVALID index is ignored for reads: the query it backs gets slower, and every later migration run fails until someone runs `DROP INDEX CONCURRENTLY` by hand.
- `deploy/assert-schema-ready.ts` checks only unique indexes, so it would not flag this.
- `2026-10-24-knowledge-op-fingerprint-index` is already applied on prod. The risk is the next `-- migrate:no-transaction` file.

**Alternatives checked (adopt over build).** Atlas, graphile-migrate and node-pg-migrate's default mode all take `pg_try_advisory_lock` (Atlas documents this deadlock); dbmate blocks under `lock_timeout` and shares the bug. Switching tools means migrating the ledger, header directives and CI gates, which is far larger than the fix, so we keep our runner and adopt the same try-lock pattern.

### Ticket: Contract

1. Take the lock **before planning** and hold it for the whole `--apply` or `--mark-applied` run, on the session that runs every statement.
2. Never wait for the lock inside a SQL statement. Use `pg_try_advisory_lock`. The loser exits non-zero with `migrate: another migration run holds the lock (automata:schema_migrations); nothing was applied` and touches nothing: no ledger creation, no DDL.
3. If OD1 picks waiting instead, poll from Node with a bound, so no snapshot is open on the waiting session.
4. As a result, no no-transaction file runs while another runner is planning or waiting.
5. Keep the existing `concurrency` group, and correct `AGENTS.md`.

### Ticket: Acceptance Criteria

- [ ] A runner test races two runners against a throwaway Postgres, with a fixture that includes a no-transaction CIC file. In both start orders:
  - exactly one runner applies every file;
  - the other exits with the named message;
  - no `NOT indisvalid` index is left.
- [ ] The CLI loser exits non-zero with that message, using the exit code from OD1.
- [ ] The `@terragon/migrate` suite passes, with `serializes two concurrent runners` (which asserts the old wait-then-apply-0 behaviour) replaced by a busy-loser test.
- [ ] A test reproduces the production shape: a fixture with a no-transaction CIC file, a writer holding a lock on the table, and a second runner arriving mid-CIC. Against the current runner it leaves an INVALID index; with the fix, exactly one runner applies, the other exits 3, and `pg_index` has no `NOT indisvalid` row.
- [ ] Spike 062's two-runner reproduction gives 0/N deadlocks (N ≥ 5).
- [ ] `AGENTS.md` matches the new behaviour.

### Ticket: Tests

- `pnpm --filter @terragon/migrate exec vitest run --no-file-parallelism`
- `node deploy/lint-migrations.ts`
- CI `schema-drift` is green

### Ticket: Open decisions

| #   | Question                            | Recommended default                                                                 | Blocks |
| :-- | :---------------------------------- | :---------------------------------------------------------------------------------- | :----- |
| OD1 | Should the loser wait or fail fast? | Fail fast, with exit code 3 for "busy". CI already queues its own runs.             | No     |
| OD2 | Which lock key?                     | Keep the current key. A new one would let an old and a new runner run side by side. | No     |
| OD3 | Does the dry run take the lock?     | No: it stays read-only and lock-free.                                               | No     |

### Ticket: UAT (T0, local Docker Postgres 16)

1. `docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=pw postgres:16`, then create an empty database.
2. Run two `DATABASE_URL=… pnpm exec tsx deploy/migrate.ts --apply &` processes, then `wait`.
3. Expect:
   - one exits 0 with `applied 23 migration(s)`;
   - the other exits non-zero with the lock message;
   - `SELECT count(*) FROM pg_index WHERE NOT indisvalid` returns 0;
   - the ledger has 23 rows.
4. Repeat 5 times, swapping which process starts first.

## Decisions (supersede the ticket's Open decisions)

Verdict: **READY ON DEFAULTS** (decision record of 2026-11-15; evidence: the evaluation's 170 prototype race runs, 0 deadlocks, 0 INVALID indexes).

| #   | Decision                                                                                                                                                                                                                |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OD1 | **Fail fast.** The loser never waits. `deploy/migrate.ts` exits **3** ("busy"), a code no other path uses (see the exit-code contract below). CI already queues its own runs through `concurrency: migrate-production`. |
| OD2 | **Same key**, `automata:schema_migrations` through `hashtext`. A new key would let an old and a new runner revision run side by side.                                                                                   |
| OD3 | **The dry run stays lock-free and read-only.** Measured: 3 dry runs during a CIC that waits on a writer never stalled or deadlocked, on either runner (about 190 ms each).                                              |

Ticket corrections taken from the evaluation:

- The AC "the existing suite passes" cannot hold as written: `serializes two concurrent runners` asserts the old wait-then-apply-0 behaviour (`[0, 2]`). It is replaced by the busy-loser test (ticket AC3 already says so).
- The production-shape test (a second runner arriving while the CIC waits on a writer) is an AC (ticket AC4). That path is the both-exit-1, INVALID-index outcome; the empty-database repro does not exercise it.

## Ground truth (verified at c5e25f07 on 2026-11-15)

Every file:line in the ticket was re-read at `c5e25f07` (worktree `gh-633`, clean).

| Claim                                                                                                                                                                                                         | Where                                                                                                      | Status                                              |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------- | :-------------------------------------------------- |
| `ADVISORY_LOCK_KEY = "automata:schema_migrations"`                                                                                                                                                            | `packages/migrate/src/runner.ts:14`                                                                        | holds                                               |
| `withAdvisoryLock` is private, runs blocking `SELECT pg_advisory_lock(hashtext($1))`, then `fn`, then `pg_advisory_unlock` in `finally`; no try variant anywhere in the package                               | `runner.ts:106-118`                                                                                        | holds                                               |
| `applyMigrations` wraps everything in the lock, calls `ensureLedger`, re-reads the ledger and re-plans under the lock                                                                                         | `runner.ts:244-287` (lock + re-read at `249-251`)                                                          | holds                                               |
| `markApplied` validates unknown ids **before** the lock, then takes it, calls `ensureLedger`, writes rows in one `BEGIN … COMMIT`                                                                             | `runner.ts:295-346` (lock at `309`)                                                                        | holds; not in the ticket                            |
| No-transaction files run in autocommit with session `set_config(…, false)`, reset after; the invalid-index check runs on success **and** failure and throws the `DROP INDEX CONCURRENTLY` hint                | `runner.ts:194-236` (check `213-224`, hint `142-148`)                                                      | holds                                               |
| The CLI plans before any lock: `markApplied` (if any) at `:154`, then `planMigrations(files, await readLedger(client))` at `:156`, `printPlan` at `:157`, and only `applyMigrations` at `:178` takes the lock | `deploy/migrate.ts:147-187`                                                                                | holds (the ticket cites `:156,178`)                 |
| One `pg.Client` for the whole run ("the advisory lock and the no-transaction session settings are per-session")                                                                                               | `packages/migrate/src/client.ts:3-11`; opened at `deploy/migrate.ts:151`, ended in `finally` at `:184-186` | holds                                               |
| `readLedger` returns `[]` when the ledger is absent (`to_regclass`), so the dry run never creates it                                                                                                          | `packages/migrate/src/ledger.ts:28-60`                                                                     | holds: the dry run is read-only                     |
| The CIC file is `-- migrate:no-transaction` + `CREATE INDEX CONCURRENTLY IF NOT EXISTS "knowledge_op_claim_evidence_fingerprint_index"`                                                                       | `deploy/migrations/2026-10-24-knowledge-op-fingerprint-index.sql`                                          | holds; it is the only no-transaction file of the 23 |
| `concurrency: migrate-production`, `cancel-in-progress: false`                                                                                                                                                | `.github/workflows/migrate.yml:48-50`                                                                      | holds                                               |
| The concurrency test races two `applyDir` with no CIC file and asserts counts `[0, 2]`                                                                                                                        | `packages/migrate/src/runner.test.ts:194-208`                                                              | holds                                               |
| AGENTS.md: "a pooler cannot hold the session advisory lock that serializes concurrent runners"                                                                                                                | `AGENTS.md:139-140`                                                                                        | holds                                               |
| Manual `--apply` with the direct URL is documented                                                                                                                                                            | `AGENTS.md:119-123`                                                                                        | holds (ticket: `120-122`)                           |
| `deploy/assert-schema-ready.ts` checks columns and unique indexes only, and takes no lock                                                                                                                     | `deploy/assert-schema-ready.ts` header; no `lock`/`advisory` in the file                                   | holds                                               |

**Test Postgres in `packages/migrate`.** `vitest.config.ts` sets `globalSetup: ./src/test-global-setup.ts`, which calls `@terragon/dev-env`'s `setupTestContainers()`: `pnpm docker-up-tests` (`packages/dev-env/docker-compose.yml`, `postgres:16-alpine`), or `TEST_DATABASE_ADMIN_URL` with no Docker. It exports `MIGRATE_TEST_ADMIN_URL`; each test gets its own empty database from `createFreshDb()` (`src/test-db.ts:38-56`, `CREATE DATABASE` / `DROP … WITH (FORCE)`), plus `migrationsDir()` and `silentLogger()`. Timeouts are 60 s. The admin server can be **shared** by other suites and agents. Advisory locks are scoped per database, so two test databases never contend for the key. `pg_stat_activity`, though, shows every database, so a poll in a test must filter on `datname = current_database()`.

**`cli.test.ts`** spawns `node --import tsx deploy/migrate.ts` with `spawnSync` (cwd `packages/migrate`, `GITHUB_ACTOR=ci-bot`, 60 s timeout). It pins exit 0 (dry run, `--apply`, re-run), 1 (drift, orphan, unknown `--mark-applied` id, pooler URL, unset URL), 2 (`--no-contract` with a contract file), and the stdout strings `23 pending`, `applied 23 migration(s)`, `applied 0 migration(s)`. `spawnSync` cannot race two processes: a CLI race test needs async `spawn`.

### Every caller of the lock

| Caller                                             | Path                                                                                          | Takes the lock today                | After the fix                                                                                                                                                |
| :------------------------------------------------- | :-------------------------------------------------------------------------------------------- | :---------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applyMigrations`                                  | `runner.ts:249`                                                                               | yes, blocking                       | try-lock (nested, re-entrant under the CLI's outer lock)                                                                                                     |
| `markApplied`                                      | `runner.ts:309`                                                                               | yes, blocking                       | try-lock (nested, re-entrant)                                                                                                                                |
| `deploy/migrate.ts --apply`                        | `:178` via `applyMigrations`, after planning                                                  | yes, after planning                 | outer try-lock **before** planning, held to the end                                                                                                          |
| `deploy/migrate.ts --mark-applied`                 | `:154` via `markApplied`, then a re-plan and print unlocked                                   | yes, only around the insert         | outer try-lock before `markApplied`, held through the re-plan                                                                                                |
| `deploy/migrate.ts` (dry run)                      | `:156-176`                                                                                    | no                                  | no (OD3)                                                                                                                                                     |
| `migrate.yml` "Plan (dry run)"                     | `:91-94`                                                                                      | no                                  | no                                                                                                                                                           |
| `migrate.yml` "Apply"                              | `:95-107` (`--apply` / `--apply --no-contract`)                                               | yes                                 | yes; a busy exit 3 fails the job, so `notify` opens or comments on `migrate-failure`. That is correct: it means a manual run overlapped. No workflow change. |
| `migrate.yml` "Assert"                             | `deploy/assert-schema-ready.ts`                                                               | no                                  | no (skipped when Apply fails)                                                                                                                                |
| `ci.yml` schema-drift job                          | `:197-204`, two **sequential** `--apply` runs, the second must print `applied 0 migration(s)` | yes                                 | unchanged (no overlap, so never busy)                                                                                                                        |
| `deploy/schema-drift.ts`                           | `openClient` at `:80`, catalog reads only                                                     | no                                  | no                                                                                                                                                           |
| `runner.test.ts` (`applyDir`, `markApplied` tests) | `:39-51`, `:263-277`                                                                          | yes                                 | yes                                                                                                                                                          |
| `cli.test.ts`                                      | all sequential                                                                                | yes, for `--apply`/`--mark-applied` | yes                                                                                                                                                          |

The other advisory locks in the repo (`packages/shared/src/model/knowledge-intent.ts`, `rehome-repos-to-org.ts`, `packages/worker/src/agent-run/engine-db.ts`) use other keys and other code paths. They are out of scope.

### Exit-code contract of `deploy/migrate.ts` today

Header `deploy/migrate.ts:14-17` and `run()` at `:189-198`:

| Code | Meaning now                                                                                                                                                                                                                                                                                                                                                            |
| :--- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | plan clean (and applied, with `--apply`; marked, with `--mark-applied`)                                                                                                                                                                                                                                                                                                |
| 1    | drift, orphan ledger row (`main` returns 1 at `:158-160`); **any thrown error** via `run()`'s catch at `:192-197`: a failed migration (including the invalid-index hint and `deadlock detected`), an unset or pooler `DATABASE_URL`, an unreachable database, a bad argument (`parseArgs`), an unknown `--mark-applied` id, a baseline refused on a non-empty database |
| 2    | `--no-contract` and a pending contract file (`:164-171`)                                                                                                                                                                                                                                                                                                               |
| 3    | **unused**: free for "busy"                                                                                                                                                                                                                                                                                                                                            |

So exit 3 collides with nothing. Precedence after the fix: argument and URL errors (1) still come before connecting; once connected, busy (3) comes before anything that reads the database, so a loser never reaches drift (1) or contract (2) checks.

### The prototype (`eval-633/prototype.diff`)

What it changes, 3 files:

- `packages/migrate/src/runner.ts`: adds `export class MigrationLockBusyError extends MigrationError` with the message `another migration run holds the lock (${ADVISORY_LOCK_KEY}); nothing was applied`; exports `withAdvisoryLock`; replaces the blocking query with `SELECT pg_try_advisory_lock(hashtext($1)) AS locked` and throws the busy error when `locked !== true`. The `finally` unlock is unchanged. It relies on session advisory locks stacking (a nested try on the same session succeeds; each unlock pops one level), so the nested calls in `applyMigrations` and `markApplied` still work.
- `packages/migrate/src/index.ts`: exports `MigrationLockBusyError` and `withAdvisoryLock`.
- `deploy/migrate.ts`: imports both; moves the body after `openClient` into `runPlan(client, args, files)`; `main` calls `withAdvisoryLock(client, () => runPlan(...))` when `args.apply || args.markApplied.length > 0`, else `runPlan` directly; `run()` maps `MigrationLockBusyError` to a `migrate: <message>` line on stderr and `process.exitCode = 3`.

**Does it apply cleanly at c5e25f07? No, not as stored.**

- The file holds ANSI colour escapes (116 escape sequences; `runner-test.diff` holds 84), so `git apply` reports "No valid patches in input".
- With the escapes stripped, it still fails: the added lines are **tab**-indented and the repo uses 2 spaces, so the context lines do not match (`patch failed: deploy/migrate.ts:39`, `index.ts:22`, `runner.ts:103`).
- With the escapes stripped **and** `git apply --ignore-whitespace`, both `prototype.diff` and `runner-test.diff` pass `--check`.
- The logic is sound and matches the contract, but take it as a reference, not a patch: re-type it with 2-space indent, run prettier, and drop the leftover bare `{ … }` block that `runPlan` wraps its body in.
- It also leaves stale comments: `runner.ts:13` ("takes … before touching the ledger"), `runner.ts:238-243` ("a runner that waited behind another one applies only what is still pending"), the `deploy/migrate.ts` exit header (no 3), and `migrate.yml:46-47` ("a second run queues behind the first (the runner's advisory lock is the database-side backstop)").

## Constraints for the implementer

- **Fail fast, never wait inside SQL.** Only `pg_try_advisory_lock` on the migration key. No blocking `pg_advisory_lock`, and no Node-side poll loop either (OD1 is fail fast).
- **Exact message.** The loser's stderr line is `migrate: another migration run holds the lock (automata:schema_migrations); nothing was applied`. The error's `.message` is the text after `migrate: `. The message is the same for `--apply` and `--mark-applied`.
- **Exit 3** for busy, from `deploy/migrate.ts` only. Codes 0/1/2 keep their meanings. Document 3 in the header at `deploy/migrate.ts:14-17`.
- **The loser touches nothing.** Before the try-lock, the session runs only `connect`: no `ensureLedger` (no ledger created on an empty database), no DDL, no ledger read, no plan print, no `markApplied` insert. Assert `to_regclass('public.schema_migrations')` is still `NULL` after a busy run on an empty database.
- **Lock before planning, held for the whole run, on the one session.** For `--apply` and `--mark-applied`, take the lock right after `openClient`, before `markApplied` / `readLedger` / `printPlan`, and release it only after `applyMigrations` returns or throws. Same `pg.Client` for everything; no second connection, no pool.
- **The runner functions keep locking on their own.** `applyMigrations` and `markApplied` stay safe for library callers (the tests call them directly), so they keep their own (now try-) lock. Under the CLI's outer lock they rely on re-entrancy on one session. Say so in a comment.
- **The dry run stays lock-free and read-only** (no `ensureLedger`, no try-lock). The `migrate.yml` dry-run step and the `cli.test.ts` dry-run case keep working unchanged.
- **Same key**, `automata:schema_migrations` with `hashtext` (OD2). Do not switch to the two-int form or a new string.
- **No new dependency.** The considered alternatives (Atlas, graphile-migrate, node-pg-migrate, dbmate) are recorded in the ticket. `deploy/migrate.ts` keeps importing only `../packages/migrate/src/index` (no bare `pg` import: `deploy/` has no package.json).
- **Do not change** `migrate.yml`'s `concurrency` group or steps. Comment wording there is in scope.
- **TS rules** (AGENTS.md): no `any`, `unknown` in catches narrowed with `instanceof`, no `!` without a comment, `async`/`await` only, no silently swallowed errors, kebab-case file names.
- **Tests are deterministic.** Order runners by observed state, never by bare sleeps where a state is observable: poll `pg_stat_activity` / `pg_locks` filtered on `datname = current_database()`, with a bounded loop that **fails** the test when the state is never reached (the `runner-test.diff` loop falls through silently; fix that).
- Prettier: `pnpm exec prettier --no-editorconfig --config .prettierrc --write <files>`.
- Docker-backed test runs (vitest in `packages/migrate`, the race script) run **unsandboxed**.

## Gates

1. `pnpm --filter @terragon/migrate exec vitest run --no-file-parallelism` (unsandboxed; docker compose test Postgres 16)
2. `node deploy/lint-migrations.ts`
3. `pnpm turbo tsc-check`
4. `pnpm turbo lint`
5. `pnpm exec prettier --no-editorconfig --config .prettierrc --check <changed files>`
6. **T0 two-runner race** (unsandboxed, local Docker only, never a shared or production database), the evaluation's `scripts/race.sh` + `matrix.sh` + `holder.mjs` + `q.mjs` + `sampler.mjs` + `summarize.mjs`, copied into the session scratchpad and adapted:
   - set `WT=` to this worktree (`…/.claude/worktrees/gh-633`) and `PG_FROM=$WT/packages/migrate/package.json`;
   - start `postgres:16-alpine` and `postgres:18-alpine` as containers `eval633-pg16` / `eval633-pg18` on host ports `55416` / `55418` (`race.sh` uses `554$V`), `POSTGRES_PASSWORD=pw`, with `-c log_lock_waits=on -c deadlock_timeout=1s`;
   - run with Homebrew bash ≥ 4 (`race.sh` uses `${DB,,}`; `/bin/bash` 3.2 fails);
   - `matrix.sh 16 fix 10 10` and `matrix.sh 18 fix 10 10`: N = 10 per start order (AB and BA) for `empty`, `cic-writer`, `cic-reader`, `cic-nohold`, plus 10 `cic-dryrun`.
   - **Pass:** across every run, 0 client-side `deadlock detected`, 0 `NOT indisvalid` rows, exactly one applier per race, every overlapping loser exits 3 with the exact message and printed no plan, the ledger is complete (23 rows for `empty`), and every dry run exits 0. Count deadlocks from the client logs, not `serverDeadlocks` (the log windows overlap).
   - Remove the containers afterwards.
7. CI `schema-drift` green on the PR.

## Phases

1. **Runner + CLI** (3 files: `packages/migrate/src/runner.ts`, `packages/migrate/src/index.ts`, `deploy/migrate.ts`).
   - In `runner.ts`, add `MigrationLockBusyError` (extends `MigrationError`, `name` set) and make `withAdvisoryLock` exported, try-lock, throwing the busy error. Update the comments at `:13` and `:238-243`.
   - In `index.ts`, export `MigrationLockBusyError` and `withAdvisoryLock`.
   - In `deploy/migrate.ts`, take the outer lock before planning for `--apply` / `--mark-applied`; the dry run stays unlocked; map busy to exit 3 with the exact message; add exit 3 to the header.
   - Gates: `tsc-check` for `@terragon/migrate`, and the existing suite. Only `serializes two concurrent runners` may fail at this point; it is replaced in phase 2.
2. **Tests** (2 files: `packages/migrate/src/runner.test.ts`, `packages/migrate/src/cli.test.ts`).
   - `runner.test.ts`: replace `serializes two concurrent runners` with **two racing runners, both start orders**. The first holds the lock (`001` has `pg_sleep(0.5)`); the second rejects with `MigrationLockBusyError`; the winner applies `["001","002"]`; the ledger has 2 rows; `once` has 1 row. Start the loser after the winner holds the lock, by observing `pg_locks` (`locktype = 'advisory'`, granted, on this database) rather than a fixed 100 ms.
   - `runner.test.ts`: add **the production-shape test**. A traffic session holds `ROW EXCLUSIVE` on `items`; runner A applies a `-- migrate:no-transaction` `CREATE INDEX CONCURRENTLY IF NOT EXISTS` file and is observed waiting (`wait_event = 'virtualxid'`, this database). Runner B then gets `MigrationLockBusyError` with the exact message. After the traffic commits, A applies `["002"]`, `pg_index` has no `NOT indisvalid` row, and the ledger is `["001","002"]`. Against the current runner this test must fail with `002: left 1 invalid index(es) behind` (the evaluation measured this); record that run in the PR.
   - `runner.test.ts`: add a test that a busy `markApplied` writes no ledger row.
   - `cli.test.ts`: add a CLI race with async `spawn`, two `--apply --dir <fixture>` where the fixture's first file sleeps and a later one is a no-transaction CIC. Exit codes sorted must be `[0, 3]`; the loser's stderr contains the exact `migrate: …` line and its stdout has no `migrations:` plan line. Then add a busy run against an empty database while a test session holds the key (`pg_advisory_lock(hashtext('automata:schema_migrations'))`): exit 3 for `--apply` and for `--mark-applied`, `to_regclass('public.schema_migrations')` still `NULL`. Finally, a dry run while the key is held: exit 0 with the plan printed (OD3).
   - Gate: the full `@terragon/migrate` suite (unsandboxed).
3. **Docs** (≤ 2 files: `AGENTS.md`, `.github/workflows/migrate.yml` comments only).
   - `AGENTS.md:139-140`: the pooler cannot hold the session advisory lock, which lets **one runner at a time** apply; a second `--apply` or `--mark-applied` exits 3 with the lock message and touches nothing; the dry run takes no lock. Mention exit 3 next to the commands at `:119-123`.
   - `migrate.yml:46-47`, comment only: GitHub queues its own runs; a run that overlaps a manual one exits 3 and opens `migrate-failure`.
4. **Repo gates and T0.** Gates 2 to 6 above: `lint-migrations`, `turbo tsc-check`, `turbo lint`, prettier on the changed files, and the race matrix on pg16 and pg18 (N = 10 per order). Attach `summary.md` from the race to the PR.

## Validate round 1 (PASS_WITH_WARNINGS): fixes folded in

These override anything above.

- **W1.** The production-shape test must not hang on the current runner, where B blocks in `pg_advisory_lock`.
  - Commit the traffic once B is seen either rejected or waiting (`pg_stat_activity.wait_event = 'advisory'` for B's pid), not after awaiting B's promise.
  - Then assert both possible outcomes.
- **W2.** The busy-loser runner test holds the winner's lock deterministically.
  - Block `001` on a lock the test session holds (give it `-- migrate:lock-timeout` above 5 s), or use `pg_sleep(3)` or longer.
  - Release the lock after B rejects.
  - Filter `pg_locks` by `database = (SELECT oid FROM pg_database WHERE datname = current_database())`, because `pg_locks` has no `datname` column.
- **W3.** The CLI race orders its processes explicitly.
  - Spawn A, then poll `pg_locks` until A's advisory lock is granted, then spawn B.
  - A's first file must outlast B's tsx startup: use a held-lock gate, or a sleep of 10 s or more, under the 120 s statement timeout.
  - W2 and W3 share one bounded poll helper, and the test fails when it times out.
- **W4.** These stale "serialize" comments and docs are also updated:
  - the `connection.ts` docblock above `assertDirectConnection`;
  - `runner.ts:13` and `runner.ts:238-243`;
  - the comments in `migrate.yml:46-47`;
  - `AGENTS.md:139-140` and `:119-123`.
- **W5.** `withAdvisoryLock` throws the busy error **before** its `try` block, so a failed try-lock never calls `pg_advisory_unlock`. A test asserts that a busy runner emits no "you don't own a lock" warning.
- **How to prove the regression test fails on the old runner.** Copy `runner.ts` from `origin/main` into a temp file and swap it in for one run. Do not use `git stash`, because the stash stack is shared across worktrees. Record that the production-shape test fails against it.

## Phases (from the validator)

1. **Runner and CLI.**
   - Files: `packages/migrate/src/runner.ts`, `packages/migrate/src/index.ts`, `deploy/migrate.ts`.
   - Gates: `pnpm --filter @terragon/migrate exec tsc --noEmit`, then the migrate suite. Only `serializes two concurrent runners` may fail at this point.
2. **Tests.**
   - Files: `packages/migrate/src/runner.test.ts`, `packages/migrate/src/cli.test.ts`, with W1–W3 applied.
   - Gate: `pnpm --filter @terragon/migrate exec vitest run --no-file-parallelism`, unsandboxed.
3. **Docs.**
   - Files: `AGENTS.md`, `.github/workflows/migrate.yml` (comments only), `packages/migrate/src/connection.ts` (docblock only).
   - Gate: prettier `--check` on those files.
4. **Repo gates.**
   - `node deploy/lint-migrations.ts`, `pnpm turbo tsc-check`, `pnpm turbo lint`.
   - The T0 race: N=10 in each order on postgres:16 and :18. It requires 0 deadlocks, 0 `NOT indisvalid` rows, and exit codes in {0, 3}.
