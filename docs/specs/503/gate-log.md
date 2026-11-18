# #503 gate log

Branch `fix/503-egress-post-revoke-drop` off `origin/main` @ `a6996533` (re-fetched before ship: still
`a6996533`, so `git merge --no-ff origin/main` was a no-op). Run on 2026-11-17 on macOS (pnpm
10.14.0). Each line is the command and its real exit code, on the final code (after `/simplify`).

## Verification gates

| Gate      | Command                                                                      | Exit                     |
| --------- | ---------------------------------------------------------------------------- | ------------------------ |
| install   | `CI=true pnpm install --frozen-lockfile --prefer-offline`                    | 0                        |
| typecheck | `pnpm turbo tsc-check`                                                       | 0                        |
| lint      | `pnpm turbo lint`                                                            | 0                        |
| format    | `pnpm turbo format-check`                                                    | 0                        |
| worker    | `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism`       | 0 (76 files, 2064 tests) |
| red first | `vitest run src/agent-run/workflow-cleanup.test.ts -t 503` before the change | 1 (3 failed, 2 passed)   |

The two cases that passed before the change are the regression guards (AC-2 "without the mark" and
the AC-3 "cancelled" run); the three that failed are AC-1, its 25-event sibling, and the AC-3
"completed" run.

## Review

- Validate (fresh agent, adversarial): PASS_WITH_WARNINGS. The three warnings were spec cites off by
  one to four lines (fixed), and two known remainders (recorded in the spec's Risks section).
- `/simplify`: four angles. Applied: the revoked flag split from the drop count, the flush tick stopped
  on the mark, a dead check removed from `flush()`, one shared `console.info` spy and drop-log helper.
  Skipped: hoisting the #473 run setup into a shared helper (touches an untouched test), and moving
  the mark into a `pollCtx` hook (changes `www-client`'s `PollContext`, outside the decided change).
- roborev (`roborev-guard review --branch --wait`, job 1265): exit 0, "Pass, no issues found".

## Acceptance

| AC   | Evidence                                                                                                 | Verdict |
| ---- | -------------------------------------------------------------------------------------------------------- | ------- |
| AC-1 | `workflow-cleanup.test.ts` "#503: once marked terminal ..." and "after the mark, events added later ..." | PASS    |
| AC-2 | `workflow-cleanup.test.ts` "#503: without the terminal mark, close() still POSTs the buffer"             | PASS    |
| AC-3 | `workflow-cleanup.test.ts` "#503: a batch buffered after the terminal read ..." (completed, cancelled)   | PASS    |
| AC-4 | The gate table above                                                                                     | PASS    |

The issue's production check (no `postEgressEvents non-2xx` line after a `terminal=true` line for the
same run, on the box) needs a worker deploy and is verified after merge from the box journal.
