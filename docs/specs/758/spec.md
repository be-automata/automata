# Spec #758: dead-letter poison messages (agent bus S2 follow-up)

The hardened ticket (GitHub be-automata/automata#758) is the spec and follows verbatim below the ground truth.
Owner decisions are in its "Decisions (owner, 2026-11-23)" section.

## Ground truth (verified 2026-11-23 against worktree `.claude/worktrees/758` at origin/main `d3efdab8`)

- `receiveFor`: `packages/shared/src/model/agent-bus/messages.ts:173-226`. It loops one `db.transaction` per message: `FOR NO KEY UPDATE` on the thread, then a claim of `to_run = $1 AND consumed_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED` (`:194-203`). Inside the same transaction: insert into `agent_applied` with on-conflict-do-nothing, then `apply` only if that row is new, then set `consumed_at` (`:207-218`). A throw in `apply` aborts the whole transaction and propagates out of the loop. The return type is `{ applied: number }`.
- `sweepUnconsumed`: `messages.ts:257-298`. It inner-joins `thread`, filters on `consumed_at IS NULL AND created_at < now() - olderThanMs`, groups by `to_run` ordered by `min(created_at)` with limit 100, and calls `receiveFor` sequentially. On failure it logs `` logger.error(`agent-bus sweep: delivery to ${toRun} failed`, error) `` (the raw error). It returns `{ targets, applied }`.
- `BusLogger` (`messages.ts:46-52`) is `{ error(message: string, error: unknown) }`. Structured fields go in its second argument.
- No `attempts`, `last_error` or `dead_lettered_at` column exists on `agent_messages` (`packages/shared/src/db/schema.ts:3500-3524`).
- Savepoints: drizzle-orm 0.45.2. A nested `tx.transaction(cb)` issues `savepoint spN`, rolls back to it on throw, and releases it on success: node-postgres `NodePgTransaction.transaction` (`node_modules/.pnpm/drizzle-orm@0.45.2/node_modules/drizzle-orm/node-postgres/session.js:204-221`) and neon-serverless `NeonTransaction.transaction` (`.../neon-serverless/session.js:197-210`). Postgres accepts `ROLLBACK TO SAVEPOINT` in an aborted transaction state. Precedent: a savepoint nested inside a transaction already runs in production. `apps/www/src/server-lib/audit/audit-ledger.ts:125-128` passes a `tx` as a DB into helpers whose `withSelfHealTx` (`packages/shared/src/model/self-heal-tx.ts:55`) nests as a savepoint.
- DB drivers: node-postgres (tests, box), or neon-serverless (a Workers fallback selected by URL shape), per `packages/shared/src/db/index.ts:1-60`. Both are interactive-transaction drivers.
- Migrations: the newest file on main is `deploy/migrations/2026-11-25-cell-session-checkpoint.sql`. The last entry in `packages/migrate/src/expected-migrations.ts` is `"2026-11-25-cell-session-checkpoint"`. **The new file is `2026-11-26-agent-messages-dead-letter.sql`.**
- Crash fixture: `packages/shared/src/model/agent-bus/__fixtures__/messages-crash-child.ts`. It is driven by the env vars `KILL_POINT=after-apply`, `KILL_AT_APPLY=N` and `UNSAFE=1` (lines 19-49), and SIGKILLs itself at line 32.
- Callers of `receiveFor` and `sweepUnconsumed`: `sendMessage` (`messages.ts:108-161`), `runAgentBusSweep` (`apps/www/src/server-lib/agent-bus/delivery.ts:127-142`) and the tests. `sendAgentMessage` still has no production caller.
- Already done: nothing for this ticket. S2 (#660) is merged.


## Validator fix cycle 1: amendments (these override the ticket text below where they differ)

- **F1, AC 9 amended.** The return shape of `receiveFor` becomes `{ applied, deadLettered }`, so the existing strict assertions in `messages.test.ts` may change from `toEqual({ applied: N })` to `toEqual({ applied: N, deadLettered: 0 })`: at `:439-445`, `:509-511` and `:520-522`. Nothing else in the #660 tests changes, apart from the extra `attempts = 1` assertion on the `:488` test.
- **F2, body redaction (option a).** Build `last_error` in this order:
  1. Take `"<error.name>: <error.message>"`.
  2. Replace every occurrence of `message.body` (when the body is not empty) with `[body]`.
  3. Truncate to 500 UTF-16 units.
  4. Run `sanitizeForJson`. Truncating first means a cut never leaves a lone surrogate in the stored text.

  AC 8 adds a test: an apply that throws an error whose message echoes the body stores `[body]`, never the body.
- **F3, test seam.** `receiveFor` gains an optional `onAttemptRecorded?: (info: { messageId: number; attempts: number; deadLettered: boolean }) => void | Promise<void>`. It is called inside the outer transaction, after the attempts UPDATE and before COMMIT. It is an internal test hook, documented as not part of the bus contract, and production callers never pass it. The crash fixture uses it for `KILL_POINT=after-apply-failure`: an apply that always throws, then a SIGKILL from inside the hook. That covers AC 7.
- **F4, logger.** `receiveFor` gains `logger?: BusLogger` (default `DEFAULT_LOGGER`). `sendMessage` (`messages.ts:143`) and `sweepUnconsumed` (`:288`) pass theirs through. The dead-letter log is the single `logger.error("agent-bus: message dead-lettered", { messageId, fromRun, toRun, attempts, errorName })`. A dead-lettered message does not rethrow, so `sendMessage` and the sweep never log it a second time, and the existing `toHaveBeenCalledTimes(1)` assertions still hold.
- **The attempt UPDATE is one statement:** `SET attempts = attempts + 1, last_error = $e, dead_lettered_at = CASE WHEN attempts + 1 >= MAX THEN now() END ... RETURNING attempts, dead_lettered_at`. It uses `>=`, so it stays correct if someone edits the counter by hand.
- **Missing target thread.** With no thread there is no row lock, so two receivers can count attempts on different messages in parallel. AC 4's FIFO claim covers existing targets only.
- **Inbox index.** Dead-lettered rows stay in the partial `agent_messages_inbox` index, so the claim walks past them first. This is accepted, and their retention is out of scope (#759 never deletes them).
- **Validator warnings adopted (cycle 2).**
  - **The seam's name says it is test-only:** `__testOnAttemptRecorded`. No production caller passes it, and `grep -rn __testOnAttemptRecorded apps packages` shows only the fixture and tests.
  - **The new crash drill has its own sentinel,** `killing at after-apply-failure`, and its test asserts that full string. The existing `expectKilled()` match on `after-apply` would also pass on the new sentinel, so it is not enough.
  - **Redaction is an exact substring match.** A very short body redacts aggressively, and a body echoed only in part is not redacted. Both are accepted and stated in the PR.
- **Migration header:** cites `#758`, not a placeholder. File: `deploy/migrations/2026-11-26-agent-messages-dead-letter.sql`.
- **AC 5 test isolation:** the sweep is global across the shared test database. Backdate the poison and healthy rows by minutes and order them explicitly, so leftover rows from other tests can't take the `limit: 2` slots.
- **As shipped (owner-accepted deviations from F2 and the review fixes).** These override F2 and the `last_error`
  row of the design table below:
  - **Redaction marker is `<redacted>`, not `[body]`.** `last_error` goes through the shared
    `createValueRedactor([body], 1)` (`packages/utils/src/redact.ts`), which also blanks the JSON-escaped body
    and any secret pattern. AC 8's test asserts `<redacted>`.
  - **`last_error` is `"<name>[ <code>]: <message>"` of the recorded error.** When drizzle wraps a driver error
    (`"Failed query: <sql>\nparams: <params>"`), the wrapped `cause` is recorded instead, with its SQLSTATE or
    system `code`.
  - **A body too large to redact** (V8 refuses the redactor's RegExp at about 32K characters) stores
    `"<name>: <unrecordable>"`, so the attempt is still counted and the message is never stored unredacted.
  - **`errorName`, in logs and `last_error`, is class-like only** (`/^[A-Za-z_$][\w$.]{0,63}$/`); any other
    name is replaced by the value's type.

---


Parent: #651 (agent bus epic) · Follows: #660 (S2, merged in PR #689 on 2026-11-18) · Should land before: #663 (S5, MCP tools)

## Context / why

PR #689 (merged 2026-11-18T01:23Z, closing #660) shipped exactly-once message delivery between agent runs:
`insertMessage` commits a row in `agent_messages`; `receiveFor` then claims each unconsumed message for a
target in its own transaction, records it in `agent_applied`, runs the caller's `apply`, and sets
`consumed_at`. A cron sweeper (`sweepUnconsumed`, every-minute tick) re-runs `receiveFor` for targets whose
messages were never received.

The spec (`docs/specs/660/spec.md`, A3 and A6) and the PR's "Known gaps" both name a hole that was left out of
S2 on purpose: **poison messages**.

- When `apply` throws, the message's transaction rolls back, `receiveFor` rethrows, and the row stays
  unconsumed. Because `receiveFor` always claims the **oldest** unconsumed message of the target, the same
  failing message is claimed again on every later call. **Every later message to that target is blocked forever.**
- The sweeper picks targets ordered by the age of their oldest unconsumed message, with `limit = 100`. A poison
  target's message is always the oldest, so poison targets stay at the head of the list every minute, forever.
  **With 100 or more poison targets, healthy targets are never swept.** Each poison target also costs one failing
  transaction and one error log per minute, with no end.

Nothing sends messages in production yet (`sendAgentMessage` has no caller at d3efdab8; S5 #663 adds the MCP
tool, and S3 #661 adds child runs). This must land **before** a real caller exists. A later apply function
(S3/S4) or an oversized body (body size limits are S5's job) would turn the gap into a live outage for that
target.

## Reality check (pinned at `d3efdab8`, origin/main)

| What | Where | Status |
|---|---|---|
| `receiveFor` locks the target thread `FOR NO KEY UPDATE`, then claims `to_run = $1 AND consumed_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED` | `packages/shared/src/model/agent-bus/messages.ts:187-203` | exists |
| On claim: insert `agent_applied` (ON CONFLICT DO NOTHING), `apply` if it was new, set `consumed_at`. One transaction per message | `messages.ts:207-218` | exists |
| A throw in `apply` rolls back the whole transaction and leaves the loop; no attempt is recorded | `messages.ts:185-225` (doc comment `:164-172`) | exists: this is the gap |
| `sendMessage` catches the delivery error, logs `messageId`/`toRun`/`errorName`, returns ok | `messages.ts:141-160` | exists |
| `sweepUnconsumed`: `olderThanMs = 10_000`, `limit = 100`, inner join `thread`, `GROUP BY to_run ORDER BY min(created_at) ASC LIMIT 100`, sequential `receiveFor` per target, per-target try/catch logs the raw error | `messages.ts:257-297` | exists; no attempt cap, so poison is retried forever |
| `queuedFollowUpApply` throws only when neither a `thread_chat` nor the `thread` row exists | `messages.ts:307-344` (throw at `:341-343`) | exists. The missing thread is permanent. The sweep already ignores such rows (inner join, `:270-274`), so today only the in-request receive of `sendMessage` reaches it |
| `runAgentBusSweep` calls `sweepUnconsumed({ db, apply: queuedFollowUpApply })`, then kicks targets | `apps/www/src/server-lib/agent-bus/delivery.ts:127-142` | exists |
| Sweep runs in `runScheduledTasksCron`'s `finally`, after the knowledge reconcile sweep, fail-soft | `apps/www/src/server-lib/cron.ts:277-279`, `:557-566` | exists |
| `agent_messages` columns: `id, idem_key, from_run, to_run, body, created_at, consumed_at` | `packages/shared/src/db/schema.ts:3500-3524`; `deploy/migrations/2026-11-21-agent-messages.sql:7-15` | exists. **No `attempts`, `last_error` or `dead_lettered_at`** |
| Partial index `agent_messages_inbox (to_run, id) WHERE consumed_at IS NULL` | `schema.ts:3516-3518`; migration `:29` | exists. It still serves the claim if dead-lettered rows keep `consumed_at` NULL |
| `agent_applied (msg_id PK → agent_messages.id, run, applied_at)` | `schema.ts:3527-3535` | exists |
| Existing test: "an apply that throws rolls back … and rethrows" | `packages/shared/src/model/agent-bus/messages.test.ts:488` | exists; its contract changes (see AC 2) |
| Existing test: "logs one target's failure and still delivers the others" | `messages.test.ts:626` | exists |
| Real-DB crash drill (child process SIGKILLs itself after the Nth apply) | `messages.crash.test.ts`, `__fixtures__/messages-crash-child.ts` | exists; extend it |
| Precedent: `audit_effects.attempts` / `last_error` / status `failed`; `markEffectRetry` bumps attempts under `FOR UPDATE`, terminal at `OUTBOX_MAX_ATTEMPTS = 5` | `schema.ts:2533-2541`; `packages/shared/src/model/self-heal-outbox.ts:42-48, 318-373` | exists: reuse the shape |
| Precedent: `knowledge_intent.attempts` / `last_error_code`, `KNOWLEDGE_INTENT_MAX_ATTEMPTS = 8` → state `failed` | `packages/shared/src/model/knowledge-intent.ts:28, 242-300` | exists |
| A dead-letter table, `poison` handling, or a savepoint inside a `receiveFor`-style claim | repo-wide grep (`dead_letter`, `poison`, `savepoint`) in `packages/shared/src`, `packages/worker/src`, `deploy/migrations` | **does not exist** |

## Proposed design (recommended)

**Three columns on `agent_messages`. No new table and no new index.**

| column | type | meaning |
|---|---|---|
| `attempts` | `integer NOT NULL DEFAULT 0` | failed apply attempts |
| `last_error` | `text` | `"<error.name>: <message truncated to 500 chars>"`. **Never the body** |
| `dead_lettered_at` | `timestamptz` | set when `attempts` reaches the cap; the row is then out of delivery |

`consumed_at` keeps its meaning (applied and consumed). A dead-lettered row has `consumed_at IS NULL AND
dead_lettered_at IS NOT NULL`.

**Recording a failure atomically (savepoint).** Inside the existing per-message transaction, after the claim,
run the `agent_applied` insert and `apply` inside a nested `tx.transaction(...)`. Drizzle issues a `SAVEPOINT`
for this on node-postgres and on neon-serverless; prove it in a test. If `apply` throws:

1. Roll back to the savepoint. This removes the `agent_applied` row and any partial effect.
2. Still holding the row lock, set `attempts = attempts + 1, last_error = …`. When the new count reaches
   `AGENT_MESSAGE_MAX_ATTEMPTS` (proposed **5**, exported constant), also set `dead_lettered_at = now()`.
3. Commit the outer transaction, so the counter survives.

A crash (SIGKILL or a lost connection) before that commit counts no attempt, and the message is retried as
today. That is deliberate: we under-count, never over-count, and never apply twice.

**Ordering, stated.** Delivery stays **strict FIFO per target**:
- Below the cap, a failing message still blocks later messages to the same target. `receiveFor` commits the
  attempt, then rethrows (the A3 contract is unchanged).
- When a message is dead-lettered, `receiveFor` does **not** rethrow. It logs and moves on to the next message
  of that target, so the target is unblocked.
- Messages are never reordered. Worst-case blocking is about `AGENT_MESSAGE_MAX_ATTEMPTS` sweep ticks (≈5 min)
  plus any in-request receives in between.

**Claim and sweep skip dead-lettered rows.** Add `AND dead_lettered_at IS NULL` to the `receiveFor` claim
(`messages.ts:199`) and to the sweep's `WHERE` (`messages.ts:275-280`). Poison targets then leave the sweep's
top 100 after at most N ticks, which bounds the starvation.

**Return shape.** `receiveFor` returns `{ applied, deadLettered }`. `sweepUnconsumed` sums `deadLettered`.

**Observability.** One `logger.error("agent-bus: message dead-lettered", { messageId, fromRun, toRun, attempts,
errorName })` when a row is dead-lettered. Never log `body` or `last_error` (PII rule). The sweep's per-target
log keeps `errorName` instead of the raw error object, as `sendMessage` already does. To count dead-lettered
messages:
`SELECT count(*) FROM agent_messages WHERE dead_lettered_at IS NOT NULL`.

**Manual replay (documented, not built).** An operator re-queues a message with
`UPDATE agent_messages SET dead_lettered_at = NULL, attempts = 0, last_error = NULL WHERE id = $1;`.
The next receive or sweep delivers it, and `agent_applied` still guarantees it is applied at most once.

**Migration.** New file `deploy/migrations/<YYYY-MM-DD>-agent-messages-dead-letter.sql`. It must sort after
the newest existing file (at d3efdab8 that is `2026-11-25-cell-session-checkpoint`, so
`2026-11-26-agent-messages-dead-letter` or later; re-check main when implementing):

```sql
-- migrate:expand
-- #758: poison-message dead-letter for the agent bus (follow-up of #660 / PR #689).
-- Additive and idempotent. ADD COLUMN ... NOT NULL DEFAULT 0 is metadata-only on PG 11+.
-- Apply BEFORE deploying the revision that reads these columns (migrate.yml does it on green main CI).
-- Names and types match packages/shared/src/db/schema.ts (schema-drift CI).
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "dead_lettered_at" timestamp with time zone;
```

The migration adds no index, so lint rules L3 and L4 do not apply. If an index is ever needed, it goes in its
own `-- migrate:no-transaction` file with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. Add the id to
`EXPECTED_MIGRATION_IDS` in `packages/migrate/src/expected-migrations.ts` (`files.test.ts:108` asserts the
exact list).

## Scope

- `packages/shared/src/db/schema.ts`: three columns on `agentMessages`.
- `deploy/migrations/<date>-agent-messages-dead-letter.sql` and `packages/migrate/src/expected-migrations.ts`.
- `packages/shared/src/model/agent-bus/messages.ts`: savepoint and failure recording in `receiveFor`; skip
  dead-lettered rows in the claim and in `sweepUnconsumed`; `AGENT_MESSAGE_MAX_ATTEMPTS`; `deadLettered` in the
  return values; dead-letter log; no raw error in the sweep log; doc comments updated (A3).
- Tests in `messages.test.ts`, `messages.crash.test.ts` and its fixture.
- `docs/specs/660/spec.md`: amend A3 and Out-of-scope to point at this issue.

## Out of scope

- A UI or MCP surface for dead-lettered messages, and telling the sender (S5 #663 can read `dead_lettered_at`).
- Automatic replay or a replay API (the manual SQL above is enough for now).
- Backoff between attempts (`next_attempt_at`). Revisit if transient database errors dead-letter healthy
  messages in practice.
- Retention or pruning of consumed and dead-lettered rows (separate PR #689 follow-up).
- Body size limits (S5).
- Rows whose target thread was deleted. They are already ignored by the sweep and stay so.

## Steps

1. Add the three columns to `agentMessages` in `schema.ts`, with a comment explaining the dead-letter semantics.
2. Write the migration (above) and add its id to `EXPECTED_MIGRATION_IDS`. Run `node deploy/lint-migrations.ts`.
3. In `receiveFor`: add `isNull(agentMessages.deadLetteredAt)` to the claim. Wrap the `agent_applied` insert and
   `apply` in `tx.transaction(...)`. On throw, run the attempt update in the outer transaction and return a
   `failed` or `dead_lettered` outcome together with the error. After commit, rethrow on `failed`; log and
   continue on `dead_lettered`. Count `deadLettered`.
4. In `sweepUnconsumed`: add `isNull(agentMessages.deadLetteredAt)` to the `WHERE`. Log `errorName` only. Sum
   `deadLettered`.
5. Export `AGENT_MESSAGE_MAX_ATTEMPTS = 5`. Truncate `last_error` to 500 chars after `sanitizeForJson`, so NUL
   bytes never reach the text column.
6. Update the doc comments on `receiveFor`, `sweepUnconsumed` and the module header, and amend spec A3.
7. Write the tests below and run the verification commands.

## Acceptance criteria

1. Migration: the new file passes `node deploy/lint-migrations.ts` and `pnpm --filter @terragon/migrate test`,
   and the schema-drift CI job is green with no new `drift-allowlist.json` entry.
2. An `apply` that throws once leaves the message unconsumed with `attempts = 1`, `last_error` set,
   `dead_lettered_at` NULL and no `agent_applied` row, and `receiveFor` still rejects with the original error.
   A later receive with a good `apply` delivers it exactly once.
3. After `AGENT_MESSAGE_MAX_ATTEMPTS` failing receives, the message has `dead_lettered_at` set and
   `consumed_at` NULL, and is never passed to `apply` again by `receiveFor` or `sweepUnconsumed`.
4. Target T holds messages m1 (poison) and m2 (healthy). On the receive that dead-letters m1, the same
   `receiveFor` call goes on to apply m2 and resolves with `{ applied: 1, deadLettered: 1 }`, without rejecting.
   m2 is never applied before m1 is dead-lettered (FIFO holds).
5. Sweep starvation: with `limit: 2`, two poison targets older than one healthy target, the healthy target is
   delivered within `AGENT_MESSAGE_MAX_ATTEMPTS + 1` sweep passes, and the poison targets are no longer selected
   after they are dead-lettered.
6. A target whose only unconsumed rows are dead-lettered is not returned by the sweep's target query.
7. Exactly-once survives a crash: a SIGKILL after `apply` and before the outer COMMIT leaves `attempts`
   unchanged and no `agent_applied` row. Redelivery applies the message once (one queued follow-up).
8. A dead-letter emits exactly one log call with `messageId`, `fromRun`, `toRun`, `attempts`, `errorName`. No
   log call contains the message body. `last_error` is at most 500 chars and never contains the body.
9. Existing #660 tests still pass. The `messages.test.ts:488` test is updated only to also assert `attempts = 1`.

## Tests

- `messages.test.ts` (real Postgres via the shared harness): AC 2, 3, 4, 5, 6 and 8, each its own `it`.
  AC 4 uses an `apply` that throws only for m1's id. AC 5 uses `backdateCreated` and `limit: 2`.
- Savepoint proof: inside the failing path, the `agent_applied` row inserted before the throw is gone after the
  receive, and the `attempts` update committed. Test this on node-postgres; note in the PR whether
  neon-serverless was exercised.
- `messages.crash.test.ts` and the fixture: add a `KILL_POINT=after-apply-failure` mode (an apply that throws,
  then SIGKILL before COMMIT) for AC 7, and assert that the existing crash drills are unchanged.
- `packages/migrate`: `files.test.ts` and `runner.test.ts` pick the new id up from `EXPECTED_MIGRATION_IDS`.

## Verification commands

`pnpm turbo tsc-check` · `pnpm turbo lint` · `pnpm turbo format-check` ·
`pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` ·
`pnpm --filter @terragon/www exec vitest run --no-file-parallelism` ·
`pnpm --filter @terragon/shared exec vitest run --coverage --no-file-parallelism src/model/agent-bus` ·
`node deploy/lint-migrations.ts` · `pnpm --filter @terragon/migrate test` · the `schema-drift` CI job.

## Risks / rollback

- **Transient errors dead-letter a good message.** Statement timeouts or connection blips count as attempts, and
  every `sendMessage` to the target adds one. Mitigations: a cap of 5, manual replay SQL, and the dead-letter
  log for alerting. If this shows up in practice, add backoff (out of scope).
- **The savepoint changes the transaction shape.** If the database errors out of the savepoint itself (for
  example a lost connection), the outer transaction aborts and no attempt is recorded. This is the same as
  today's behaviour.
- **Deploy order.** The columns must exist before the revision that reads them. `migrate.yml` applies expand
  files on green main CI, and `deploy/assert-schema-ready.ts` fails closed otherwise.
- **Rollback.** Revert the code. The columns are additive and inert to the old code: the old claim ignores them
  and still delivers dead-lettered rows, which is acceptable. Dropping the columns needs a `migrate:contract`
  file and is not part of the rollback.

## Definition of done

- AC 1-9 pass. CI is green, including schema-drift and migrate tests.
- The migration has been applied to prod by `migrate.yml` before the www deploy.
- Spec `docs/specs/660/spec.md` A3 and Out-of-scope point here.
- The PR description states the ordering semantics and the manual replay SQL.
- #651's checklist links this issue under S2.

## References

- Epic #651 · S2 #660 · PR #689 (merged 2026-11-18, merge commit `2e0a95a2`), "Known gaps and follow-ups" ·
  S3 #661 · S5 #663
- `docs/specs/660/spec.md` (A3, A6, Out of scope) at `d3efdab8`
- Code at `d3efdab8`: `packages/shared/src/model/agent-bus/messages.ts`,
  `apps/www/src/server-lib/agent-bus/delivery.ts`, `apps/www/src/server-lib/cron.ts`,
  `packages/shared/src/db/schema.ts`, `deploy/migrations/2026-11-21-agent-messages.sql`
- Precedents: `packages/shared/src/model/self-heal-outbox.ts` (`markEffectRetry`),
  `packages/shared/src/model/knowledge-intent.ts` (`requeueExpiredKnowledgeIntents`)
- Migration rules: `AGENTS.md` (Schema migrations), `deploy/lint-migrations.ts` (L1-L6),
  `packages/migrate/src/expected-migrations.ts`

## Decisions (owner, 2026-11-23)

- **Cap:** `AGENT_MESSAGE_MAX_ATTEMPTS = 5`, retried immediately, **no backoff**. Add backoff only if transient errors start dead-lettering healthy messages.
- **Missing thread:** counts against the cap like any other failure (no special error class).
- **`last_error`:** stores the error name and a message truncated to 500 characters, never the body.
- **Migration filename:** re-check `deploy/migrations` on main at implementation time, so the new file sorts last.

