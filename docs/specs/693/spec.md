# #693: the cell's daemon credential is event-only, and the sidecar's path match is proven against path confusion

Ticket: be-automata/automata#693 (hardened in place on 2026-11-18 with a Decision section, Scope, Out of scope and a definition of done). Branch `fix/693-cell-token-path-confusion`, off `origin/main` at `96c28905`. This is a sensitive change: it touches daemon-token auth.

## Problem

Inside a cell, the run's daemon token is supposed to work only on `POST /api/daemon-event`. Today the only thing enforcing that is the OpenSandbox sidecar's exact path match on the vault binding. The vault holds the worker's own token, and that token also opens `cell-plan`. A `cell-plan` response carries the user's Claude OAuth token and a fresh broker bearer. The token also opens `thread-status`, `next-message`, the model proxies and the rest of the daemon protocol. The live gate tries three near-miss paths and no path-confusion cases. No bypass has been shown.

## Decision (taken 2026-11-18, final)

The ticket's option 2(a): **a narrower cell credential.**

- `cell-plan` mints a second, event-scoped daemon token for the vault.
- `verifyDaemonApiKey` refuses that token by default.
- Only `/api/daemon-event` opts in.

The decision extends ADR-003 F1/F2 and applies ADR-014 Amendment §4 "Narrowest scope". Neither the DB schema nor the worker or guest changes.

