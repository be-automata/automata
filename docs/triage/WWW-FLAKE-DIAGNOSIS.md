# WWW / test-suite nondeterminism — diagnosis

**Date:** 2026-07-15
**Author:** triage-tester
**Scope:** Why the same commit produced wildly different suite results across agents
(shared 453/453 vs 385/68-fail; www ~clean vs 740/53-fail), and why a single www
test (`stop-thread`) failed intermittently.

## TL;DR

The test suites share **one long-lived docker-compose Postgres** on
`localhost:15432` (database `postgres`, schema `public`), started by
`packages/dev-env/src/test-global-setup.ts` and **never torn down**. The old
setup ran `DROP SCHEMA public CASCADE; CREATE SCHEMA public` on **every** run.

When two runs overlap — two suites of one agent, or two agents, or CI + a local
run — one run's `DROP SCHEMA` **deletes the other run's tables mid-flight**. The
victim run then sees missing relations, FK violations on `user/session/account`,
`Unauthorized` (its `session` rows vanished), and missing `feature_flags`. Which
tables are hit depends purely on timing, so the **same commit yields different
red/green outcomes per agent**. This is the root cause of the divergence, not a
code bug at HEAD.

`drizzle-kit push` itself is **not** the problem: on a fresh database it applies
all 43 tables, including the new `organization`/`member`/`invitation` tables and
`session.active_organization_id`, in non-TTY (verified directly). The
"push reported success but skipped 2 relations" observation is the concurrent
`DROP SCHEMA` deleting those tables *after* push created them.

## Evidence

- **Infra:** `setupTestContainers()` returned a fixed
  `postgresql://postgres:postgres@localhost:15432/postgres` for every run and
  cleared state with `DROP SCHEMA public CASCADE`. `teardownTestContainers()` was
  a no-op ("keep containers for speed"). Redis (`FLUSHALL`) is shared the same way.
- **Push is fine on a clean DB:** pushing the current schema into a fresh
  `pushtest` DB (non-TTY) produced **43 tables**, including `organization`,
  `member`, `invitation`, and `session.active_organization_id`. No skips.
- **Divergence reproduced/explained:** production-validator saw shared 385/68-fail
  (failures concentrated in `automations` + `user_feature_flags`) and www
  740/53-fail (FK on `user/session/account`, `Unauthorized`) at the same commit
  the team-lead ran green. All of these are exactly the symptoms of tables being
  dropped mid-run by a concurrent `DROP SCHEMA`.
- **"not part of this team"** is a red herring for org fixtures: that string comes
  from `packages/shared/src/model/slack.ts:176` (a Slack-team check), surfaced when
  a concurrent `DROP SCHEMA` corrupted Slack test data — **not** the Better Auth
  org plugin. The org plugin is bare `organization()` with no session gating;
  `activeOrganizationId` is nullable, so `getSession` works without membership.
  **`createTestUser`/`mockLoggedInUser` do not need to seed org membership.**

## The `stop-thread` single-test flake (the mild tail)

`stop-thread.test.ts > should successfully stop a thread` intermittently read its
just-created `working` thread as already `complete`
(machine log `[user.stop] complete → complete`, no `Thread error`), so `user.stop`
no-op'd and the status stayed `complete`. Instrumented capture:
`rawThreadStatus:"complete", rawErrorMessage:null`, thread created→flipped within
~40ms. Null `errorMessage` rules out the stalled-thread sweep
(`stopStalledThreads` sets `"request-timeout"`). This is the same shared-mutable-DB
family: a concurrently-running suite/run wrote to the shared database during the
test.

Note: an **earlier, distinct** all-5-fail variant of this file was a real test bug
(floating `expect(async…).rejects` + a `waitUntilResolved` drain that leaked a
rejected promise across tests) — fixed separately in commit `b26c6de`.

## Fixes applied

1. **Per-run database isolation** (`packages/dev-env/src/test-global-setup.ts`,
   commit `b6b9bd4`). Each vitest invocation now `CREATE DATABASE`s a unique
   `test_<pid>_<time>_<rand>` database and returns its URL; teardown
   `DROP DATABASE … WITH (FORCE)`. The shared `public` schema is never mutated, so
   concurrent runs cannot corrupt each other.
2. **Fail-loud schema verification** (`packages/shared/src/test-global-setup.ts`,
   commit `b6b9bd4`). After `drizzle-kit push`, a sentinel set of required tables
   is checked; any missing table throws immediately with an unambiguous message
   instead of surfacing later as confusing FK/missing-relation errors.
3. **Feature-flag seeding** (commit `436b439`) and the **`stop-thread` test bug**
   (commit `b26c6de`) — see those commits.

## Known residual: shared Redis

Redis (SRH on `:18079` → one Redis DB) is still shared across runs and `FLUSHALL`-ed
on setup. Under **concurrent** runs this can wipe a peer run's keys / add latency,
which intermittently breaks Redis-coordination tests (observed once:
`batch-threads.test.ts > handles concurrent requests`, in a deliberately-concurrent
shared+www proof). Postgres-backed suites are unaffected. Recommended follow-up
(owned by the apps/www Redis code, `src/lib/redis.ts` — out of this change's
scope): honor a per-run key prefix env in the client, OR have tests leave
`REDIS_URL` unset so each worker uses the per-process in-memory Redis (its NX/get/set
semantics are already correct for single-process tests). Sequential (non-concurrent)
runs are unaffected.

## CI / operator watch instructions

- **Never run two suites against `:15432` expecting the old shared-schema behavior.**
  With the per-run-DB fix this is now safe, but if the fix is reverted, serialize
  suite runs or give each its own database.
- If a run aborts before teardown, it leaves an orphan `test_*` database. They are
  harmless but accumulate; periodic cleanup:
  `psql -c "SELECT datname FROM pg_database WHERE datname LIKE 'test_%'"` then drop.
- A `Schema push incomplete: … required table(s) missing` error now means the push
  genuinely failed (or the DB was corrupted) — treat as a hard failure, do not retry
  blindly.
- Watch `batch-threads` / other Redis-coordination tests for the residual above when
  runs are deliberately concurrent.

## Stability evidence

- Concurrent shared+www, 3 rounds (harsher than required): shared **453/453 every
  round**; www 802 pass in rounds 1 & 3, one Redis-residual failure in round 2
  (`batch-threads`, not Postgres). The Postgres corruption is gone.
- Sequential shared→www in isolation, 3 rounds: _(results appended after the run)_.
