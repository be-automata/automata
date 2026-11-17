# #660 gate log (2026-11-17)

Every command was run from the worktree root (`.claude/worktrees/660`, branch `feat/660-agent-messages`,
base `origin/main` @ `e3d74abb`). Exit codes are real (`echo "rc=$?"` after each command) unless the row says
otherwise.

## Final code tree (`cbee19e0`; later commits change docs only)

| Gate | Command | Exit | Output |
|---|---|---|---|
| install | `pnpm install --frozen-lockfile --prefer-offline` | 0 | lockfile in sync |
| typecheck | `pnpm turbo tsc-check` | 0 | 21/21 tasks |
| lint | `pnpm turbo lint` | 0 | |
| format | `pnpm turbo format-check` | 0 | 18/18 tasks |
| migration lint | `node deploy/lint-migrations.ts` | 0 | `lint-migrations: OK — 21 file(s) linted, 5 grandfathered` |
| migrate tests | `pnpm --filter @terragon/migrate test` | 0 | 5 files, 45 tests (the new id sorts last: `files.test.ts`) |
| shared tests (full) | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` | 0 | 98 files, 1714 tests (see "Load-sensitive tests" for the run before it) |
| agent-bus tests | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model/agent-bus` | 0 | 105 tests incl. the 4 crash drills; the crash file was run 3× in a row green |
| coverage | `pnpm --filter @terragon/shared exec vitest run --coverage --no-file-parallelism src/model/agent-bus` | 0 | `messages.ts` 99.16% statements, 95.91% branches (refinement round; the simplify round removed code, not branches) |
| www touched tests | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/agent-bus src/server-lib/cron.test.ts src/server-lib/cron-routes.static.test.ts` | 0 | 3 files, 45 tests (42 after the it.each collapse) |
| www tests (full) | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism` | 1 | 2 failed / 4470 passed / 9 skipped: `admin.test.ts` 5000 ms timeouts; that file re-run alone: 30/30, rc 0. See below. |
| schema drift (AC: migration ≡ drizzle) | postgres:18 throwaway container; `DATABASE_URL=$PG/a pnpm exec tsx deploy/migrate.ts --apply` (×2); `DATABASE_URL=$PG/b pnpm -C packages/shared exec drizzle-kit push --force`; `pnpm exec tsx deploy/schema-drift.ts --a $PG/a --b $PG/b` | see note | `applied 26 migration(s)` then `applied 0 migration(s)`; `compared 1531 objects in a (a) with 1531 in b (b)`, `schema drift: none (0 allowlisted difference(s))`. These commands were piped through `tail`, so the recorded codes are `tail`'s; the verdict rests on the printed drift line. Also run on Postgres 16 in phase 1 (same result). |
| roborev (via roborev-guard) | `roborev-guard review --branch --wait` | 1 → fix rounds | job 1239 (`e3d74ab..cbee19e`): Pass + 1 Low (spec contract stale) → fixed `4133f00e`. Job 1240 (`..72aed2a`): Pass + 1 Medium (the kick awaited the drain, which can boot a sandbox: a send and the serial cron sweep blocked) + 1 Low (a failed broadcast skipped the drain) → fixed: the drain goes through `waitUntil` like `queueFollowUpInternal`, the broadcast is caught on its own; refinement re-review of the delta: clean (3 low/nit items applied). Final job: see the PR. |

## Load-sensitive tests (not touched by this branch)

Full-suite runs on this machine ran under heavy load (one www run: 817 s, 449 s of setup). Each time a
different file this branch does not touch timed out at 5000 ms, and each passed alone:

- shared: `backfill-organizations.test.ts` (2 × timeout) → alone 3/3 in 309 ms; the next full shared run: 98
  files, 1714 tests, rc 0 (that test 915 ms).
- www: `e2e.test.ts` (2), `supersede-sweep.order.test.ts` (1) → both alone 21/21, rc 0.
- www: `admin.test.ts` (2, a timeout and a spy assertion that fired after it) → alone 30/30, rc 0.

None of these files imports the code this branch adds. The PR's CI is the clean full-suite run of record.

## Acceptance criteria → proof

| AC | Proof | Result |
|---|---|---|
| 1 receiver crash | `messages.crash.test.ts` "AC1": legacy target (the production default) and a chat-model variant; child SIGKILLs after the 2nd apply, before COMMIT (stderr sentinel checked); rerun | 3 `agent_applied`, 3 queued follow-ups, 3 consumed |
| 2 sender crash | `messages.crash.test.ts` "AC2": `sendMessage` killed inside the receive apply (insert committed); retry same key | `duplicate: true`, same id; 1 row; 1 applied, 1 queued, consumed |
| 3 negative control | `messages.crash.test.ts` "AC3": fixture `UNSAFE=1`, apply on the plain db, chat-model target | 4 queued follow-ups for 3 messages (3 `agent_applied`, all consumed) |
| 4 refused send writes nothing | `messages.test.ts` "refusal": not_found (unknown sender, unknown target, target in another organization), lane pair, terminal sender/target, blocked sender/target | 0 rows in `agent_messages` and `agent_applied` each |
| 5 sweeper | `messages.test.ts` "sweepUnconsumed": backdated message delivered by one pass, a fresh one left alone, deleted target inert; `cron.test.ts` "runScheduledTasksCron agent-bus sweep" | delivered once; the sweep runs in the `*/1` route's runner, also when due-threads throws; a throwing sweep is swallowed |

## Negative controls

- AC3 above is the ticket's negative control: moving the apply out of the receive transaction yields 4
  applications for 3 messages, so the kill lands between the effect and the ack.

## Validate and review history

- Validate cycle 1 (Opus): BLOCK (4 fixes) → PASS_WITH_WARNINGS on re-grade.
- Refinement (Opus): 1 blocker (legacy threads, the production default, could never receive), 3 major, 6 minor —
  all fixed in `7270121b`.
- /simplify (4 reviewers): queued-append helper shared with `updateThreadChat`, test flag out of `receiveFor`,
  re-kick window 2 min, test dedupe — `cbee19e0`.

## Roborev fix round 2 (delivery.ts)

`pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/agent-bus src/server-lib/cron.test.ts src/server-lib/cron-routes.static.test.ts` 0 (48 tests) ·
`pnpm turbo tsc-check lint format-check` 0. New tests: a rejected broadcast still drains; `kickTarget` and
`sendAgentMessage` resolve while the drain never settles, and the drain is handed to `waitUntil`.
Known limit (for S5): on a request path Cloudflare keeps `waitUntil` work ~30 s after the response, the same
exposure `queueFollowUpInternal` already accepts; the cron path is unaffected.