## Ground truth at `96c28905`

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Where                                                                                                                                                           |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cell-plan` reads the caller's `X-Daemon-Token` and puts that same string in the plan as `daemonToken`                                                                                                                                                                                                                                                                                                                                                 | `apps/www/src/app/api/daemon/cell-plan/route.ts:97-100`, `:202`                                                                                                 |
| The daemon vault entry: host = broker, `paths: [CELL_DAEMON_EVENT_PATH]`, `apiKey` on `X-Daemon-Token`, the fixed placeholder                                                                                                                                                                                                                                                                                                                          | `packages/shared/src/model/cell-create-plan.ts:97-110`; constants `packages/types/src/cell.ts:40,42,44`                                                         |
| The adapter emits `match.paths` verbatim and a header-only substitution                                                                                                                                                                                                                                                                                                                                                                                | `packages/sandbox/src/providers/opensandbox-cell.ts:298-330` (`bindingAuth` :309, `vaultBody`)                                                                  |
| `cell-plan` refuses before its first mutation, `openNextAttempt` (`:176`); the plan is built at `:191`; `CellPlanError` and `CellEgressNotEnforcedError` are caught after the open                                                                                                                                                                                                                                                                     | `route.ts:176-236`                                                                                                                                              |
| Every daemon-token check goes through `verifyDaemonApiKey`, which already refuses one class of token by default (`allowRetired`, a name suffix)                                                                                                                                                                                                                                                                                                        | `apps/www/src/lib/daemon-api-key.ts:45-84`                                                                                                                      |
| Callers: `getDaemonTokenContext` (`auth-server.ts:220-238`), which is used by `daemon-event`, `thread-status`, `next-message`, `egress-event`, `parseDaemonRequest` (run-terminal, run-staleness, run-credential-source), `authorizeDaemonThreadRequest` (agent-credentials, cell-plan, cell-teardown), the internal broadcast routes (`getUserIdOrNullFromDaemonToken`) and the CLI router. The four model proxies call `verifyDaemonApiKey` directly | `git grep -n "verifyDaemonApiKey\|getDaemonTokenContext" apps/www/src`                                                                                          |
| `daemon-event` does not use `ctx.apiKeyId`. It checks F1 (`tokenType`) and F2 (`threadChatId`, `threadId`), then passes only `userId`                                                                                                                                                                                                                                                                                                                  | `apps/www/src/app/api/daemon-event/route.ts:18-41`                                                                                                              |
| The worker's run token is minted with `name = daemonRunKey` (`${threadId}:${threadChatId}`)                                                                                                                                                                                                                                                                                                                                                            | `apps/www/src/agent/hatchet/dispatch.ts:947`; `daemon-token.ts:36-44`                                                                                           |
| The api-key plugin caps names at 64 (`maximumNameLength: 64`). Its minimum `expiresIn` is 1 day. A retire renames and caps `expires_at` by a direct UPDATE                                                                                                                                                                                                                                                                                             | `apps/www/src/lib/auth.ts:309-318`; `daemon-token.ts:150-182`                                                                                                   |
| The per-thread sweep deletes names `LIKE '${threadId}:%'`                                                                                                                                                                                                                                                                                                                                                                                              | `daemon-token.ts:215-226`; caller `server-lib/supersede-sweep.ts:599`                                                                                           |
| The terminal cell read: `finishStep`, then `retireDaemonTokenById`. After that the worker's token 401s on `thread-status`, so a retry cannot come back                                                                                                                                                                                                                                                                                                 | `apps/www/src/app/api/daemon/thread-status/route.ts:189-240`                                                                                                    |
| `cell-teardown` accepts the retired token; `revoke` calls `revokeAttempt(stepKey, attempt)`; `report` deletes a retired token                                                                                                                                                                                                                                                                                                                          | `apps/www/src/app/api/daemon/cell-teardown/route.ts:87-152`                                                                                                     |
| `CELL_RUN_TTL_MS` = 45 min                                                                                                                                                                                                                                                                                                                                                                                                                             | `packages/types/src/cell.ts:94`                                                                                                                                 |
| The worker side of `cell-plan` and `cell-teardown` is not wired yet (no caller in `packages/worker/src`)                                                                                                                                                                                                                                                                                                                                               | `git grep -n "cell-plan\|cell-teardown" packages/worker/src` is empty                                                                                           |
| The live gate's daemon scenario: three near misses through `https_headers` (Python `urllib`)                                                                                                                                                                                                                                                                                                                                                           | `packages/sandbox/src/providers/opensandbox-cell.integration.test.ts:783-823`; probe `packages/sandbox/src/providers/opensandbox-it/harness.ts:233-238,421-436` |
| The existing DB-backed "refused everywhere" matrix, real auth                                                                                                                                                                                                                                                                                                                                                                                          | `apps/www/src/lib/retired-daemon-token.integration.test.ts`                                                                                                     |

**Upstream: OpenSandbox `release-1.2.1`, `components/egress/mitmscripts/system.py`, read via `gh api`.** The order is what matters.

1. **Authority gate.** Before any binding is selected, HTTP/1 `Host` is validated strictly (`_live_h1_authority` :1693). The authority must equal the connection SNI and the admission token's SNI, or the request gets 403 (:2003-2021). This covers a `Host` that differs from SNI and an absolute-form target that names another authority. **Live correction (2026-11-18, see the gate log):** an absolute-form target naming another authority than `Host` is not refused; it is injected and still answered by the bound host.
2. **Binding selection.** `_select_binding` matches the raw `flow.request.path` with the query removed (`_request_path` :1187). A non-wildcard pattern needs string equality (`_path_matches` :1326). A request that matches no binding is "ordinary egress traffic … left untouched, including paths whose encoding would be ambiguous" (`_apply_vault_binding` :2112-2124).
3. **Ambiguity rejection.** Only for a request that did match a binding, `_reject_ambiguous_binding_path` (:2085) refuses two kinds of path:
   - a path with a `..` segment, a backslash or `%5c` at any decode depth (`_path_is_ambiguous` :1195);
   - a path whose decoding at any depth changes the set of matched bindings (`_path_decoding_changes_binding` :1243).

Two bindings that can match one request are refused at vault load (`components/egress/pkg/credentialvault/vault.go:1358-1380`). The sidecar adds the header even when the guest omits the placeholder (`docs/specs/656/gate-log-b.md`).

What follows: with one exact-path daemon binding, every confused path whose raw form is not literally the bound path passes through **untouched** (no token), a `Host` that differs from SNI gets 403, and a foreign absolute-form target is injected but answered by the bound host (live, 2026-11-18). Only two forms are injected, by design: the bound path with a query, and a same-authority absolute-form target. www routes both to `daemon-event`. HTTP/2 has its own identity gate (`_live_h2_authority`); the raw probe is HTTP/1.1 only, so h2 stays uncovered by the live gate, and the gate log says so.

## Design

### 1. The event-scoped token (`apps/www/src/lib/daemon-token-context.ts`, `daemon-token.ts`)

- Constants: `DAEMON_EVENT_SCOPE = "daemon-event"` and `CELL_EVENT_TOKEN_INFIX = ":cell-event:"`.
- `isEventScopedKey({ name, metadata })` is true when `metadata.scope === "daemon-event"` **or** the name contains `:cell-event:`. The name check fails closed if the metadata ever fails to round-trip. Only the owner of a token so named would be affected.
- **The name is bound to the cell step:** `cellEventTokenName({ threadId, threadChatId, stepKey, attempt })` is `${daemonRunKey}:cell-event:${stepKey}:${attempt}`.
  - `stepKey` is `cellStepKey(workerApiKeyId)` (`packages/types/src/cell.ts:122`).
  - Two runs of one thread therefore never share a name, although `attempt` restarts at 1 for each step. Without it, run A's late teardown would delete run B's live token.
  - The name passes the 64-character cap only through the direct UPDATE below, as `:retired` does.
- `mintCellEventToken({ userId, threadId, threadChatId, stepKey, attempt })`:
  1. `auth.api.createApiKey` with no name, `expiresIn` 1 day (the plugin minimum), and metadata `{ organizationId?, threadChatId, threadId, tokenType: "daemon", scope: "daemon-event" }`. It shares one helper with `mintDaemonToken`.
  2. One UPDATE fenced by id and owner sets the name and caps `expires_at` at `LEAST(expires_at, now() + CELL_RUN_TTL_MS)` in UTC. A failure deletes the new row and rethrows.
  - **It deletes nothing else.** Earlier tokens are superseded only after the plan wins (below).
- `supersedeCellEventTokens({ …step, keepApiKeyId })` deletes the step's cell tokens **created before** `keepApiKeyId`. "Older than mine", not "every other one", so two racing replays converge on the newest token instead of deleting each other's. A same-millisecond tie leaves both, each event-only and capped.
- `revokeCellEventTokens({ …step, attempt? })` deletes one attempt's token, or the whole step's.
- Every delete goes through `deleteDaemonTokens`: owner-fenced, one log line, ids only. LIKE patterns are escaped with `escapeLikePattern`.

### 2. Default refusal (`daemon-api-key.ts`, `auth-server.ts`)

- `verifyDaemonApiKey(token, { allowRetired, allowEventScoped })`. An event-scoped key without `allowEventScoped` is refused like an unknown key: it returns `null`, which means 401, and logs `"Unauthorized", "reason", "event-scoped token"`. The order is unknown → verify → retired → event-scoped.
- `getDaemonTokenContext`'s `opts` take the same `DaemonApiKeyOptions`.
- `/api/daemon-event` is the only caller that passes `allowEventScoped: true`.

### 3. `cell-plan`

1. The `X-Daemon-Token` header read goes. `ctx.apiKeyId === null` still answers 403 `no_run_key`.
2. A cell token is refused at `authorizeDaemonThreadRequest` → `getDaemonTokenContext` → `verifyDaemonApiKey` with 401, before anything else.
3. After `openNextAttempt` succeeds, it calls `mintCellEventToken({ …, stepKey, attempt })` and passes `daemonToken: cell.token`.
4. If the build throws, this call's token is deleted by id before the refusal or the rethrow. That covers `bearer_refused`/`superseded` and `CellEgressNotEnforcedError`. A failed delete is logged.
5. After the build succeeds, which means `mintBearer` won, it calls `supersedeCellEventTokens`. A failure there is logged and does not fail the plan: the leftovers are event-only and capped.
6. A mint throw propagates (5xx), and the worker's retry with the same `requestId` replays the open.

### 4. Revocation points

- **Re-plan:** the supersede after a winning plan. Every older token of the step goes, including earlier attempts and a replay's earlier response.
- **Terminal cell read (`thread-status` `cellPoll`):** after `finishStep` returns true and **before** `retireDaemonTokenById`, it calls `revokeCellEventTokens` for the step. A throw answers 500 `cell_revoke_failed`, and because the worker's token is not yet retired, the retry is accepted. On the `cell_step_conflict` branch, the step's cell tokens are revoked in the same `waitUntil` as the plain revoke.
- **`cell-teardown`:** `revoke` and `report` delete that step's token for that attempt. A throw on `revoke` answers 500 `revoke_failed`, the existing code. On `report` the revoke rides `waitUntil` with the retired-token delete.
- **Sweep:** `revokeDaemonTokensForThread` already matches `${threadId}:%`.
- **Backstop:** the 45-minute cap. This also covers the paths that never revoke cell tokens: `revokeDaemonTokensForSandbox` (in-process sandbox runs, which have no cell) and the non-cell terminal branch of `thread-status`.

### 5. The live gate (`packages/sandbox/src/providers/opensandbox-it/harness.ts`, `opensandbox-cell.integration.test.ts`)

- **A new probe kind, `https_raw`.**
  - It opens a TLS connection to `host:443` with SNI `host`, and writes one raw HTTP/1.1 `POST <target>` with `Host: <hostHeader ?? host>`, the headers, `Content-Length: 0` and `Connection: close`.
  - It reads at most 200,000 bytes and retries 429 and 503 like `https_headers`.
  - Only the status and one boolean per marker leave the guest.
  - `urllib` cannot send an absolute-form target or a `Host` that differs from SNI, so a raw probe is needed.
- **The control, a raw POST to the literal bound path, must get the canary.** This proves the probe can see an injection.
- **Variants.** The bound path is `P = /anything/daemon-event`. In every variant **the canary must be absent**.

  - Variants marked _echo_ must also answer 200 with the placeholder present. httpbin.org answers 200 to those raw targets with the request echoed, as measured on 2026-11-18 from a host with no sidecar.
  - The others answer 404 or 400 at httpbin, so for them only the canary's absence is asserted.

  | Variant                      | Targets (echo?)                                                                                                                                                                                                                                                  |
  | :--------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | dot segments, raw            | `/anything/./daemon-event` (y), `/anything/x/../daemon-event` (y), `P/../../anything/daemon/cell-plan` (y)                                                                                                                                                       |
  | dot segments, encoded        | `/anything/x/%2e%2e/daemon-event` (y), `P/%2e%2e/cell-plan` (y), `/anything/x/%252e%252e/daemon-event` (y)                                                                                                                                                       |
  | encoded `/`                  | `/anything%2Fdaemon-event` (n), `/anything%2fdaemon-event` (n), `P%2F..%2Fcell-plan` (n)                                                                                                                                                                         |
  | encoded `-`                  | `/anything/daemon%2Devent` (y), `/anything/daemon%2devent` (y), `/anything/daemon%252Devent` (y)                                                                                                                                                                 |
  | double slash, trailing slash | `//anything/daemon-event` (y), `/anything//daemon-event` (y), `P//` (y), `P/` (y)                                                                                                                                                                                |
  | `;`                          | `P;x` (y), `/anything;x/daemon-event` (n)                                                                                                                                                                                                                        |
  | fragment                     | `P#frag` (n), `/anything#/daemon-event` (n)                                                                                                                                                                                                                      |
  | case                         | `/ANYTHING/daemon-event` (n), `/anything/DAEMON-EVENT` (y)                                                                                                                                                                                                       |
  | backslash                    | `/anything\daemon-event` (y)                                                                                                                                                                                                                                     |
  | the path behind a query      | `/anything?/daemon-event` (y)                                                                                                                                                                                                                                    |
  | authority                    | `Host: example.org` with SNI `httpbin.org` (canary absent; refused). Foreign absolute-form `https://example.org` + `P` with `Host: httpbin.org`: injected, asserted answered by the bound host (canary echoed, no example.org page), per the 2026-11-18 live run |

  Recorded, not asserted: `P?x=1` and absolute-form `https://httpbin.org` + `P`. Upstream injects into these by design.

