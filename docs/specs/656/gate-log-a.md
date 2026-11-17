# #656 PR-A gate log

Branch `feat/656-a-lease-authority`, off `main` at `c596e47f` (after #652's control effects, #664). Spec: `docs/specs/656/spec-a.md`. Validate: PASS_WITH_WARNINGS, with seven fixes folded in.

## Gates (worktree root, outside the Claude sandbox)

| Gate                                                                                                    | Exit      | Result                                                                                                                                 |
| :------------------------------------------------------------------------------------------------------ | :-------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| `CI=1 pnpm install --frozen-lockfile --prefer-offline`                                                  | 0         | The lockfile changes by one importer move only: `@terragon/types` goes to sandbox `dependencies`, because `cellKeyId` now runs from it |
| `node deploy/lint-migrations.ts`                                                                        | 0         | 22 files linted, 5 grandfathered                                                                                                       |
| `pnpm --filter @terragon/migrate test`                                                                  | 0         | 45                                                                                                                                     |
| `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model/cell-authority.test.ts` | 0         | 48. Includes the race tests with a committing lock holder, which prove the stamp blocked, and `openNextAttempt` against `finishStep`   |
| shared, www and sandbox full suites                                                                     | 0 / 0 / 0 | 1722; 4458 (9 skipped); 557 (145 skipped)                                                                                              |
| `pnpm turbo tsc-check --force`; `pnpm turbo lint --force`                                               | 0 / 0     | 21/21                                                                                                                                  |

**Fixed while gating:** the `deadCellAttempts` matrix test reported a fifth dead key. The `backdate` helper set `last_seen_at` unconditionally, which turned the NULL-lease row (one opened by the old `openStep`) into a stale one. The function was right: it keeps NULL leases. The helper now ages only a stamped lease.
