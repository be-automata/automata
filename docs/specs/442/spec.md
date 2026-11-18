# Spec #442: per-credential unavailability (epic #440 C2)

The ticket is the spec: <https://github.com/be-automata/automata/issues/442> (hardened on
2026-11-17; its Decisions, Scope, Acceptance Criteria, Tests and UAT sections are binding).
This file adds the verified ground truth and the design the implementation follows.

## Ground truth (verified in this worktree, `origin/main` @ `85b07e6c`)

| Claim                                                                                                                                                                                                                  | Evidence                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `agent_provider_credentials` has no availability columns                                                                                                                                                               | `packages/shared/src/db/schema.ts:1465-1515`                                                            |
| Selection = newest active row for user + org + agent                                                                                                                                                                   | `packages/shared/src/model/agent-provider-credentials.ts:229-248`                                       |
| `insertAgentProviderCredentials` takes `Omit<AgentProviderCredentialsDecrypted, "id"\|"userId"\|"organizationId"\|"createdAt"\|"updatedAt">`, so new select columns become required input keys unless they are omitted | `agent-provider-credentials.ts:27-40`, `:50-53`                                                         |
| A connect inserts a new row and deactivates the others                                                                                                                                                                 | `agent-provider-credentials.ts:83-102`                                                                  |
| The delivery route resolves through `getAndVerifyCredentials` and records nothing                                                                                                                                      | `apps/www/src/app/api/daemon/agent-credentials/route.ts:56-84`                                          |
| `getAndVerifyCredentials` has 3 callers: the route, `agent/sandbox.ts:181`, `api/internal/broadcast/sandbox/env/route.ts:63`                                                                                           | grep                                                                                                    |
| The Claude path resolves via `getClaudeCredentialsJSONOrNull` → `getAgentProviderCredentialsDecrypted` → `getAgentProviderCredentialsRecord`, returning `{contents, error}` only                                       | `apps/www/src/agent/msg/claudeCredentials.ts:353-460`                                                   |
| The worker maps 204 or any non-OK status to `built-in-credits`                                                                                                                                                         | `packages/worker/src/agent-run/www-client.ts:233-246`                                                   |
| The classifier hook sits in `handleDaemonEvent`, and `errorMessage = PROVIDER_UNAVAILABLE_ERROR` is set only when `isError && providerUnavailable` (and not prompt-too-long)                                           | `apps/www/src/server-lib/handle-daemon-event.ts:367-392`                                                |
| The chat write is `updateThreadChatWithTransition`                                                                                                                                                                     | `handle-daemon-event.ts:594`                                                                            |
| `threadChat` comes from `getThreadChat`, which selects `getTableColumns(schema.threadChat)`, so a new column is read automatically                                                                                     | `packages/shared/src/model/threads.ts:760-785`                                                          |
| A legacy chat is synthesized from the thread row and needs the new field explicitly                                                                                                                                    | `threads.ts:827-856`                                                                                    |
| **Every production thread is legacy** (`enableThreadChatCreation` defaults to false). Its chat state lives on the `thread` row, and `threadChatShared` fields exist on both tables (precedent: `queued_at`)            | `feature-flags-definitions.ts:81-85`, `schema.ts:349-374`, `deploy/migrations/2026-10-22-queued-at.sql` |
| `ThreadInfo` omits chat-shared columns (`queuedAt`), and `ThreadForThreadChatInfoFull` picks them                                                                                                                      | `packages/shared/src/db/types.ts:372-386`, `threads.ts:789-814`                                         |
| `createTestThread` defaults to a legacy thread; `enableThreadChatCreation: true` gives a `thread_chat` row                                                                                                             | `packages/shared/src/model/test-helpers.ts:131-137`                                                     |
| route.test mocks `@/agent/credentials` with only `getAndVerifyCredentials`; the oauth test injects `read` fakes typed `typeof getClaudeCredentialsJSONOrNull`                                                          | `route.test.ts:21-23`, `claudeCredentials.oauth.test.ts:101-116`, `claudeCredentials.ts:499`            |
| `resetsAt` is epoch ms                                                                                                                                                                                                 | `classify-provider-result.ts:37`                                                                        |
| Kinds are `usage_limit`, `subscription_disabled`, `credit_exhausted`, `auth_rejected`; indefinite = not `usage_limit`                                                                                                  | `apps/www/src/agent/msg/classify-provider-result.ts:24-29`, `:398-402`                                  |
| Newest migration is `2026-11-19-cell-step-last-seen`; the expected list ends there                                                                                                                                     | `deploy/migrations/`, `packages/migrate/src/expected-migrations.ts`                                     |
| No new table, so the rehome guard (`REHOME_EXCLUDED_TABLES`) does not apply                                                                                                                                            | only columns are added                                                                                  |