- **Deviations from ticket AC 1:**
  - The placeholder is asserted only where the echo server can return it.
  - The "in front of and behind the bound path" placement is applied wherever the variant's shape allows one.
- **Deferred:** the run needs Docker and the public internet outside the agent sandbox (`OPENSANDBOX_IT=1`). `harness.test.ts` covers the harness change: the wire shape, no marker in clear, the guest script running under `python3`, the raw request bytes and the status parse. The raw probe was also smoke-run from the host against httpbin.org.

### 6. Unit test: the binding stays exact-path

`packages/shared/src/model/cell-create-plan.test.ts` models upstream's `_path_matches` and `_request_path`, and asserts two things about the planned vault:

- only the literal `/api/daemon-event` (and that path plus a query) selects the `daemon` binding on the broker host;
- every confused variant above selects no `daemon` binding.

### 7. Docs

- ADR-003: "Amendment (2026-11-18, #693): F1b, the cell's event-only token".
- `docs/specs/693/gate-log.md`: the gate exits, the deferred live command and the upstream rule. `docs/specs/656/gate-log-b.md` gets a pointer to it, since the ticket asks for the rule to be recorded there.

## Acceptance criteria

1. `verifyDaemonApiKey` refuses an event-scoped key (by metadata or by name) unless `allowEventScoped`. This is tested through the real verify.
2. DB-backed, real auth (`apps/www/src/lib/cell-event-token.integration.test.ts`): a minted cell token gets the unknown token's 401, with the log reason `event-scoped token`, on each of these:

   - `next-message`, `agent-credentials`, `run-terminal`, `egress-event`, `run-staleness`, `run-credential-source`, `thread-status`, `cell-plan`, `cell-teardown`;
   - `internal/broadcast` and its `sandbox/env` and `sandbox/keepalive` routes;
   - the anthropic, google, openai and openrouter proxies;
   - the CLI router.

   On `daemon-event` it gets the run token's answer and ingests its own thread's batch (200).

