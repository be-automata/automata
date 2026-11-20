# #707: a test database for cell runs of TEST_SERVICES_REPOS repos

Ticket: be-automata/automata#707 (parent #634, follows #656 and #706). Base: `origin/main` @
`47897a23` (#706 merged). The ticket body is the contract (scope, AC 1-5, tests, UAT). This file
adds the ground truth verified at that sha, the two places the ticket's mechanism does not exist as
written, and the design.

## Decisions applied (owner, 2026-11-19)

- **OD-1, option A:** the Postgres runs inside the cell, per run, only for repos in
  `TEST_SERVICES_REPOS`, with no network path to the box.
- **OD-2:** Postgres 16, the major `install-test-postgres.sh` installs.

## Ground truth (verified at 47897a23, 2026-11-19)

| Fact                                                                                                                                                                                                | Where                                                                                      |
| :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| The box's test-services file is `/etc/automata/agent-test-services.env`, keys allowlisted, scoped by `TEST_SERVICES_REPOS` (case-insensitive), read on every call, refused when unsafe or malformed | `packages/worker/src/agent-run/box-test-services.ts:22-23,36,82-104`                       |
| The box's lane gate: task, PR and self-heal fix runs, never review or audit                                                                                                                         | `box-test-services.ts:113-122` (`receivesBoxTestServices`)                                 |
| The box injects the URL into its container through a socket bridge                                                                                                                                  | `container-daemon-process.ts:458-474`                                                      |
| The box server: Postgres 16, `127.0.0.1:25432`, role `automata_test` `LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40`, a 48-hex password                     | `packages/worker/deploy/linux/install-test-postgres.sh:14,57-58,200-202,247`               |
| Only a plain task run may execute in a cell                                                                                                                                                         | `run-executor.ts:78-85`                                                                    |
| `cell-run.ts` has no test-services reference                                                                                                                                                        | `grep -n test-services packages/worker/src/agent-run/cell-run.ts` → no hit                 |
| The cell runs as `agent` (uid 10001), never root, no sudo, `no_new_privileges`                                                                                                                      | `deploy/images/cell/README.md:13,64`; `verify.sh` identity checks                          |
| **The adapter's exec takes no env**, and execd logs exec argv                                                                                                                                       | `packages/types/src/cell.ts:166-174`                                                       |
| copyIn bytes ride in the upload body (not logged); stage sensitive bytes in a 0700 dir                                                                                                              | `packages/types/src/cell.ts:226-232`                                                       |
| #706's channel: the agent's `~/.claude/settings.json` `env` block, written by copyIn 0600                                                                                                           | `cell-run.ts` bootstrap (`composeContainerSettings(..., settingsEnv)`); `cell-repo-env.ts` |
| #706's value scrub: exec text from 4 chars, every cell log line from 8                                                                                                                              | `cell-run.ts` `runCell` (`createValueRedactor`)                                            |
| `TEST_DATABASE_ADMIN_URL` is not a reserved repo env name (an owner may set it)                                                                                                                     | `daemon-env.ts` `RESERVED_REPO_ENV_KEYS`; `cell-repo-env.ts`                               |
| The setup heartbeat stamps every `CELL_SETUP_STAMP_MS` (60 s) from a background loop, independent of the setup steps                                                                                | `cell-run.ts:73`, `startHeartbeat`                                                         |
| The cell image is `FROM` the batteries image by digest; it had no `RUN` (asserted)                                                                                                                  | `deploy/images/cell/Dockerfile`; `cell-image-assets.test.ts`                               |
| The batteries image is Ubuntu 24.04 with an apt snapshot `20261015T000000Z`                                                                                                                         | `deploy/images/batteries/Dockerfile:27,34`                                                 |
| The cell IT harness (IT-E1, `OPENSANDBOX_IT`) lives in the worker package                                                                                                                           | `packages/worker/src/agent-run/cell-run.integration.test.ts`                               |

### Where the ticket's mechanism does not exist as written

1. **"exports `TEST_DATABASE_ADMIN_URL` to the daemon exec env"**: there is no daemon-start exec and
   exec carries no env (#706 found the same). The URL goes through #706's channel: the settings
   `env` block, merged as `{ ...testDbEnv, ...repoEnv }` so the owner's value of the same name wins.
2. **"as the cell's postgres user"** (the brief): every exec runs as uid 10001 with no way to switch
   users, so Postgres runs as `agent`. The cluster belongs to the agent's uid (it could reach it as
   superuser over the unix socket). The `CREATEDB NOSUPERUSER` role is for parity with the box, not
   a wall against the agent, which is the only tenant of a throwaway cell.

## Design

### Gate (`cell-test-db.ts`, `planCellTestDb`)

`start` when `receivesBoxTestServices(input, lane)` and the box file's `TEST_SERVICES_REPOS` names
the repo (new `isBoxTestServicesRepo`, same read and refusals as `readBoxTestServicesEnv`, sharing
one parser); `owner` when the filtered repo env already sets `TEST_DATABASE_ADMIN_URL` (no server is
started; one log line); `off` otherwise. Membership only: the box's URL is never used by a cell.

### Steps (`cell-run.ts`, `startTestDb`, in bootstrap before the settings write)

1. `mkdir -m 700 /tmp/automata-test-db` (fails if it exists).
2. copyIn the worker-generated password (24 random bytes, hex) to `<dir>/pw`, 0600 agent.
3. `bash -c CELL_TEST_DB_START_SH`: `initdb` (peer on the socket, scram on TCP, UTF8, C.UTF-8),
   then `pg_ctl start -W` with `listen_addresses=127.0.0.1`, port 25432, socket in the dir,
   durability off (fsync, synchronous_commit, full_page_writes).
4. A bounded readiness loop: `pg_isready` every 500 ms, 30 s budget, raced against the run's abort.
5. `bash -c CELL_TEST_DB_ROLE_SH`: psql reads the password from the file itself (`\set pw
\`cat …\``), `SET log_min_error_statement = panic`, `CREATE ROLE automata_test LOGIN CREATEDB
   NOSUPERUSER … CONNECTION LIMIT 40` (the box's role), then the file is removed.

On a failure that is not an abort the run goes on without the variable (one log line; the failed
step's stderr tail is logged through the scrub), after a best-effort cleanup exec
(`CELL_TEST_DB_STOP_SH`: remove the staged password, `pg_ctl -m immediate stop`; its result is
ignored). Aborts (fence, stop, lost heartbeat) propagate, with no cleanup (the cell is deleted).
The password is added to #706's scrub values, so it is redacted in any exec tail or log line.
`cell: test database ready in <ms>` is logged (AC 4). The worst case stays under one setup stamp:
start exec 20 s plus a 30 s readiness budget measured from the first step.

Known limit (the same as #706): the agent is known only after bootstrap, so a non-Claude agent
still gets a server started but never sees the URL (the settings `env` block is the Claude CLI's).
One line is logged for it. Cells are Claude-only today.

### Image

`deploy/images/cell/Dockerfile` gains one `RUN`: `postgresql-16` from the batteries snapshot,
`create_main_cluster = false` via `createcluster.d`, the ssl-cert snakeoil pair removed. The asset
test now allows exactly that `RUN` and checks the snapshot equals the batteries one. `verify.sh`
gains an offline Postgres smoke (init, start, loopback only, create and drop).

Alternatives checked: a baked start script (needs the CI staging to change and a rebuild for any
fix; inline constants follow `CELL_WRITE_MESSAGE_SH`), a Postgres in the base batteries image (the
box does not need it there), option B (OD-1 decided).

### Files

`packages/worker/src/agent-run/cell-test-db.ts` (new), `box-test-services.ts` (+ `isBoxTestServicesRepo`),
`cell-run.ts`, `cell-executor-default.ts` (`testDbPassword`), tests (`cell-run.test.ts`,
`box-test-services.test.ts`, `cell-test-db.test.ts`, `cell-image-assets.test.ts`, `cell-run.integration.test.ts` case f),
`deploy/images/cell/{Dockerfile,verify.sh,README.md}`.

## Acceptance criteria mapping

| AC  | Proof                                                                                                                                                                                                                                                                         |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | unit: steps, order, password file, URL in settings env; local: the exact scripts in the built image (uid 10001, no network, caps dropped); IT-E1 (f) in a live cell (needs the image inside the IT dind: the published digest, or a local build `docker load`ed into it); UAT |
| 2   | unit: unlisted repo and absent file → no Postgres exec, no file, no variable                                                                                                                                                                                                  |
| 3   | unit: the owner's value is the one in the settings env, no server started                                                                                                                                                                                                     |
| 4   | log line with elapsed ms; local measure in the image; IT-E1 (f) asserts `< CELL_SETUP_STAMP_MS`                                                                                                                                                                               |
| 5   | unit: not in argv, plan, www calls, logs; redacted in a failed step's tail; IT-E1 (f) scans docker inspect/logs and the guest's Postgres logs                                                                                                                                 |

## Risks and rollback

Image +~190 MB; setup +~2.5 s for listed repos only (measured under amd64 emulation). Rollback: the previous cell image digest (a
worker on this code with the old image logs "test database not started" and runs on), or drop the
repo from `TEST_SERVICES_REPOS`.
