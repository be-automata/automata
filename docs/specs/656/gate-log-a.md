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

## Refinement (two Medium, seven Low; all fixed in the next commit)

- **Medium:** `finishStep` on a step that never opened wrote nothing, so a late `openNextAttempt` opened attempt 1 for an already-finished thread.
  - `finishStep({db, stepKey, organizationId, threadId})` now upserts a **done tombstone**: `current_attempt` 0, `done_at` set, no schema change.
  - `openNextAttempt` checks an org/thread mismatch first, then done, then a ref mismatch, so a tombstone always gives `step_done`.
  - Test 12a fails without the fix.
- **Medium:** `openNextAttempt` is not idempotent: a lost response followed by a retry burns an attempt. The spec now records this as accepted, with an optional PR-C nonce.
- **Lows:**
  - `stampSeen` never grants a lease to a NULL row;
  - a row that vanishes returns `conflict`;
  - a re-open keeps the stored budget and timeout;
  - the 1000th and 1001st attempt boundary is tested;
  - `cellKeyId` replaces a hand-built key;
  - tests 13 and 14 assert full keys.
- **After the fixes (outside the Claude sandbox):** `cell-authority` 52, shared 1726, www 4458 (9 skipped), all exit 0.
