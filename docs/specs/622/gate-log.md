# #622 gate log

All commands ran from the worktree root on 2026-11-15. The shared, www and worker suites ran unsandboxed. Every command below exited 0 unless noted.

| Command                                                                                                                                         | Exit         | Result                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------- |
| `pnpm --filter @terragon/utils exec vitest run --no-file-parallelism src/fix-branch.test.ts src/package-exports.test.ts`                        | 0            | 28 tests: 175-name sha256 `f4cc7c43…8524`, exact AC2 messages, `./fix-branch` pin |
| `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/self-heal/fix-paths.test.ts`                                          | 0            | 22 tests                                                                          |
| www: `fix-run-prompt`, `plan-self-heal-run`, `no-merge.static`, `skill-contract-drift`, hatchet `dispatch`                                      | 0            | 178 tests                                                                         |
| `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/workflow.test.ts src/agent-run/self-heal-fix-check.test.ts` | 0            | 83 tests; AC5 runs the real `fixBranchName`                                       |
| `pnpm turbo tsc-check --force`                                                                                                                  | 0            |                                                                                   |
| `pnpm turbo lint --force`                                                                                                                       | 0            |                                                                                   |
| prettier `--check` on changed files                                                                                                             | 0            |                                                                                   |
| AC8: `pnpm exec tsx deploy/self-heal-bench/verify-fixes.ts`                                                                                     | 1 (expected) | Prints USAGE. No module error.                                                    |
| AC4: `git grep -n 'readSource\|WORKER_FIX_BRANCH_PREFIX' packages/worker`                                                                       |              | No hits                                                                           |
| AC7: `git diff --stat origin/main...HEAD -- '*/package.json'`                                                                                   |              | Only the utils `./fix-branch` exports entry                                       |

## Mutation checks

- **AC1 baseline is main's.** The refinement pass rebuilt the 175 names with main's own builder, outside the repo, and got the same sha256.
- **AC2 messages are exact.** Appending a character to a message fails 3 tests.

## Review passes

- **Validate:** PASS_WITH_WARNINGS. R1–R4 are folded in.
- **Refinement:** no defects.
- **`/simplify`:**
  - www's builder tests were reduced to a smoke test for the re-export;
  - a stale comment was fixed;
  - the re-exports stay (OD2).
- **roborev, four rounds.** Each round passed with its low findings fixed:

  - the spec now records that the tests moved;
  - the messages are matched exactly;
  - superseded spec lines are marked inline.

  The final round reported no issues. Two runs never reached the reviewer because the daemon enqueue timed out; those were retried and are not counted.
