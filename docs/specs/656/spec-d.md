# #656 PR-D: the run-end endpoint, and thread-status's terminal read and lease stamp

Ticket: be-automata/automata#656 (S5 of #634). This is "PR-D" of the 7-PR plan.

- **Branch:** `feat/656-d-run-end`, **stacked on PR-C's branch `feat/656-c-cell-plan`**. It merges after PR-C. The ground truth below was verified on `main` at `08c1b194` (PR-A #677, PR-B #665, PR-F #666, PR-G #669); the PR-C facts come from `docs/specs/656/spec-c.md` (in the gh-656-c worktree).
- **From PR-C:**
  - `cellStepKey(apiKeyId)` (`cell-${apiKeyId}`) in `packages/types/src/cell.ts`, with its tests (spec-c decision 1, `:103-104`). Recorded on #656 at 22:11. PR-D imports it and never builds a key by hand.
  - `cell-plan` on `openNextAttempt`, which stamps the lease.
  - **The removal of `teardownCell`** (spec-c decision 5 / phase 5). PR-D does not touch `cell-control.ts`.

It covers:

- Scope item 2 (the run-end endpoint, OD-3);
- the www half of item 6 (the `cell_teardown_incomplete` event and the ops alert);
- item 10 (R1, as refined on #656 on 2026-11-17: `finishStep`; and tightened here: retire the token, and accept a retired token only on `cell-teardown`);
- the www half of item 11 (R2: `thread-status` stamps the lease);
- the endpoint half of AC-3, the event half of AC-4, and the terminal-read and lease half of AC-14.

Out of this PR:

- **PR-C:** the step-key helper, `cell-plan`, `isDead` wiring, the adapter, and `teardownCell`;
- **PR-E:** the worker. It sends `cellAttempt` on every poll, calls this endpoint, and stamps during setup.

Until PR-E, no caller sends `cellAttempt` or calls the endpoint, and nothing is ever retired, so the deploy changes no behaviour.

## Ground truth (verified at `08c1b194`, plus PR-C's spec)

| Fact                                                                                                                                                                                                                                                                                                                                                                                                  | Where                                                                                                                                                                                                 |
| :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread-status` takes `{threadId, threadChatId}`. Its auth is inline (F1, F2, thread anchor, the `getThreadChat` owner fence, the org check), **not** `authorizeDaemonThreadRequest`                                                                                                                                                                                                                  | `apps/www/src/app/api/daemon/thread-status/route.ts:24-71`                                                                                                                                            |
| Its terminal branch revokes the caller's token by id in `waitUntil`, **after** serving `terminal: true`. It has no cell code                                                                                                                                                                                                                                                                          | `thread-status/route.ts:73-94`                                                                                                                                                                        |
| `terminal = !isAgentWorking(status)`. `stopping` counts as working, and the worker leaves on `stopping` by itself                                                                                                                                                                                                                                                                                     | `apps/www/src/agent/thread-status.ts:3-15`; `packages/worker/src/agent-run/www-client.ts:775-777`                                                                                                     |
| `authorizeDaemonThreadRequest` returns `{ok, ctx, body, threadId, threadChatId, thread}` or a ready 400/401/403. Its callers are `agent-credentials` and `cell-plan`                                                                                                                                                                                                                                  | `apps/www/src/lib/daemon-thread-auth.ts:32-113`                                                                                                                                                       |
| **Every daemon credential check ends in `verifyDaemonApiKey`:** <br>- `getDaemonTokenContext` (`daemon-event`, `thread-status`, `next-message`, `egress-event`, the cli-router); <br>- `parseDaemonRequest` (`run-terminal`, `run-staleness`, `run-credential-source`); <br>- `authorizeDaemonThreadRequest` (`agent-credentials`, `cell-plan`); <br>- the four model proxies, which call it directly | `apps/www/src/lib/auth-server.ts:220-238`; `daemon-route.ts:21-29`; `daemon-thread-auth.ts:55`; `app/api/proxy/{anthropic,google,openai,openrouter}/[[...path]]/route.ts:426`, `:360`, `:320`, `:340` |
| `verifyDaemonApiKey` answers 401 for an unknown, disabled or expired key, and 503 when the store fails. `daemonTokenContextFromApiKey` maps `id`, `referenceId`/`userId` and `metadata` only, **not `name`**. Its comment warns that a renamed field silently 401s everyone, which only a database-backed test caught                                                                                 | `apps/www/src/lib/daemon-api-key.ts:40-74`; `daemon-token-context.ts:46-91`                                                                                                                           |
| `cell-plan` derives `stepKey = \`cell:${ctx.apiKeyId}\``. PR-C replaces it with `cellStepKey`                                                                                                                                                                                                                                                                                                         | `apps/www/src/app/api/daemon/cell-plan/route.ts:81` (spec-c cites `:80`)                                                                                                                              |
| `stampSeen` renews only when `current_attempt = attempt`, the attempt is undone and unrevoked, and a lease already exists. So **a fenced attempt cannot renew its successor's lease**                                                                                                                                                                                                                 | `packages/shared/src/model/cell-authority.ts:284-311` (`:300`, `:302`)                                                                                                                                |
| `finishStep({db, stepKey, organizationId, threadId})` is an org/thread-scoped upsert: it revokes through `current_attempt`, sets `done_at`, and writes a tombstone for a never-opened key. It is idempotent. **It returns `false` only when the key belongs to another org or thread**                                                                                                                | `cell-authority.ts:322-357`                                                                                                                                                                           |
| `revokeAttempt` is capped at `current_attempt` and has no org or thread fence. It returns `false` for an unknown key                                                                                                                                                                                                                                                                                  | `cell-authority.ts:561-578`                                                                                                                                                                           |
| Daemon tokens expire after 1 day, as a backstop                                                                                                                                                                                                                                                                                                                                                       | `apps/www/src/lib/daemon-token.ts:62`                                                                                                                                                                 |
| **The double-dispatch guard `hasActiveDaemonToken` matches `name = runKey` and ignores `expires_at`.** `runKey` is `${threadId}:${threadChatId}`. A follow-up run mints its token under the same name                                                                                                                                                                                                 | `daemon-token.ts:96-109`; `apps/www/src/agent/hatchet/dispatch.ts:887`, `:903-911`                                                                                                                    |
| Supersede-sweep rule (iii) revokes by the `${threadId}:` name prefix                                                                                                                                                                                                                                                                                                                                  | `daemon-token.ts:143-155`; `apps/www/src/server-lib/supersede-sweep.ts:599`                                                                                                                           |
| **onFailure's `run-failed` goes to `POST /api/daemon-event`:** one message `{type: "custom-error", session_id: null, duration_ms: 0, error_info}`, with the run's token and `x-run-external-id` = the workflow run id. It runs after the run's own teardown                                                                                                                                           | `www-client.ts:271-300`, `:66-78`; `packages/worker/src/agent-run/workflow.ts:349`, `:2030-2037`                                                                                                      |
| **The worker can read terminal and then fail.** After `terminal: true`, a late memory-starvation check throws, so the run fails and onFailure runs **after** the terminal read                                                                                                                                                                                                                        | `www-client.ts:762-772`                                                                                                                                                                               |
| `daemon-event` parses the body, then authenticates. It passes `x-run-external-id` to `handleDaemonEvent`, whose generation fence answers 409 for a run that is not the thread's active run. **With no header it fails open**, which the in-sandbox daemon relies on                                                                                                                                   | `apps/www/src/app/api/daemon-event/route.ts:10-18`, `:73-75`; `apps/www/src/server-lib/handle-daemon-event.ts:123-141`                                                                                |
| **On task threads `activeRunExternalId` is stamped only for review runs**, and a non-review follow-up goes through `clearThreadTerminalForResume`. The fence (`decideThreadGeneration`) passes when either side is null. So on a task thread even a header-carrying `custom-error` from an old run lands in the follow-up                                                                             | `apps/www/src/agent/hatchet/dispatch.ts:551-555`, `:1296-1308`; `packages/shared/src/model/threads.ts:1161-1166`                                                                                      |
| `ops-alert.ts` has **no dedupe**. The #652 ledger `runEffect` records an intent per key and returns `already_done` for a done key; its `findByMarker` runs only for an intent left not-done                                                                                                                                                                                                           | `apps/www/src/server-lib/knowledge/ops-alert.ts:91-131`; `packages/shared/src/model/control-effects.ts:155-195`                                                                                       |
| The #386 guard is the worker's box-local ledger. It never calls www, and a redelivery to another box finds no entry                                                                                                                                                                                                                                                                                   | `packages/worker/src/agent-run/run-terminal-ledger.ts:7-33`; `workflow.ts:507-541`                                                                                                                    |
| `postOpsAlert({text})` never throws and times out after 3 s. Precedent of an awaited inline call: the opensandbox evidence route                                                                                                                                                                                                                                                                      | `apps/www/src/server-lib/knowledge/ops-alert.ts:33`, `:127-131`; `app/api/internal/profile-evidence/opensandbox/route.ts:127-133`                                                                     |
| The apiKey plugin has rate limiting off, and `auth.ts` sets no `secondaryStorage`, so a write to `apikey` is seen by the next verify                                                                                                                                                                                                                                                                  | `apps/www/src/lib/auth.ts:303-311`                                                                                                                                                                    |
| Checked and not found: a `cell-teardown` route; `cell_teardown_incomplete`; `cellAttempt`; callers of `stampSeen` or `finishStep` outside tests; any "retired" token state                                                                                                                                                                                                                            | `git grep`                                                                                                                                                                                            |

## Decisions taken in this spec

1. **A cell run is recognised by `cellAttempt` in the `thread-status` body,** which PR-E's worker sends on every poll. It costs nothing on non-cell polls. The step key comes from the caller's own token (`cellStepKey(ctx.apiKeyId)`), so a false `cellAttempt` affects only the caller's own step.
2. **The terminal read of a cell run calls `finishStep`, then retires the token.** `retireDaemonTokenById` is one `UPDATE`, scoped by id and owner, that:
   - appends `:retired` to `name`. The double-dispatch guard no longer sees the run as in flight, and sweep rule (iii)'s prefix still matches it;
   - caps `expires_at` at `LEAST(expires_at, now() + 15 min)` (`RETIRED_DAEMON_TOKEN_GRACE_MS`, the teardown margin of `CELL_RUN_TTL_MS`). `LEAST` means no later call can ever move the expiry later. `now()` is the database clock; the column is `timestamp` without a time zone, written by the plugin in UTC, so the implementation must compare in UTC (`now() AT TIME ZONE 'UTC'`), which the expiry test pins.
3. **A retired token is accepted only on `cell-teardown`** (orchestrator decision, tightening the owner's R1 retire). This closes a stale-event write. On a task thread no run carries an `activeRunExternalId`, and the fence passes when either side is null (`threads.ts:1161-1166`). So a cell guest, through its vault, or a zombie could post a late `/api/daemon-event`, a `custom-error` included, into the thread's follow-up run. The header does not help.
   - **Plumbing.** `verifyDaemonApiKey(token, { allowRetired = false })` reads the verified key's `name`. If the name ends with `:retired` and `allowRetired` is false, it logs `Unauthorized reason retired token` and returns `null`. Every route then answers its own existing unknown-token 401 (same body, same status).
     - The flag goes through `getDaemonTokenContext(request, opts?)` and `authorizeDaemonThreadRequest({…, allowRetired?})`. **Only `cell-teardown` passes `true`.**
     - The model proxies call `verifyDaemonApiKey` directly, so they refuse with no change at the call site.
     - `DaemonTokenContext` gains `retired: boolean`, mapped from `name` in `daemonTokenContextFromApiKey` (`VerifiedApiKeyLike` gains `name?: string | null`).
   - **Refused:** every other daemon route, including `daemon-event`, whatever the body or headers, and `thread-status` itself. A retried terminal read whose first response was lost gets 401, and the worker fails the run, as it does today after a revoke. The same holds for `next-message`, `agent-credentials`, `cell-plan`, `egress-event`, `run-terminal`, `run-staleness`, `run-credential-source` and the proxies. `daemon-event/route.ts` is not edited.
4. **`report` deletes only a retired token** (`id` + owner + `name LIKE '%:retired'`), after the 200. There is no `keepToken`.
   - **A failure or cancel exit with no terminal read:** the token was never retired, so `report` leaves it. onFailure posts `run-failed` with a live token, as today.
   - **The worker read terminal and then failed** (`www-client.ts:762-772`): the token is retired, and onFailure's `run-failed` on `daemon-event` gets 401, whether or not `report` has deleted it yet. **This is an accepted, unchanged cost, not a regression.** Today the terminal read deletes the token, and the same post already 401s: that loss is documented at `www-client.ts:266-268`, with the stalled-thread watchdog as backstop. The thread is already terminal in this case.
5. **`revoke` calls `revokeAttempt(attempt)`, not `finishStep`.** It is attempt-scoped and capped, so a fenced zombie's `finally` cannot end its live successor's step. The step's done mark comes from the terminal read.
6. **The endpoint has no `opensandboxCells` flag gate.** A rollback must not strand a live cell's revoke and report.
7. **`thread-status` failures:**

   - **`stampSeen` throws:** log it and still serve the status with `lease: "error"`. The poll's job is the status; the lease ages, and only five minutes of failures reap the cell.
   - **`finishStep` throws:** 500, and nothing is retired. The worker retries, and `finishStep` is idempotent.
   - **`finishStep` returns `false`** (the key belongs to another org or thread). That is impossible for a key derived from the caller's own token id, short of a corrupted row. **Fail closed:**

     - answer 409 `cell_step_conflict`, logged with ids every time, with an ops alert **once per `(stepKey, attempt)`** through the same #652 ledger as the teardown alert (`effect: "step-conflict-alert"`). The token delete runs in `waitUntil`, so a quick retry can hit 409 again before it lands;
     - do **not** retire the token: `waitUntil(revokeDaemonTokenById)`, the non-cell path's delete.

     Why: www can neither mark the step done nor vouch for it, so it must not hand the run a grace-period credential or a normal terminal. The worker gets a non-2xx, then 401s, and fails the run loudly. The step is foreign, so the run has nothing of its own left to tear down.

## Contract

> **Superseded in part by refinement, `/simplify` and roborev 1268. The code is the source of truth. Read this before building PR-E on it.**
>
> - **A failed retire answers 500 `cell_retire_failed`**, and the worker retries; `finishStep` is idempotent. It is no longer logged and served as 200.
> - **There is no `DaemonTokenContext.retired` field.** The key's name is the only signal: `isRetiredTokenName` in `verifyDaemonApiKey`, with `allowRetired` for `cell-teardown` only.
> - **The `cell-teardown` body uses `z.union`**, not a `discriminatedUnion`.
> - **An unknown attempt** (above `current_attempt`) writes its own `skipped_unknown_attempt` log line from `alertCellStepOnce` (`server-lib/cell-ops-alert.ts`). The event carries no `alert` field.
> - **better-auth's `/api-key/update` is disabled** (`disabledPaths`), so an owner cannot rename a retired token back.

### 1. Token custody (`apps/www/src/lib/daemon-token.ts`, `daemon-api-key.ts`, `daemon-token-context.ts`, `auth-server.ts`)

```ts
export const RETIRED_DAEMON_TOKEN_GRACE_MS = 15 * 60 * 1000;
export const RETIRED_TOKEN_SUFFIX = ":retired";
export function isRetiredTokenName(name: string | null | undefined): boolean; // endsWith(RETIRED_TOKEN_SUFFIX)

/** Cell terminal read: frees the dispatch guard and caps the life. Idempotent (a second call returns false). */
export async function retireDaemonTokenById(a: {
  userId: string;
  apiKeyId: string;
}): Promise<boolean>;
// UPDATE apikey
//    SET name = name || ':retired',
//        expires_at = LEAST(COALESCE(expires_at, $cap), $cap)
//  WHERE id = $apiKeyId AND reference_id = $userId AND name NOT LIKE '%:retired'
// where $cap = (now() AT TIME ZONE 'UTC') + interval '15 minutes'. LEAST: never later than before.

/** Report: deletes the caller's token only if it was retired. */
export async function revokeRetiredDaemonTokenById(a: {
  userId: string;
  apiKeyId: string;
}): Promise<number>;
```

- `verifyDaemonApiKey(token, opts?: { allowRetired?: boolean })`: a retired key without `allowRetired` returns `null`, with its own log line.
- `getDaemonTokenContext(request, opts?)` passes the option through.
- `DaemonTokenContext.retired: boolean`.

### 2. `thread-status` (`apps/www/src/app/api/daemon/thread-status/route.ts`)

**Body:** `{threadId, threadChatId, cellAttempt?}`.

- Unknown keys stay tolerated, as today.
- A present `cellAttempt` that is not an integer from 1 to 1000 answers 400 `invalid_cell_attempt`.

**With `cellAttempt`:**

- A null `ctx.apiKeyId` answers 403 `no_run_key`, and an org-less thread answers 403 `org_required`.
- Otherwise `stepKey = cellStepKey(ctx.apiKeyId)`.
- **Not terminal:** `stampSeen` answers `lease: "renewed"` or `"refused"`. A throw answers `"error"` and the response is still 200.
- **Terminal:** `finishStep`:

  - a throw answers 500;
  - `false` takes decision 7's fail-closed path (409, token deleted);
  - `true` leads to `retireDaemonTokenById`. A failure there is logged, the status is still served, and the token keeps its 1-day life.

  The answer is `lease: "finished"`, and the read never calls `revokeDaemonTokenById`.

**Without `cellAttempt`:** today's code, byte for byte.

**Response:** `{status, terminal, lease?}`.

### 3. NEW `apps/www/src/app/api/daemon/cell-teardown/route.ts`

```
POST /api/daemon/cell-teardown
{ threadId, threadChatId, action: "revoke", attempt }
{ threadId, threadChatId, action: "report", attempt, outcome: "clean" }
{ threadId, threadChatId, action: "report", attempt, outcome: "incomplete",
  failedSteps: ("revoke_attempt"|"vault"|"quarantine"|"delete"|"survivor")[] }   // 1..5, unique
```

- **Wrappers:** `withDaemonAuthUnavailable`, `dynamic = "force-dynamic"`, `Cache-Control: no-store` on every response. The body is never logged.
- **Auth:** `authorizeDaemonThreadRequest({strictThreadId: true, allowRetired: true, logLabel: "daemon cell-teardown"})`.
- **Body:** a zod `discriminatedUnion("action")`, each branch `.strict()`. A failure answers 400 `invalid_body`.
- **Then:** a null `apiKeyId` answers 403 `no_run_key`, and `stepKey = cellStepKey(ctx.apiKeyId)`.
- **No flag gate, and no provider call.**

| Action                 | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Response                                                                                           |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------- |
| `revoke`               | `revokeAttempt({db, stepKey, attempt})`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 200 `{ok: true, revoked}`. An unknown step is `revoked: false`, still success. A throw answers 500 |
| `report`, `clean`      | log `{threadId, stepKey, attempt, outcome}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 200 `{ok: true}`, then `waitUntil(revokeRetiredDaemonTokenById)`                                   |
| `report`, `incomplete` | `failedStep` = the canonical first of `failedSteps` (`revoke_attempt, vault, quarantine, delete, survivor`). **First** `console.error("[cell] cell_teardown_incomplete", {event, stepKey, attempt, failedStep, failedSteps})`, **then** the alert, **once per `(stepKey, attempt)`** (below), and **only when `attempt <= current_attempt`** of that step. `attempt` is caller-supplied: a single read of `cell_step` by key bounds the alert keys to attempts that really opened. An unknown step, or an attempt above the current one, logs the event (with `alert: "skipped_unknown_attempt"`) and sends no alert | same as `clean`                                                                                    |

**Idempotency:**

- `revoke` repeats as a no-op and answers 200.
- `report` answers 200 while the token lives. A retry after a retired token was deleted gets 401, and PR-E treats that as already reported.
- A repeated incomplete report repeats the event line but not the alert.

**Alert dedupe.** `ops-alert.ts` has none, so this reuses the #652 ledger: `runEffect` in `@terragon/shared/model/control-effects`, recorded in its `control_effects` table.

- **Key parts:** `organizationId` = the thread's org (a cell step is org-only; an org-less thread logs the event and sends no alert), `mission: "cell-teardown"`, `step: stepKey`, `effect: "incomplete-alert"`, `outputDigest: String(attempt)`.
- **Target:**
  - `apply` = `postOpsAlert({text: \`cell teardown incomplete: step ${stepKey}, attempt ${attempt}, failed ${failedStep}\`})`. It throws on a transient `sent: false` (`timeout`, `request_failed`, `non_2xx`), so the intent stays and the next report retries it. It returns on `unconfigured`, `invalid_url`or`redirect` (logged): retrying cannot fix those;
  - `findByMarker` = `false`, because a webhook cannot be read back.
- **Result:**
  - a repeated report finds the key done (`already_done`) and sends nothing;
  - the structured event line is logged on **every** report;
  - a ledger throw is logged and the report still answers 200.
- **The residual:** a crash between the post and the done mark re-sends once.

**Secrets:** the event and the alert carry `stepKey`, `attempt` and enums only. Never the token, a bearer, the model token, a tag value or a cell id.

## The #386 check

The #386 guard is the worker's box-local ledger, and nothing here touches it.

The terminal-read revoke used to give a cross-box backstop as a side effect: a redelivery to another box got 401. For a cell run, that backstop is now:

- **refusal of the retired token,** on every route a redelivered run would call (`cell-plan`, `thread-status`, `next-message`, `agent-credentials`): the same 401 as before;
- **`finishStep`,** which outlives the token: `cell-plan` answers `step_done`.

Non-cell runs are unchanged, pinned by a test. The poll loop returns on the first `terminal: true`. The S12 rule (a 401 after a successful poll fails the run) is intact, because nothing retires a token before its terminal read.

## The R1 cost, recorded

- **A worker killed after the terminal read:**
  - the token is usable only on `cell-teardown`;
  - for at most 15 min;
  - it no longer blocks dispatch.
- **A worker killed before the terminal read:** the token is live for up to its 1-day expiry, on every route, for anyone holding the raw value, which is the box (the sealed payload and the plane key). This is today's dead-run backstop. It also keeps blocking re-dispatch, a residual already documented (`dispatch.ts:895-902`).
- **"Usable only on `/api/daemon-event` through the vault"** is true for the guest, not for the token. The cell's vault copy dies when the reconciler reaps the cell.

## Acceptance (this PR)

- **AC-3, endpoint half:**
  - `revoke` and `report` behind daemon-token auth;
  - repeats succeed (with `report`'s 401 after deletion);
  - no provider call.
- **AC-4, event half:** an `incomplete` report emits exactly one `cell_teardown_incomplete` line `{stepKey, attempt, failedStep}` and an ops alert, with no secret.
- **AC-14, terminal and lease half:**
  - the terminal read finishes the step (`openNextAttempt` then answers `step_done`);
  - a poll with the current attempt renews the lease;
  - a fenced attempt's poll renews nothing.

## Tests (each security check has a negative control)

`daemon-token.test.ts` and `daemon-api-key` / `auth-server-daemon-token.test.ts` (**database-backed, through the real better-auth verify**, the lesson at `daemon-token-context.ts:46-52`):

1. **Retire:**
   - renames once and caps `expires_at` at about now + 15 min, in UTC;
   - a second call returns `false`, and `expires_at` is unchanged: **never later**;
   - with `expires_at` already earlier than the cap, it stays earlier;
   - a `report` after the retire never moves `expires_at` later either;
   - another user's id changes nothing.
2. **`verifyDaemonApiKey`:**
   - a retired key returns `null` by default;
   - with `allowRetired` it returns the key;
   - **a live key is unaffected either way** (control).
3. **An expired retired token:** with `expires_at` in the past, `allowRetired: true` still returns `null` (401).
4. **`revokeRetiredDaemonTokenById`:**
   - deletes a retired token;
   - leaves a live, un-retired one (control);
   - leaves another user's.
5. **Old report after a follow-up:** the old run's token is retired (`runKey:retired`) and the follow-up has minted its own (`runKey`, live). The old run's `report` deletes only the retired row; the follow-up's token still verifies, and `hasActiveDaemonToken(runKey)` stays `true`.
6. **The sweep prefix:** `revokeDaemonTokensForThread` also deletes a retired token.

`thread-status/route.test.ts` (real database, revoke and retire spied):

7. **Unchanged path:** without `cellAttempt`, a terminal read calls `revokeDaemonTokenById` once and never calls `finishStep`. The existing tests stay green.
8. **Validation:** `cellAttempt` of `0`, `1.5`, `"1"` or `1001` answers 400, with no stamp and no finish.
9. **Stamp:** with attempt 1 opened by `openNextAttempt` and the lease backdated, a poll answers `renewed` and `last_seen_at` moves forward.
10. **Fenced poll (control):** with attempts 1 and 2 opened, a poll for attempt 1 answers `refused` and leaves the lease unchanged; a poll for attempt 2 renews it.
11. **Terminal read:**
    - `done_at` is set and `revoked_through = current_attempt`;
    - `openNextAttempt` then answers `step_done`;
    - no `revokeDaemonTokenById`;
    - the token is renamed and capped;
    - `hasActiveDaemonToken(runKey)` goes from `true` (control, before the read) to `false`.
12. **`finishStep` failures:** a throw answers 500 and retires nothing. A `false` (a row seeded under another thread) answers 409 `cell_step_conflict`, does not retire, calls `revokeDaemonTokenById` and sends one alert. **A second identical call also answers 409 and logs, but sends no second alert** (ledger dedupe).
13. **`stampSeen` throw:** 200 with the status and `lease: "error"`.
14. **The key** is `cellStepKey(apiKeyId)`, asserted through the helper, never a literal.

Retired-token refusal across routes. **One new file, `apps/www/src/lib/retired-daemon-token.integration.test.ts`**, with the real auth (no `vi.mock` of `@/lib/auth-server`, `daemon-api-key` or `handle-daemon-event`) and the real test database. The existing route tests mock `@/lib/auth-server` file-wide (`daemon-event/route.test.ts:8`, also `handle-daemon-event` at `:11`; `next-message` `:17`; `agent-credentials` `:17`; `run-terminal` `:30`; `thread-status` `:19`; `cell-plan` `:32`; `generation-fence.integration.test.ts:33`), so they cannot prove this. The file seeds one retired token and one live token through `mintDaemonToken` and `retireDaemonTokenById`, and calls each route's exported `POST` (or handler) directly:

15. **The retired token gets 401, with the same body as an unknown token; the live token gets anything but 401 (control).** The routes:

    - `daemon-event`, with an ordinary message batch;
    - **`daemon-event` with onFailure's exact `run-failed`** (one `custom-error`, with `x-run-external-id`) **on a TASK thread with no `activeRunExternalId`.** It gets 401, and the thread row is unchanged: the stale-write case;
    - the same on a review-stamped thread, also 401 (the refusal does not depend on the fence);
    - `next-message`, `agent-credentials`, `run-terminal`, `thread-status`, `cell-plan`;
    - the four model proxies (`anthropic`, `google`, `openai`, `openrouter`), with upstream `fetch` stubbed;
    - the cli-router (`server/orpc/cli-router.ts`). For a live daemon token it already refuses by F1, so its control is "not reached past auth" versus "401 from verify", asserted through the log reason;
    - the three internal broadcast routes that authenticate through `getUserIdOrNullFromDaemonToken` (`auth-server.ts:239`): `internal/broadcast`, `internal/broadcast/sandbox/env` and `internal/broadcast/sandbox/keepalive`.

16. **Allowed only on `cell-teardown`:** the retired token answers 200 on `revoke` and on `report`. As the control, the same retired token answers 401 on `daemon-event` in test 15.

`cell-teardown/route.test.ts` (real auth and real database, with **no mock of `@/lib/auth-server`**; tokens minted with `mintDaemonToken`; only `postOpsAlert` is mocked):

17. **Refusals, each with no authority write:**
    - 401 without a token, or with an unknown token;
    - 403 for a non-daemon token, a token bound to another threadChat, a token with a null thread id (strict), or a foreign owner or org;
    - 503 when auth is unavailable.
18. **Schema:** an unknown key, an unknown action, `attempt` of 0 or 1001, `incomplete` without `failedSteps`, an unknown step name or a duplicate step each answer 400 `invalid_body`. A null `apiKeyId` answers 403 `no_run_key`.
19. **Idempotent revoke:**
    - two calls both answer 200, with `revoked_through` at the attempt;
    - a `revoke` of fenced attempt 1 while 2 is current leaves 2 unrevoked (control);
    - an unknown step answers 200 `revoked: false`;
    - with the flag off it still answers 200.
20. **Clean report:** no alert and no event line.
21. **Incomplete report:**
    - one event, where `["delete","vault"]` gives `failedStep: "vault"`;
    - one alert, and a second identical report sends **no** second alert but logs the event again;
    - a transient alert failure (`sent: false`, `timeout`) leaves the ledger intent, and the next report sends it;
    - **no secret:** seed canaries for the raw token, a minted bearer and the model token; none of them, nor any tag or cell id, appears in the logged object or the alert text;
    - an alert with `sent: false` still answers 200;
    - **attempt bound:** with the step at `current_attempt` 2, an `incomplete` report for attempt 5 logs the event and sends no alert, and creates no ledger row (control: attempt 2 alerts). An unknown step does the same.
22. **Token custody:**
    - after a cell terminal read, `report` deletes the retired token, and a second `report` gets 401;
    - **without** a terminal read, `report` leaves the live token, and a second `report` answers 200 (control).
23. **No provider:** `@terragon/sandbox` is mocked to throw on import.

## Gates (worktree root; database suites outside the Claude sandbox)

- `pnpm install --frozen-lockfile --prefer-offline`.
- `pnpm --filter @terragon/docs exec fumadocs-mdx`, then `pnpm turbo tsc-check --force` and `pnpm turbo lint --force`.
- Prettier on the changed files: `pnpm exec prettier --no-editorconfig --config .prettierrc --check`.
- `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`: the full suite. Every `getDaemonTokenContext` and `verifyDaemonApiKey` caller must stay green.
- `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model/cell-authority.test.ts`, as a guard.
- `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/www-client.test.ts src/agent-run/run-terminal-ledger.test.ts`: no worker file changes.

## Risks

- **The verified key may not carry `name`.** If better-auth's `verifyApiKey` result drops `name`, the check silently never fires. Tests 2–3 go through the real verify, and they fail if it does. The fallback is a by-id row read of `name` in `verifyDaemonApiKey`, which `apiKeyRowExists` already half does.
- **A direct `apikey` write that bypasses the plugin.** No key cache exists today (`auth.ts:303-311`). A later better-auth cache would delay the cap, while the rename and the refusal would still hold.
- **PR-C ordering:** `deadCellAttempts`' `staleMs` stays `null` until this PR and PR-E are deployed together.
- **Repeated reports.** A retried incomplete report logs the event every time and alerts once per `(stepKey, attempt)` through the ledger. A crash between the post and the done mark re-sends once. Different attempts of one step alert separately.
- **onFailure after a late failure** (the worker read terminal, then failed) gets 401 on `daemon-event`. That is the loss today's code already has (`www-client.ts:266-268`), unchanged and accepted.
- **Stacking on PR-C.** PR-D no longer edits `cell-plan/route.test.ts`; it still rebases on PR-C's final head before phase 5.
- **An open broadcast socket outlives a retired token** (`apps/broadcast/src/auth.ts:25-35` authenticates at connect). Same as the old delete; follow-up, not in this PR.
- **`/api/auth/api-key/update` is disabled** (`disabledPaths: ["/api-key/update"]` in `auth.ts`): a session user owns their apikey rows and could rename a retired token back, extend it or rewrite its metadata. Nothing calls it. `auth.api` called from server code is unaffected.
- **Rollback:** revert. Nothing is retired before PR-E. A retired row left behind is an apikey row with a suffix: the sweep prefix still matches it, and it expires within 15 min.

## Ticket changes to record

- **Scope 10 / R1:**
  - The terminal read calls `finishStep` and retires the token: it is renamed out of the dispatch guard and capped at 15 min.
  - A retired token is refused on every daemon route and proxy (`daemon-event` included), and accepted only on `cell-teardown`.
  - `report` deletes only a retired token.
  - onFailure's post after a late failure keeps today's 401 loss.
  - The worker's `revoke` is `revokeAttempt`.
- **Scope 13, the recorded cost:** at most 15 min, and `cell-teardown` only, after a terminal read. The 1-day backstop applies only before it.
- **Scope 6:** the event carries `failedStep` (the canonical first) plus `failedSteps`. The alert goes once per `(stepKey, attempt)`, through the #652 ledger.

## Phases (5 files at most each; stacked on `feat/656-c-cell-plan`)

1. **Retired-token plumbing:** `apps/www/src/lib/daemon-api-key.ts`, `daemon-token-context.ts`, `auth-server.ts`, `daemon-thread-auth.ts`, `auth-server-daemon-token.test.ts` (tests 2, 3).
2. **Token custody helpers:** `apps/www/src/lib/daemon-token.ts` and `daemon-token.test.ts` (tests 1, 4–6).
3. **thread-status:** `thread-status/route.ts` and `route.test.ts` (tests 7–14). Test 12's alert dedupe uses the ledger for real.
4. **The refusal matrix (no route code changes):** one new file, `apps/www/src/lib/retired-daemon-token.integration.test.ts` (test 15), with real auth and the real database.
5. **Run-end endpoint:** first rebase on PR-C's final head. Then `cell-teardown/route.ts` and `cell-teardown/route.test.ts` (tests 16–23). The `cell-plan` refusal is in phase 4's file, so `cell-plan/route.test.ts` is not edited by PR-D.
6. **Full gates**, then `docs/specs/656/gate-log-d.md`.
