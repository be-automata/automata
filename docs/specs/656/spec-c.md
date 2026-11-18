# #656 PR-C: cell-plan, the reconciler wiring with Cloudflare Access, and the adapter fixes found live

Ticket: be-automata/automata#656 (S5 of #634). This PR is "PR-C" of the 7-PR plan. Branch `feat/656-c-cell-plan-wiring`, off `main` at `08c1b194` (after PR-B #665, PR-F #666, PR-G #669 and PR-A #677).

It covers:

- Scope items 4 (client half), 7 (wiring), 12 and 13 (`cell-plan` half), and the two PR-G findings that #656's 2026-11-17 20:00 comment assigns here (label-unsafe `stepKey`, teardown not idempotent once the sidecar is gone);
- the #656 2026-11-17 21:50 comment (roborev job 1235 on #677): **`openNextAttempt` gets a caller-supplied request nonce**, so a lost response plus a retry does not burn and fence an attempt;
- AC-5 (wiring), AC-12 (client half), AC-14 (`cell-plan` half), AC-15 (`allowedRef` and budget), AC-16 (`cell-plan` half).

Out of this PR:

- the `thread-status` terminal read (`finishStep`), `stampSeen` and the run-end endpoint (PR-D);
- the worker that calls `cell-plan` and creates the cell (PR-E);
- switching `staleMs` from `null` to `CELL_LEASE_STALE_MS` (after PR-D and PR-E ship together);
- the reconciler's page-5 starvation (`gate-log-b.md:92`), the installer restart that kills live cells and the `%2F` path-fence test (`spec-g.md:514-515`): their own follow-ups.

## Ground truth (verified in this worktree at `08c1b194`)

