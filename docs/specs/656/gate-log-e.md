# #656 PR-E gate log

Branch `feat/656-e-worker`, off `main` at `5e302b76`. Spec: `docs/specs/656/spec-e.md`. Live evidence the design rests on: `docs/specs/656/probe-e-vault.md`.

## Gates run in the Claude sandbox (literal exits)

| Gate                                                               | Exit | Note                                                                                                                                         |
| :----------------------------------------------------------------- | :--- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| per-phase `pnpm --filter <pkg> exec tsc --noEmit` (phases 1 to 7b) | 0    | worker, sandbox, types, shared, www                                                                                                          |
| `pnpm --filter @terragon/docs exec fumadocs-mdx`                   | 0    |                                                                                                                                              |
| `pnpm turbo tsc-check --force`                                     | 0    | 21 of 21 tasks                                                                                                                               |
| `pnpm turbo lint --force`                                          | 0    | 2 of 2 tasks                                                                                                                                 |
| worker unit tests for every file this PR touches or adds           | pass | `cell-config`, `cell-image-assets`, `cell-ttl`, `cell-www-client`, `www-client`, `cell-teardown`, `cell-run`, `workflow`, `workflow-cleanup` |
| sandbox `opensandbox-cell.test.ts` (T-COPYIN)                      | pass | 225 tests                                                                                                                                    |

The full worker and sandbox suites also contain tests that bind a loopback port (`startEgressProxy`, `startCredBroker`). They time out inside the Claude sandbox (local port binding is off) and are unrelated to this PR.

## Not run here (need Docker, Hatchet or the public internet)

- `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` (`cell-authority.test.ts`: `leaseRefusal`)
- `pnpm --filter @terragon/www exec vitest run --no-file-parallelism` (`thread-status/route.test.ts`: T-LEASE-SUPERSEDED; `cell-control.test.ts`: T-STALE-ON)
- the full `HATCHET_IT=1` worker list in `CLAUDE.md` (the admission move in `workflow.ts`), then `docker compose -p automata-hatchet-it down -v --remove-orphans`
- `OPENSANDBOX_IT=1 OPENSANDBOX_IT_CELL_IMAGE=<digest> pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/cell-run.integration.test.ts` (IT-E1)
- `OPENSANDBOX_IT=1 pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism src/providers/opensandbox-cell.integration.test.ts` (the new live `copyIn` case)
- `pnpm install --frozen-lockfile --prefer-offline` and `pnpm audit --prod --audit-level critical` (the lockfile importer was edited by hand: `@terragon/sandbox` added, `@terragon/types` moved to `dependencies`)

## Deviations from the spec

- The lockfile importer for `@terragon/worker` was edited by hand, because `pnpm install --lockfile-only` also rewrote unrelated `deprecated:` text.
- `cellCloneArgv` returns the list of argvs in order (clone, `checkout -B`, `fetch`), and `CELL_WRITE_MESSAGE_SH` removes the staged file whether or not the daemon write worked.
- T-CONFIG's "zero www calls" is zero `cell-plan` and `cell-teardown` calls: the pre-daemon throw still posts its one typed `run-terminal`, as the exit-path matrix (E1) says.
- A real marked run reads the cell config twice (selection, then the executor), because `RunExecutorInput` carries no config. The unit test pins one read at selection.
- `copyIn`'s `Blob` body is cast through `ArrayBuffer`: the worker's tsconfig has no DOM `BlobPart`.

## Docker and live suites (outside the Claude sandbox, 2026-11-18)

| gate                                                                              | exit | result                                    |
| :-------------------------------------------------------------------------------- | :--: | :---------------------------------------- |
| `pnpm install --frozen-lockfile`                                                  |  0   | accepts the worker importer edit          |
| worker vitest                                                                     |  0   | 2187 passed, 47 skipped                   |
| sandbox vitest                                                                    |  0   | 602 passed, 146 skipped                   |
| shared vitest                                                                     |  0   | 1786 passed                               |
| www vitest                                                                        |  0   | 4634 passed, 9 skipped                    |
| `HATCHET_IT=1` worker list, then the compose teardown                             |  0   | 65 passed, 1 skipped                      |
| `OPENSANDBOX_IT=1` sandbox live suite (includes the new `copyIn` case)            |  0   | 11/11                                     |
| `OPENSANDBOX_IT=1` IT-E1 (`cell-run.integration.test.ts`), cold, on an amd64 host |  0   | **5/5**, 231 s, no `osbit` container left |

**IT-E1 needs an amd64 host.** The cell image is `linux/amd64` only (`FROM --platform=linux/amd64`).

- On an arm64 Mac the nested daemon refuses the pull: `no matching manifest for linux/arm64/v8`.
- `DOCKER_DEFAULT_PLATFORM=linux/amd64` does not help either: the digest-pinned dind will not start
  under it (`up.sh` exits 125).
