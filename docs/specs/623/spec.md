# #623 spec: bound fixBranchName's issue and attempt numbers to safe integers

## Ticket

Follow-up from #622 (OD3). `fixBranchName` checks its issue and attempt numbers with `Number.isInteger`, which accepts `1e21`. The builder then emits `automata/fix-1e+21-…`, and the worker's self-heal fence (`FIX_SUFFIX_SHAPE`) refuses it because of the `+`. Real GitHub issue numbers never get that large. Still, the builder should refuse what the fence refuses, instead of producing a name that cannot be pushed.

## Reality check on be-automata/automata@8ebffabe

| What                                                                                    | Where                                                                                                   |
| :-------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ |
| `assertPositiveInteger` uses `Number.isInteger(value) && value > 0`                     | `apps/www/src/server-lib/audit/fix-run-prompt.ts:42-46` (moves to `@terragon/utils/fix-branch` in #622) |
| The builder template `${prefix}${issueNumber}-${fingerprint.slice(0, 8)}-a${attemptNo}` | `fix-run-prompt.ts:49-60`                                                                               |
| The worker suffix rule `^[A-Za-z0-9][A-Za-z0-9._-]*$` (refuses `+`)                     | `packages/worker/src/agent-run/workflow.ts:830`                                                         |

## Contract

- The issue and attempt checks use `Number.isSafeInteger(value) && value > 0`.
- The existing error text stays: `fix run issue number|attempt number must be a positive integer, got <v>`.
- Any value up to `Number.MAX_SAFE_INTEGER` gives the same output as today.

## Acceptance Criteria

- AC1: `1e21`, `2 ** 53` and `Number.MAX_SAFE_INTEGER + 2` are refused for both the issue and the attempt, with the existing message.
- AC2: `Number.MAX_SAFE_INTEGER`, `1` and `99999` give byte-identical names to today.
- AC3: a property test over the real builder, with issue and attempt each in `[1, MAX_SAFE_INTEGER]`, shows every name passes `selfHealRefFence`. It runs as part of #622's worker test.

## Tests

- `pnpm --filter @terragon/utils exec vitest run --no-file-parallelism src/fix-branch.test.ts`
- `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/workflow.test.ts`
- `pnpm turbo tsc-check`

## Open decisions

None. #622 OD3 sets the order: this lands after #622 moves the builder.

## UAT

T0 (local): run the Tests commands.

## Decisions

There are no open decisions. #622's OD3 set the order: this change comes after the builder moved to utils, which merged as `35d23c86`.

## Ground truth (verified at 35d23c86 on 2026-11-15)

| What                                                                                                                                            | Where                                                    |
| :---------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------- |
| The builder is now in `@terragon/utils/fix-branch`                                                                                              | `packages/utils/src/fix-branch.ts:28-39`                 |
| `assertPositiveInteger` uses `!Number.isInteger(value) \|\| value < 1`, with message `fix run ${what} must be a positive integer, got ${value}` | `fix-branch.ts:21-25`                                    |
| Issue is checked first, then attempt, then fingerprint                                                                                          | `fix-branch.ts:33-37`                                    |
| The AC1 table already goes up to `Number.MAX_SAFE_INTEGER`, pinned by sha256 `f4cc7c43…8524`                                                    | `packages/utils/src/fix-branch.test.ts:11,33`            |
| The AC2 rejection table is `[0, -1, 1.5, NaN]` for issue and attempt, with exact messages                                                       | `fix-branch.test.ts:63-95`                               |
| The worker runs the real builder through `selfHealRefFence`, up to `MAX_SAFE_INTEGER`                                                           | `packages/worker/src/agent-run/workflow.test.ts:879-900` |
| The ticket's `apps/www/.../fix-run-prompt.ts:42-46` reference is outdated: the check moved to utils in #622                                     | n/a                                                      |

Not done yet: nothing in the repo uses `Number.isSafeInteger` for these checks.

## Contract (the change)

- In `fix-branch.ts`, `assertPositiveInteger` uses `!Number.isSafeInteger(value) || value < 1`. The message is unchanged.
- No other file changes behaviour.

## Constraints for the implementer

- Output must stay byte-identical for every value up to `MAX_SAFE_INTEGER`: the sha256 pin must not change.
- Messages stay exact, and the existing exact-match helper keeps covering them.
- Utils keeps no imports.
- Follow the TypeScript rules in AGENTS.md.
- Run prettier as `pnpm exec prettier --no-editorconfig --config .prettierrc`.

## Gates

- `pnpm --filter @terragon/utils exec vitest run --no-file-parallelism src/fix-branch.test.ts`
- `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/workflow.test.ts` (unsandboxed)
- `pnpm turbo tsc-check`
- `pnpm turbo lint`
- prettier on the changed files

## Phases

1. **Files:** `packages/utils/src/fix-branch.ts` and `packages/utils/src/fix-branch.test.ts`.
   - AC1: add `1e21`, `2 ** 53` and `2 ** 53 + 2` to the issue and attempt rejection tables, with exact messages (`got 1e+21`, `got 9007199254740992`, `got 9007199254740994`). The ticket's `Number.MAX_SAFE_INTEGER + 2` is not representable in floating point and equals `2 ** 53`, so this uses `2 ** 53 + 2`.
   - AC2: the sha256 pin and the edge-value table are unchanged.
   - AC3: moved to phase 2 (validate RF1).

## Validate round 1 (BLOCK, fixed): RF1

AC3 was not covered. `workflow.test.ts:883-891` takes attempts only up to 99999, and the table is fixed. Phase 2 adds the coverage. `fast-check` is not installed, and no dependency is added.

2. **Phase 2 — file:** `packages/worker/src/agent-run/workflow.test.ts`.
   - Extend the real-builder fence test: attempts gain `2147483647` and `Number.MAX_SAFE_INTEGER`.
   - Add a deterministic seeded sample (an LCG over BigInt, reduced into `[1, MAX_SAFE_INTEGER]`) for both issue and attempt. Every name must map to exactly `refs/heads/<name>` through `selfHealRefFence`.
   - Gate: `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/workflow.test.ts`, run unsandboxed.
3. **Phase 3 — repo gates:** `pnpm turbo tsc-check`, `pnpm turbo lint`, and prettier on the three changed files.