| Fact                                                                                                                                                                                                                                                                                 | Where                                                                                                                                                                                          |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The body is `{ threadId, threadChatId, attempt, worker, epoch }`, `.strict()`; `attempt` is caller-chosen, 1 to 1000                                                                                                                                                                 | `apps/www/src/app/api/daemon/cell-plan/route.ts:47-55`                                                                                                                                         |
| `stepKey = "cell:" + apiKeyId`                                                                                                                                                                                                                                                       | `route.ts:81`                                                                                                                                                                                  |
| Order today: flag → `no_run_key` → `org_required` → parallel reads → `agent_not_supported` → **`getClaudeOauthAccessToken`** → `unknown_profile` → `egress_not_enforced` → `openStep`. The credential lookup runs before the profile and egress refusals                             | `route.ts:77-131`                                                                                                                                                                              |
| There is **no** terminal-thread refusal                                                                                                                                                                                                                                              | `route.ts` (whole file)                                                                                                                                                                        |
| `openStep` with caller `attempt`, `stepTimeoutMs: CELL_RUN_TTL_MS`, **`effectBudget: null` (`:144`)**, **`allowedRef: null` (`:146`)**                                                                                                                                               | `route.ts:136-148`                                                                                                                                                                             |
| The plan has no `daemonToken`; the response is `{ plan }` only                                                                                                                                                                                                                       | `route.ts:152-173`                                                                                                                                                                             |
| The daemon token is the request's `X-Daemon-Token` header, verified by `getDaemonTokenContext`                                                                                                                                                                                       | `apps/www/src/lib/auth-server.ts:220-237`                                                                                                                                                      |
| `apiKeyId` is the better-auth `apikey.id`. No custom `generateId` is configured, so it is better-auth's default: 32 chars of `[a-zA-Z0-9]`. `cell-` + 32 = 37 chars, label-safe                                                                                                      | `apps/www/src/lib/auth.ts:303` (the `apiKey` plugin; `drizzleAdapter` at `:137` sets no `generateId`); `node_modules/@better-auth/core/dist/utils/id.mjs:3-5`; `daemon-token-context.ts:89-90` |
| `openNextAttempt` exists: one upsert, attempt 1 then `current + 1`, stamps `last_seen_at`, refuses `step_done` / `conflict` / `attempt_limit`; **no nonce**. `stepTimeoutMs`, `effectBudget` are fixed at first open, `allowedRef` must match on every re-open (else `conflict`)     | `packages/shared/src/model/cell-authority.ts:218-275`, `classifyMiss` `:101-143`                                                                                                               |
| `CELL_MAX_ATTEMPTS = 1000`, `DEAD_READ_MAX_KEYS = 1000`                                                                                                                                                                                                                              | `cell-authority.ts:75-76`                                                                                                                                                                      |
| `deadCellAttempts({db, keys, staleMs: number \| null})` returns `Set<cellKeyId>`; `null` disables the lease rule; throws on a DB error                                                                                                                                               | `cell-authority.ts:360-410`                                                                                                                                                                    |
| `finishStep` writes a done tombstone for a never-opened step, so a later open gives `step_done`                                                                                                                                                                                      | `cell-authority.ts:315-358`                                                                                                                                                                    |
| `mintBearer` mints a new bearer for the current attempt on every call; earlier bearers of that attempt stay live                                                                                                                                                                     | `cell-authority.ts:465-474`                                                                                                                                                                    |
| `expected-migrations.ts` lists every migration id; the last is `2026-11-19-cell-step-last-seen`                                                                                                                                                                                      | `packages/migrate/src/expected-migrations.ts:32`                                                                                                                                               |
| `packages/types` has no test script or runner                                                                                                                                                                                                                                        | `packages/types/package.json`                                                                                                                                                                  |
| The tunnel's catch-all answers a bare 404 for any path outside the fence                                                                                                                                                                                                             | `packages/worker/deploy/README.md:1194`, `:1205-1206`                                                                                                                                          |
| Upstream's not-found codes end in `::SANDBOX_NOT_FOUND` (`DOCKER::SANDBOX_NOT_FOUND` for this server)                                                                                                                                                                                | upstream `constants.py:128`                                                                                                                                                                    |
| `cell-plan`'s `worker` regex `^[a-z0-9][a-z0-9-]{0,62}$` allows a trailing `-` (a label failure)                                                                                                                                                                                     | `route.ts:52`                                                                                                                                                                                  |
| `cell_step` has no nonce column; `last_seen_at` came in `2026-11-19-cell-step-last-seen.sql`                                                                                                                                                                                         | `packages/shared/src/db/schema.ts:3313-3345`; `deploy/migrations/2026-11-19-cell-step-last-seen.sql`                                                                                           |
| Effects: only `git-receive-pack` claims one (`beginEffect`), one per push generation, up to `MAX_PUSH_GENERATIONS = 20`; `effects_used` is per step and never refunded (`releaseEffect` deletes the claim row only). The GitHub API routes claim none                                | `packages/cell-broker/src/git.ts:66`, `:700-706`; `cell-authority.ts:630-636`, `:688-718`                                                                                                      |
| `CellTags` = `automata, worker, epoch, stepKey, attempt, expiresAt, deployment`; `CELL_RUN_TTL_MS = 45 min`; `CELL_LEASE_STALE_MS = 5 min`; `cellKeyId = stepKey#attempt`                                                                                                            | `packages/types/src/cell.ts:21-31`, `:94`, `:97`, `:105-107`                                                                                                                                   |
| The adapter's `assertPlanFields` checks tags for **non-blank only**: no label rule. `createBody` sends `metadata: plan.tags` whole                                                                                                                                                   | `packages/sandbox/src/providers/opensandbox-cell.ts:227-240`, `:710`                                                                                                                           |
| The adapter imports the contract **type-only**, and mirrors runtime constants locally with a sync test (`OPENSANDBOX_HEADER_NAME_PATTERN`)                                                                                                                                           | `opensandbox-cell.ts:1-25`, `:54`                                                                                                                                                              |
| `teardownStrict` runs revoke → quarantine → delete, each 404 = done, then throws the one failure or an `AggregateError`. There is **no** `GET /sandboxes/{id}` in the adapter                                                                                                        | `opensandbox-cell.ts:717-756`, `:542-556`, `:643-663`                                                                                                                                          |
| `revoke` and `quarantine` use `retry: "idempotent"`, so a 502 is retried with backoff for the whole `retryBudgetMs` (10 s) before it fails                                                                                                                                           | `opensandbox-cell.ts:30`, `:499-539`                                                                                                                                                           |
| **Upstream 1.2.1:** value `^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$`, at most 63; key name `^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$` at most 63 with an optional DNS-subdomain prefix; the prefix `opensandbox.io/` is reserved; the 400 body **quotes the offending value** | `opensandbox-group/OpenSandbox@release-1.2.1` `server/opensandbox_server/services/validators.py:51-54`, `:68-129`; `constants.py:19`, `:165` (read via `gh api`)                               |
| Live: every create with a `:` in a tag got `400 SANDBOX::INVALID_METADATA_LABEL`; a deny-all is refused while the vault holds a binding; a no-policy cell's revoke and deny-all answer **502** (no sidecar)                                                                          | `docs/specs/656/gate-log-g.md:76-78`                                                                                                                                                           |
| `teardownCell` has **no production caller** (only `cell-control.test.ts:61-98`)                                                                                                                                                                                                      | `apps/www/src/server-lib/compute/cell-control.ts:62-81`; grep of `apps/www/src`                                                                                                                |
| `runCellReconciler` passes no `isDead`                                                                                                                                                                                                                                               | `cell-control.ts:83-102`                                                                                                                                                                       |
| `cellProvider()` passes a plain `fetch` wrapper; no Access headers                                                                                                                                                                                                                   | `cell-control.ts:36-54`                                                                                                                                                                        |
| `reconcileExpiredCells` already takes `isDead?` and fails safe on a throw; limit 20, 5 pages                                                                                                                                                                                         | `packages/sandbox/src/cell/reconcile.ts:20-43`, `:105-122`                                                                                                                                     |
| The cron calls `cellProvider()` then `runCellReconciler({db, provider})`, logs any error with `console.error(..., error)`                                                                                                                                                            | `apps/www/src/server-lib/cron.ts:477-488`                                                                                                                                                      |
| The www env has `OPENSANDBOX_URL`, `_API_KEY`, `_GUEST_IMAGE`. **No Access env exists**; nothing in the repo sends `CF-Access-Client-*` (only the README names them)                                                                                                                 | `packages/env/src/apps-www.ts:110-116`; grep                                                                                                                                                   |
| The tunnel ingress is path-fenced to `^/(health\|sandboxes(/[^/]+(/(networkpolicy\|credential-vault))?)?)$`; `GET /sandboxes/{id}` passes it. Step 8 asks for "PR-C's two Access secrets", unnamed                                                                                   | `packages/worker/deploy/README.md:1196-1206`, `:1246-1262`                                                                                                                                     |
| Work branch at dispatch: plain task run, `prNumber === undefined` and `branch === repoBaseBranchName` → `remoteTaskBranchName(threadId)`; else none (the worker stays on `branch`)                                                                                                   | `apps/www/src/agent/hatchet/dispatch.ts:1194-1201`; `remote-task-pr.ts:59-61`                                                                                                                  |
| Dispatch's `branch` is `branchName ?? thread.branchName ?? thread.repoBaseBranchName`, where `branchName` is a **per-message argument `cell-plan` cannot see**                                                                                                                       | `apps/www/src/agent/msg/startAgentMessage.ts:93`, `:405-407`                                                                                                                                   |
| A cell marker is only set on plain task runs of an org thread                                                                                                                                                                                                                        | `dispatch.ts:1208-1216`                                                                                                                                                                        |
| `thread.branchName` / `githubPRNumber` change only at finish (`openRemoteTaskPullRequest`)                                                                                                                                                                                           | `remote-task-pr.ts:165`, `:304`                                                                                                                                                                |
| Terminal = `!isAgentWorking(threadChat.status)` (`draft`, `scheduled`, `stopped`, `complete`, `error`)                                                                                                                                                                               | `apps/www/src/app/api/daemon/thread-status/route.ts:73`; `apps/www/src/agent/thread-status.ts:3-28`                                                                                            |
| Nothing outside www calls `cell-plan` (grep of `packages/worker/src`, `packages/daemon/src`, `apps/cli/src`)                                                                                                                                                                         | grep                                                                                                                                                                                           |

