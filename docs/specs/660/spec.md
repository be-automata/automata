# #660 — Agent bus S2: exactly-once message delivery between runs

Ticket: https://github.com/be-automata/automata/issues/660 (part of #651, slice 2 of 5).
Branch `feat/660-agent-messages`, worktree base `origin/main` @ `e3d74abb` (S1, #667, merged).

## Decisions taken for this run (2026-11-17, confirmed by the owner)

- **D1 — sweeper wiring.** No new cron trigger or route (deviation from the ticket's "a cron
  route", owner decision). Production crons on Workers are a fixed map of 4 patterns → 4 routes
  (`apps/www/worker-entry.ts:43-46`, `apps/www/wrangler.jsonc:32`, mirrored by
  `apps/www/vercel.json`). The `*/1` route (`apps/www/src/app/api/internal/cron/scheduled-tasks/route.ts`)
  calls `runScheduledTasksCron()` DIRECTLY — it never reaches `runScheduledCron`. So the sweeper
  `runAgentBusSweepSafe()` goes inside `runScheduledTasksCron`'s existing `finally`
  (`apps/www/src/server-lib/cron.ts:254-258`), after `runKnowledgeReconcileSweepSafe()`, each Safe
  runner logging and swallowing its own errors. S3's G6 reconciler (#651) can join it later.
- **D2 — framing.** An applied message lands in the target run's primary chat as ONE queued user
  message: `{ type: "user", model: null, parts: [{ type: "text", text }] , timestamp }` with
  `text = "Message from agent run <from_run>:\n\n<body>"`. The header also means a body starting
  with `/` can never be taken for a slash command by `maybeProcessFollowUpQueue`
  (`apps/www/src/server-lib/process-follow-up-queue.ts:53`). `model: null` is filled by
  `startAgentMessage` (`apps/www/src/agent/msg/startAgentMessage.ts:579`, `userMessageToSend.model ?? …`).

Other defaults (not owner questions; listed as assumptions in the PR):

- **A1** A duplicate key whose stored `(to_run, body)` differ from the retry's returns
  `{ ok: false, error: "idem_key_conflict" }` (key reuse with different params is a caller bug;
  Stripe-style). Same params → `{ ok: true, id, duplicate: true }`.
- **A2** `authorizeSend` runs on every call, retries included (ticket order). A retry after the
  target ended is refused even though the first send committed; the committed row is still
  delivered by receive/sweeper. Documented, not "fixed".
- **A3** Apply failure (throws): that message's transaction rolls back, `receiveFor` stops for
  that target and rethrows; the message stays unconsumed and the sweeper retries it. No
  dead-letter in S2 (out of scope; follow-up named in the PR).
- **A5** Kick gating follows `queueFollowUpInternal`'s three checks, with one deliberate difference (it THROWS on tier `none`, follow-up.ts:130-133; we only skip the kick) — plus a fourth, bus-specific one: skip when the target user's access tier is
  `none` (`getAccessInfoForUser`, `follow-up.ts:130`), when the thread is `shadow`, or when the chat
  `isAgentWorking`, or when the target's `agent_run.blocked_at` is set (a run blocked after the send must not be
  resumed by a kick; `agent-run.ts` markBlocked). The message stays queued (visible) in every skip case.
- **A6** Lost kick: the kick runs after commit and can fail or die with the request. The sweeper
  therefore also re-kicks targets that had a message consumed in the last 5 minutes
  (`recentlyDeliveredTargets`); the kick is idempotent (`maybeProcessFollowUpQueue` returns on an
  empty queue). Poison messages (A3) remain a known gap → dead-letter follow-up issue.
- **A4** Timestamps are `timestamptz` as the ticket's contract says (drizzle
  `timestamp(..., { withTimezone: true, mode: "date" })`).

## Ground truth (verified in the worktree at write time)

