# #395 spec: serialise the hatchet-lite IT stack across processes

Ticket: be-automata/automata#395 (hardened 2026-11-17). Base: `origin/main` @ `85b07e6c`.
Branch: `fix/395-concurrent-trigger-loss`.

## Problem (verified)

A HATCHET_IT burst run that "reached COMPLETED without executing" was a run executed by
**another process's worker** on the same shared IT stack. It was not an engine fault.

Evidence (2026-11-17, this worktree, hatchet-lite v0.94.10):

- On an idle machine, nine runs of `burst.integration.test.ts` with the concurrent case
  unskipped all passed: four of the whole file, four with `-t CONCURRENT`, and the first run.
  That is 378 concurrent triggers and 378 executions, a 0% loss rate.
- In the two-process drill, A ran `-t "dispatches at caps"` and B ran `-t CONCURRENT`, started
  once A logged `listening for actions`. B failed with
  `executed of terminal: expected 17 to be 42` at `burst.integration.test.ts:298`. A's log shows
  41 `Task run starting` and B's 22. That is 17 + 25 = 42 for B's runs, so every run executed;
  25 of them ran in A's worker. A then failed with `ECONNREFUSED 127.0.0.1:27077` once B's
  `afterAll` tore the stack down.

## Ground truth (cited at `85b07e6c`)

| Claim                                                                                                                                                                                                                                                                                                                                                                                                   | Where                                                                      |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------- |
| One fixed compose project and fixed ports for every IT process                                                                                                                                                                                                                                                                                                                                          | `packages/worker/src/agent-run/hatchet-it-harness.ts:27-32` (`IT`)         |
| `composeUp()` writes the override, then `docker compose up -d postgres hatchet-lite`: a no-op join if the project is already up                                                                                                                                                                                                                                                                         | `hatchet-it-harness.ts:82-85`                                              |
| `composeDownV()` runs `down -v`, errors swallowed, and removes the override                                                                                                                                                                                                                                                                                                                             | `hatchet-it-harness.ts:87-90`                                              |
| `bootstrapTenant()` always resolves the **default** tenant and mints a new token for it                                                                                                                                                                                                                                                                                                                 | `hatchet-it-harness.ts:221-247` (query at `:229`)                          |
| 11 suites call `composeUp`/`composeDownV` (burst, supersede, scheduling-health, safe-restart, container-run, admission-deferral, payload-seal, run-terminal-redelivery, self-heal-box-lock, hatchet-tenant, knowledge-worker-isolation); every `afterAll` calls `composeDownV()` unconditionally (e.g. `burst.integration.test.ts:169-173`), and vitest runs `afterAll` even when `beforeAll` timed out | `grep -rln composeUp packages/worker/src`                                  |
| The concurrent case is the one at `:268` (it was `it.skip` on main); the stale "#395" comments are at `:176-182` and `:264-267`                                                                                                                                                                                                                                                                         | `packages/worker/src/agent-run/burst.integration.test.ts`                  |
| Kernel `flock(2)` lock primitive: `acquireBoxLock({ root, holder, signal?, log? })` waits; `tryAcquireBoxLock({ root, holder, log? })` returns `null` when busy; both create `root` (`mkdir -p`) and lock `<root>/box.lock`, and `BoxLock.release()` is idempotent; the lock is released when the holder dies                                                                                           | `packages/worker/src/agent-run/box-lock.ts:78-130`, `:345`, `:625`, `:869` |
| `box-lock.test.ts` already runs inside the CI HATCHET_IT step, so `flock`/`lockf` exist on the runner                                                                                                                                                                                                                                                                                                   | `.github/workflows/ci.yml:229-246`                                         |
| CI runs every IT file in ONE vitest process with `--no-file-parallelism`, so CI never collides                                                                                                                                                                                                                                                                                                          | `.github/workflows/ci.yml:233-243`                                         |
| hatchet `"Worker"` columns `"tenantId"`, `"isActive"`                                                                                                                                                                                                                                                                                                                                                   | `scheduling-health.integration.test.ts:472`                                |
| Docker-free harness unit tests live in `hatchet-it-harness.test.ts` (worker vitest suite)                                                                                                                                                                                                                                                                                                               | `packages/worker/src/agent-run/hatchet-it-harness.test.ts`                 |

Does not exist yet: any cross-process exclusion in the harness. No `HATCHET_IT_LOCK_DIR`.

## Design

### 1. Stack lock (`hatchet-it-harness.ts`)

- `IT_LOCK_ROOT = process.env.HATCHET_IT_LOCK_DIR ?? "/tmp/automata-hatchet-it"`. The path is
  fixed and machine-wide on purpose, so it is **not** `os.tmpdir()`: sandboxed and unsandboxed
  shells get different `TMPDIR`s, and two such processes would each take their own lock.
  Known loud failures, both intended: a sandboxed run that cannot write `/tmp` fails on `mkdir`
  with EPERM, and the IT stack needs Docker, so it runs unsandboxed anyway. A second Unix user
  cannot open the owner-only `box.lock` (`box-lock.ts:357-359`) and gets
  `BoxLockUnavailableError`. `HATCHET_IT_LOCK_DIR` is the override for both.
- `acquireItStackLock({ root = IT_LOCK_ROOT, log = console.log, signal? }): Promise<BoxLock>`:
  - `tryAcquireBoxLock` first;
  - on `null`, log one line (`hatchet IT stack is held by another process (<root>/box.lock); waiting`)
    and then `acquireBoxLock` with `signal` (parks in the kernel);
  - `holder` is `hatchet-it pid <pid>`.
    This reuses the worker's lock primitive (adopt over build).