### Existing `cell:` rows

None is expected in production, and none matters:

- nothing calls `cell-plan` (last row above), the route answers 404 unless both the env and the per-user flag are on, and the README sets `OPENSANDBOX_URL` last, after the AC-12 checks that have not run (`acceptance.json` AC-12 DEFERRED);
- even if a row exists, no cell can: every create with a `cell:` tag 400s, and the reconciler works from cells, never from rows. The row cascades with its thread.

No backfill or migration for them. The person may confirm before deploy with a read-only `select count(*) from cell_step where step_key like 'cell:%'`; the spec does not run it (no DB access).

## Decisions

1. **`stepKey = cellStepKey(apiKeyId)` = `cell-<apiKeyId>`,** one helper in `@terragon/types/cell` shared with PR-D (`spec-d.md:49`, whose interim body is `cell:`; this PR sets the label-safe one). The route refuses (`403 invalid_run_key`) any `apiKeyId` whose `stepKey` fails the label rule, so a future id format change fails closed instead of 400ing at create. The tag value and `cell_step.step_key` are the same string (PR-A's byte-equality constraint, `spec-a.md:307`).
2. **The open is idempotent by nonce.** The body gains `requestId` (required, `^[A-Za-z0-9_-]{16,64}$`). The worker (PR-E) makes one per plan fetch and reuses it for every HTTP retry of that fetch. A repeat returns the same attempt, fences nothing and does not count toward the cap. A replay revokes the earlier bearer(s) of that attempt before minting, so one bearer per attempt is live. This needs one nullable column, so this PR has a migration.
3. **`allowedRef` comes from one shared rule.** A new pure `taskRunPushBranch` in `remote-task-pr.ts` is used by both dispatch and `cell-plan`:

   - no PR and `branch === base` → `remoteTaskBranchName(threadId)`;
   - otherwise (an existing PR or a non-base branch) → `branch`;
   - `branch === base` with a PR, or a blank result → `null`, and `cell-plan` refuses `409 work_branch_unresolved`. A cell never gets its base branch as `allowedRef`.

   `cell-plan` calls it with `branch = thread.branchName ?? thread.repoBaseBranchName`. It cannot see `startAgentMessage`'s per-message `branchName`; if that override ever differs from the thread row, the broker refuses the push (fail closed). Recorded as a risk.

4. **`effectBudget = 50`** (`CELL_TASK_EFFECT_BUDGET`, a route constant). Only pushes spend it, one per generation, never refunded, shared by every attempt of the step. 50 covers a 45-minute run pushing about once a minute; a zombie loop stops at 50.
5. **`teardownCell` is removed.** No caller exists today. OD-3 moved run-end teardown into the worker; PR-D's endpoint revokes without a provider call (ticket Scope 2); the reconciler does its own revoke-first teardown inside `reconcileExpiredCells`. Keeping it would leave a ready-made www→box teardown path, the one OD-3 rejected.
6. **Access headers are added only for the configured origin over https.** Both `OPENSANDBOX_ACCESS_CLIENT_ID` and `OPENSANDBOX_ACCESS_CLIENT_SECRET` empty → plain fetch (dev, the IT server). Exactly one set, or either set with a non-`https:` `OPENSANDBOX_URL` → `cellProvider()` returns `null` and warns once with a fixed message (the reconciler no-ops, like an unset URL).

## Contract

### 1. Migration and schema (`deploy/migrations/2026-11-20-cell-step-open-nonce.sql`, `packages/migrate/src/expected-migrations.ts`, `packages/shared/src/db/schema.ts`)

- `-- migrate:expand`; `ALTER TABLE "cell_step" ADD COLUMN IF NOT EXISTS "open_nonce" text;` Nullable, no default, no backfill. The header says it must reach prod before this revision (migrate.yml does so on green main); `assert-schema-ready` enforces it.
- The file name sorts after PR-A's `2026-11-19-cell-step-last-seen.sql`. `expected-migrations.ts` gains `"2026-11-20-cell-step-open-nonce"` after `:32`.
- `cellStep.openNonce: text("open_nonce")`, with a comment: the request nonce of the open that made the current attempt; null = opened without one.
- Must pass `node deploy/lint-migrations.ts` and the `schema-drift` job.

### 2. Authority (`packages/shared/src/model/cell-authority.ts`)

`openNextAttempt({ db, step: { …, nonce?: string } })`:

- `nonce`, when given, must match `^[A-Za-z0-9_-]{16,64}$` (`RangeError` otherwise, message names the field only).
- **Insert:** `openNonce: nonce ?? null`.
- **On conflict, set:** `currentAttempt = CASE WHEN open_nonce IS NOT NULL AND open_nonce = $nonce THEN current_attempt ELSE current_attempt + 1 END`, `openNonce = $nonce`, `lastSeenAt = now()`.
- **Where:** today's clauses, with the cap relaxed for a replay: `(current_attempt < 1000 OR open_nonce = $nonce)`.
- **One live bearer per attempt on a replay (decided).** `openNextAttempt` returns `{ ok: true, attempt, replayed: boolean }`. On `replayed: true` the route calls a new `revokeAttemptBearers({ db, stepKey, attempt })` (deletes or expires every `cell_bearer` row of that step and attempt) **before** `buildCellCreatePlan` mints the new one. The lost response's bearer therefore dies; the step and attempt are not revoked. `replayed` cannot come from `RETURNING` (it sees only new values before Postgres 18; dev runs 16), so when `nonce` is given the open runs in one transaction that first reads `open_nonce` with `SELECT … FOR UPDATE` by primary key, then upserts; `replayed` = the row existed and its `open_nonce` equalled `nonce`. Without `nonce`, it stays PR-A's single statement.
- A replay on a done step still gives `step_done` (the `done_at IS NULL` clause is unchanged); a replay of a revoked attempt returns it, and `mintBearer` then refuses (`bearer_refused`).
- Without `nonce` the behaviour is exactly PR-A's. `openStep` does not touch `open_nonce`.
- The doc comment's "not idempotent" note (and `spec-a.md:315`'s accepted behaviour) becomes "idempotent per nonce".

