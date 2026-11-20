# Spec #718: a refused cell run names its reason, and dispatch stops marking runs cell-plan always refuses

- Ticket: be-automata/automata#718
- Branch: `fix/718-cell-plan-refusal-reason`, at `origin/main` `a0271136` (2026-11-20)
- Ticket verified on `5e29ab8c`. The only change since then is `a0271136` (#717/#721). It touched
  `packages/worker/src/agent-run/{cell-repo-env*,repo-env*,cell-run.ts,cell-test-db.ts,container-*,daemon-env.ts}`.
  In `cell-run.ts` only the repo-env import and filter changed (`cellRepoEnv` → `filterRepoEnv`). The
  admission, plan-fetch and refusal code did not change, but its lines moved by about 4 (see §2).

## 1. Decisions and acceptance criteria (verbatim from the ticket)

### Decisions (2026-11-20, the owner took the recommendations via `/address-open-questions --auto-recommend`)

| # | Decision | Confidence | Effect on this ticket |
|:--|:--|:--|:--|
| OD-1 | **(a) + (c′):** keep refusing a marked run that cell-plan refuses, but end it with the named reason and resend guidance, and add the missing eligibility checks (agent, `opensandbox/runc` profile and evidence, Claude OAuth) to dispatch using cell-plan's own functions. **No box fallback.** | 8/10 | ADR-014 is unchanged; the Amendment 2 draft below is not proposed. AC-1 to AC-6 apply; AC-7 to AC-9 (the (b) branch) are out of scope. |
| OD-2 | **Moot:** it only applies under (b). | — | Nothing to build. |
| OD-3 | **`info` on the existing `run-failed-unreported` terminal**, not a new `TerminalCause`. | 7/10 | Only `abnormal-end.ts` text changes; no new sweep semantics or chip. |
| OD-4 | **Yes:** a user without a Claude OAuth credential is "not eligible" at dispatch, so the run stays on the box, as #705 did for egress a cell cannot express. | 8/10 | AC-3 includes the OAuth check. |

### Acceptance criteria (OD-1 = (a) + (c′))

1. A marked run refused by cell-plan ends with a terminal whose text names the refusal code and, for the race codes, says that sending the message again runs it where it is now allowed. It never shows an internal code's details, a token or a value.
2. `CellRunRefusedError` (`cells_unconfigured`, `cell_lane_refused`) carries a named reason to the thread in the same way.
3. Dispatch does not mark a run when the chat's agent is not `claudeCode`, when `opensandbox/runc` is missing or fails `assertCellEgressEnforced` (evidence expired included), or (OD-4 = yes) when the user has no Claude OAuth credential. Each logs a code-only "run stays on the box" line, like `dispatch.ts:851`.
4. Each dispatch check uses the **same** function cell-plan uses (no second copy of the rule), and fails closed to "not eligible".
5. A marked run is never executed on the box (`run-executor.ts:74-90` unchanged).
6. cell-plan's refusal order and its non-mutation guarantee before `openNextAttempt` are unchanged.

AC-7 to AC-9 (OD-1 = (b)) are out of scope. ADR-014 is not touched.

## 2. Ground truth (re-verified at `a0271136`)

Paths are relative to the worktree root.

### Dispatch (`apps/www/src/agent/hatchet/dispatch.ts`)

| Ticket cite | Now | Quote | Holds? |
|:--|:--|:--|:--|
| `cellEligibleForRun` `:814-830` | `:814-830` | `return await cellsEnabledForRun({ db, userId, organizationId });` (dynamic import of `@/server-lib/compute/cell-gate`; a catch logs and returns `false`) | yes |
| `cellEgressCompiles` `:836-862` | `:836-862` | `console.log("[hatchet] cell egress refused (run stays on the box)", { code: plan.code, reason: plan.reason });` at `:851` | yes |
| marker `:1259-1265` | `:1259-1265` | `isPlainTaskRun && thread?.organizationId && (await cellEligibleForRun(...)) && (await cellEgressCompiles(...)) ? ({ cell: "opensandbox" } as const) : {}` | yes |
| `isPlainTaskRun` `:1186-1189` | `:1186-1189` | `taskPlan !== undefined && selfHealPlan.selfHeal === undefined && !isCompanionRun` | yes |
| shadow resolver `:1190-1225` | `:1190-1219` | `await recordShadowCellDecision({ ... })` | yes, the range is 6 lines shorter |
| `taskRunPushBranch` `:1239-1246` | `:1237-1244` | `const push = taskRunPushBranch({ threadId, prNumber, branch, baseBranch: thread?.repoBaseBranchName });` | yes, shifted by 2 |
| marker into input `:1266-1273` | `:1266-1273` | `...cellMarker,` inside `const input: AgentRunInput = {...}` | yes |
| `sealWireInput` `:1289` | `:1289` | `const wireInput = await sealWireInput({ input, secrets, planeKey });` | yes |
| (not cited) | `:907-928` | `dispatchAgentRun({ userId, threadId, threadChatId, repoFullName, branch, deliveryId })` | **The signature carries no agent.** Dispatch loads the thread through `getThreadMinimal` (`:988`), which leaves out every thread-chat column, `agent` included (`packages/shared/src/model/threads.ts:450`). So dispatch cannot see `threadChat.agent` today. |
| (not cited) | `apps/www/src/agent/msg/startAgentMessage.ts:401` | `await dispatchAgentRun({...})`, inside `withThreadChat({ execOrThrow: async (threadChat) => ...})` (`:248`) | The only caller, and it already holds `threadChat`. |

`apps/www/src/server-lib/compute/resolve-cell-decision.ts:43-55`: "the profile is `automata-box` / `customer_box`". `CELL_DECISION_MODE = "shadow"` is at `:49`. Holds: the shadow resolver never evaluates `opensandbox/runc`.

### cell-plan route (`apps/www/src/app/api/daemon/cell-plan/route.ts`)

The ticket's line numbers all hold.

| Step | Line | Quote | Notes |
|:--|:--|:--|:--|
| auth | `:94-99` | `authorizeDaemonThreadRequest({ request, strictThreadId: true, ... })` | Refusals come from `apps/www/src/lib/daemon-thread-auth.ts:45-105`: `"Unauthorized"` 401, `"Forbidden"` 403, `"Invalid body"` / `"Missing threadId or threadChatId"` 400. `withDaemonAuthUnavailable` returns 503 `"Authentication temporarily unavailable"`. None of these strings match the worker's `^[a-z_]{1,40}$`, so the worker reads them as code `unknown`. |
| `invalid_body` | `:103` | `return reply({ error: "invalid_body" }, 400);` | |
| `cells_disabled` | `:108-116` | `if (!(await cellsEnabledForRun({...}))) return reply({ error: "cells_disabled" }, 404);` | Uses `reply`, not `refuse`, so it writes **no** `[daemon cell-plan]` outcome log line. (The ticket says only the www log holds the code; for this code it does not.) |
| `no_run_key` | `:117` | `reply({ error: "no_run_key" }, 403)` | No log line, as above. |
| `refuse` logger | `:122-134` | `console.log("[daemon cell-plan]", { threadId, stepKey, attempt, outcome: code })` | Holds (`:127-133`). |
| `invalid_run_key`, `org_required`, `invalid_deployment_tag`, `invalid_body` | `:139`, `:144`, `:148-149`, `:151` | | |
| parallel reads | `:154-164` | `getThreadChat`, `getExecutionProfile`, `getCurrentProfileEvidence`, `getRepoReviewSetting` | |
| `agent_not_supported` 422 | `:167-169` | `if (threadChat?.agent !== "claudeCode") return refuse("agent_not_supported", 422);` | The rule is this inline comparison. No function exports it. |
| `thread_terminal` 409 | `:171` | `if (!isAgentWorking(threadChat.status)) return refuse("thread_terminal", 409);` | |
| `unknown_profile` 409 | `:173` | `if (!profileRow) return refuse("unknown_profile", 409);` | |
| `egress_not_enforced` 409 + `reason` | `:174-180` | `profileRecordForPolicy(profileRow, evidence)` → `assertCellEgressEnforced({ profile, now: new Date() })` → `refuseEgress` (`:135-136`, `{ reason: error.reason }`) | |
| egress plan 409 + `reason` | `:186-193` | `planCellEgressForRepo(...)`; `refuse(egress.code, 409, { reason: egress.reason })` | The codes are `egress_level_unsupported` and `egress_compile_failed` (`packages/shared/src/model/cell-egress-catalog.ts:138-145`, `:187-193`). |
| `work_branch_unresolved` 409 | `:197-203` | `if (pushBranch === null) return refuse("work_branch_unresolved", 409);` | |
| `no_model_credential` 422 | `:207-211` | `getClaudeOauthAccessToken({ userId: ctx.userId, organizationId })`; `null` gives `refuse("no_model_credential", 422)`; a failed lookup throws (5xx) | |
| first mutation | `:214` | `const opened = await openNextAttempt({...})` | Holds. |
| attempt-fence refusals | `:226` | `refuse(opened.reason, 409)` | The reasons are `step_done`, `conflict`, `attempt_limit` (`packages/shared/src/model/cell-authority.ts:259`). |
| post-open refusals | `:274-289` | `CellPlanError` → `superseded` or `error.code` (`runtime_not_runc`, `bearer_refused`, `egress_wildcard`, `packages/shared/src/model/cell-create-plan.ts:27-30`); `refuseEgress`; `egress_compile_failed` | |

`packages/shared/src/model/cell-egress-guard.ts:49-101` (the ticket says `:49-90`, but the function now ends at `:101`): `assertCellEgressEnforced` is pure, and its reasons are `CELL_EGRESS_GUARD_REASONS` at `:13-24`: `unknown_profile`, `egress_mode_missing`, `egress_mode_observe`, `egress_mode_unknown`, `egress_not_allowlist`, `allowlist_empty`, `evidence_missing`, `evidence_not_from_conformance`, `evidence_invalid`, `evidence_expired`. Holds.

### Worker (`packages/worker/src/agent-run/`)

| Ticket cite | Now | Quote | Holds? |
|:--|:--|:--|:--|
| `run-executor.ts:24` | `:24` | `/** A marked run that must not run in a cell and must never fall back to the box. */` | yes |
| `run-executor.ts:74-90` | `:74-90` | `if (input.cell === undefined) return deps.box;` … `throw new CellRunRefusedError("cell_lane_refused")` (`:84`) … `throw new CellRunRefusedError("cells_unconfigured")` (`:87`) | yes. `CellRunRefusedError` is at `:25-34`, with a `code` field. Its message for `cells_unconfigured` names `WORKER_OPENSANDBOX_*`, an internal detail that must not be copied into the thread text. |
| `workflow.ts:661-683` | `:661-684` | `const executor = await selectRunExecutor(input, {...})` at `:668`, inside the `try` that starts at `:661` | yes |
| `workflow.ts:707-722` | `:709-725` | `const end = claimAbnormalEnd(abnormal, { thrown: { error: err }, ... }); if (end) await postAbnormalEnd(abnormal, end, {...})` | yes, shifted by 2 |
| `cell-run.ts:311-325` admission | `:316-325` | `const admitted = await admitRunSlot({...})` | yes, shifted by #717 |
| `cell-run.ts:330-354` plan fetch | `:332-358` | `throw new CellPlanRefusedError(fetched.code, fetched.status);` (`:353`); `await releaseAdmission(); throw error;` (`:357-358`) | yes, shifted by #717 |
| (not cited) | `cell-run.ts:347-351` | `throw new CellPlanUnavailableError(...)` for `cell_plan_unavailable` / `cell_plan_superseded` | **Not in the ticket.** The retries ran out, which is also a pre-daemon `run-failed-unreported` with no info. |
| (not cited) | `cell-run.ts:419-421` | `throw new CellPlanRefusedError("cells_unconfigured", 0);` | **Not in the ticket.** This throw comes **after** the attempt opens, inside the teardown `try`. The cell's own teardown claims it (`:1111`) and posts it through `deps.www.postAbnormal` (`:1145`, which is `postAbnormalEnd`). `daemonStarted` is still false, so the cause is `run-failed-unreported`, and the same `abnormalEndInfo` change covers it. |
| `cell-www-client.ts:46` | `:46-54` | `class CellPlanRefusedError extends NonRetryableError { constructor(public readonly code: string, public readonly status: number)` | yes. **It carries no `reason`.** `fetchCellPlan` reads only `error` (`codeOf`, `:76`; `readErrorCode`, `www-client.ts:586-592`, `ERROR_CODE = /^[a-z_]{1,40}$/` at `:583`). The egress `reason` the route sends (`evidence_expired`, …) is dropped. |
| `cell-www-client.ts:148` | `:148-220` | `fetchCellPlan`. The worker's own codes: `cell_plan_mismatch` (`:182`), `unknown` (no code), `cell_plan_unavailable` / `cell_plan_superseded` (`:211-219`) | yes |
| `abnormal-end.ts:65-82` (classify) | `:58-94` | `return o.daemonStarted ? "daemon-failed" : "run-failed-unreported";` (`:93`) | yes |
| `abnormal-end.ts:101-127` (info) | `:96-129` | `abnormalEndInfo(cause, o)` returns text only for `timeout` and `out-of-memory`. Otherwise `return undefined;` (`:128`) | yes: there is no info for `run-failed-unreported` |
| `abnormal-end.ts:137` (300 chars) | `:137` | `export const TERMINAL_INFO_MAX_CHARS = 300;` | yes. Enforced in www by `info: z.string().max(300).optional()` (`apps/www/src/app/api/daemon/run-terminal/route.ts:45`). A longer info is a 400, and then **no** typed terminal is written (`abnormal-end.ts:112-113`). |
| (not cited) | `run-lane.ts:30-37` | `ownsAbnormalTerminal` = `resolveRunLane(input) === "task" && input.selfHeal === undefined` | **This limits AC-2.** Of the inputs that throw `cell_lane_refused`, only a task-lane input that carries `reviewAgent` has `owns = true`. Review, pr and self-heal inputs have `owns = false`, so `claimAbnormalEnd` returns null and the worker posts no terminal. `onFailure` closes those threads. Dispatch never marks those lanes (`dispatch.ts:1186-1189`), so in practice `cell_lane_refused` cannot be reached. |

### Thread display

- `packages/shared/src/model/terminal-cause.ts:77-82`: `label: "Failed before reporting"`, `detail: "The run failed on the execution plane before it could report back (#380 sweep rule iii)."` Holds.
- `ABANDONED_TERMINAL_CAUSES` is at `:107`. Holds. It stays unchanged (OD-3).
- `apps/www/src/components/chat/run-status-chip.tsx:84`: `case "run-failed-unreported":` gives tone `danger`. Holds. The chip shows only `label` and `detail`, never `info`.
- `info` reaches the user like this: run-terminal route `:117-121` → `markThreadTerminal({ errorMessageInfo: detail?.info })` → `threadChat.errorMessageInfo` → `ChatError errorInfo` (`apps/www/src/components/chat/chat-ui.tsx:273-287`). The error box already has a Retry button (`handleRetry`), so "send the message again" matches an action that exists.

## 3. Dispatch checks to add (AC-3, AC-4)

All three checks run **after** `cellEligibleForRun && cellEgressCompiles`, inside the same `&&` chain, so a run that is not flagged or not eligible pays nothing new. Like `cellEgressCompiles`, each one sits in its own `try`, logs code-only `[hatchet] cell <check> refused (run stays on the box)` with `{ code }`, and returns `false` on a refusal or a throw. Every module below is already loaded by www and imports nothing from `agent/hatchet`, so no import cycle is possible. Use dynamic `import()` the way `cellEligibleForRun` does, to keep dispatch's cold path light.

| Check | The rule cell-plan uses | Path:line, signature | What it reads | Importable from dispatch | Cost per eligible dispatch |
|:--|:--|:--|:--|:--|:--|
| **Agent** | `threadChat?.agent !== "claudeCode"` → `agent_not_supported` | Inline at `route.ts:167`, no function. The read is `getThreadChat({ db, threadId, threadChatId, userId, organizationId? }): Promise<ThreadChatInfoFull \| undefined>` (`packages/shared/src/model/threads.ts:721`). | The full `thread_chat` row, including `messages` (heavy). | yes (`@terragon/shared/model/threads`, which dispatch already imports at `:22`). | **Recommended:** export one predicate from `apps/www/src/server-lib/compute/cell-gate.ts`, e.g. `cellAgentSupported(agent: string \| null \| undefined): boolean` (`agent === "claudeCode"`). The route uses it at `:167` with the same refusal and order, so AC-6 holds. `startAgentMessage.ts:401` passes `threadChat.agent` into a new optional `dispatchAgentRun` field. That is 0 queries, and undefined fails closed. Alternative: `getThreadChat` inside dispatch, 1 heavy query. Both meet AC-4, because the rule then lives in one place. |
| **Profile + evidence** | `getExecutionProfile` + `getCurrentProfileEvidence` → `profileRecordForPolicy` → `assertCellEgressEnforced` (`route.ts:156-157`, `:173-180`) | **Reuse `readCellEvidenceStatus({ db, now, configured }): Promise<CellEvidenceStatus>`** (`apps/www/src/server-lib/compute/cell-evidence-status.ts:78-97`). Its doc (`:20-27`) says it makes "the same reads and the same guard cell-plan runs". It calls `classifyCellEvidence` (`:42-70`), which calls `assertCellEgressEnforced`. Eligible means `status` is `"ok"` or `"expiring"`. `refused` carries `reason` (`unknown_profile` when the row is missing, or a guard reason). Pass `configured: true`, because `cellsEnabledForRun` already checked the env. | `execution_profile` by id `opensandbox/runc` (`execution-profiles.ts:239-252`, LIMIT 1), and `profile_evidence` DISTINCT ON capability (`:78-94`). | yes (`@/server-lib/compute/cell-evidence-status`, the same package; it imports `cell-gate` and `profile-evidence-expiry`) | **2 queries, in parallel**, both by primary or indexed key, and pure CPU for the guard. Log `{ code: "unknown_profile" }` or `{ code: "egress_not_enforced", reason }`. |
| **Claude OAuth** (OD-4) | `getClaudeOauthAccessToken({ userId, organizationId })`, where `null` means `no_model_credential` (`route.ts:207-211`) | `getClaudeOauthAccessToken({ userId, organizationId? }, read?): Promise<string \| null>` (`apps/www/src/agent/msg/claudeCredentials.ts:505-521`). It throws on a failed lookup. | `getAgentProviderCredentialsDecrypted` (1 query + decrypt, `claudeCredentials.ts:366-372`). For an API key it returns early (`:381-387`), which gives `null`. For `setup-token` there is no refresh (`:399-415`). **For an interactive OAuth credential it may refresh the token** (`getValidAccessToken`, `:417-420`): a network call to the Anthropic token endpoint, a DB write, then a re-read (`:422-430`). | yes (`@/agent/msg/claudeCredentials`; the route already imports it, and dispatch → `agent/msg` has no cycle because `claudeCredentials` does not import `startAgentMessage` or `dispatch`) | **1 query**, plus up to 1 refresh round trip and 2 DB ops when the token is near expiry. The box path's own credential pull would do that refresh later anyway (`agent/credentials.ts:122`). **The return value is a live credential:** test it with `!== null`, never keep or log it, and never put it into `input` or `secrets`. A throw fails closed (the run stays on the box). That is acceptable under OD-4, but say so in the log line (`code: "credential_lookup_failed"`). |

Order inside the chain, cheapest first: agent (0 queries when passed in), then evidence (2 queries), then OAuth (may refresh). Each one short-circuits the next.

Not added (ticket: "partly"): `work_branch_unresolved`. Dispatch already computes `taskRunPushBranch` (`:1237`), but from different inputs than the route (`branch` vs `thread.branchName ?? repoBaseBranchName`). It is not in AC-3, and it is left out. The terminal text covers it (§4).

## 4. Refusal codes and the user-facing text (AC-1, AC-2)

### Every code a marked run can end with before its daemon starts (from code)

| Class | Codes (source) | After this change, does a resend help? |
|:--|:--|:--|
| **R: resend.** Dispatch re-checks the code, so the next message goes to the box or the cell, whichever is allowed then. | `cells_disabled` (route `:115`); `agent_not_supported` (`:168`); `unknown_profile` (`:173`); `egress_not_enforced` (`:136`); `egress_level_unsupported`, `egress_compile_failed` (`:192`, `:288`); `no_model_credential` (`:211`); `cell_plan_unavailable`, `cell_plan_superseded` (worker, `cell-www-client.ts:211-219`; transient) | yes. The first four and `no_model_credential` become races only once §3 lands. |
| **N: named only.** A resend is marked again and fails the same way, or the code is an internal or contract error. | `cells_unconfigured` (`run-executor.ts:87`, `cell-run.ts:420`: dispatch checks www's env, not the worker's, so a resend fails again); `cell_lane_refused` (`run-executor.ts:84`); `no_run_key`, `invalid_run_key`, `org_required`, `invalid_deployment_tag`, `invalid_body` (route `:117-151`); `thread_terminal` (`:171`); `work_branch_unresolved` (`:203`); `step_done`, `conflict`, `attempt_limit` (`:226`); `runtime_not_runc`, `bearer_refused`, `egress_wildcard` (`:278`); `cell_plan_mismatch` (worker); `unknown` (any non-matching body, the auth refusals included) | no |

`thread_terminal`: the thread is already terminal, so the run-terminal write is a no-op (an idempotent reapable-status guard). Giving it text costs nothing.

### Text (worker-authored, built only from a fixed allowlist)

- R: `The cell refused this run before it started (<code>). Send the message again: it runs where it is allowed now.`
- N: `The cell refused this run before it started (<code>).`
- `cells_unconfigured` (N, with a hint): `The cell refused this run before it started (cells_unconfigured): cells are not configured on this execution plane.`

Rules:
- `<code>` is printed only when it is a member of the worker's allowlist. Anything else prints as `unknown`. The route's string is never echoed raw. (It already passes `^[a-z_]{1,40}$`, but the allowlist is what guarantees that no internal text reaches the user.)
- Never include the HTTP status, the error `message` (`CellRunRefusedError`'s message names `WORKER_OPENSANDBOX_*`), ids, a token or a value.
- The longest line is about 150 characters, well under `TERMINAL_INFO_MAX_CHARS = 300`. A unit test asserts `<= 300` for every allowlisted code.
- Optional and recommended: name the egress `reason` (`evidence_expired`, `egress_mode_observe`, …) as `(<code>: <reason>)`. This needs `fetchCellPlan` to read `reason` with the same regex and allowlist, and `CellPlanRefusedError` to gain an optional `reason`. Allowlist the reasons against a mirror of `CELL_EGRESS_GUARD_REASONS` plus the egress-catalog reasons. Without it, the user sees `egress_not_enforced` only.
- Where the table lives: in the worker (it does not depend on `@terragon/shared`, see `packages/worker/package.json:34-39`). Put it in `cell-www-client.ts`, next to `CELL_PLAN_UNAVAILABLE_CODES`, or in `@terragon/types/cell`, which both planes already import. A drift test against the route's literal codes is optional (planes import nothing from each other).
- The hook: `abnormalEndInfo` (`abnormal-end.ts:101`) gains a `run-failed-unreported` branch. It matches `o.thrown?.error` by `instanceof` `CellPlanRefusedError`, `CellPlanUnavailableError` or `CellRunRefusedError`. That needs value imports from `./cell-www-client` and `./run-executor`. Neither imports `abnormal-end` at runtime (`run-executor.ts:4` is `import type`), so there is no cycle. Every other `run-failed-unreported` keeps `undefined`, which is today's behaviour. Both the outer catch (`workflow.ts:719`) and the cell teardown (`cell-run.ts:1145`) post through `postAbnormalEnd`, so this one change covers the pre-open and post-open throws.
- AC-2 boundary: the text reaches the thread only where `ownsAbnormalTerminal` is true (§2). `cell_lane_refused` on a review, pr or self-heal input stays with `onFailure`, unchanged. This spec does not widen terminal ownership.

## 5. What exists and what does not

Exists:
- `abnormalEndInfo`, the `detail.info` path and its 300-character cap. Text for `timeout` and `out-of-memory`.
- `readCellEvidenceStatus` / `classifyCellEvidence` (#709): cell-plan's own profile and evidence check, as a function.
- `getClaudeOauthAccessToken`: cell-plan's own OAuth check, as a function.
- `cellsEnabledForRun` and `planCellEgressForRepo` at dispatch, with the fail-closed log pattern at `dispatch.ts:851`.

Does not exist yet:
- Any `info` for `run-failed-unreported`. No cell refusal code reaches the thread today.
- Any user-facing allowlist or classification of cell refusal codes.
- A `reason` on `CellPlanRefusedError`, or any reading of `reason` in `fetchCellPlan`.
- An exported agent predicate. The rule is inline at `route.ts:167`.
- Any way for dispatch to know the chat's agent (no `agent` parameter, and `getThreadMinimal` leaves it out).
- Any dispatch check for agent, profile/evidence or OAuth.
- A `[daemon cell-plan]` log line for `cells_disabled` and `no_run_key`. This is out of scope: changing them would touch the route, and AC-6 must hold. Record it in the PR.

Unchanged by design: `run-executor.ts:74-90` (AC-5), the route's refusal order and the absence of any mutation before `openNextAttempt` (AC-6, except swapping `:167`'s inline comparison for the same predicate), `terminal-cause.ts`, `ABANDONED_TERMINAL_CAUSES`, the chip, ADR-014.

## 6. Tests and gates

### Test files to change or extend

| Module | Test file | What to add |
|:--|:--|:--|
| `abnormal-end.ts` | `packages/worker/src/agent-run/abnormal-end.test.ts` (`describe("abnormalEndInfo (#437 Part A2)")` at `:119`) | For each class, a `CellPlanRefusedError` gives text naming the code, with resend guidance for R codes only. A code outside the allowlist prints `unknown`. Every line is `<= 300`. A plain `Error` keeps `undefined`. `CellRunRefusedError` (both codes) and `CellPlanUnavailableError` are named (AC-1, AC-2). |
| `workflow.ts` + `run-executor.ts` | `packages/worker/src/agent-run/workflow.test.ts` (T-CONFIG at `:1415-1442`; cells_disabled at `:1605-1640`; the `run-failed-unreported` post at `:1495-1512`) | Extend these to assert the posted `/run-terminal` body has `detail.info` naming the code (`cells_unconfigured`, `cells_disabled` plus the resend line). Keep `box.fn` not called (AC-5). |
| `cell-run.ts` | `packages/worker/src/agent-run/cell-run.test.ts` (T-REFUSED at `:383`) | The post-open `cells_unconfigured` (`:420`) path posts info through the teardown. T-REFUSED is unchanged. |
| `cell-www-client.ts` (only if `reason` is carried) | `packages/worker/src/agent-run/cell-www-client.test.ts` | `reason` is read under the regex and allowlist. A bad or oversized reason is dropped. |
| `dispatch.ts` | `apps/www/src/agent/hatchet/dispatch-cell-marker.test.ts` | **The existing positive cases (`:106`, `:134`, `:142`, `:196`) will fail once §3 lands.** They seed no `opensandbox/runc` profile or evidence, no OAuth credential and no agent. Add fixtures: `upsertExecutionProfile` + `insertProfileEvidenceRows` (as in `apps/www/src/app/api/daemon/cell-plan/route.test.ts:29-30, :105, :211`), and mock `getClaudeOauthAccessToken` (as `route.test.ts:57-58` does). New cases: no marker for a non-`claudeCode` agent, a missing profile, expired evidence, a null OAuth result, and an OAuth lookup that throws. Each logs code only and never the token. A marker when everything passes. The OAuth value never appears in `input` or `secrets` (AC-3, AC-4). |
| `dispatch.ts` (golden) | `apps/www/src/agent/hatchet/dispatch-golden.test.ts`, `dispatch.test.ts`, `dispatch-cell-shadow.test.ts` | These have no cell cases (grep finds nothing). They must stay green: a non-flagged run must make no new reads. |
| `startAgentMessage.ts` (if agent is passed in) | `apps/www/src/agent/msg/startAgentMessage.test.ts` | `dispatchAgentRun` receives `agent`. |
| `cell-gate.ts` (if the predicate goes here) | `apps/www/src/server-lib/compute/cell-gate.test.ts` | The predicate: only `claudeCode` is true; `null` and `undefined` are false. |
| cell-plan route | `apps/www/src/app/api/daemon/cell-plan/route.test.ts` | Unchanged and green (AC-6). |
| evidence | `apps/www/src/server-lib/compute/cell-evidence-status.test.ts` | Unchanged (reused as is). |

### Gates (from the repo's `CLAUDE.md`)

```bash
pnpm install --frozen-lockfile --prefer-offline
pnpm --filter @terragon/docs exec fumadocs-mdx
pnpm turbo tsc-check
pnpm turbo lint
pnpm turbo format-check
pnpm exec prettier --check --config .prettierrc --no-editorconfig <changed files>   # ~/.editorconfig sets tabs
pnpm --filter @terragon/worker exec vitest run --no-file-parallelism
pnpm --filter @terragon/www exec vitest run --no-file-parallelism                  # docker compose Postgres + Redis (or TEST_DATABASE_ADMIN_URL)
pnpm --filter @terragon/shared exec vitest run --no-file-parallelism               # DoD lists it; only needed if shared changes
```

The hatchet-lite ITs are not affected (no admission or engine change).
