# #660 gate log (2026-11-17)

Every command was run from the worktree root (`.claude/worktrees/660`, branch `feat/660-agent-messages`,
base `origin/main` @ `e3d74abb`). Exit codes are real (`echo "rc=$?"` after each command) unless the row says
otherwise.

## Final code tree (`18d243e7`; the commits after it change `docs/specs/660/` only)

Run once, in order, on the final tree, each command's own exit code captured (no pipes).

| Gate | Command | Exit | Output |
|---|---|---|---|
| install | `pnpm install --frozen-lockfile --prefer-offline` | 0 | lockfile in sync |
| typecheck | `pnpm turbo tsc-check` | 0 | 21/21 tasks |
| lint | `pnpm turbo lint` | 0 | 2/2 tasks |
| format | `pnpm turbo format-check` | 0 | 18/18 tasks |
| migration lint | `node deploy/lint-migrations.ts` | 0 | `lint-migrations: OK — 21 file(s) linted, 5 grandfathered` |
| migrate tests | `pnpm --filter @terragon/migrate test` | 0 | 5 files, 45 tests (the new id sorts last: `files.test.ts`) |
| shared tests (full) | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` | 0 | 98 files, 1714 tests |
| coverage | `pnpm --filter @terragon/shared exec vitest run --coverage --no-file-parallelism src/model/agent-bus` | 0 | 4 files, 105 tests; `messages.ts` 99.1% statements, 95.45% branches, 87.5% functions, 99.1% lines (uncovered 96-97) |
| www tests (full) | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism` | 0 | 336 files passed, 1 skipped; 4476 tests passed, 9 skipped |
| schema drift | postgres:18 throwaway container: `DATABASE_URL=$PG/a pnpm exec tsx deploy/migrate.ts --apply` (×2); `DATABASE_URL=$PG/b pnpm -C packages/shared exec drizzle-kit push --force`; `pnpm exec tsx deploy/schema-drift.ts --a $PG/a --b $PG/b` | 0 / 0 / 0 / 0 | `applied 26 migration(s)`, then `applied 0 migration(s)`; `compared 1531 objects in a (a) with 1531 in b (b)`, `schema drift: none (0 allowlisted difference(s))` |
| roborev (via roborev-guard) | `roborev-guard review --branch --wait` | see "Roborev" | |

## Roborev

| Job | Range | Assessment | Findings → outcome |
|---|---|---|---|
| 1239 | `..cbee19e` | Pass | Low: spec contract stale → `4133f00e` |
| 1240 | `..72aed2a` | Pass | Medium: the kick awaited the drain (sandbox boot); Low: a failed broadcast skipped the drain → `6fd24ac9` |
| 1243 | `..6fd24ac` | Pass | Low: re-kick re-broadcast; hardening: `FOR NO KEY UPDATE` → `18d243e7` (round 3 approved by the owner) |
| 1244 | `..18d243e` | Pass | Low: spec www contract stale → `4ec06b84` |
| 1245 | `..4ec06b8` | Pass | Low: this gate log claimed an older final tree → this rewrite, with every gate rerun on `18d243e7` |

## Load-sensitive tests during development (history; the final run above is green)

Full-suite runs on this machine ran under heavy load (one www run: 817 s, 449 s of setup). Each time a
different file this branch does not touch timed out at 5000 ms, and each passed alone:

- shared: `backfill-organizations.test.ts` (2 × timeout) → alone 3/3 in 309 ms; the next full shared run: 98
  files, 1714 tests, rc 0 (that test 915 ms).
- www: `e2e.test.ts` (2), `supersede-sweep.order.test.ts` (1) → both alone 21/21, rc 0.
- www: `admin.test.ts` (2, a timeout and a spy assertion that fired after it) → alone 30/30, rc 0.

None of these files imports the code this branch adds; the final full runs above are green.

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

## Roborev fix round 3 (owner-approved, 2026-11-17)

Job 1243 (`..6fd24ac`): Pass + 1 Low (every sweep re-kick re-broadcast an already-broadcast message, up to 200
per tick) + a hardening note (lock the target thread `FOR NO KEY UPDATE`). Fixed: `sweepUnconsumed` reports only
targets it applied to; `runAgentBusSweep` broadcasts only for those, and re-kicks recently delivered targets
silently (`kickTarget(id, { broadcast: false })`); receive locks the thread `FOR NO KEY UPDATE`. Refinement and
simplify of this ~20-line delta: reviewed inline by the orchestrator (no findings).

`pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model/agent-bus` 0 (4 files, 105 tests,
all 4 crash drills) · `pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/agent-bus
src/server-lib/cron.test.ts src/server-lib/cron-routes.static.test.ts` 0 (49 tests; new: a re-kicked recently
delivered target is kicked once with 0 broadcasts) · `pnpm turbo tsc-check lint format-check` 0.

## Merged tree (`caf12bdb` = this branch + `origin/main` @ `85b07e6c`)

main gained `2026-11-18-control-effects` (#652) and `2026-11-19-cell-step-last-seen` (#656 PR-A); this branch's
migration was renamed `2026-11-21-agent-messages` to keep sorting last. Every gate rerun on the merged tree,
each command's own exit code captured:

| Gate | Exit | Output |
|---|---|---|
| `pnpm install --frozen-lockfile --prefer-offline` | 0 | |
| `pnpm --filter @terragon/docs exec fumadocs-mdx` | 0 | |
| `pnpm turbo tsc-check` | 0 | 21/21 tasks |
| `pnpm turbo lint` | 0 | 2/2 tasks |
| `pnpm turbo format-check` | 0 | 18/18 tasks |
| `node deploy/lint-migrations.ts` | 0 | `OK — 23 file(s) linted, 5 grandfathered` |
| `pnpm --filter @terragon/migrate test` | 0 | 5 files, 45 tests |
| `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` | 0 | 100 files, 1759 tests |
| `pnpm --filter @terragon/shared exec vitest run --coverage --no-file-parallelism src/model/agent-bus` | 0 | 105 tests; `messages.ts` 99.1 / 95.45 / 87.5 / 99.1 |
| `pnpm --filter @terragon/www exec vitest run --no-file-parallelism` | 0 | 337 files passed, 1 skipped; 4499 tests passed, 9 skipped |
| schema drift, postgres:18 (migrate ×2, drizzle-kit push, schema-drift.ts) | 0 / 0 / 0 / 0 | `applied 28 migration(s)`, then `applied 0`; `compared 1546 objects in a (a) with 1546 in b (b)`, `schema drift: none` |
