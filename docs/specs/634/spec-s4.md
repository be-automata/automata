# #634 S4: the cell control plane

Slice 4 of #634. Shipped so far:

- **#646 (S1+S2):** the cell contract (`@terragon/types/cell`), the OpenSandbox renderer and plan builder, and the adapter.
- **#653 (S3):** the `OPENSANDBOX_IT` harness. It proved AC-3, AC-5, AC-6 and AC-8 live, and it writes conformance evidence for `opensandbox/runc` to a file.

What is still missing is everything the control plane owns: a profile and its evidence in the database, the reconciler (AC-7), a teardown that revokes first, and a way for a run to get its create plan. The worker executing that plan is S5.

## Decisions (owner, 2026-11-16)

1. **One PR for all of S4** (owner's choice over a two-PR split).
2. **Plan timing: the worker fetches the plan per attempt** from `POST /api/daemon/cell-plan`. Nothing is built at dispatch, and nothing secret goes into the workflow input.
   - This replaces the slice plan's "build at dispatch, seal for transport".
   - The research behind it, at confidence 7/10, is in the corpus report _Credential delivery for durable workflow sandboxes_ (2026-11-16):
     - Temporal's guidance is to never pass API keys as workflow arguments, because history keeps them for the whole retention window even when encrypted, and to fetch them inside the activity instead.
     - Per-attempt tokens are the norm elsewhere: GitHub `run_attempt`, Buildkite job tokens, fencing tokens.
     - Sealing at dispatch would still need a re-mint path on every retry.
   - The existing daemon token is already the scoped reference the research recommends: daemon-purpose, bound to one thread and chat, revoked when the run ends, with a 1-day backstop (`apps/www/src/lib/daemon-token.ts:7-18`).
   - The seal contract (`packages/utils/src/payload-seal.ts`, `RunSecrets`) is **not changed**.
3. **Switch.** A per-user feature flag `opensandboxCells` (default off) **and** `OPENSANDBOX_URL` plus `OPENSANDBOX_API_KEY` in the www env. Both must be on. With either off, no run changes.
4. **Reconciler.** It runs in the www cron, in the 10-minute chain, and is a no-op while the env is unset. S5 decides how www reaches the box's server.
5. **Evidence.** A new ingest route plus a push script; renewing the evidence means rerunning the IT and pushing again.
6. **`dns_closed: false`** is recorded as measured. Shadow decisions will show `secrets_exfiltrable_by_dns`, and closing DNS is decided before any switch to enforce. This slice does not change the policy.

## Ground truth (origin/main `222d480d`, 2026-11-16)

| What                      | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Profile tables            | `packages/shared/src/db/schema.ts:3130-3155` `execution_profile` (`id`, `provider`, `tier`, `configuration`, `config_hash`; unique `(provider, tier, config_hash)` `:3149`); `:3165-3198` `profile_evidence` (`expires_at` generated as `measured_at + 30 days`)                                                                                                                                                                                                     | exist                                                                          |
| Profile model             | `packages/shared/src/model/execution-profiles.ts`: `executionProfileConfigHash` `:34`, `getCurrentProfileEvidence` `:78`, `profileRecordForPolicy` `:103`, `getExecutionProfile` `:239`, `insertProfileEvidenceRows` `:212`                                                                                                                                                                                                                                          | exist                                                                          |
| Seed precedent            | `deploy/migrations/2026-11-10-execution-profile-seed-automata-box.sql`: data-only `-- migrate:expand`, the hash computed in SQL (`:30-36`), `ON CONFLICT ("id") DO NOTHING`; the hashes are pinned in `packages/shared/src/model/execution-profiles.test.ts`                                                                                                                                                                                                         | exists; **no `opensandbox/runc` row**                                          |
| Evidence ingest precedent | `apps/www/src/app/api/internal/profile-evidence/box/route.ts`. It checks `PROFILE_EVIDENCE_SECRET` with `reconcileTokenMatches` against the `PROFILE_EVIDENCE_TOKEN_HEADER` header. It caps the body at 64 KiB and uses a strict zod schema. The profile is fixed server-side, the **server judges** the raw report, `measuredAt` must be within a window, and errors are enum codes.                                                                                | exists for the box only                                                        |
| Evidence builder          | `packages/sandbox/src/providers/opensandbox-it/evidence.ts`: `buildConformanceEvidence`, `RUNC_REQUIRED_CHECKS`; **not exported** from `packages/sandbox/package.json`                                                                                                                                                                                                                                                                                               | exists                                                                         |
| Cell authority            | `packages/shared/src/model/cell-authority.ts`: `openStep` `:87` (`stepKey, organizationId, threadId, attempt, stepTimeoutMs, effectBudget, allowedRef`), `mintBearer` `:183`, `revokeAttempt({db, stepKey, attempt})` `:325` (never revokes a future attempt; returns false for an unknown step)                                                                                                                                                                     | exist; **no production caller** of `openStep`, `mintBearer` or `revokeAttempt` |
| Plan builder              | `packages/shared/src/model/cell-create-plan.ts:112` `buildCellCreatePlan(input, {now, mintBearer})`. The input is `stepKey, attempt, ttlMs, egressRefs, egress{brokerHost}, profile, tags{worker, epoch}, resources, modelToken, runtime`.                                                                                                                                                                                                                           | exists; no production caller                                                   |
| Adapter                   | `packages/sandbox/src/providers/opensandbox-cell.ts:372` `createOpenSandboxCellProvider`; config `:61` needs `baseUrl, apiKey, image, entrypoint, selfCheck`; `listByTags` `:504-533` always adds `automata=cell`; `teardown` = revoke → quarantine → delete                                                                                                                                                                                                         | exists                                                                         |
| Daemon auth               | `apps/www/src/app/api/daemon/agent-credentials/route.ts:37-120`: `getDaemonTokenContext`, F1 `tokenType === "daemon"`, F2 thread and chat binding, an org check, `getAndVerifyCredentials` (`apps/www/src/agent/credentials.ts:31`). For `claudeCode` that returns `{type:"json-file", contents}` with `claudeAiOauth.accessToken`, or `built-in-credits`. `DaemonTokenContext.apiKeyId` is this run's token row id (`apps/www/src/lib/daemon-token-context.ts:22`). | exists                                                                         |
| Cron                      | `apps/www/src/server-lib/cron.ts:384` `runScheduledCron`; `*/10` runs queued → self-heal tick → delivery (`:408-414`); every runner is a bulkheaded `run…Safe` with a dynamic import                                                                                                                                                                                                                                                                                 | exists; **no cell reconciler**                                                 |
| Flags                     | `packages/shared/src/model/feature-flags-definitions.ts`; `getFeatureFlagForUser({db, userId, flagName})` (`feature-flags.ts:333`)                                                                                                                                                                                                                                                                                                                                   | exist; no cell flag                                                            |
| Env                       | `packages/env/src/apps-www.ts` (`CELL_BROKER_ENABLED` `:109`, `PROFILE_EVIDENCE_SECRET` `:158`)                                                                                                                                                                                                                                                                                                                                                                      | no `OPENSANDBOX_*`                                                             |
| Dispatch                  | `apps/www/src/agent/hatchet/dispatch.ts:840` `dispatchAgentRun`; `AgentRunInput` `:345-461`; the worker mirror type is `packages/worker/src/agent-run/types.ts:137`                                                                                                                                                                                                                                                                                                  | exist                                                                          |
| Import graph              | `apps/www` depends on shared, sandbox, types, env; `packages/sandbox` and `packages/worker` do not import shared at runtime                                                                                                                                                                                                                                                                                                                                          | —                                                                              |
| A cell-id table           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **none**: the reconciler works from provider tags (ADR-014 `:84-87`)           |

## Contract

### A. Profile seed (migration)

`deploy/migrations/2026-11-17-execution-profile-seed-opensandbox-runc.sql`, data-only `-- migrate:expand`, idempotent:

```
id 'opensandbox/runc', provider 'opensandbox', tier 'customer_box',
configuration {"egress_mode":"enforce"}, config_hash computed in SQL like the automata-box seed.
```

It seeds **no** evidence; evidence comes only through the ingest route (B). The unique `(provider, tier, config_hash)` index does not collide with `automata-box/enforce`, because the provider differs. A test in `execution-profiles.test.ts` pins the hash: it equals `executionProfileConfigHash({egress_mode:"enforce"})`.

### B. Evidence ingest

- **Export.** `packages/sandbox/package.json` gains `"./opensandbox-evidence": "./src/providers/opensandbox-it/evidence.ts"`. Nothing moves.
- **Route.** `apps/www/src/app/api/internal/profile-evidence/opensandbox/route.ts`, `POST`, mirroring the box route:
  - **Auth:** `PROFILE_EVIDENCE_SECRET` through `reconcileTokenMatches`, with the same header. An empty secret refuses everything.
  - **Body:** at most 64 KiB, strict zod: `{ measuredAt: datetime, platformSha: /^[0-9a-f]{40}$/ (no "-dirty"), artifactDigest: /^sha256:[0-9a-f]{64}$/, checks: ConformanceChecks }`. Each group is an array of at most 64 `{name: /^[a-z0-9_]{1,64}$/, ok: boolean}`.
  - **The server decides.** The profile id `opensandbox/runc` and the allowlist are fixed on the server (`OPENSANDBOX_PROFILE_ALLOWLIST`, a constant in the route: the measured hosts). The route calls `buildConformanceEvidence({ ..., required: RUNC_REQUIRED_CHECKS })`. Any `ConformanceEvidenceError` returns `422 {recorded:false, reason}` and posts an ops alert, as the box route does; nothing is recorded.
  - **Window:** `measuredAt` must be within 24 h in the past and at most 5 min in the future, else 422 `measured_at_out_of_window`.
  - **Profile row:** if it is missing, 409 `unknown_profile`.
  - **On success:** `insertProfileEvidenceRows`, then `{recorded:true, rows, expiresAt}`. Values are never logged.
- **Push script.** `packages/sandbox/opensandbox-it/push-evidence.sh <base-url>`:
  - reads `$OPENSANDBOX_IT_STATE/opensandbox-runc-conformance.json`;
  - builds the body (measuredAt, platformSha, artifactDigest, checks) with `jq`;
  - refuses a `-dirty` platformSha;
  - reads `PROFILE_EVIDENCE_SECRET` from the environment and sends it as a header through `curl -H @-` on stdin, never in argv;
  - prints the JSON reply.
- **The IT's JSON file** must therefore also carry `checks` (the grouped `ConformanceChecks`). Add it to what the evidence `it` writes.

### C. Reconcile core (`packages/sandbox`)

`packages/sandbox/src/cell/reconcile.ts`, exported as `./cell-reconcile`. Pure over injected dependencies:

```ts
reconcileExpiredCells({
  provider: Pick<ICellProvider, "listByTags" | "teardown">,
  revoke: (stepKey: string, attempt: number) => Promise<void>,
  now: () => number,
  logger,
  limit?: number,   // default 50 per run
}): Promise<{ listed: number; expired: number; reaped: number; failed: number }>
```

- It lists `listByTags({})`; the adapter adds `automata=cell` and re-checks client-side.
- A cell is **expired** when `Number(tags.expiresAt) <= now()`. A cell whose `expiresAt`, `stepKey` or `attempt` is missing or invalid is treated as expired and reaped, so it fails safe. Its revoke is skipped, because there is no valid key, and it is logged.
- For each expired cell, in this order: `revoke(stepKey, attempt)`, then `provider.teardown(cellId)` (provider revoke → quarantine → delete).
  - A failed `revoke` does **not** stop the teardown: kill the cell anyway. It is counted and logged.
  - A failed teardown is counted, and the next run retries it.
- Cells are processed one after another, so a slow server is not hammered. Each cell is isolated (one failure never stops the rest), and processing stops at `limit`.
- Logs carry `cellId`, `stepKey`, `attempt` and error codes only; never tags beyond those, never secrets.

### D. Control plane (`apps/www`)

- **Env** (`packages/env/src/apps-www.ts`): `OPENSANDBOX_URL` (optional URL), `OPENSANDBOX_API_KEY` (optional secret), `OPENSANDBOX_GUEST_IMAGE` (optional, a digest-pinned reference). "Configured" means the URL and the key are both non-empty.
- **`apps/www/src/server-lib/compute/cell-control.ts`:**
  - `opensandboxConfigured(): boolean`.
  - `cellProvider(): ICellProvider | null`. Null when not configured. It is built with `createOpenSandboxCellProvider`, real `fetch`, a timer `sleep`, `Date.now` and a logger that drops field values. `image`, `entrypoint` and `selfCheck` come from `OPENSANDBOX_GUEST_IMAGE` and fixed constants; they are only used by `create`, which www never calls.
  - `teardownCell({ db, provider, cellId, stepKey, attempt })`: `revokeAttempt({db, stepKey, attempt})` **first**, then `provider.teardown(cellId)`. This is the contract's teardown order (#634): `revokeAttempt` → vault delete → deny-all → delete.
  - `runCellReconciler({ db, provider, now })`: `reconcileExpiredCells` with `revoke = (k, a) => revokeAttempt({db, stepKey: k, attempt: a})` (its false return for an unknown step is fine).
- **Cron:** `runCellReconcilerSafe()` in `cron.ts`. It does a dynamic import, does nothing when not configured, logs and swallows every error, and runs **last** in the `*/10` chain, after delivery, inside its own `finally`.

### E. Plan endpoint

`apps/www/src/app/api/daemon/cell-plan/route.ts`, `POST`. The response is H2-class: it carries the model token and the bearer, so the body is never logged and is sent with `Cache-Control: no-store`.

1. **Auth** uses the same contract as `agent-credentials`:

   - `getDaemonTokenContext`;
   - F1, a daemon-purpose token, else 403;
   - F2, the body's `threadId` and `threadChatId` must equal the token's;
   - the thread's org must equal the token's org, else 403.

   Shared steps are reused, not copied. If that contract is only inline in `agent-credentials`, extract a small `authorizeDaemonThreadRequest` helper both routes call, without changing `agent-credentials`' behaviour (its tests stay green).

2. **Body,** strict zod: `{ threadId, threadChatId, attempt: int 1..1000, worker: /^[a-z0-9][a-z0-9-]{0,62}$/, epoch: /^\d{1,20}$/ }`.
3. **Gate:** `opensandboxConfigured()` and `getFeatureFlagForUser(ctx.userId, "opensandboxCells")`. If either is off: 404 `{error:"cells_disabled"}`.
4. **Step:** `stepKey = "cell:" + ctx.apiKeyId`. A null `apiKeyId` gets 403 `no_run_key`. Then `openStep({ stepKey, organizationId: thread.organizationId, threadId, attempt, stepTimeoutMs: CELL_STEP_TIMEOUT_MS, effectBudget: null, allowedRef: null })`.
   - `CELL_STEP_TIMEOUT_MS = 2 h`.
   - `allowedRef` is null in S4, because cell pushes are S5.
   - A refusal (`stale_attempt` / `step_done` / `conflict` / `revoked`) gets 409 `{error: reason}`.
5. **Agent and credential:** `getThreadChat`; only `claudeCode` is supported, else 422 `agent_not_supported`. `getAndVerifyCredentials` must return a json-file whose `claudeAiOauth.accessToken` is a non-empty string, else 422 `no_model_credential`. A cell never falls back to built-in credits.
6. **Profile:** `getExecutionProfile("opensandbox/runc")`, then `getCurrentProfileEvidence`, then `profileRecordForPolicy`. A missing profile gets 409 `unknown_profile`.
7. **Plan:** `buildCellCreatePlan` with:

   - `egressRefs: []`;
   - `egress: { brokerHost: <host of env.BETTER_AUTH_URL or the existing public-URL env, verified at write time> }`;
   - `tags: { worker, epoch }`;
   - `resources: { cpu: 2, memoryMiB: 4096 }`;
   - `ttlMs: CELL_STEP_TIMEOUT_MS`;
   - `runtime: "runc"`;
   - `mintBearer: (a) => mintBearer({ db, ...a })`.

   `CellPlanError` gets 409 `{error: code}`. `CellEgressNotEnforcedError` gets 409 `{error: "egress_not_enforced", reason}`. Messages are codes only.

8. **Reply:** 200 `{ plan }`. Logs carry `threadId`, `stepKey`, `attempt` and the outcome code only.

### F. Flag and dispatch marker

- `feature-flags-definitions.ts`: `opensandboxCells: { defaultValue: false, description: "Runs eligible tasks in an OpenSandbox cell (ADR-014 #634); needs OPENSANDBOX_URL/API_KEY." }`.
- `dispatch.ts`: when `opensandboxConfigured()` and the flag is on for the thread's user, `AgentRunInput` gets `cell: "opensandbox"`. This is a reference only; no secret is added.
- The worker mirror (`packages/worker/src/agent-run/types.ts`) gets `cell?: "opensandbox"`. The worker ignores it until S5.
- A dispatch test: flag off gives no `cell`; flag on with env set gives `cell: "opensandbox"`, and the sealed secrets are unchanged.

### G. AC-7 live (the S3 harness)

A new scenario in `opensandbox-cell.integration.test.ts`, run **before** AC-8 so the netns leak does not affect it:

1. Create cell X with `tags.expiresAt = now - 1000`, and cell Y with `expiresAt = now + 10 min`, through the adapter. The IT's `plan()` gains an `expiresAt` override.
2. `dind(["docker", "restart", "osb-server"])`, then wait until `/health` answers. That is the server restart.
3. Run `reconcileExpiredCells` with the real provider, a recording `revoke` and **no worker process**: the test process is not a worker.
4. Assert:

   - `revoke` was called once, with `(X.stepKey, 1)`, before X's teardown;
   - X is gone (`delete` returns `"gone"`, and `listByTags({stepKey: X})` is `[]`);
   - Y is still listed;
   - the result is `{expired: 1, reaped: 1, failed: 0}`.

   Then tear Y down.

5. Record `reconciler_reaped_expired_after_restart` in `teardown_verified`, and add it to `RUNC_REQUIRED_CHECKS`.

## Acceptance criteria (this slice)

1. **AC-7 (#634).** The reconciler deletes an expired cell, tagged by worker and epoch, after a server restart and with no worker running, and leaves an unexpired one: scenario G, live. Unit tests cover the ordering (revoke before teardown), fail-safe reaping of an untagged cell, a revoke failure that still tears down, per-cell isolation and `limit`.
2. **Revoke before teardown.** `teardownCell` calls `revokeAttempt` before `provider.teardown` (a call-order spy); a `revokeAttempt` that throws still tears the cell down, and the error is reported.
3. **Seed.** The migration applies to a database that has the baseline plus the earlier migrations; it is idempotent; the pinned hash test passes; `node deploy/lint-migrations.ts` passes; and the schema-drift gate is unaffected (data only).
4. **Ingest.** A correct report records 9 rows for `opensandbox/runc`. Each of these is refused and records nothing:

   - a wrong secret or an empty secret;
   - a missing required check or a failed check (with an ops alert);
   - a `-dirty` or short sha;
   - an out-of-window `measuredAt`;
   - a body over 64 KiB;
   - an extra field;
   - a missing profile row.

   After ingest, `profileRecordForPolicy` plus `assertCellEgressEnforced` pass for the profile.

5. **Plan endpoint.** It returns a plan whose `tags.stepKey === "cell:" + apiKeyId`, `tags.attempt === String(attempt)`, `tags.worker` and `tags.epoch` as sent, a policy rendered from the platform egress set, and a vault with the model and broker entries.
   - 401 for no token; 403 for a non-daemon token, a thread or chat mismatch, an org mismatch, or a null `apiKeyId`; 404 `cells_disabled` for the flag off or the env unset.
   - 409 for a stale attempt, and attempt 2 after attempt 1 fences attempt 1: a bearer minted for attempt 1 no longer verifies.
   - 422 for a non-Claude agent or no OAuth credential.
   - 409 `egress_not_enforced` for a profile without evidence.
   - The token value and the bearer appear in no log line (a console spy).
6. **Flag and marker.** As in F; existing dispatch tests are unchanged.
7. **Off means off.** With the flag off or the env unset, nothing changes for any run: no `cell` field, the reconciler does nothing, and the endpoint answers 404.

## Tests and gates

- `pnpm turbo tsc-check`, `pnpm turbo lint`, and prettier on the changed files. A home `~/.editorconfig` breaks `pnpm turbo format-check` here, so use `--no-editorconfig --config .prettierrc`.
- `pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism` (reconcile unit tests).
- `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism` (the seed hash pin).
- `pnpm --filter @terragon/www exec vitest run --no-file-parallelism` for the new and touched www tests (routes, `cell-control`, cron, dispatch).
- `node deploy/lint-migrations.ts`, and the migration applied to the test database.
- `OPENSANDBOX_IT=1 …opensandbox-cell.integration.test.ts`, live, run outside the Claude sandbox (scenario G plus the existing 8). Then `push-evidence.sh` against a local www with the test database is the ingest UAT.

## Out of scope

- The worker fetching and executing the plan, and the box's rootless daemon and its x86_64 re-check: S5.
- How www reaches the box's OpenSandbox server: S5.
- Enforce mode, and closing DNS.
- Cell pushes (`allowedRef`).
- The #654 harness follow-ups.

## Risks

- **The plan endpoint returns a live OAuth token,** the same class as `agent-credentials`. Mitigations: the same auth contract, no-store, no logging, the flag defaulting off, and refusal unless the profile has current conformance evidence.
- **A reconciler bug could delete live cells.** Mitigations: only tags with `expiresAt` in the past (or missing) count, the adapter re-checks the tags client-side, the run is capped at 50 per pass, and there are no cells in production until S5.
- **Rollback:** revert the PR. The seed row is inert without evidence and the flag.

**Sensitive** (migration, API routes): this PR waits for a TL review as well as Automata.

## Validate cycle 1 (PASS_WITH_WARNINGS): binding adjustments

Where these differ from the sections above, these win.

1. **Org required.** `cell_step.organization_id` is a foreign key to `organization`, and `openStep` takes a string. So:
   - The plan endpoint refuses a thread whose `organizationId` is null with 403 `org_required`.
   - The dispatch marker is never set for an org-less thread.
2. **Broker host.** Use `new URL(nonLocalhostPublicAppUrl()).hostname` (`apps/www/src/lib/server-utils.ts:12-27`, the same host as `daemonCallbackUrl`), passed through `normalizeCellBrokerHost`. Tests set `NEXT_PUBLIC_APP_URL`.
3. **Migration pins.** Update the id lists in `packages/migrate/src/files.test.ts:104-130` and `runner.test.ts:67-96`. Change `toHaveLength(23)` to 24 in `runner.test.ts:99` and `cli.test.ts:111`. The gates add `pnpm --filter @terragon/migrate exec vitest run`.
4. **`openStep` is nested:** `openStep({ db, step: { stepKey, organizationId, threadId, attempt, stepTimeoutMs, effectBudget, allowedRef } })`. `mintBearer` and `revokeAttempt` stay flat.
5. **Credential extraction.**
   - For `claudeCode`, `getAndVerifyCredentials` returns `{type:"json-file", contents: string}`, where `contents` is a JSON string. It may hold `{anthropicApiKey}` or `{claudeAiOauth:{accessToken,…}}`, and the call can throw `ThreadError`.
   - `JSON.parse` it inside a `try`, and require a non-empty `claudeAiOauth.accessToken`.
   - Every other outcome maps to 422 `no_model_credential`: a `ThreadError`, a parse failure, the API-key shape, or built-in credits. The parsed value is never logged.
6. **No mutation before every refusal.** The endpoint runs all non-mutating checks first, in this order:

   1. auth;
   2. gate;
   3. org;
   4. agent;
   5. credential;
   6. profile row;
   7. `assertCellEgressEnforced(profileRecordForPolicy(...))`, a pre-check.

   Only then does it call `openStep`, and then `buildCellCreatePlan`. A refused request never creates or advances a `cell_step`, and never fences a previous attempt.

7. **Strict thread binding.**
   - `authorizeDaemonThreadRequest` is extracted into `apps/www/src/lib/daemon-thread-auth.ts` and takes `{ strictThreadId }`.
   - `cell-plan` passes `true`, so `ctx.threadId` must be non-null and must equal the body's.
   - `agent-credentials` passes `false`, so its behaviour, including its temporary permissive clause at `route.ts:80`, is unchanged and its tests stay green.
   - Both routes are wrapped in `withDaemonAuthUnavailable`.
8. **Ingest reasons are enum codes.** Map `ConformanceEvidenceError` to `check_missing`, `check_failed` or `allowlist_empty` before replying or alerting; never echo its message. A judged failure replies 422 `{recorded:false, reason}`. The box route replies 200 here, so this is a deliberate difference.
9. **Allowlist.** The ingest computes `egress_allowlist` on the server as `[CELL_EGRESS_MODEL_HOST, <broker host from item 2>]`. These are the hosts a real cell needs, and the IT measured the provider enforcing an allowlist for its own probe hosts. `cell.rego`'s `egress_host_not_allowed` then matches what a real plan needs.
10. **IT output.** The evidence `it` also writes `measuredAt`, `platformSha`, `artifactDigest` and `checks` at the top level of its JSON file. The push script reads only those four.
11. **Dispatch eligibility.**
    - `cell: "opensandbox"` is set only for a plain task run (`isPlainTaskRun`) on a thread with an organization, when the flag is on for the thread's user and OpenSandbox is configured.
    - Review, self-heal and companion runs never get it.
    - It is set **before** `sealWireInput`, because the seal's binding covers the whole input.
    - "Secrets unchanged" means the `RunSecrets` plaintext is identical with the flag on and off.
12. **Scenario G** sits after AC-5 (its `run_baseline_restored`) and before AC-8. Nothing in the repo shows that OpenSandbox 1.2.1 re-adopts sandboxes, lists them, or reaches their sidecars after a server restart. G is the first proof, so a failure there is recorded as a finding, not patched as a test bug.
13. **Accepted and recorded under Risks:**
    - **Attempt range.** Whoever holds a run's daemon token can open attempt 1000 and leave the real run permanently `stale_attempt`. That is a denial of service on its own run only. The same token already yields the OAuth token through `agent-credentials`, so no confidentiality is lost.
    - **Repeat requests.** Repeating a POST for the current attempt mints another bearer, each expiring within 2 h. There is no per-attempt cap in S4.
    - **Unbounded listing.** `listByTags({})` pages through the whole server before `limit` applies. There are no production cells until S5; if that becomes a cost, S5 adds a page cap.
14. **S5 items, added to Out of scope:**
    - The server's `max_sandbox_timeout_seconds` must allow `CELL_STEP_TIMEOUT_MS` (2 h; the IT's config allows 1 h), or the TTL must be lowered.
    - A run-end `teardownCell` / `revokeAttempt` caller.
