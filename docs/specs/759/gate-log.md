# Gate log for #759 (prune consumed agent_messages)

Branch `feat/759-agent-messages-retention`, rebased onto origin/main `ba392f84`. Every exit code below is the command's own: no pipes. The tsc, lint and format checks ran with `--force`, so turbo served nothing from its cache.

## Final gates

| Gate                        | Command                                                                                               | Exit | Result                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| install                     | `pnpm install --frozen-lockfile --prefer-offline`                                                     | 0    | lockfile in sync                                                                     |
| typecheck                   | `pnpm turbo tsc-check --force`                                                                        | 0    | 21/21 tasks                                                                          |
| lint                        | `pnpm turbo lint --force`                                                                             | 0    | 2/2 tasks                                                                            |
| format                      | `pnpm turbo format-check --force`                                                                     | 0    | 18/18 tasks                                                                          |
| shared tests (full)         | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`                                | 0    | at HEAD `b66b2077`: 107 files, 1956 tests                                            |
| coverage                    | `pnpm --filter @terragon/shared exec vitest run --coverage --no-file-parallelism src/model/agent-bus` | 0    | 5 files, 123 tests; `retention.ts` 100% on statements, branches, functions and lines |
| www tests (full)            | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`                                   | 0    | at HEAD `b66b2077`: 356 files passed, 2 skipped; 5247 tests passed, 13 skipped       |
| roborev (via roborev-guard) | `roborev-guard review --branch --wait`                                                                | 0    | job 1396 at `b66b2077`: Pass, no issues                                              |

The tsc, lint and format results are from `debb796f`. The next commit, `b66b2077`, changes comments only.

These runs predate `ddfb8604`, `cf0cba48` and `72568569`, which changed `retention.ts` and `retention.test.ts` (and a `messages.ts` comment). None of the results above covers those three commits.

## Validate (Opus, adversarial, graded against the repository)

The verdict was **PASS_WITH_WARNINGS**. Five required fixes were folded into the spec as amendments:

- **F1:** the files are `retention.ts` and `retention.test.ts`, not `messages.ts`, which #758 owns.
- **F2:** a dead-lettered row is pruned only through the orphan pass, once its target is gone.
- **F3:** two passes, a consumed pass and an orphan pass.
- **F4:** the cron mock and all three hourly-order assertions.
- **F5:** the authorize-first premise is written in the JSDoc.

The warnings were adopted: a keyset cursor, a wall-clock budget, the SQL shape, AC testability and test helpers.

## Refinement (ruflo `refinement`)

No blockers. Applied:

- Chat-mode sender tests. Mutation-checked: replacing `threadLastWriteAt()` with `thread.updatedAt` fails exactly one of them.
- A `gte` index bound on the keyset.
- The orphan pass runs first, so a slow or failing consumed pass cannot starve or abort it.
- AC8 asserts only on its own ids.
- A test where a kept row sits at the head of the keyset.
- A test that an orphan younger than R is kept.
- Input guards.

## /simplify (4 reviewers)

Applied:

- One batch runner shared by both passes.
- One `NOT EXISTS` sender rule.
- Ids passed as one array parameter.
- An orphan pass with no order and no cursor.
- `assertPositiveInt`.
- Each doc statement made once.
- Test helpers.

Skipped as follow-ups:

- A neutral `withBoundedTx` (a rename across about 14 files).
- A deadline for the whole cron run.
- Refactoring the existing prunes into a fail-soft runner.
- A shared retention constant.
- An index on `thread_chat(thread_id, updated_at)`, which needs a migration.

## Roborev

- **Job 1393 at `107bc020`** (Pass, 1 Low): the AC9 `show()` read `db.execute`'s `QueryResult` as if it were a row array, so the test could never fail. Fixed in `debb796f`: it now reads `.rows` through `rowsOf` and fails loudly on a missing value. Mutation-checked: a leaked session `SET statement_timeout = '10s'` fails the test.
- **Job 1395 at `debb796f`** (Pass, 1 Low): rows kept for live senders are re-read on every hourly call. The comment and JSDoc were corrected in `b66b2077` and now state the limit and its failure signal (`agent_messages prune failed`). A persisted cursor is a follow-up.
- **Job 1396 at `b66b2077`:** Pass, no issues.