**Already done (do not redo):** classification, the `provider-unavailable` error, and the
per-lane notices (C1 #449 and C6 #472).

**Does not exist (checked):** the `unavailable_*` columns, `delivered_credential_id`, any mark
or resolve function, and `getAndVerifyCredentialsWithSource`.

## Design

### Migration `deploy/migrations/2026-11-20-credential-unavailable.sql`

The file is `-- migrate:expand`, with five `ADD COLUMN IF NOT EXISTS` statements (exact SQL in the
ticket). The columns are nullable, with no default, no backfill and no FK. It is added to the end
of `expected-migrations.ts`.

### `schema.ts`

- `agentProviderCredentials` gets:
  - `unavailableUntil: timestamp("unavailable_until", { mode: "date", withTimezone: true })`;
  - `unavailableReason: text("unavailable_reason").$type<CredentialUnavailableReason>()`;
  - `unavailableMarkedAt: timestamp("unavailable_marked_at", { mode: "date", withTimezone: true })`.
- `threadChatShared` gets `deliveredCredentialId: text("delivered_credential_id")`, so both
  `thread` and `thread_chat` carry it, as with `queuedAt`. The migration has five statements
  (adding `thread`). `ThreadInfo` omits it and `ThreadForThreadChatInfoFull` picks it.
- `CredentialUnavailableReason = "usage_limit" | "subscription_disabled" | "auth_rejected"` lives
  in its own type-only file, `packages/shared/src/model/credential-unavailable-reason.ts`
  (`credential-kind.ts` is scoped to kind → UI facts).

### Shared model (`agent-provider-credentials.ts`)

- **`markAgentProviderCredentialUnavailable({db, userId, credentialId, reason, until})`** →
  `Promise<boolean>` (true when the row changed). `until: Date | null`, where null means
  indefinite. It is one `UPDATE … WHERE id AND user_id AND <guard> RETURNING id`:
  - Indefinite: `SET until = NULL, reason, marked_at = now()`. The guard is
    `NOT (reason IS NOT NULL AND until IS NULL)`, so an existing indefinite mark is left as it was.
  - Timed: `SET until = $until, reason, marked_at = now()`. The guard is
    `NOT (reason IS NOT NULL AND until IS NULL) AND (reason IS NULL OR until IS NULL OR until < $until)`
    (an unmarked row, even after a half admin clear, always takes the mark). This never
    shortens a mark and never touches an indefinite one, so it is monotonic (`GREATEST`
    semantics). Concurrent marks serialise on the row lock, and READ COMMITTED re-checks the
    guard against the committed version, so the larger `until` wins.
- **`isAgentProviderCredentialUnavailable(row, now)`**: a type guard, true when
  `reason != null && (until == null || until > now)`. After the rollback SQL (both NULL), the row
  is available.
- **`resolveAgentProviderCredential({db, userId, agent, organizationId, now = new Date()})`** →
  one of:

  - `{status: "available", credential}`;
  - `{status: "credential-unavailable", credentialId, until, reason}`;
  - `{status: "none"}`.

  It is built on `getAgentProviderCredentialsRecord`, the same selection, so it can never return
  an older or inactive row.

- `insertAgentProviderCredentials` input type: also omit the three `unavailable_*` keys.

### Shared model (`threads.ts`)

- `setThreadChatDeliveredCredential({db, userId, threadId, threadChatId, credentialId: string | null})`:
  - for `LEGACY_THREAD_CHAT_ID`, `UPDATE thread SET delivered_credential_id`, fenced by the
    thread id and user_id;
  - otherwise `UPDATE thread_chat`, fenced by the chat id, thread id and user_id;
  - both keep `updated_at` as it was, and neither broadcasts.
- `createLegacyThreadChatFull` maps `thread.deliveredCredentialId`.
- Admin clear means nulling both `unavailable_until` and `unavailable_reason`.
- The id is a non-secret UUID and may reach the browser in `ThreadChatInfoFull`.

### www

- `apps/www/src/agent/credentials.ts`: `getAndVerifyCredentialsWithSource` returns
  `{credentials, credentialId: string | null}`. `getAndVerifyCredentials` delegates to it and
  returns `.credentials`, so its other callers do not change. The Claude path gets the id from
  `getClaudeCredentialsJSONOrNull`, which now also returns `credentialId`. Amp gets it from its
  row. Codex, gemini, opencode and built-in credits return `null`.
- `getClaudeCredentialsJSONOrNull` returns a **required** `credentialId: string | null` (null
  without contents), so a new success branch cannot silently skip attribution. The injected
  `read` fakes in `claudeCredentials.oauth.test.ts` supply it.
- route.test.ts mocks `getAndVerifyCredentialsWithSource`.
- The 204 branch (no agent) records nothing, which is acceptable because only claudeCode is
  classified.
- The route has no run-generation fence, so a superseded attempt's late pull can overwrite the
  id. It resolves the same newest active row, so the risk is low; noted for C3.
- Route: call the `WithSource` variant. Record the id, or `null` on **any** resolution failure
  (a `ThreadError` answers built-in credits; any other error is a 5xx, which the worker also maps
  to built-in credits), through `recordDeliveredCredential` (below). A recording failure is
  caught and logged: it must never turn into a non-OK response. The response body stays as it
  is.
- **Dispatch clear** (`apps/www/src/agent/hatchet/dispatch.ts`, `dispatchAgentRun`): before the
  trigger, and alongside `resolveHatchetConfig`, record `null`. Only a delivery made during
  this run can then attribute a mark: a run that never pulls (a shared box) or falls back to
  built-in credits marks nothing. Clearing after the trigger would race the run's credential
  pull.
- `recordDeliveredCredential({db, userId, threadId, threadChatId, credentialId, logLabel})` in
  `credential-unavailability.ts` is the one never-throwing wrapper both writers use.
- `apps/www/src/server-lib/credential-unavailability.ts` (new):
  `credentialMarkFor(provider, now)` → `{reason, until} | null`:

  - `usage_limit` → `until = new Date(resetsAt)`. When `resetsAt` is unknown or `<= now`, it is
    `now + 1 h` (`UNKNOWN_RESET_MARK_MS`);
  - `subscription_disabled` and `auth_rejected` → `until = null`;
  - `credit_exhausted` → `null`.

  `markDeliveredCredentialUnavailable({db, userId, credentialId, provider, now})` returns false
  when there is no id or no mark.

- `handleDaemonEvent`: after `updateThreadChatWithTransition`, when
  `threadChatUpdates.errorMessage === PROVIDER_UNAVAILABLE_ERROR` and the thread is on the worker
  plane (`!thread.codesandboxId`; the legacy sandbox plane never pulls through the route), call
  it with `threadChat.deliveredCredentialId` and `receivedAt`. It is awaited, so the mark is
  written before the finish path that C3's gate will follow, inside a try/catch that logs; it is
  non-fatal.

## Phases (validator round 1)

1. Migration (5 statements), `expected-migrations.ts`, `schema.ts` (`threadChatShared`), `db/types.ts` (`ThreadInfo` omit), `credential-unavailable-reason.ts` reason type.
2. Credential model: insert-type omission, mark, `isAgentProviderCredentialUnavailable`, resolve, plus model tests.
3. Thread model: legacy mapping, `setThreadChatDeliveredCredential` for both shapes, plus tests.
4. `credentials.ts` WithSource, `claudeCredentials.ts` required id, route recording, route tests (legacy and chat-mode), oauth test doubles.
5. `credential-unavailability.ts` (+ test), `handleDaemonEvent` mark, provider tests (legacy and chat-mode, credit, unclassified, no id, mid-run switch).

Tests in AC5 and AC6 cover **both** thread shapes.

## As built: changes after validate

- **Refinement:**
  - the dispatch clear (above);
  - NULL is recorded on any resolution failure;
  - the worker-plane guard on the mark;
  - the unmarked-row arm of the timed guard;
  - tests for each.
- **/simplify:**
  - one `recordDeliveredCredential` wrapper;
  - the clear runs in parallel with `resolveHatchetConfig`;
  - the type-guard helper;
  - the required Claude `credentialId`.

## Gates

- `pnpm turbo tsc-check`
- `pnpm turbo lint`
- `pnpm turbo format-check`
- the shared, www and migrate vitest suites
- `node deploy/lint-migrations.ts deploy/migrations`
- the `schema-drift` job steps of `.github/workflows/ci.yml`, run locally against Postgres 18