- It ran on a throwaway Hetzner cpx32 (amd64, `nbg1`) with root Docker, Node 24.11.1
  (checksum-verified) and the worktree's code only: no `.git`, `node_modules`, `.env*` or key files.

Two defects in the test itself, found live and fixed:

1. **The canary scan planted the canary in the logs it checks.** It passed the canary as one exec
   argument, and execd logs exec argv, so the cell container's logs contained it. The scan now joins
   two halves in the shell. It also reads only files written after the cell started
   (`find / -xdev -newer /proc/1`), plus every process's environ and cmdline. A full `grep /` of
   the batteries image took about 300 s, the whole budget. The image's own layers cannot hold a
   runtime secret, and PR-F's layer scan covers them in CI.
2. **A cold pull outlasted the create budget.** The multi-GB pull happened inside `create` (about
   2 min). The test now pre-pulls the image into the dind, as the box's runbook does (PR-G).

## Refinement

There were no High findings: five Medium and two Low. All seven are fixed, each with tests.

- **M1:** a heartbeat 500 on a terminal write aborts setup at once. The settle runs before
  teardown, with each read under 10 s.
- **M2:** every provider call (create, exec, copyIn) races the run's liveness, so a fence, Stop,
  heartbeat loss or timeout starts the teardown immediately. A create that finishes late is reaped.
- **M3:** the teardown deadline is 70 s and A is capped at 30 s. A test pins the worst case at least
  30 s under onFailure's 120 s wait.
- **M4:** a `fencedRuns` guard means onFailure posts nothing for a fenced run.
- **L5:** the cell config is read once.
- **L6:** a failed message write logs no stderr.
- **L7:** the plan-fetch backoff stops on abort.

Gates after the fixes, outside the Claude sandbox, all exit 0:

- worker vitest: 2198 passed;
- `HATCHET_IT=1` list: 65 passed, 1 skipped;
- IT-E1 on the amd64 box: 5/5 (its `teardownCellRun` path changed);
- worker tsc, `tsc-check --force`, `lint --force`.

## `/simplify`

**Applied** (quality only; behaviour unchanged, tests unchanged apart from replaced internals):

- one shared terminal-read retry (`createTerminalReadRetry`) for the poll loop and the heartbeat;
- two sleeps (`abort-sleep.ts`: resolve on abort, reject on abort). The 250 ms wake loop is
  replaced by an abort listener. The SDK's `ctx.cancelled` is `controller.signal.aborted`, the
  same signal, and `PollContext.cancelled` is a snapshot, so the box path reacts to a cancel as
  before;
- one error-code reader, and `withTimeout` used where it exists;
- one best-effort teardown helper;
- one bounded run-end map (`run-end-marks.ts`, precedence fenced > tokenGone > retired) instead of
  three sets;
- one result assignment;
- the heartbeat, bootstrap and exit decision as named functions;
- the cell executor's default wiring in `cell-executor-default.ts`, loaded with `import()` on the
  first marked run, so `workflow.ts` imports no cell module at runtime.

**Skipped:** running `pgrep` and the status read in parallel. That would change the order in which
a dead daemon is detected.

**Gates after the pass**, all exit 0:

- worker vitest: 2198 passed;
- `HATCHET_IT=1` list: 65 passed, 1 skipped;
- IT-E1 on the amd64 box: 5/5;
- worker tsc, `tsc-check --force`, `lint --force`.

## Roborev

- **Job 1275 on `96c2890..f61528d`: Fail**, with one Medium and one Low. Both are fixed.
  - **Medium:** the cell's bootstrap always ran `checkout -B <workBranch>` from the cloned branch.
    That ignored a work branch already pushed by an earlier run, so the agent's push would be
    non-fast-forward and orphan that work. The box path continues it (`provision.ts:192-230`).
    The fix is `CELL_CHECKOUT_WORK_BRANCH_SH`, a fixed bash script with the validated ref as `$1`.
    It continues `origin/<workBranch>` when that exists, and otherwise starts from the cloned
    branch. Unit tests cover both argv cases, and one runs the script against a real local git
    remote with both branches.
  - **Low:** a Stop or fence that landed while `next-message` was in flight surfaced as a raw
    `AbortError`. It is now rethrown as `SetupAbortedError`, so the exit decision picks
    `stopped`, fenced or cancelled. A real error on a live signal keeps today's handling: a 4xx
    is NonRetryable. A test and a control cover it.
- **Gates after the fixes**, all exit 0:
  - worker vitest: 2201 passed;
  - IT-E1 on the amd64 box: 5/5;
  - worker tsc, `tsc-check --force`, `lint --force`.
