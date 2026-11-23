# Spec #759: prune consumed agent_messages without breaking idempotency (agent bus S2 follow-up)

The hardened ticket (GitHub be-automata/automata#759) is the spec and follows verbatim below the ground truth.
Owner decisions are in its "Decisions (owner, 2026-11-23)" section: R = 30 days, a replayed key after a resume past R counts as a new message, orphan pruning is in, and body blanking is out.

## Ground truth (verified 2026-11-23 against worktree `.claude/worktrees/759` at origin/main `d3efdab8`)

- **Delivered in parallel with #758** (dead-letter), branch `feat/758-agent-messages-dead-letter`, under this file-ownership map:
  - **#758 owns** `receiveFor`, `sweepUnconsumed`, the `agentMessages` columns in `schema.ts`, the migration, `messages.crash.test.ts` and the crash fixture.
  - **#759 owns** two NEW files: `packages/shared/src/model/agent-bus/retention.ts` (`pruneAgentMessages`, `AGENT_MESSAGE_RETENTION_MS`) and `retention.test.ts`. It also owns the hourly wiring in `apps/www/src/server-lib/cron.ts` and the matching case in `cron.test.ts`.
  - #759 touches `messages.ts` only in the JSDoc of `insertMessage` (`:54-58`) and `sendMessage` (`:102-107`). It touches `schema.ts` only in the `agentMessages` doc comment (`:3493-3499`). It adds no functions to `messages.ts`.
  - The second PR to merge rebases onto the first.
- **Dead-lettered rows (from #758)** stay `consumed_at IS NULL`. The prune deletes one **only through the orphan pass**, once its target thread is gone. That is safe: a retry to a gone target is refused as `not_found` (`capabilities.ts:182-186`) before any insert. #759 never references `dead_lettered_at`, so the two PRs can merge in either order.
- **Hourly prunes:** `apps/www/src/server-lib/cron.ts:88-121`, inside `runStalledTasksCron`. `pruneHatchetRuns` runs first, then `pruneEgressEvents`. Each is a dynamic import with its own try/catch, logs only when `pruned > 0`, and the stalled recovery follows (`:123`).
- **Hourly order test:** `apps/www/src/server-lib/cron.test.ts:163` ("hourly: review sweep, prunes and the stalled stop run before self-heal").
- **Bounded batch prune pattern:** `packages/shared/src/model/self-heal-outbox.ts:407-470` (`pruneSelfHealRows`, a subselect with `.limit(batch)` at `:433`). Retention constants are at `:50-51`.
- **Timeouts helper:** `packages/shared/src/model/self-heal-tx.ts:46-61`, `withSelfHealTx(db, fn, opts)`. It sets `SET LOCAL` statement, lock and idle timeouts in one `set_config` statement, with each value bounded to [1 s, 30 s]. Reuse it with `{ statementTimeoutMs: 10_000, lockTimeoutMs: 1_000 }` rather than writing a new helper (reuse ladder).
- **Thread helpers:** `packages/shared/src/model/thread-effective-status.ts`:
  - `threadLastWriteAt()` (`:37-41`) correlates on `thread.id`, so it must be used where `thread` is in scope (a join or `EXISTS` on `thread`).
  - `threadTimestampParam(at)` (`:50-52`) is required on the right-hand side because `thread.updated_at` is `timestamp without time zone`.
  - `threadIsTerminal()` (`:68-70`) is table-qualified and works inside subqueries.
- **Authorization:** `authorizeSend`, `packages/shared/src/model/agent-bus/capabilities.ts:181-199`, returns `sender_not_running` at `:188` and `target_not_running` at `:196`.
- **FK:** `agent_applied.msg_id → agent_messages.id`, `ON DELETE no action` (`deploy/migrations/2026-11-21-agent-messages.sql:17-26`).
- **Already done:** nothing for this ticket. S2 (#660) is merged.


## Validator amendments (these override the ticket text below where they differ)

- **F1, files.** The code goes in a NEW file `packages/shared/src/model/agent-bus/retention.ts` (`AGENT_MESSAGE_RETENTION_MS`, `pruneAgentMessages`), and the tests in `retention.test.ts`. The ticket body's "in messages.ts" and "messages.test.ts" are superseded. `messages.ts` and `schema.ts` get comment-only changes.
- **F2.** AC7 adds a case: an unconsumed row that was delivered and failed (a dead-letter-like row: unconsumed, target present) is KEPT. Once its target thread is deleted and `created_at` is older than R, it is pruned. #759 must not reference `dead_lettered_at`.
- **F3, two passes.** Each batch is one `withSelfHealTx(db, fn, { statementTimeoutMs: 10_000, lockTimeoutMs: 1_000 })`.
  - **(a) Consumed pass:** `consumed_at < cut`, plus the sender rule, `ORDER BY consumed_at, id LIMIT batch`. A keyset cursor `(consumed_at, id) > last-seen` carries between batches in the same call (W2), so rows that are kept are not scanned again.
  - **(b) Orphan pass:** `consumed_at IS NULL AND created_at < cut AND NOT EXISTS (select 1 from thread where thread.id = agent_messages.to_run)`, `ORDER BY id LIMIT batch`.
  - **Both passes** use `FOR UPDATE OF agent_messages SKIP LOCKED`, then `DELETE agent_applied WHERE msg_id = ANY(ids)`, then `DELETE agent_messages WHERE id = ANY(ids)`.
  - **`maxBatches` applies per pass,** so AC8's bound is `batch × maxBatches` per pass.
  - **There is also a wall-clock budget** (`budgetMs`, default 20_000): once it is spent, no new batch starts (W3). The function returns `{ messages, applied, orphans }`.
- **SQL shape (W5).** Never alias `thread`. Express the sender rule with `EXISTS` / `NOT EXISTS` subqueries on an unaliased `thread`, because `threadLastWriteAt()` and `threadIsTerminal()` correlate on `"thread"."id"`. The rule is: `NOT EXISTS (thread where id = from_run)`, OR `EXISTS (thread where id = from_run AND threadIsTerminal() AND threadLastWriteAt() < threadTimestampParam(cut))`. Take every cut from the `now` argument, never SQL `now()`. `consumed_at` and `created_at` are timestamptz, so plain `lt(col, cut)` works for them.
- **F4, cron tests.** `cron.test.ts` mocks every hourly dependency by module path (`:63-79`). Add `vi.mock("@terragon/shared/model/agent-bus/retention", …)` pushing `"prune-agent-messages"`, and insert that entry after `"prune-egress"` in all three full-order assertions (`:163`, `:179`, `:252`). AC10 gets a new test: a rejecting prune still yields `stop`, `self-heal:hourly` and `knowledge-purge`.
- **F5, premise.** The JSDoc on `insertMessage` and `sendMessage` states the following.
  - Callers MUST authorize the sender (`authorizeSend`) before `insertMessage`. The retention rule in `retention.ts` assumes a terminal or deleted sender can never insert.
  - Dedup holds for the sender's active life plus **at least** R after it last ended. Prune lag only makes the window longer.
  - The note on #663 repeats both points.
- **W6, AC testability.**
  - **AC9:** a "pooled session unchanged" check can't be pinned on a pool, so it is covered by citing `self-heal-tx.test.ts:24-35` (the existing `SET LOCAL` scope test) and by asserting `SHOW statement_timeout` after the call, outside the prune.
  - **AC1 ("one transaction"):** assert both rows are gone.
  - **AC11:** the target must stay alive with an `agent_run` row, otherwise the result is `not_found` rather than `sender_not_running`. AC11 pins the premise.
- **W7, test helpers.** Duplicate the backdate helpers inside `retention.test.ts`. Backdate `thread.updated_at` and every `thread_chat.updated_at` LAST, because any later drizzle update re-stamps them through `$onUpdate`.
- **Out of scope (W8):** pruning consumed rows whose target is gone but whose sender is live, and rows from senders that never become terminal.

---


Part of #651 (agent bus). It follows #660 (S2: exactly-once message delivery), merged in PR #689 on 2026-11-18. It should land before #663 (S5: the MCP tools), which is the first production writer.

## Context / why

S2 (#660, PR #689, merged 2026-11-18) added two tables. `agent_messages` holds one row per message between two agent runs, keyed for idempotency by the unique `(from_run, idem_key)`. `agent_applied` holds one row per delivered message and is the exactly-once record. Every message is consumed within seconds: by the receive inside the send request, or by the every-minute sweeper. After that the row stays forever. Nothing in the repo deletes from either table, so both grow by one row per message for as long as the product runs. Each row holds an agent-written body, and that text is already copied into the target chat's queued messages when it is delivered.

A plain age-based delete is not safe. The unique `(from_run, idem_key)` row is the only thing that makes a retried send idempotent. `insertMessage` does `INSERT … ON CONFLICT DO NOTHING` and then reads the existing row to return `duplicate: true`. If that row is deleted, a late retry with the same key inserts a new row and the target receives the message a second time. So retention must only delete a row once no send from that sender can still arrive with that key.

There is no production caller yet: `sendAgentMessage` is only called from tests, and #663 adds the tools. The table is close to empty today, so this is cheap to land now and much harder once it holds a backlog.

## Reality check (main @ d3efdab8a3f80afaf74c387defd4938179bf450f)

| What | Where | Status |
|---|---|---|
| `agent_messages` table: `consumed_at` column, unique `(from_run, idem_key)`, inbox partial index, `consumed_at` partial index | `packages/shared/src/db/schema.ts:3500-3525`; `deploy/migrations/2026-11-21-agent-messages.sql:7-15,28-30` | exists |
| `agent_applied` table, `msg_id` primary key, FK to `agent_messages.id` with **ON DELETE no action** | `schema.ts:3527-3535`; migration `:17-26` | exists, so `agent_applied` rows go first |
| No FK from `from_run`/`to_run` to `thread` or `agent_run` | `schema.ts:3500-3525` | when a thread is deleted (`packages/shared/src/model/threads.ts:1573`), its message rows stay |
| Reader 1, the idempotency check: insert on conflict, then select by `(from_run, idem_key)`; a conflict with no row throws | `packages/shared/src/model/agent-bus/messages.ts:75-99` (throw at `:95-97`) | needs consumed rows for as long as the sender can retry |
| The send authorizes **before** the insert, on every call (retries included) | `messages.ts:127-136`; `capabilities.ts:181-199` (`sender_not_running` at `:188`, `target_not_running` at `:196`) | a terminal sender writes nothing |
| A sender whose thread is gone is `not_found` (inner join to `thread`) | `agent-run.ts:50-75`; `messages.ts:131` | a deleted sender can never send again |
| "Terminal" can be undone: a resume clears `terminal_cause` and keeps the same thread id (= `from_run`) | `threads.ts:1146-1172` (`terminalCause: null` at `:1168`); `clearThreadTerminalForResume` `threads.ts:1627-1645`, called from `apps/www/src/agent/msg/startAgentMessage.ts` and `apps/www/src/agent/hatchet/dispatch.ts:1368` | "sender terminal" alone is **not** a safe bound |
| Terminal and last-write SQL helpers | `packages/shared/src/model/thread-effective-status.ts:37-41` (`threadLastWriteAt`), `:50-52` (`threadTimestampParam`; `thread.updated_at` has no time zone), `:68-70` (`threadIsTerminal`) | exists, reuse |
| Reader 2, `receiveFor`: unconsumed rows only (`FOR UPDATE SKIP LOCKED`); writes `agent_applied` with `ON CONFLICT DO NOTHING` | `messages.ts:173-226` | never reads consumed rows |
| Reader 3, `sweepUnconsumed`: unconsumed rows older than 10 s, inner join to the target thread (a missing target is "inert") | `messages.ts:257-297` (join at `:270-274`) | unconsumed rows whose target is gone are never consumed or deleted |
| Reader 4, `recentlyDeliveredTargets`: consumed rows within **120 s** | `messages.ts:229-251` | needs consumed rows for 120 s only |
| `agent_applied` read back in production | grep across `apps/` and `packages/` | **none** (tests only) |
| The bus sweep runs in the every-minute cron's `finally` | `apps/www/src/server-lib/cron.ts:274-280`, `:557-566`; `apps/www/src/server-lib/agent-bus/delivery.ts:127-141` | exists |
| Production writer `sendAgentMessage` | `delivery.ts:111-119`; callers: `delivery.test.ts` only | not called from production yet (#663) |
| Hourly prunes, fail-soft, before stalled recovery | `cron.ts:88-121` (`pruneHatchetRuns`, `pruneEgressEvents`), dispatched from `cron.ts:405-428` (`"0 * * * *"`, `apps/www/wrangler.jsonc:32`) | pattern to follow |
| Unbounded single-statement prunes | `packages/shared/src/model/hatchet-run.ts:125-142`; `packages/shared/src/model/egress-events.ts:123-140` | do **not** copy (no batch limit) |
| Bounded batch prune (`DELETE … WHERE id IN (SELECT … LIMIT batch)`), 30/90-day constants | `packages/shared/src/model/self-heal-outbox.ts:50-51`, `:402-470` | pattern to copy |
| Transaction-scoped `statement_timeout` / `lock_timeout` set with `SET LOCAL` | `packages/shared/src/model/self-heal-tx.ts:18-22`, `:46-61` | pattern to copy |
| A default `statement_timeout` on the www pool | `packages/shared/src/db/index.ts:24,48` (only `connectionTimeoutMillis`) | **none**, so the prune must set its own |
| An agent-bus retention function or constant | grep `prune`, `retention` in `packages/shared/src/model/agent-bus/` | **none** |

## Proposed design (recommended)

**Retention rule.** A message row `m`, and its `agent_applied` row, may be deleted when all of the following hold:

1. `m.consumed_at IS NOT NULL AND m.consumed_at < now() - R`, **and**
2. the sender can no longer send in a way that counts as a retry:
   - its thread is gone (`thread.id = m.from_run` matches nothing), **or**
   - its thread is terminal (`threadIsTerminal()`) **and** its last write is older than R (`threadLastWriteAt() < threadTimestampParam(now - R)`).

Also, unconsumed rows whose target thread is gone (the sweeper already treats them as inert, `messages.ts:270`) are deleted once `created_at < now() - R`.

R defaults to **30 days** (`AGENT_MESSAGE_RETENTION_MS`, matching `EFFECT_RETENTION_MS` and `EGRESS_EVENTS_PRUNE_AFTER_MS`). This is OD-1.

**Why this keeps idempotency.**

- A live sender's keys are never deleted, whatever their age. A long-lived parent that keeps being resumed, for example a weekly automation that uses deterministic keys, refreshes its last write every time it runs, so its keys stay.
- A deleted sender cannot send (`agent-run.ts:63-73`, then `not_found`), so its keys are dead.
- A terminal sender cannot write: the check runs before the insert (`messages.ts:132-133`). Its daemon token is also revoked at terminal (#651 G3). So while it stays terminal, a retry is refused and writes nothing, with or without the row.
- The only remaining case is a sender that was terminal and idle for more than R, is then resumed, and replays the same key. The contract becomes: **a key is deduplicated for the sender's whole active life plus R after it last ended.** After a resume past that point, the same key is a new message. It can only land if the target is also running, because `authorizeSend` refuses a terminal target (`capabilities.ts:196`).
- The rule never touches an unconsumed row whose target exists, so `receiveFor` and `sweepUnconsumed` are unaffected. R is far longer than 120 s, so `recentlyDeliveredTargets` is unaffected.

**Rejected alternatives.**

- (a) Age-only delete: a live sender reusing a key after R would deliver twice.
- (b) Only when the sender is terminal: a resume makes the sender live again with all its keys gone.
- (c) A permanent key-only tombstone: blank the body and add a `body_sha256` column for the conflict check. It needs a migration and still grows by one row per message forever. It is still available as OD-2 if the owner wants dedup that never expires.

**Batched delete.** Add `pruneAgentMessages({ db, now, batch = 500, maxBatches = 10 })` in `packages/shared/src/model/agent-bus/messages.ts`. Each batch is one transaction with `SET LOCAL statement_timeout = '10s'`, `lock_timeout = '1s'` and `idle_in_transaction_session_timeout = '5s'`, set the same way `withSelfHealTx` does it, or through a shared helper. Each transaction:

1. selects up to `batch` ids that meet the rule, ordered by `consumed_at`, `FOR UPDATE OF agent_messages SKIP LOCKED`;
2. runs `DELETE FROM agent_applied WHERE msg_id = ANY(ids)`;
3. runs `DELETE FROM agent_messages WHERE id = ANY(ids)`.

Use two statements, not a data-modifying CTE, so the NO ACTION FK check runs against a state that is clearly committed. The function stops when a batch deletes fewer than `batch` rows or after `maxBatches` batches. It returns `{ messages, applied, orphans }`. It is not fenced by organization (maintenance across all orgs, like `pruneHatchetRuns`), and it logs counts only, never bodies or keys.

**Where it runs.** In the hourly `runStalledTasksCron`, right after the `egress_event` prune (`cron.ts:104-121`), with the same import inside the function, the same try/catch and a log line only when rows were deleted. Not in the every-minute bus sweep: that tick must stay lean, and an hourly cadence is enough for a 30-day horizon.

**Index support (no migration).** The `agent_messages_consumed_at_index` predicate, `(consumed_at) WHERE consumed_at IS NOT NULL`, is implied by condition 1, so the planner can range-scan it in `consumed_at` order for `ORDER BY … LIMIT`. The sender check joins `thread` on its primary key. Deleting `agent_applied` rows by `msg_id`, and the FK check, use the `agent_applied` primary key. The orphan scan reads unconsumed rows only, which the sweeper keeps near zero, through the `agent_messages_inbox` partial index.

## Scope

- `pruneAgentMessages` and the `AGENT_MESSAGE_RETENTION_MS` constant in `packages/shared/src/model/agent-bus/messages.ts`.
- The hourly cron wiring in `apps/www/src/server-lib/cron.ts`.
- A JSDoc note on `insertMessage` / `sendMessage` and on the `agentMessages` schema comment that states the idempotency window.
- Tests (below).

## Out of scope

- Blanking the body at consume time (OD-4, separate data-minimisation issue).
- The tombstone / body-hash variant (OD-2), and any schema or migration change.
- Retention for `agent_run` (it cascades when the thread is deleted) and for S4 artifacts (#662).
- Changing the 120 s re-kick window or the 10 s sweep threshold.

## Steps

1. Add `AGENT_MESSAGE_RETENTION_MS = 30 * 86_400_000` and `pruneAgentMessages` as designed. Reuse `threadIsTerminal()`, `threadLastWriteAt()` and `threadTimestampParam()`.
2. Document the idempotency window on `insertMessage` (`messages.ts:54-58`), on `sendMessage` (`:102-107`) and on the `agentMessages` schema comment (`schema.ts:3493-3499`).
3. Wire it into `runStalledTasksCron` after the `egress_event` prune, fail-soft.
4. Add the tests below and run the gates.

## Acceptance criteria

1. A consumed row older than R, whose sender thread is terminal and last written more than R ago, is deleted together with its `agent_applied` row in one transaction.
2. A consumed row older than R whose sender is **not** terminal is kept.
3. A consumed row older than R whose sender is terminal but was last written within R is kept. This covers a sender resumed recently and terminal again.
4. A consumed row younger than R is kept, whatever the sender's state.
5. An unconsumed row whose target thread exists is never deleted, at any age.
6. A consumed row older than R whose sender thread no longer exists is deleted.
7. An unconsumed row whose target thread no longer exists and whose `created_at` is older than R is deleted, and its `agent_applied` row if one exists (OD-3).
8. One call deletes at most `batch × maxBatches` rows. Each batch commits on its own, and a second call continues where the first stopped.
9. Each prune transaction sets `statement_timeout` and `lock_timeout` with `SET LOCAL`, and the pooled session is unchanged afterwards.
10. A prune failure is logged and does not skip stalled-thread recovery, the self-heal hourly run or the purge sweep.
11. After a prune, a retry of a pruned key from the still-terminal sender returns `sender_not_running` and writes no row. This pins the idempotency argument.
12. `recentlyDeliveredTargets` still returns a target whose message was consumed 60 s ago, right after a prune.

## Tests

- Postgres-backed vitest in `packages/shared/src/model/agent-bus/messages.test.ts` (throwaway database). Cover AC 1-9, 11 and 12 by backdating `consumed_at`, `created_at` and `thread.updated_at` (and the thread-chat rows) with direct updates, the way the file already does at `:78-87`.
- A fake-clock `now` argument instead of real waiting.
- `apps/www/src/server-lib/cron.test.ts`: the hourly order includes the new prune after `prune-egress` (extend the test at `:163`), and a throwing prune does not stop the stalled stop (AC 10).
- Gates: `pnpm turbo tsc-check`, `lint`, `format-check`, shared and www vitest.

## Risks / rollback

- **Deletes cannot be undone.** The loss is limited: the body has already been copied into the target chat's queue and history by `queuedFollowUpApply` (`messages.ts:307-344`), and `agent_applied` is never read in production. Rollback means reverting the code; deleted rows stay deleted.
- **Race with a concurrent retry.** If a retry hits a row being deleted, `insertMessage` throws `conflict without a row` (`messages.ts:95-97`). Under this rule only a sender that is terminal and idle for more than R can race, and its send is refused before the insert. A resume that lands mid-prune is the one remaining edge case and would at worst deliver once more.
- **The idempotency contract becomes time-bounded** (active life plus R). It is documented in code and in the #663 tool description.
- **Cost.** The thread subqueries run per candidate row, bounded by `batch`. If prod shows a slow plan, lower `batch`.

## Definition of done

AC 1-12 met with test evidence. Gates green. The idempotency window is documented on `sendMessage` and `insertMessage`, and a note is posted on #663 so the tool description can state it. OD-1 to OD-3 are recorded on this issue.

## References

- #660 (S2 spec) and PR #689.
- #651 (decision record: G3 identity / daemon token, G6 reconciler).
- #661 (S3), #663 (S5, the first production writer).
- `packages/shared/src/model/agent-bus/messages.ts`, `packages/shared/src/model/agent-bus/capabilities.ts`, `packages/shared/src/model/agent-bus/agent-run.ts`.
- `packages/shared/src/model/self-heal-outbox.ts:402-470` (pattern), `packages/shared/src/model/self-heal-tx.ts:46-61` (timeouts).
- `apps/www/src/server-lib/cron.ts:88-121`.

## Decisions (owner, 2026-11-23)

- **OD-1:** R = **30 days** (`AGENT_MESSAGE_RETENTION_MS`).
- **OD-2:** if a sender is resumed after more than R idle and replays a key, that key counts as a new message. No tombstone, no migration.
- **OD-3:** yes. Unconsumed rows whose target thread is gone are pruned after R.
- **OD-4:** blanking the body at consume time stays out of scope.