- `createStackGuard(acquire: (signal: AbortSignal) => Promise<BoxLock>)` returns `{ enter, exit }`:
  a small, injectable object, so the decision is unit-testable without docker.
  - `enter()`: memoises ONE pending acquire (`pending ??= …`; validator fix 3: two
    `composeUp()` calls close together must not start two helpers, or the process would park
    behind itself). It owns an `AbortController`, and records `held` when the acquire resolves.
  - `exit(teardown: () => Promise<void>)`: when `held` is null (still waiting, or the acquire
    failed), abort the pending acquire and return **without** calling `teardown`. A waiter
    whose `beforeAll` timed out must never `down -v` the holder's live stack (validator fix 1).
    It then awaits `pending.catch(() => {})`, so the AbortError never becomes an unhandled
    rejection, and resets `pending`, `held` and the controller. An acquire granted just as the
    abort lands is released by `acquireBoxLock` itself: its post-ack `signal.aborted` check
    releases and throws AbortError, so `exit` needs no extra release in that race.
    When held, `try { await teardown() } finally { await held.release() }`, then the same reset,
    so the next `enter()` (the next file in the same process) acquires again.
- Module-level `const stack = createStackGuard((signal) => acquireItStackLock({ signal }))`.
  `composeUp()` awaits `stack.enter()` before writing the override and running `up`.
  `composeDownV()` becomes `stack.exit(async () => { down -v (errors swallowed as today);
rm override })`.
- Each file in one process takes and releases the lock in turn. A second process can
  interleave between files, and each file gets a fresh stack, which is correct.

### 2. One-worker guard (`burst.integration.test.ts`)

`expectSoleWorker()` runs in both cases right before the first trigger. It runs
`SELECT id FROM "Worker" WHERE "tenantId" = $1 AND "isActive"` through the suite's `pg`,
and expects exactly one row (validator fix 2: there is no heartbeat filter, because the heartbeat may
not have landed by the first trigger, and each file's stack is fresh, so there are no stale rows), with the message
`"another process's worker shares this IT stack (#395): its runs would look COMPLETED without executing here"`.

### 3. Unskip and comments

- `it.skip` → `it` for the `#395` case. Rewrite the comments at `:176-182` and `:264-267`
  to state the verdict: concurrent triggers do not lose runs; a shared stack did.
- `docs/uat/hatchet-lite-v0.94.10-observed.md`: new `## 6. Concurrent triggers lose no run (#395)`.
- `deploy/uat/phase2-4.md:66`: replace "concurrent triggers lose runs … (#395, skipped
  variant …)" and "the concurrent-trigger variant stays skipped under #395" with the verdict.
  The rest of the evidence row is unchanged.

### Not changed

- `apps/www` dispatch, `definition.ts`, the engine pin, and per-process project/port
  randomisation. The latter would break the fixed teardown `docker compose -p automata-hatchet-it down -v`
  in `ci.yml:246` and CLAUDE.md.

Validation: cycle 1 BLOCK (5 fixes, applied); cycle 2 PASS_WITH_WARNINGS (3 notes, applied).

## Phases (file cap 4 per phase)

1. `hatchet-it-harness.ts` (lock and wiring) and `hatchet-it-harness.test.ts` (lock unit tests).
   Gate: worker tsc, and `vitest run src/agent-run/hatchet-it-harness.test.ts`.
2. `burst.integration.test.ts` (unskip, guard, comments). Gate: `HATCHET_IT=1` burst file, then teardown.
3. `docs/uat/hatchet-lite-v0.94.10-observed.md`, `deploy/uat/phase2-4.md`, `docs/specs/395/gate-log.md`.
   Gate: prettier `--no-editorconfig --check`.

## Tests

- **Unit** (`hatchet-it-harness.test.ts`, no docker, each case on its own `mkdtemp` root):
  1. While `acquireItStackLock` holds root R, `tryAcquireBoxLock({ root: R })` returns `null`.
  2. A second `acquireItStackLock({ root: R, signal: AbortSignal.timeout(300) })` rejects with
     an abort (it parked; it did not get the lock) and logged the waiting line.
  3. After `release()`, a parked `acquireItStackLock({ root: R })` resolves.
  4. `createStackGuard`: `exit(teardown)` before the acquire resolves aborts it and never
     calls `teardown`; after it resolves, `exit` calls `teardown` then `release`, and a throwing
     `teardown` still releases; two concurrent `enter()` calls start one acquire; after an `exit` without the lock, a fresh `enter()` acquires.
     Regression: before the fix `acquireItStackLock` does not exist, and nothing stops the second
     holder.
- **IT**: `HATCHET_IT=1` burst file, with both cases green and 42/42 executed in each.
- **Drill (AC 5)**: the two-process script, run before the fix (B fails 17/42, recorded above)
  and after it (A and B exit 0, and the later process logs the waiting line). Exit codes go in
  `gate-log.md`.

## AC mapping

| AC  | Proof                                                                                           |
| :-- | :---------------------------------------------------------------------------------------------- |
| 1   | unit tests 1-3 and the drill's waiting line                                                     |
| 2   | `release()` in the guard's `exit` `finally`; kernel lock (box-lock.ts contract); unit tests 3-4 |
| 3   | burst `#395` case green                                                                         |
| 4   | `expectSoleWorker` in both cases                                                                |
| 5   | drill before/after in gate-log                                                                  |
| 6   | doc diffs                                                                                       |
| 7   | gate-log table                                                                                  |

## Risks

- A waiter can exceed a suite's `beforeAll` timeout behind a long file. The waiter's file fails
  with a loud timeout and the waiting line. Its `afterAll` → `composeDownV()` aborts the
  pending acquire and never touches the holder's stack (guard `exit`), so the holder is
  unaffected. Accepted.
- A `/tmp/automata-hatchet-it/box.lock` left behind is harmless. `flock` holds nothing after
  the holder dies, and the file is only a name.
