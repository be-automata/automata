# Verification evidence: #743 (timed-out cell run continues its session in a new cell)

- Head: `33d08bf2`. Run on 2026-11-22, sandbox off, from the `gh-743` worktree.
- Logs: `$SCRATCHPAD/acc743-{worker,www,shared,r2}.log` (scratchpad of the evidence session).
- Last full verify: worker 2513 passed, www 5083 passed.

## Commands, exit codes, Tests lines

| # | Command | Exit | Test Files | Tests |
|:--|:--|:--|:--|:--|
| 1 | `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/cell-run.test.ts src/agent-run/cell-session-checkpoint.test.ts src/agent-run/cell-session-redact.test.ts src/agent-run/cell-salvage.test.ts src/agent-run/cell-session.integration.test.ts` | 0 | 4 passed, 1 skipped (5) | 178 passed, 1 skipped (179) |
| 2 | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/cell-session src/app/api/daemon/cell-checkpoint src/app/api/daemon/run-terminal src/server-lib/review` | 0 | 42 passed (42) | 697 passed (697) |
| 3 | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model/cell-session-checkpoint.test.ts src/model/cell-session-continuation.test.ts` | 0 | 2 passed (2) | 17 passed (17) |
| 4 | `R2_CONFORMANCE=local pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/lib/r2-conformance.integration.test.ts` | 0 | 1 passed (1) | 4 passed (4) |

## Skipped without an environment variable

| Test | Gate | Proves |
|:--|:--|:--|
| `packages/worker/src/agent-run/cell-session.integration.test.ts` "restores a killed cell's session into a new cell and resumes only the pending step" (the 1 skipped in command 1) | `OPENSANDBOX_IT=1` and `OPENSANDBOX_IT_CELL_IMAGE=<digest or local tag>`; needs a running OpenSandbox (up.sh/down.sh) | AC-1 (real `--resume` on a restored transcript in a second cell, stub agent) |
| `apps/www/src/lib/r2-conformance.integration.test.ts` (4 tests) | `R2_CONFORMANCE=local` (wrangler/miniflare local proxy, no secrets) or `remote` (throwaway real bucket) | AC-6. Ran here with `local`: exit 0, 4 passed. `remote` was not run. |
| `packages/worker/src/agent-run/cell-run.integration.test.ts` IT-E1 | `OPENSANDBOX_IT=1` plus image | Not mapped to an AC (cell lifecycle) |

## Per-AC map (path -> exact test name)

### AC-1 re-dispatch once to a new cell, `--resume` on the restored transcript
- `packages/worker/src/agent-run/cell-run.test.ts` :: `copies the transcript in before the message and keeps the session id`
- `apps/www/src/server-lib/cell-session/continuation.test.ts` :: `continues an eligible first timeout and names the turn and branch`
- `apps/www/src/app/api/daemon/run-terminal/route.test.ts` :: `a first timeout with a checkpoint re-dispatches once and defers the reply`
- `packages/worker/src/agent-run/cell-session.integration.test.ts` :: `restores a killed cell's session into a new cell and resumes only the pending step` (gated, OPENSANDBOX_IT)

### AC-2 no checkpoint starts fresh and says so
- `packages/worker/src/agent-run/cell-run.test.ts` :: `a hash mismatch starts fresh and says so`
- `packages/worker/src/agent-run/cell-run.test.ts` :: `posts startedFresh on the terminal only when the restore failed`
- `apps/www/src/server-lib/cell-session/continuation.test.ts` :: `a run with no checkpoint row (not a cell run) is no-checkpoint, and nothing is queued`
- `apps/www/src/app/api/daemon/run-terminal/route.test.ts` :: `no checkpoint keeps today's reply and queues nothing (OQ-1)`

### AC-3 second timeout is not re-dispatched, the reply names the limit
- `packages/shared/src/model/cell-session-continuation.test.ts` :: `a second run on the same thread is budget-spent`
- `apps/www/src/server-lib/cell-session/continuation.test.ts` :: `budget-spent beats no-checkpoint (F4): a second timeout with no checkpoint names the limit`
- `apps/www/src/app/api/daemon/run-terminal/route.test.ts` :: `a spent budget puts the limit in the reply (AC-3)`

### AC-4 redelivered timeout terminal re-dispatches at most once
- `packages/shared/src/model/cell-session-continuation.test.ts` :: `racing claims on one source run leave exactly one winner`
- `packages/shared/src/model/cell-session-continuation.test.ts` :: `the same source run twice is already-claimed`
- `apps/www/src/server-lib/cell-session/continuation.test.ts` :: `a redelivered call is already-claimed and only one claim exists`
- `apps/www/src/app/api/daemon/run-terminal/route.test.ts` :: `F1: a redelivered terminal takes the early branch, claims at most once and posts no reply`

### AC-5 no identity, token or secret in a checkpoint (canary, 048 redaction set)
- `packages/worker/src/agent-run/cell-session-checkpoint.test.ts` :: `AC-5: no canary survives in the chunk, the events or the manifest`
- `packages/worker/src/agent-run/cell-session-redact.test.ts` :: `leaves no canary and keeps every line parseable`
- `packages/worker/src/agent-run/cell-session-redact.test.ts` :: `pins the rules digest: rules may be added, never removed`
- `apps/www/src/app/api/daemon/cell-checkpoint/route.test.ts` :: `never logs the body or blob bytes`

### AC-6 create-only writes, head moves by CAS, 412 on both
- `apps/www/src/lib/r2-conformance.integration.test.ts` :: `a second create of the same key is 412 and keeps the first bytes` (gated, R2_CONFORMANCE)
- `apps/www/src/lib/r2-conformance.integration.test.ts` :: `10 racing creates yield exactly one 201` (gated, R2_CONFORMANCE)
- `packages/shared/src/model/cell-session-checkpoint.test.ts` :: `two racing CAS calls on one version: exactly one wins`
- `apps/www/src/server-lib/cell-session/checkpoint-store.test.ts` :: `a lost CAS race leaves the old head and returns head_moved, not a throw`

### AC-7 WIP commit on the fenced work branch, continued run starts from it
- `packages/worker/src/agent-run/cell-salvage.test.ts` :: `commits a dirty tree and pushes HEAD to the run's own ref`
- `packages/worker/src/agent-run/cell-salvage.test.ts` :: `pushes only HEAD:refs/heads/<the run's ref>, to the broker URL`
- `packages/worker/src/agent-run/cell-run.test.ts` :: `freeze, then the final pull, then the salvage, all before the revoke`
- `packages/worker/src/agent-run/cell-image-assets.test.ts` :: `the checkout script continues origin/<ref> when it exists, else branches from head`

### AC-8 production UAT
Not covered here. It needs a real run across two cells in production; checkpoint size, write count and restore latency go in a ticket comment.

## What the unit tests do not prove

AC-1 to AC-7 rest on mocked cells (fake `ICellProvider`), mocked/in-memory R2 stores and a throwaway Postgres.
No test here runs a real `claude --resume`, a real cell timeout, or the real R2 bucket.
