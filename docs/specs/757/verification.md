# Verification evidence: #757 (www marks only task-lane runs for a cell)

- Head: `77ee0ff3`. Run on 2026-11-23, sandbox off, from the `gh-757` worktree.
- The verify gates before each commit also ran, all exit 0: forced `pnpm turbo tsc-check` and `pnpm turbo lint` (utils, worker, www); utils vitest (160 passed); worker `src/agent-run` vitest (2320 passed, 53 skipped integration); www `src/agent/hatchet` vitest (184 passed). roborev on `d3efdab..77ee0ff`: Pass, no findings.

## Commands, exit codes, Tests lines

| #   | Command                                                                                                                                                               | Exit | Test Files   | Tests                                        |
| :-- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--- | :----------- | :------------------------------------------- |
| 1   | `pnpm --filter @terragon/utils exec vitest run --no-file-parallelism src/run-lane.test.ts`                                                                            | 0    | 1 passed (1) | 16 passed (16)                               |
| 2   | `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/run-lane.test.ts src/agent-run/run-budget.test.ts src/agent-run/workflow.test.ts` | 0    | 3 passed (3) | 119 passed (119)                             |
| 3   | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/agent/hatchet/dispatch-cell-marker.test.ts`                                                    | 0    | 1 passed (1) | 31 passed (31)                               |
| 4   | `grep -rn "function resolveRunLane" packages/*/src apps/*/src`                                                                                                        | 0    | —            | one hit: `packages/utils/src/run-lane.ts:47` |

## Per-AC map

### AC-1 PR-numbered org thread is not marked

- `apps/www/src/agent/hatchet/dispatch-cell-marker.test.ts` :: `#757: a non-review PR thread never gets the marker` (no `cell`, and the org-cells lookup is never called)

### AC-2 no-PR org thread is still marked

- same test, second half: `dispatchPlain({ organizationId })` yields `cell: "opensandbox"`; plus the existing `flag on and env set: cell is opensandbox, secrets keep the same shape`

### AC-3 one `resolveRunLane`

- Command 4: the only definition is `packages/utils/src/run-lane.ts`. `packages/worker/src/agent-run/run-lane.ts` re-exports it; `apps/www/src/agent/hatchet/dispatch.ts` imports `isCellEligibleLane` from the same module.

### AC-4 what www marks, the worker accepts

- One predicate, `isCellEligibleLane` (`packages/utils/src/run-lane.ts`): `selectRunExecutor` refuses on it (`packages/worker/src/agent-run/run-executor.ts`), dispatch marks on it, `refreshesRunBudget` reads it.
- `apps/www/src/agent/hatchet/dispatch-cell-marker.test.ts` :: `#757: a non-review PR thread never gets the marker` asserts `isCellEligibleLane(marked)` on the marked input.
- `packages/utils/src/run-lane.test.ts` :: `accepts a plain task run` and `refuses %s` (PR number, prKey, supersede policy, self-heal, review agent).
- Worker side unchanged in behaviour: `packages/worker/src/agent-run/workflow.test.ts` T-LANE cases still pass (command 2).

### AC-5 production

- Deferred, `needs-production`: after the deploy, the next merge on the cells-on org must post a real audit, and the #679/#680 audits are re-run by redelivering their merge events.