### 3. Types (`packages/types/src/cell.ts`)

- `CELL_LABEL_VALUE_PATTERN = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/`, `CELL_LABEL_MAX_LENGTH = 63`, and `isCellLabelValue(v: string): boolean` (non-empty, length, pattern). Doc comment cites upstream `validators.py:51-54,88-91`.
- **`cellStepKey(apiKeyId: string): string`** returns `` `cell-${apiKeyId}` ``: the one derivation of a cell run's `cell_step.step_key` and its `stepKey` tag (byte-equal). `cell-plan` (this PR) and PR-D's `thread-status` and `cell-teardown` import it; none builds the key by hand or reads it from a body. It does not validate (callers check `isCellLabelValue` on the result, so the refusal code stays the caller's). If PR-D merges first with the interim `cell:` body (`spec-d.md:50`, `:77-79`), this PR changes only the helper's body.
- Tests: `packages/types` has no test runner, so they go in `packages/sandbox/src/providers/opensandbox-cell.test.ts` (next to the pattern sync test): `cellStepKey("abc")` is `cell-abc`; for a 32-char better-auth id the result passes `isCellLabelValue`; a 59-char id fails it (64 chars).

### 4. Adapter (`packages/sandbox/src/providers/opensandbox-cell.ts`)

- **Label guard.** A local `OPENSANDBOX_LABEL_VALUE_PATTERN` (kept equal to `CELL_LABEL_VALUE_PATTERN` by a sync test, the file's type-only precedent). In `assertPlanFields`: every key of `plan.tags` must be a label name (no `/`, so no prefix and never `opensandbox.io/`), and every value (`worker`, `epoch`, `stepKey`, `attempt`, `expiresAt`, `deployment`, `automata` and any extra) a non-empty label value of at most 63 chars. This catches a `worker` ending in `-`, which `route.ts:52` lets through. Else `CellProviderError("invalid_plan", "create")` before any HTTP call. The value is never echoed (the upstream body would quote it).
- **Idempotent teardown.** New private `exists(cellId): Promise<boolean>`: `GET /sandboxes/{id}`, `retry: "idempotent"`. It returns false **only** for a 404 whose JSON body carries a code ending in `::SANDBOX_NOT_FOUND` (top-level `code` or `detail.code`, read capped like `bodyCode`). A bare 404 (the tunnel catch-all, `README.md:1194`, `:1205-1206`) or any other answer throws `http_error`. 2xx → true. The live IT records the real body shape.
  - `teardownStrict`: run the three steps as today. If any failed, poll `exists` within `retryBudgetMs`; once it returns false, resolve (the cell and its sidecar are gone, so there is no vault or route left). Otherwise throw the original failure or `AggregateError`, unchanged.
  - A repeat teardown of a deleted cell: revoke, quarantine and delete each 404 → resolved with no `GET`.
  - The internal `teardownSteps` (create's cleanup) is unchanged.
- **Header comment** on `quarantine`: a deny-all is refused while the vault holds a binding, so callers revoke first; `teardown` already does (gate-log-g run 3).

### 5. Plan route (`apps/www/src/app/api/daemon/cell-plan/route.ts`)

**Body:** `{ threadId, threadChatId, worker, epoch, requestId }`, `.strict()`. `attempt` is gone: a body that still sends it is `400 invalid_body`.

**Order** (every refusal before the first mutation; each logs the outcome code only):

1. auth (`authorizeDaemonThreadRequest`), body → 400;
2. `cells_disabled` 404;
3. `no_run_key` 403 (null `apiKeyId`, or a null `X-Daemon-Token` header, unreachable after auth); `stepKey = cellStepKey(apiKeyId)`; `invalid_run_key` 403 when `!isCellLabelValue(stepKey)`;
4. `org_required` 403;
5. `deployment = cellBrokerHost()`; `invalid_deployment_tag` 409 when `!isCellLabelValue(deployment)` (a host over 63 chars); `invalid_body` 400 when `worker` fails `isCellLabelValue` (the zod regex allows a trailing `-`);
6. the parallel reads (unchanged);
7. `agent_not_supported` 422;
8. **new** `thread_terminal` 409 when `!isAgentWorking(threadChat.status)`;
9. **moved up** `unknown_profile` 409, `egress_not_enforced` 409;
10. **new** `work_branch_unresolved` 409 (Decision 3); `allowedRef = "refs/heads/" + branch`;
11. `getClaudeOauthAccessToken` → `no_model_credential` 422;
12. `openNextAttempt({ stepKey, organizationId, threadId, stepTimeoutMs: CELL_RUN_TTL_MS, effectBudget: CELL_TASK_EFFECT_BUDGET, allowedRef, nonce: requestId })` → `step_done` / `conflict` / `attempt_limit` 409; on `replayed`, `revokeAttemptBearers` first;
13. `buildCellCreatePlan({ …, attempt, ttlMs: CELL_RUN_TTL_MS, tags: { worker, epoch, deployment }, daemonToken })` → `CellPlanError` 409.

**Response:** `200 { attempt, plan }`, no-store. Logs carry `threadId`, `stepKey`, `attempt` (once known) and `outcome`, never a body, token or ref.

The route exports only `dynamic` and `POST`: Next's app-route export check forbids other names, which is why the branch rule lives in `remote-task-pr.ts`.

### 6. Branch rule (`apps/www/src/server-lib/task/remote-task-pr.ts`, `apps/www/src/agent/hatchet/dispatch.ts`)

- `taskRunPushBranch({ threadId, prNumber, branch, baseBranch }): string | null` per Decision 3.
- `dispatch.ts:1196-1201` becomes `const push = taskRunPushBranch({ threadId, prNumber, branch, baseBranch: thread?.repoBaseBranchName })` and `workBranch = isPlainTaskRun && push !== null && push !== branch ? push : undefined`. That is today's rule exactly (the helper differs from `branch` only in the base-branch case). `dispatch.test.ts` must pass untouched.

### 7. Control plane (`apps/www/src/server-lib/compute/cell-control.ts`)

- **Remove** `teardownCell` (Decision 5); `revokeAttempt` stays imported for the reconciler's `revoke`, and `deadCellAttempts` is added.
- `runCellReconciler` passes `isDead: (keys) => deadCellAttempts({ db, keys, staleMs: CELL_RECONCILE_STALE_MS })`, with `const CELL_RECONCILE_STALE_MS: number | null = null` and a comment: `null` until PR-D's and PR-E's stamps ship in the same deploy, then `CELL_LEASE_STALE_MS` (PR-A constraint, `spec-a.md:308`).
- `accessFetch({ origin, clientId, clientSecret }): typeof fetch` (module-private):
  - refuses a request whose URL origin is not `origin` (fixed-message `Error`, no URL in it);
  - copies `init.headers` into a `Headers`, sets `CF-Access-Client-Id` and `CF-Access-Client-Secret`, forces `redirect: "manual"` (an Access 302 becomes a non-ok response, `http_error`, instead of following to the login page with the headers);
  - calls the global `fetch` unbound (workerd).
- `cellProvider()` applies Decision 6. Neither the wrapper nor the provider logger ever receives a header value.
- Header comment updated: www lists, revokes and tears down for the reconciler only; the worker creates and tears down at run end (OD-3).

### 8. Env and runbook (`packages/env/src/apps-www.ts`, `packages/worker/deploy/README.md`)

- `OPENSANDBOX_ACCESS_CLIENT_ID`, `OPENSANDBOX_ACCESS_CLIENT_SECRET`: `str({ default: "", allowEmpty: true })`. Comment: secrets, never logged; `OPENSANDBOX_URL` is the Access-protected tunnel hostname (`https://<host>`, README "OpenSandbox cells" steps 3-8), not the box's loopback.
- README step 8: name the two secrets and add that both must be set before `OPENSANDBOX_URL`, and that a half-set pair keeps the reconciler off (with its warn line).

## Acceptance (this PR)

| AC                           | What this PR proves                                                                                                                                                                             | Where                                                                                    |
| :--------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| AC-5 (wiring)                | The reconciler reaps a revoked, fenced or done attempt's unexpired cell through `deadCellAttempts`; leaves a live one; a read throw reaps expired only; the lease rule is off (`staleMs: null`) | `cell-control.test.ts`; the core stays PR-A's and PR-B's                                 |
| AC-12 (client half)          | Every reconciler request carries both Access headers, only to the configured origin, over https, never logged; half-config keeps it off                                                         | `cell-control.test.ts`. The 403 half is the box check (README step 7), run by the person |
| AC-14 (`cell-plan` half)     | Two opens give attempts 1 and 2 and attempt 1's bearer is refused; a repeat `requestId` gives the same attempt and fences nothing; a terminal thread is refused                                 | `route.test.ts`, `cell-authority.test.ts`                                                |
| AC-15 (`allowedRef`, budget) | The step row holds `refs/heads/automata/task-<id8>` (base-branch run) or `refs/heads/<branch>` (existing PR); never the base; budget 50                                                         | `route.test.ts`, `remote-task-pr.test.ts`. The push itself is PR-E and the UAT           |
| AC-16 (`cell-plan` half)     | `plan.ttlMs` and the row's `step_timeout_ms` both equal `CELL_RUN_TTL_MS`                                                                                                                       | `route.test.ts`                                                                          |

## Tests (negative controls marked NC)

- **Label guard (adapter, unit):** a `stepKey` of `cell:x`, a 64-char value, a value ending in `-`, a `worker` of `w1-` (trailing `-`), an empty value, an extra key `opensandbox.io/x` and an extra key with `:` are each `invalid_plan` with **zero fetches** (NC: the same plan with `cell-x` creates). The error and every logger call omit the value. Sync test: the local pattern equals `CELL_LABEL_VALUE_PATTERN`.
- **`isCellLabelValue` (in `opensandbox-cell.test.ts`; types has no runner):** the 63/64 boundary, dots and underscores inside, non-alphanumeric ends, empty.
- **Idempotent teardown (adapter, unit):**
  - revoke 502, quarantine 502, delete 204, `GET` 404 → resolves; the calls are the three steps then `GET` (NC: `GET` 200 → rejects with the `AggregateError` of the two 502s);
  - revoke and quarantine 502, delete 500, `GET` 404 → resolves (the cell is gone anyway);
  - a second teardown of a deleted cell (all three 404) resolves with no `GET`;
  - `GET` 500 or a transport failure → the original error, never swallowed (NC);
  - `GET` 404 with an empty or non-OpenSandbox body (the tunnel catch-all) → still rejects (NC); 404 with `{"code":"DOCKER::SANDBOX_NOT_FOUND"}` resolves;
  - no error message, `JSON.stringify(error)` or log contains the API key (canary).
- **Nonce (shared, DB):**
  - same nonce twice → same attempt, `replayed: true`, `last_seen_at` restamped, no fence; after `revokeAttemptBearers` plus a new mint, the first bearer is refused and the second verifies (exactly one live bearer for the attempt; NC: without the revoke both verify);
  - a new nonce → `current + 1`, the old bearer is refused (NC for the above);
  - a nonce replay at attempt 1000 succeeds; a new nonce there is `attempt_limit`;
  - a replay after `finishStep` → `step_done`;
  - concurrent opens with one nonce → one attempt; with two nonces → two consecutive attempts;
  - no nonce → PR-A's behaviour (its existing tests pass unchanged); a malformed nonce → `RangeError`.
- **Route (www, DB):**
  - the plan's `tags.stepKey` is `cell-<apiKeyId>` and equals the row's `step_key` byte for byte; the response carries `attempt`;
  - `invalid_run_key` for an `apiKeyId` with `:` or of 60 chars, with no step row (NC: a 32-char alphanumeric id plans);
  - `thread_terminal` for each of `complete`, `error`, `stopped`, `draft`, `scheduled`, no step row, **and the credential lookup never called** (NC: `booting` plans);
  - **refusal order:** `unknown_profile` and `egress_not_enforced` with `getClaudeOauthAccessToken` **not called** (spy; fails on today's order); `work_branch_unresolved` likewise;
  - the daemon vault entry is `buildDaemonVaultEntry(cellBrokerHost(), <header token>)` exactly; no log line contains the daemon token, model token or bearer (canary header value);
  - the row's `allowed_ref` and `effect_budget` (both branch cases; NC: a PR thread whose `branchName` is null is refused, never `refs/heads/<base>`);
  - `ttlMs` and `step_timeout_ms` equal `CELL_RUN_TTL_MS`;
  - 400 for `worker: "w1-"` (NC: `w1` plans);
  - 400 for a body with `attempt`, without `requestId`, or with a bad `requestId`;
  - `route.test.ts:204-215` rewritten: nonce A opens 1, nonce B opens 2 and bearer 1 is refused; replaying B returns 2, bearer 2 (from the first B call) is refused and the replay's bearer verifies; replaying A (no longer the current attempt's nonce) opens 3. All asserted, because a nonce only matches the current attempt.
- **Branch rule (www, unit):** the four cases of `taskRunPushBranch`, and `dispatch.test.ts` unchanged.
- **Control plane (www, unit):**
  - `isDead` is wired: `deadCellAttempts` called with `staleMs: null` and the unexpired keys; a dead-named cell is reaped revoke-first; an unnamed one is kept (NC); a throwing `deadCellAttempts` reaps expired only;
  - Access: every request the provider sends during a reconciler run (list, revoke, quarantine, delete, `GET`) carries both headers with the configured values and `redirect: "manual"`; a foreign-origin URL is refused with no fetch (NC); both empty → no Access header; one set, or `http:` with both set → `cellProvider()` is `null` and one fixed warn;
  - no `console.*` call, cron error or thrown message contains the client secret (canary through a failing server, through `runCellReconcilerSafe`'s path);
  - `teardownCell` is gone (the import fails to compile, so the old tests are deleted with it).

## Gates (worktree root)

- `pnpm install --frozen-lockfile --prefer-offline`.
- `node deploy/lint-migrations.ts`; `pnpm --filter @terragon/migrate test`.
- `pnpm --filter @terragon/docs exec fumadocs-mdx`, then `pnpm turbo tsc-check --force` and `pnpm turbo lint --force`.
- `pnpm turbo format-check` (or prettier `--check` on the changed files).
- `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` (the nonce tests; Docker Postgres, or `TEST_DATABASE_ADMIN_URL`).
- `pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism`.
- `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`.
- **Live:** `OPENSANDBOX_IT=1 pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism src/providers/opensandbox-cell.integration.test.ts`. It needs Docker, so it runs **outside the Claude sandbox**. New scenario next to AC-8's negative control: `provider.teardown(id)` on the no-policy control resolves (502s then `GET` 404), and a second `teardown` resolves; record the elapsed time (expected about 2 × the 10 s budget) in `NOTES`. Results go in `docs/specs/656/gate-log-c.md`.
- The schema-drift CI job (migration vs `schema.ts`).

## Risks

- **Migration ordering.** `openNextAttempt` writes `open_nonce`, so the column must be in prod before this www deploys. migrate.yml applies it on green main and `assert-schema-ready` fails the deploy otherwise.
- **Branch drift.** `cell-plan` sees the thread row, not `startAgentMessage`'s per-message `branchName`. A mismatch makes the broker refuse the push (fail closed), never widen it. If the UAT shows it, the follow-up is to carry the work branch on the step at dispatch.
- **`allowedRef` is fixed per step.** A redelivered run re-derives it; the thread row does not change mid-run (only at finish), so it matches. If it ever differs, `openNextAttempt` says `conflict` (409) and the run fails closed.
- **502 teardown cost.** A cell whose sidecar is gone costs about 20 s and up to ~15 subrequests in the cron. Rare (production cells always have a policy); the reconciler's limit of 20 bounds it.
- **Delete may be asynchronous.** If a deleted cell still answers `GET` 200 within the budget, teardown keeps failing and the next tick retries; the live IT measures it.
- **Budget too small.** 50 pushes per step; an exhausted budget answers 429 at the broker, visible in the run. Raise the constant if the UAT shows it.
- **Rollback:** revert the www revision; the column stays (expand only). Or unset `OPENSANDBOX_URL` / the flag: runs take today's path and the reconciler no-ops.

## Phases (the validator's order, at most 5 files each)

1. **Nonce:** `deploy/migrations/2026-11-20-cell-step-open-nonce.sql`, `packages/migrate/src/expected-migrations.ts`, `packages/shared/src/db/schema.ts`, `cell-authority.ts` (nonce, `replayed`, `revokeAttemptBearers`), `cell-authority.test.ts`.
2. **Types and adapter:** `packages/types/src/cell.ts` (`cellStepKey`, label helpers), `opensandbox-cell.ts`, `opensandbox-cell.test.ts` (also holds the `cellStepKey` / `isCellLabelValue` tests).
3. **Branch rule:** `remote-task-pr.ts`, `remote-task-pr.test.ts`, `dispatch.ts`.
4. **Route:** `cell-plan/route.ts`, `cell-plan/route.test.ts`.
5. **Control plane and env:** `cell-control.ts`, `cell-control.test.ts`, `packages/env/src/apps-www.ts`, `packages/worker/deploy/README.md`.
6. **Live gate:** `opensandbox-cell.integration.test.ts`, `docs/specs/656/gate-log-c.md`.
7. **Full gates.**

## Merge order and hand-offs

- **PR-C merges before PR-D; PR-D stacks on PR-C.** PR-C owns `cellStepKey` in `packages/types/src/cell.ts` and the removal of `teardownCell` (`cell-control.ts` and its test). PR-D drops both from its own diff and only imports `cellStepKey`.
- `spec-d.md:192` says PR-C turns the lease rule on; that is being corrected in spec-d. PR-C passes `staleMs: null`; the rule turns on only after PR-D's and PR-E's stamps ship together.
- **PR-E:** reuse a `requestId` only for an HTTP retry of a plan fetch whose response was lost **and before any create was sent for it**. Once a create has gone out, a new fetch uses a new `requestId` (a new attempt), or two cells would share one attempt. A replay's plan carries a new bearer; the earlier one is revoked.

## Addendum: the open sequence fence (roborev job 1253)

This supersedes the "one live bearer per attempt on a replay" mechanics in Contract 2 and step 12 above (`revokeAttemptBearers` was removed; the nonce is required).

- **Why.** With a replacing mint alone, a slow request R1 that finishes AFTER its retry R2 (same `requestId`) replays the open and deletes B2, the bearer the worker actually received.
- **Column.** `open_seq integer NOT NULL DEFAULT 0` (metadata-only on PG11+), added in the same unapplied migration `2026-11-20-cell-step-open-nonce.sql` (still `-- migrate:expand`) and `cellStep.openSeq`.
- **Open.** Every `openNextAttempt` (advance or replay) increments `open_seq` under the step's advisory lock and returns it: `{ ok: true, attempt, openSeq, replayed? }`.
- **Mint.** `mintBearer({ replaceOthers: { openSeq } })` runs in one transaction under the same lock. If `cell_step.open_seq !== openSeq` it returns `{ ok: false, reason: "superseded" }` with no delete and no insert; otherwise it deletes the attempt's other bearers and inserts the new one.
- **Route.** `cell-plan` passes `opened.openSeq` to the mint; a superseded mint answers `409 superseded` (the worker already moved on to the newer response).
- **Tests (shared, DB).** (a) R1 opens (seq 1), R2 replays (seq 2) and mints B2, then R1's mint is `superseded`, B2 verifies and exactly one bearer row remains; (b) in order, R1 mints B1 then R2 replays and mints B2: B1 dead, B2 live; (c) a non-replay advance still fences the old attempt's bearers; concurrent replays leave exactly one live bearer.

## Premises from the brief that did not hold

- `effectBudget: null` is `route.ts:144`, not `:143` (`:143` is `stepTimeoutMs`).
- "Derive `allowedRef` via `remoteTaskBranchName`" covers only the base-branch case, and `cell-plan` cannot see the per-message branch dispatch uses (`startAgentMessage.ts:405-407`). A PR thread with a null `branchName` would yield the base branch.
- The adapter has no label guard today (`gate-log-g.md:76`'s "code PR-B shipped" refers to PR-B's error code, not a guard).
- `stepKey` is not the only tag at risk: `deployment` is a hostname and may exceed 63 chars.
- A no-policy teardown does not fail fast: each 502 is retried for the full 10 s budget first.
- The brief omits the latest #656 comment: the nonce is PR-C scope, so PR-C ships a migration and touches shared, not only www and sandbox.