3. `cell-plan` with a cell token answers 401: no `cell_step` row, no bearer, no new apikey row.
4. `cell-plan`'s vault daemon entry carries the minted cell token, not the caller's token, and that token verifies only with `allowEventScoped`.
   - Its metadata keeps `tokenType`, `threadId`, `threadChatId` and the org, with `scope: "daemon-event"`.
   - Its name is `${runKey}:cell-event:${stepKey}:${attempt}`.
   - Its `expires_at` is ≤ now + `CELL_RUN_TTL_MS` + 5 s.
   - It is never logged.
5. A new attempt and a replay leave exactly one live cell token for the step, and it is the latest plan's. A plan that loses its bearer deletes its own token and leaves the earlier response's. A racing pair of winners converges on the newer token.
6. Revocation:
   - The terminal cell read deletes the step's cell tokens before it retires the worker's token, and leaves another step's.
   - A revoke failure answers 500 without retiring, and the retry is accepted.
   - `cell-teardown` `revoke` and `report` delete that attempt's token and leave another attempt's and another run's.
   - The sweep deletes them.
   - No revoke touches the worker's token or the double-dispatch guard.
7. The live-gate variants of §5 are in the IT and the harness unit tests pass. The IT run is listed as deferred.
8. #656 AC 13 is re-checked: with the cell token, every `/api/daemon/*` path answers 401 to the guest **by www**, independent of the sidecar's path match. The sidecar's half rests on the recorded upstream rule and on the deferred live run.

