# #395 gate log

Gates run at HEAD `a6232742` (`fix/395-concurrent-trigger-loss`), 2026-11-17, on top of
`origin/main` `85b07e6c`. `git merge --no-ff origin/main` was a no-op: main had no new
commits. Every gate exited 0. The gates ran one at a time, never two full suites together.

## Gates

| Gate                                                                                                         | Exit | Summary                                        |
| :----------------------------------------------------------------------------------------------------------- | :--: | :--------------------------------------------- |
| `pnpm install --frozen-lockfile --prefer-offline`                                                            |  0   | lockfile in sync                               |
| `pnpm --filter @terragon/docs exec fumadocs-mdx`                                                             |  0   | `.source` codegen                              |
| `pnpm turbo tsc-check`                                                                                       |  0   | 21 of 21 tasks successful                      |
| `pnpm turbo lint`                                                                                            |  0   | 2 of 2 tasks successful                        |
| `pnpm turbo format-check`                                                                                    |  0   | 18 of 18 tasks successful                      |
| `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism`                                       |  0   | 76 files passed, 11 skipped; 2068 tests passed |
| `HATCHET_IT=1 pnpm --filter @terragon/worker exec vitest run --no-file-parallelism <the 10 CLAUDE.md files>` |  0   | 10 files passed; 65 tests passed, 1 skipped    |
| `docker compose -p automata-hatchet-it down -v --remove-orphans \|\| true`                                   |  0   | teardown                                       |

The HATCHET_IT run includes `burst.integration.test.ts` with both cases (2 tests):
the sequential case and the unskipped `#395` concurrent case. Each executed 42/42.
`apps/www` is untouched, so the www suite is not a gate here.

## Loss rate

| Condition                                                                       | Runs | Concurrent triggers | Executed |                Loss                 |
| :------------------------------------------------------------------------------ | :--: | :-----------------: | :------: | :---------------------------------: |
| Before the fix, one process, idle machine (whole file × 5, `-t CONCURRENT` × 4) |  9   |         378         |   378    |                 0%                  |
| Before the fix, two processes sharing the stack (drill)                         |  1   |         42          | 17 in B  | 60% apparent (25 ran in A's worker) |
| After the fix, two processes (drill)                                            |  1   |         42          | 42 in B  |                 0%                  |

The apparent loss was never a real one. Every run executed; the "lost" ones executed in
the other process's worker.

## Two-process drill (AC 5)

The script starts A, which runs `-t "dispatches at caps"`, the sequential case. Once A's
worker logs `listening for actions`, the script starts B, which runs `-t CONCURRENT`. Both
run from the same checkout against the one `automata-hatchet-it` project.

- **Before** (pre-fix harness, concurrent case unskipped):
  - B exit 1, with `AssertionError: executed of terminal: expected 17 to be 42` at
    `burst.integration.test.ts:298`.
  - A exit 1, with `ECONNREFUSED 127.0.0.1:27077` after B's `afterAll` ran `down -v`.
  - `Task run starting` counts: A 41, B 22. B's 42 runs = 17 run by B + 25 run by A.
- **After** (`2e03c7fd`):
  - A exit 0 and B exit 0.
  - Each logged 42 `Task run starting`.
  - B logged `hatchet IT stack is held by another process (/tmp/automata-hatchet-it/box.lock); waiting` once.

## Regression proof (unit, no docker)

`packages/worker/src/agent-run/hatchet-it-harness.test.ts` was run against the `origin/main`
harness: 7 tests failed (`acquireItStackLock is not a function`, `createStackGuard is not a function`).
On the branch, 18 of 18 pass.

## Acceptance criteria to proof

| AC  | Proof                                                                                                                                                                                                                                                                           |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC1 | `hatchet-it-harness.test.ts`: "REGRESSION: while one holder has the stack, nobody else can take it", "a second acquirer parks (and says so) instead of joining the live stack", "the parked acquirer gets the stack once the holder releases"; the drill's waiting line         |
| AC2 | `createStackGuard` tests "the holder tears down, then releases — even when the teardown throws", "a grant that lands after exit aborted the hold is released, never leaked"; the kernel `flock(2)` contract of `box-lock.ts` (released on holder death; there is no owner file) |
| AC3 | `burst.integration.test.ts` "#395: 42 CONCURRENT triggers — every run that reaches COMPLETED must have executed", green in the HATCHET_IT gate above                                                                                                                            |
| AC4 | `burst.integration.test.ts` `expectSoleWorker()` is called at the top of both cases, with the message naming a shared stack (#395)                                                                                                                                              |
| AC5 | the two-process drill, before and after, above                                                                                                                                                                                                                                  |
| AC6 | `docs/uat/hatchet-lite-v0.94.10-observed.md` §6; `deploy/uat/phase2-4.md` row 3                                                                                                                                                                                                 |
| AC7 | the gates table above                                                                                                                                                                                                                                                           |

## Review trail

- Validate:
  - cycle 1 BLOCK with 5 fixes, applied;
  - cycle 2 PASS_WITH_WARNINGS with 3 notes, applied.
- `/simplify` used 4 reviewers:
  - one Hold record replaces controller/pending/held;
  - the tests use the `rejects.toMatchObject` matcher;
  - skipped: a per-run `globalSetup` lock, left as a follow-up because `packages/worker` has no vitest config.
- roborev:
  - job 1259, verdict F: one Medium (a timed-out setup joining the next holder's stack) and one Low (a racing grant leaked). Both fixed in `a6232742`.
  - job 1260: Pass, no findings.

## Re-run after `git merge --no-ff origin/main` (`a6996533`, #685)

Merge head `5d394744`. #685 touches none of the #395 files. Every gate exited 0 again:

- install: 0
- docs-mdx: 0
- tsc-check: 0 (21/21)
- lint: 0 (2/2)
- format-check: 0 (18/18)
- worker vitest: 0 (2068 passed, 42 skipped)
- the HATCHET_IT command: 0 (10 files; 65 passed, 1 skipped)
- teardown: 0
