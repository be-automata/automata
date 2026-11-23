# Gate log for #758 (dead-letter poison agent-bus messages)

Branch `feat/758-agent-messages-dead-letter`, rebased onto origin/main `ba392f84`. The gates ran once, in order, on the final code tree at `890558b7`. Each exit code is the command's own: no pipes. tsc, lint and format ran with `--force`, so turbo served nothing from its cache.

## Final gates

| Gate | Command | Exit | Result |
| --- | --- | --- | --- |
| install | `pnpm install --frozen-lockfile --prefer-offline` | 0 | lockfile in sync |
| typecheck | `pnpm turbo tsc-check --force` | 0 | 21/21 tasks |
| lint | `pnpm turbo lint --force` | 0 | 2/2 tasks |
| format | `pnpm turbo format-check --force` | 0 | 18/18 tasks |
| migration lint | `node deploy/lint-migrations.ts` | 0 | 30 files linted, 5 grandfathered |
| migrate tests | `pnpm --filter @terragon/migrate test` | 0 | 5 files, 45 tests |
| shared tests (full) | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` | 0 | 106 files, 1953 tests |
| coverage | `pnpm --filter @terragon/shared exec vitest run --coverage --no-file-parallelism src/model/agent-bus` | 0 | 4 files, 120 tests. `messages.ts`: 98.7% statements, 94.02% branches, 100% functions, 98.7% lines. Uncovered lines: 51-52 and 124-125. |
| www tests (full) | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism` | 0 | 356 files passed, 2 skipped. 5245 tests passed, 13 skipped. |
| schema drift | postgres:18 throwaway container: `DATABASE_URL=$PG/a pnpm exec tsx deploy/migrate.ts --apply` (×2), then `DATABASE_URL=$PG/b pnpm -C packages/shared exec drizzle-kit push --force`, then `pnpm exec tsx deploy/schema-drift.ts --a $PG/a --b $PG/b` | 0 / 0 / 0 / 0 | First apply: `applied 35 migration(s)`, the last one `2026-11-26-agent-messages-dead-letter`. Second apply: `applied 0`. Drift: `compared 1611 objects in a (a) with 1611 in b (b)`, `schema drift: none (0 allowlisted difference(s))`. |
| roborev (via roborev-guard) | `roborev-guard review --branch --wait` | 0 | job 1394 at `890558b7`: Pass, no issues |

## Validate (Opus, adversarial, graded against the repository)

- **Cycle 1: BLOCK.**
  - F1: AC9 contradicted the new return shape.
  - F2: AC8 promised that `last_error` never contains the body, which the design could not guarantee.
  - F3: AC7 could not be tested without a hook.
  - F4: `receiveFor` had no logger.
  - F5: two wrong citations.
- **Cycle 2: BLOCK on F5 alone.** My edit had not applied. I fixed the line and confirmed it with grep. The validator had stated that this one fix was all that stood between the spec and a pass. Its warnings were adopted as well: the hook is named `__testOnAttemptRecorded`, the new drill has its own full sentinel, and the limits of redaction are written down.

## Refinement (ruflo `refinement`)

No blockers. Fixes applied:
- A thrown value that cannot be printed no longer breaks attempt counting.
- The AC6 test now really checks the sweep's target query. A mutation check confirmed it: the test fails when the `deadLetteredAt` filter is removed.
- AC3 and AC5 no longer depend on rows left by other tests. AC5 also counts the apply calls per poison message.
- New test: truncation at the 500 cut never leaves a lone surrogate.
- The crash fixture refuses the failure drill in send mode.

## /simplify (4 reviewers)

Applied:
- `errorNameOf` helper, with the unprintable-value guard at every call site.
- The shared `createValueRedactor` with `minLength 1`. It also strips secrets, catches a JSON-escaped body and redacts short bodies; a test covers a 2-character body.
- The failure outcome no longer carries the row, so the body stays inside the transaction.
- One `deliverable` predicate.
- One `ALTER TABLE`.
- Test helpers.

Skipped:
- Narrowing the partial inbox index. That needs a separate `CONCURRENTLY` migration; it is a follow-up.
- Dropping the savepoint. That would release the row lock between rollback and the attempt update.
- Removing the test seam. The spec defines it for AC7.

## Roborev

- **Job 1392 at `371491c2`: Pass, with 1 Low finding.** `sweepUnconsumed` dropped the dead-letter count, and also the applied count and the target, when a receive dead-lettered or applied a message and then rethrew on a later one. Fixed in `890558b7`:
  - `receiveFor` reports dead-letters through `onDeadLettered`, the same way it reports applies through `onApplied`, and the sweep counts both through these callbacks.
  - Two tests cover it. One of them was mutation-checked: it fails when `onDeadLettered` does not count.
  - A combined refinement and simplify review of the fix found only test gaps, which are now closed.
- **Job 1394 at `890558b7`: Pass, no issues.**

## Drivers

The savepoint was exercised on node-postgres only. neon-serverless was not exercised. Both use the same `transaction()` savepoint code in drizzle 0.45.2: `node-postgres/session.js:204-221` and `neon-serverless/session.js:197-210`.