| Claim | Where | Status |
|---|---|---|
| S1 ledger: `getRunForOrg({db, organizationId, threadId})` → `AgentRunView \| null`, org-scoped | `packages/shared/src/model/agent-bus/agent-run.ts:41-91` | exists (merged #667) |
| `authorizeSend(from, to)` → `"ok" \| AgentBusError` | `packages/shared/src/model/agent-bus/capabilities.ts:177-199` | exists |
| `agentRun` table style (text ids, `index(...)` names `<table>_<col>_index`) | `packages/shared/src/db/schema.ts:3353-3386` | exists |
| Migration style (header `-- migrate:expand`, `IF NOT EXISTS`, `DO $$ … duplicate_object` for FKs) | `deploy/migrations/2026-11-18-agent-run.sql` | exists |
| Expected migrations list (last entry `"2026-11-18-agent-run"`) | `packages/migrate/src/expected-migrations.ts:30` | exists; append one id |
| `agent_messages`, `agent_applied`, any `agent-bus/messages*` | grep `packages/ apps/ deploy/` | **none** |
| Queued follow-ups: `updateThreadChat` appends with `COALESCE(queued_messages,'[]') \|\| $json` in ITS OWN transaction and publishes a broadcast after its own transaction commits (`threads.ts:1036-1039`) | `packages/shared/src/model/threads.ts:927-1040` (append at 1011-1014) | exists — **not usable inside the receive tx as-is** (it would nest a savepoint and broadcast before OUR commit) |
| `sanitizeForJson` used on appended messages | `packages/shared/src/model/threads.ts:1012` | exists; reuse |
| Primary chat = oldest `thread_chat` of the thread | `packages/shared/src/utils/thread-utils.ts:3-11`, ordering `threads.ts:666` `asc(threadChat.createdAt)` | exists |
| `queueFollowUpInternal` (shadow-thread skip, kick only if `!isAgentWorking(status)`) | `apps/www/src/server-lib/follow-up.ts:115-176` | exists; production kick mirrors its three checks (tier, shadow, working) + blocked (A5) |
| `maybeProcessFollowUpQueue({userId, threadId, threadChatId})` | `apps/www/src/server-lib/process-follow-up-queue.ts:9` | exists |
| `isAgentWorking` | `apps/www/src/agent/thread-status.ts:3` | exists |
| Cron composition + bulkhead pattern (`*Safe` runners swallow) | `apps/www/src/server-lib/cron.ts:384-428` | exists |
| Crash-drill precedent: `spawn(process.execPath, ["--import","tsx", CHILD])`, child reads `process.env.DATABASE_URL` directly, SIGKILLs itself, prints `RESULT {json}` | open PR #664 (`origin/feat/652-control-effects`: `packages/shared/src/model/__fixtures__/control-effects-crash-child.ts`, `control-effects.crash.test.ts`) | **not on main** — copy the technique, do not import |
| `tsx` devDependency of `@terragon/shared` | `packages/shared/package.json` (`^4.20.3`) | exists |
| Shared exports wildcard `"./*": "./src/*.ts"` (www imports `@terragon/shared/model/agent-bus/messages`) | `packages/shared/package.json:27` | exists |
| Shared tests: Postgres throwaway DB via globalSetup, `createDb(env.DATABASE_URL!)`, helpers `createTestOrg/createTestUser/createTestThread` | `packages/shared/vitest.config.ts`, `packages/shared/src/model/agent-bus/agent-run.test.ts:1-60` | exists |

Already done (do NOT redo): S1 ledger and capabilities, its migration, its expected-migrations entry.

## Contract

### Schema (`packages/shared/src/db/schema.ts`, after `agentRun`) and migration `deploy/migrations/2026-11-19-agent-messages.sql`

```sql
-- migrate:expand
create table if not exists agent_messages(
  id bigserial primary key, idem_key text not null, from_run text not null, to_run text not null,
  body text not null, created_at timestamptz not null default now(), consumed_at timestamptz);
create unique index if not exists agent_messages_idem on agent_messages(from_run, idem_key);
create index if not exists agent_messages_inbox on agent_messages(to_run, id) where consumed_at is null;
create index if not exists agent_messages_consumed_at_index on agent_messages(consumed_at) where consumed_at is not null; -- A6 re-kick query
create table if not exists agent_applied(msg_id bigint primary key, run text not null,
  applied_at timestamptz not null default now());
DO $$ BEGIN ALTER TABLE "agent_applied" ADD CONSTRAINT "agent_applied_msg_id_agent_messages_id_fk"
  FOREIGN KEY ("msg_id") REFERENCES "public"."agent_messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

Names/types in the SQL file must match drizzle exactly (`schema-drift` CI job). drizzle:
`bigserial("id", { mode: "number" })`, `bigint("msg_id", { mode: "number" }).primaryKey().references(() => agentMessages.id)` (schema-drift compares conname + pg_get_constraintdef: `packages/migrate/src/drift/catalog.ts:108-118`), `uniqueIndex("agent_messages_idem")`,
`index("agent_messages_inbox").on(t.toRun, t.id).where(sql\`consumed_at is null\`)`. Append
`"2026-11-19-agent-messages"` to `EXPECTED_MIGRATION_IDS` (it must sort LAST: `packages/migrate/src/files.test.ts:108`). Migration must pass
`node deploy/lint-migrations.ts`.

### Module `packages/shared/src/model/agent-bus/messages.ts` (never imports www)

```ts
export interface AgentMessage { id: number; fromRun: string; toRun: string; body: string; createdAt: Date }
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0]; // precedent: knowledge-store.ts:55, self-heal-tx.ts:6
export type ApplyMessage = (tx: Tx | DB, message: AgentMessage) => Promise<void>; // INSIDE the receive tx (DB only in the unsafe test path)
export type SendError = AgentBusError | "idem_key_conflict";

insertMessage({ db, from, to, key, body }) → Promise<{ id: number; duplicate: boolean } | { conflict: true }>
  // insert … on conflict (from_run, idem_key) do nothing returning id; on conflict select existing;
  // existing (to_run, body) differ → { conflict: true }.

sendMessage({ db, organizationId, from, to, key, body, apply })
  → Promise<{ ok: true; id: number; duplicate: boolean; applied: number } | { ok: false; error: SendError }>
  // 1. getRunForOrg(from), getRunForOrg(to); from null → "not_found"; authorizeSend → refusal writes NOTHING.
  // 2. insertMessage (its own statement, committed). 3. receiveFor(to). applied = receiveFor's count.

receiveFor({ db, toRun, apply, unsafeApplyOutsideTransaction? }) → Promise<{ applied: number }>
  // loop, one db.transaction per message:
  //  (1) select … where to_run=$1 and consumed_at is null order by id for update skip locked limit 1 — none → stop
  //  (2) insert into agent_applied(msg_id, run) … on conflict do nothing returning msg_id
  //  (3) if inserted: await apply(tx, msg)   [unsafeApplyOutsideTransaction: apply(db, msg) — TEST-ONLY
  //      negative control for AC3; JSDoc says so; never set in production code]
  //  (4) update agent_messages set consumed_at = now() where id = msg.id   (5) commit
  // An apply that throws rolls the tx back and rethrows (A3).

recentlyDeliveredTargets({ db, withinMs = 300_000 }) → Promise<string[]>  // distinct to_run with consumed_at > now() - withinMs (A6)

sweepUnconsumed({ db, apply, olderThanMs = 10_000, limit = 100 }) → Promise<{ targets: string[]; applied: number }>
  // select distinct to_run where consumed_at is null and created_at < now() - olderThanMs (uses the partial index),
  // receiveFor each; one target's failure is logged (injected logger or console.error) and does not stop the others.

queuedFollowUpApply: ApplyMessage   // the production apply, in shared so the crash drill exercises it
  // in tx: select the target thread's primary chat (oldest thread_chat by created_at) FOR UPDATE;
  // none → throw; then update thread_chat set queued_messages = COALESCE(queued_messages,'[]') || $json
  // with the D2 message, sanitizeForJson applied.
```

### www binding `apps/www/src/server-lib/agent-bus/delivery.ts`

- `sendAgentMessage(args)` = `sendMessage({ ...args, db, apply: queuedFollowUpApply })`, then when
  `applied > 0` → `kickTarget(to)`.
- `runAgentBusSweep()` = `sweepUnconsumed({ db, apply: queuedFollowUpApply })`, then `kickTarget` for every target in `targets` ∪ `recentlyDeliveredTargets()` (A6; kick is idempotent).
- `kickTarget(threadId)`: load thread (userId, shadow) + primary chat (id, status); skip when the
  user's tier is `none`, `shadow`, or `isAgentWorking(status)` (A5, mirrors `follow-up.ts:130-175`); else
  `await maybeProcessFollowUpQueue({ userId, threadId, threadChatId })`; before the skip checks, also
  `publishBroadcastUserMessage` the same way `updateThreadChat` does (`threads.ts:1036-1039`), so the UI shows the queued message. Errors logged, not thrown
  (delivery is already committed).
- `cron.ts`: `runAgentBusSweepSafe()` (dynamic import like the other Safe runners, logs+swallows), wired per D1.
- `delivery.test.ts`: skip on tier none / shadow / working / blocked, kick when idle, a kick error is swallowed and
  does not reject `sendAgentMessage`, the sweep kicks swept + recently delivered targets.

No caller of `sendAgentMessage` exists yet — S5 adds the MCP tool. That is expected.

## Acceptance criteria (ticket, verbatim) → proof

1. Receiver crash (a): SIGKILL inside receive before COMMIT; after restart, 3 messages applied exactly once
   (3 `agent_applied`, 3 queued follow-ups), all consumed → `messages.crash.test.ts` (seed 3 via
   `insertMessage`; child runs `receiveFor` with `queuedFollowUpApply`, KILL_POINT=after-apply on the 2nd
   message; rerun child without kill; assert counts on `agent_applied`, `thread_chat.queued_messages` length, `consumed_at`).
2. Sender crash (b): child runs `sendMessage`, killed in apply (after the insert committed, before answering);
   retry `sendMessage` same key → `duplicate: true`, same id; exactly 1 `agent_messages` row; delivered once.
3. Negative control: same as (1) with `unsafeApplyOutsideTransaction` → 4 queued follow-ups for 3 messages.
4. A refused send (each refusal class reachable: `not_found`, lane pair, terminal/blocked) writes no
   `agent_messages`/`agent_applied` row → `messages.test.ts`.
5. A message left unconsumed (receive never ran, `created_at` backdated > 10 s) is delivered by one
   `sweepUnconsumed` pass; a fresh (< 10 s) one is left alone → `messages.test.ts`; `cron.test.ts` (the `runScheduledTasksCron` describe) proves
   the sweep runs after the due-threads step, also when that step throws, and a throwing sweep is swallowed.

Plus: idempotent duplicate, `idem_key_conflict`, skip-locked concurrency (two concurrent `receiveFor` on 3
messages → 3 applied total), apply-throws rollback (A3).

## Tests / gates (from the worktree root)

`pnpm turbo tsc-check` · `pnpm turbo lint` · `pnpm turbo format-check` ·
`pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` ·
`pnpm --filter @terragon/www exec vitest run --no-file-parallelism` ·
coverage on touched packages: `pnpm --filter @terragon/shared exec vitest run --coverage --no-file-parallelism src/model/agent-bus` ·
`node deploy/lint-migrations.ts` · `pnpm --filter @terragon/migrate test`.

## Out of scope

Spawning (S3), artifacts (S4), MCP tools (S5), `LISTEN`/durable waits, dead-letter for poison messages, any
caller of `sendAgentMessage`.

## Risks / rollback

Expand-only migration (apply before deploy; migrate.yml does it on green main). Body is agent-authored text,
delivered as a user follow-up and treated as data. Rollback = revert; unconsumed rows are inert.

## Phases (from the validator)

1. Schema and migration — `schema.ts`, `deploy/migrations/2026-11-19-agent-messages.sql`, `expected-migrations.ts`.
2. Bus module + DB tests — `agent-bus/messages.ts`, `agent-bus/messages.test.ts`.
3. Crash drills — `agent-bus/__fixtures__/messages-crash-child.ts`, `agent-bus/messages.crash.test.ts`.
4. www binding + cron — `server-lib/agent-bus/delivery.ts`, `delivery.test.ts`, `cron.ts`, `cron.test.ts`.
5. Full gates.

## Validate history

- Cycle 1 (Opus): BLOCK — D1 wired into a dead switch case; migration id sorted before `agent-run`; FK name;
  undefined `Tx`. All four fixed above; warnings A5 (tier gate), A6 (lost kick), wording fixes taken.
- Cycle 1 re-grade (Opus): PASS_WITH_WARNINGS — folded: blocked-run kick skip (A5), consumed_at partial index, A5 wording.