## Out of scope

- Upstream OpenSandbox changes.
- The worker side of `cell-plan` and `cell-teardown`.
- The plugin's 1-day minimum for the worker token.

## Validation

Adversarial validate, fresh agent, 2026-11-18: **BLOCK**, then folded:

- `lifecycle` (high ×2): the name collided across runs of one thread, and delete-then-create raced under replays. Fix: the step key went into the name, and the supersede became "older than mine", run only after the plan wins.
- `live-gate` (medium ×2): the upstream rule's order was wrong (ambiguity is checked only after a binding matches), and the placeholder could pass vacuously. Fix: the rule was rewritten, and the echo/non-echo expectations come from a measured run.
- `citations` (low): the full harness path; drifted line ranges.
- `auth-surface`: PASS. No api-key becomes a session (`enableSessionForAPIKeys` is off), and every check goes through `verifyDaemonApiKey`.
- Low items taken: escaped LIKE patterns, the 45-min backstop stated for the non-cell paths, h2 recorded as uncovered, a pointer from gate-log-b.

## Risks and rollback

- **The api-key plugin drops `metadata` on verify.** The name marker still refuses the key, and the name is a DB column.
- **The cell daemon loses `daemon-event`.** `daemon-event` opts in, and test AC 2 covers it.
- **Rollback:** revert. The vault then carries the worker's token again, as it does today.
