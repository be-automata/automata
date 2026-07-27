# Hatchet Enterprise Hardening — Implementation Plan

Phased, file-level plan to close all 8 ranked gaps in
`docs/research/hatchet-enterprise-practices.md` for the Automata `agent-run`
execution plane. **Plan only — no code here.** Branch: `feat/p05-chassis-triage`
(the working main). Package filter for worker tests: `pnpm --filter @terragon/worker test`;
www: `pnpm --filter @terragon/www test` (shared Postgres container).

## Key findings that shape the plan (verified in-tree 2026-07-25)

- **F-A — the daemon socket is NOT architecturally hardcoded.** `DaemonRuntime` and
  `writeToUnixSocket` already take `unixSocketPath` as a parameter; only the CLI entry
  (`packages/daemon/src/index.ts:156,175`) passes the constant `defaultUnixSocketPath`
  (`packages/daemon/src/shared.ts:6` = `/tmp/terragon-daemon.sock`). Adding a
  `--socket-path` flag is a ~10-line, low-risk change. This is the single unlock for
  true per-run daemon isolation → real parallelism for #3b/#4b/#8. **NEEDS-DAEMON-CHANGE
  but trivial.**
- **F-B — a terminal-failure path already exists.** `handle-daemon-event.ts` treats a
  `custom-error` `ClaudeMessage` as a terminal error that runs the full finish pipeline
  (`updateThreadChatWithTransition` → `handleThreadFinish` → review reconciler + queue
  drain). So gap #2's on-failure callback can POST a **synthetic `custom-error`** to the
  existing `/api/daemon-event` with the run's `daemonToken` — **no new endpoint, no new
  terminal path.** Idempotent: a second terminal transition on an already-terminal thread
  yields `didUpdateStatus=false` → no double finish-hook.
- **F-C — the SDK ships first-class support for every gap.** `@hatchet-dev/typescript-sdk@1.26.0`:
  workflow-level `concurrency` accepts an **array** of stacked keys (`concurrency-rr`,
  `concurrency_multiple_keys` examples); `onFailure` is a **workflow method**
  (`workflow.onFailure({name, fn})` — `on_failure` example), NOT a standalone-task option;
  `NonRetryableError extends Error` is exported from `v1/task`; task-level `idempotency:
  {expression, strategy:'ttl', ttlMs}` exists; `slotCost: N` is a task option; the worker
  object exposes `stop(): Promise<void>` for graceful drain; `retries` **defaults to 0**
  (agent-run already does not auto-retry).
- **F-D — the review post is already exactly-once www-side.** Unconditional single-writer
  at thread-finish (`review-single-writer-finish.ts`) with HEAD-guard + verdict-aware
  idempotency + grace-period sweep backstop (`review-sweep.ts`) + reconciler, and native
  CF crons are wired (`wrangler.jsonc` triggers → `worker-entry.ts` → `cron.ts`). Gap #1's
  residual risk is therefore NOT "build a writer" — it's **retry/redelivery re-running the
  AGENT** and non-review side effects, addressed by keeping the agent non-idempotent-safe
  (retries=0 + engine idempotency key) and proving review idempotency under redelivery.

## Cross-cutting decision: convert `agent-run` from `hatchet.task` to `hatchet.workflow`

`onFailure` (#2) and workflow-level stacked concurrency (#3/#8) are **workflow** features.
The current standalone `hatchet.task({name:'agent-run', concurrency, fn})`
(`workflow.ts:27`) must become:

```
export const agentRunWorkflow = hatchet.workflow({ name: 'agent-run', concurrency: [...] });
agentRunWorkflow.task({ name: 'run', executionTimeout, scheduleTimeout, retries: 0,
                        idempotency: {...}, slotCost, fn });
agentRunWorkflow.onFailure({ name: 'on-failure', fn });
```

`registry.ts` exports the **workflow object** (unchanged array mechanic). The `workflowName`
in `transport.ts` (`"agent-run"`) is unchanged (workflow name == task name today; keep the
workflow name `"agent-run"` so the REST trigger contract is stable). This conversion lands
in **Phase 0** because #2/#3/#8 all build on it.

## Cross-cutting wire-contract change (BOTH mirrors, Phase 0)

Add three fields to `AgentRunInput`. The type is mirrored, not shared — **every field must
be added in both files**:
- `packages/worker/src/agent-run/types.ts` (worker mirror)
- `apps/www/src/agent/hatchet/dispatch.ts` (www mirror)

| Field | Type | Source (dispatch already loads it) | Consumed by |
|-------|------|-----------------------------------|-------------|
| `orgId` | `string` (non-empty, never null) | `thread.organizationId ?? \`u:${userId}\`` — a guaranteed non-null fallback so the CEL key never dereferences null | #3 concurrency `input.orgId`, #7 SLO dimension |
| `prNumber` | `number \| undefined` | `thread.githubPRNumber` (dispatch already fetches it for baseBranch, lines 159–177) | #8 cancel key, #2/#7 context |
| `traceparent` | `string \| undefined` | W3C context injected at dispatch (#7) | #7 trace join |

Rationale for `orgId` non-null contract: CEL `input.orgId` in a concurrency expression must
resolve to a stable non-empty string for every run (personal/no-org threads included), else
round-robin grouping is undefined. Dispatch computes the fallback; the worker never has to.

Test: extend the existing dispatch test to assert all three fields are populated (incl. the
null-org fallback path), and a worker type-level test that `AgentRunInput` carries them.

---

## Phase 0 — Enablers (no behavior change) — do first

**Why first:** pure scaffolding that #2/#3/#4/#7/#8 depend on; ships dark (no runtime
behavior change) so it can merge ahead of the risky phases and be validated in isolation.

### 0.1 Workflow conversion + wire-contract fields
- Files: `packages/worker/src/agent-run/workflow.ts` (task→workflow), `registry.ts`
  (export the workflow object — mechanic unchanged), `packages/worker/src/agent-run/types.ts`
  + `apps/www/src/agent/hatchet/dispatch.ts` (add `orgId`/`prNumber`/`traceparent`).
- dispatch.ts: populate the three fields from the already-loaded `thread` + `userId`.
- Test: worker workflow unit test (registers, still runs a happy-path fn via a mocked ctx);
  dispatch test asserts the new fields incl. null-org fallback.
- Risk: LOW. Behavior identical (concurrency still the same single constant key until Phase 2).
- Verify live: dispatch one review PR, confirm the run still executes end-to-end and the
  additionalMetadata/input now carry `orgId`/`prNumber` (visible in the Hatchet dashboard run detail).

### 0.2 Daemon `--socket-path` + `--pidfile` (F-A) — NEEDS-DAEMON-CHANGE (trivial)
- Files: `packages/daemon/src/index.ts` (add to `parseCliArgs`; pass `cliArgs.socketPath ??
  defaultUnixSocketPath` to `writeToUnixSocket` line 156 and `DaemonRuntime` line 175),
  `packages/daemon/src/shared.ts` (keep default; export a helper if useful).
- Worker side: `DaemonProcess` (`daemon-process.ts`) — make `socketPath` **per-run**
  (derive from `input.threadId`, e.g. `/tmp/terragon-daemon-<threadId>.sock`) and pass
  `--socket-path`/`--pidfile` on spawn (line 99–108); make `pidFilePath` per-run (currently
  the fixed `agent-run-daemon.pid`, line 36) so `reclaimOrphanDaemon` (line 182) reclaims
  only **its own** run's orphan and can never SIGKILL another worker's live daemon.
- Test: daemon test spins two runtimes on two distinct socket paths concurrently and both
  ACK (proves isolation); worker `DaemonProcess` test asserts the flags are passed and the
  per-run pidfile is used.
- **Guard for BUG-EXEC-01/02:** unrelated — provision/base-diff untouched.
- Risk: LOW-MED. The daemon flag is additive (default unchanged). Per-run pidfile changes
  the reclaim semantics — cover the "orphan from prior crash of the SAME threadId" case.
- Verify live: with concurrency still 1, confirm a normal run picks a per-run socket path
  (log line) and tears down cleanly; no `/tmp/terragon-daemon.sock` left behind.

> After 0.2 the socket-collision constraint that forces global `maxRuns=1` is **liftable**.
> Phases 2/3/4 exploit this, but each raise of real concurrency is gated on a memory check
> (see "Concurrency > 1 is gated on memory" below).

---

## Phase 1 — Pure safety (highest priority) — #5, #2, #6, #1

### 1.1 [MUST] #5 — Fail-closed auth-enabled deploy gate — NOW
**Design:** a shell gate + a runtime gate, both fail-closed. Port the reference
`assert-auth-enabled.sh` from orch-agents (per memory `project_hatchet_tenant_scoping_verified`
— "steal assert-auth-enabled.sh") and adapt to hatchet-lite.
- **Detection (fail-closed, positive+negative probe against `HATCHET_API_URL`):**
  1. Negative: call a tenant-scoped REST endpoint with a **deliberately-invalid** bearer
     token; assert **401/403**. If a garbage token is *accepted*, auth is disabled → **exit 1**.
  2. Positive: call the same endpoint with the real `HATCHET_CLIENT_TOKEN`; assert **2xx**.
     If the real token is rejected, the box is misconfigured → **exit 1**.
  3. Image assertion (defense-in-depth): assert the engine image tag is not `*-dev` and no
     `--disable-auth` / `SERVER_AUTH_CONFIG_DISABLE` is set (parse the running container /
     compose). `docker-compose.hatchet.yml` already pins `hatchet-lite:v0.94.10` and sets
     `SERVER_AUTH_SET_EMAIL_VERIFIED: t` — the script asserts the pin didn't drift.
- **Files:**
  - `packages/worker/scripts/assert-auth-enabled.sh` (new).
  - Runtime gate in `packages/worker/src/hello/worker.ts` `main()`: before `worker.start()`,
    run the negative-token probe in TS (cross-platform, works even if the .sh isn't wired on
    a given box) and **`process.exit(1)`** on accept. New file
    `packages/worker/src/agent-run/assert-auth.ts` (probe fn) + call site in `main()`.
  - Operator wiring: `~/.automata/run-worker.sh` calls `packages/worker/scripts/assert-auth-enabled.sh`
    before `exec … pnpm run worker` (OPERATOR ACTION — edit the pilot's run-worker.sh).
- **Test:** unit-test the TS probe with a mocked fetch: accept-on-garbage → throws/exits;
  reject-on-garbage + accept-on-real → passes.
- **Risk:** MED — a false-positive gate blocks a healthy box. Mitigate: probe an endpoint
  whose 401-vs-200 semantics are stable across hatchet-lite versions; log the exact reason.
- **Verify live:** (a) real box → worker boots, log shows "auth-enabled probe OK". (b) point
  at a throwaway `--disable-auth` engine → worker refuses to start, non-zero exit, loud log.
- **Flag:** MUST / NOW / OPERATOR ACTION (edit run-worker.sh).

### 1.2 [MUST] #2 — On-failure task → www terminal event + watchdog — NOW (needs Phase 0 workflow)
**Design (F-B):** `agentRunWorkflow.onFailure({name, fn})` posts a **synthetic `custom-error`
daemon-event** to `/api/daemon-event` using `input.daemonToken` + `input.daemonCallbackUrl`,
so www marks the thread terminal-error and runs the existing finish pipeline (review
reconciler posts "review couldn't complete" as a degraded COMMENT; queue drains). Covers
dead-worker, credits-exhausted, and the Hatchet "Running-with-no-step" footgun.
- **Files:**
  - `packages/worker/src/agent-run/workflow.ts` — add `onFailure` fn. It builds `wwwOpts`
    from `input` (same shape as the run task) and calls a new `postRunFailed(...)` helper.
  - `packages/worker/src/agent-run/www-client.ts` — add `postRunFailed(opts, {reason})`:
    POST `{ threadId, threadChatId, messages: [{ type:'custom-error', error_info: reason }] }`
    to `/api/daemon-event`. **H2:** `reason` must be a Hatchet error class/summary
    (`ctx.errors()`), never the prompt/agent output.
  - No www route change required — `/api/daemon-event` + `handle-daemon-event.ts` already
    handle `custom-error`. Confirm `custom-error` is a valid `ClaudeMessage` variant in
    `@terragon/daemon/shared` (it is consumed at `handle-daemon-event.ts:96`); if the
    daemon-event zod/body validator rejects a worker-synthesized message, widen it minimally.
  - **Watchdog:** the hourly `runStalledTasksCron` (`cron.ts:43`) already stops stalled
    threads AND runs `runReviewSweep`. Delta: **confirm the stalled cutoff comfortably
    exceeds the 30m Hatchet `executionTimeout`** (else the cron reaps a still-running remote
    thread). Inspect `getStalledThreads` cutoff; if < 40m, raise it or make it remote-aware.
    This is the slow backstop (≤1h); onFailure is the fast path (seconds).
- **Test (TDD):** worker onFailure unit test — given a thrown run + mocked fetch, asserts one
  `custom-error` POST with the reason and no prompt content. www `handle-daemon-event` test —
  a `custom-error` from the daemon token transitions the thread to error terminal and fires
  the finish hook once; a second identical event is a no-op (`didUpdateStatus=false`).
- **Risk:** MED — a spurious onFailure on a run that actually succeeded would post a false
  failure. Mitigate: onFailure only fires when the workflow FAILED (Hatchet guarantees this);
  and the www transition is terminal-idempotent, so a race with a real terminal event is
  absorbed. Do NOT revoke tokens in onFailure (leave to the normal terminal-read path).
- **Verify live:** kill the worker mid-run (or exhaust credits) → within seconds the thread
  flips to a surfaced error in the dashboard (not a silent "working…"), and a review thread
  gets a "couldn't complete" comment. Confirm via `automata.beautomata.com/api/runs`.
- **Flag:** MUST / NOW.

### 1.3 [SHOULD] #6 — Non-retryable classification — NOW (pairs with #2)
**Design:** throw `NonRetryableError` (imported from `@hatchet-dev/typescript-sdk`) for
known-terminal errors so they route straight to onFailure and never burn backoff (relevant
once retries > 0; correct to classify now regardless).
- **Files:** `packages/worker/src/agent-run/workflow.ts` (+ `daemon-process.ts`):
  - `preflightGhAuth` failure (line 84) → `NonRetryableError` (misconfig, not transient).
  - `pullNextMessage` HTTP 4xx (PR gone / permission / bad token) → `NonRetryableError`
    (distinguish from 5xx/network which stay retryable). Adjust `www-client.ts:51` to carry
    the status so the caller can classify.
  - daemon "rejected the message" (`daemon-process.ts:298`) → `NonRetryableError`.
- **Test:** unit — a 403 from next-message throws `NonRetryableError`; a 503 throws a plain
  error (retryable).
- **Risk:** LOW. Misclassifying a transient as non-retryable only means "no auto-retry" —
  which is the current behavior anyway (retries=0). Safe.
- **Flag:** SHOULD / NOW.

### 1.4 [MUST] #1 — Exactly-once GitHub review post — NOW
**Design (F-D):** the post is already exactly-once www-side. The Hatchet-layer risk is the
AGENT re-executing on redelivery. Two mechanisms + one proof:
1. **Keep `retries: 0` explicit** on the run task (with a comment: a minutes-long agent run
   is NOT idempotent — never auto-retry the agent). Default is already 0; make it explicit
   so a future edit can't silently enable retries.
2. **Engine-level idempotency key** on the run task: `idempotency: { expression:
   'input.threadId', strategy: 'ttl', ttlMs: <~35m, > executionTimeout> }`. A redelivered
   trigger for the same thread within the window is deduped by the engine before a second
   daemon ever spawns. Complements the existing www `hasActiveDaemonToken` dispatch guard
   (which guards double-DISPATCH; this guards double-EXECUTION on redelivery/at-least-once).
3. **Proof of review idempotency under redelivery:** www test — fire the finish hook TWICE
   for the same terminal review thread (simulating a redelivered/duplicated terminal event);
   assert `executeReviewFromIntent` + HEAD-guard yields exactly ONE posted review (the second
   is a HEAD/verdict-idempotent no-op). This locks the existing invariant against the
   at-least-once model rather than re-implementing it.
- **Explicit non-goal:** do NOT adopt Hatchet **durable execution** / replay-from-checkpoint.
  Our idempotency is externalized to www's single-writer (HEAD + verdict), which is simpler
  and already proven; durable execution would add a second, overlapping idempotency model.
  Record this as the architectural decision.
- **Explicit residual (out of scope, note only):** MENTION threads that post via raw `gh`
  have no single-writer channel (memory `project_review_dedup_reconciler` — deferred). At
  retries=0 + idempotency key the only double-act window is engine redelivery, now closed by
  mechanism #2. Full mention single-writer stays deferred.
- **Files:** `packages/worker/src/agent-run/workflow.ts` (retries + idempotency options);
  www test in `apps/www/src/server-lib/review/*.test.ts`.
- **Risk:** LOW-MED. Idempotency TTL must exceed `executionTimeout` or a legitimately-re-queued
  thread (after a long gap) could be wrongly deduped — size the TTL just above 30m.
- **Verify live:** dispatch a review; force a duplicate trigger (or observe a natural
  redelivery) → exactly one review at HEAD, one daemon spawn.
- **Flag:** MUST / NOW.

---

## Phase 2 — Concurrency & fairness — #3

### 2.1 [MUST] #3 — Per-org fairness via GROUP_ROUND_ROBIN on `org_id`
**Design:** replace the single constant concurrency key with a **stacked array** at the
workflow level (Phase 0 enabled workflow-level concurrency):
```
concurrency: [
  { expression: 'input.orgId', maxRuns: <perOrg>, limitStrategy: GROUP_ROUND_ROBIN },
  { expression: "'agent-run-shared-daemon-socket'", maxRuns: <global>, limitStrategy: GROUP_ROUND_ROBIN },
]
```
- **#3a NOW (no memory change): fair ORDERING at global cap 1.** Set the global constant key
  `maxRuns: 1` (protects the single-daemon-socket box) and the org key `maxRuns: 1`. Even at
  global serialization, GROUP_ROUND_ROBIN on `orgId` makes the scheduler pick the next
  **org** fairly when the slot frees, instead of FIFO letting one org's backlog head-of-line-
  block every tenant. This is the direct product answer to "one org can't starve another" at
  pilot volume, and needs only Phase 0 (orgId on the wire + workflow conversion). **No daemon
  change, no memory change.**
- **#3b LATER (real per-org parallelism): raise global `maxRuns` > 1.** Requires Phase 0.2
  (per-run socket, so N daemons don't collide) AND a memory validation (N concurrent agents ×
  ~agent RSS < box headroom — the orch-agents ENOMEM wall lesson). Until validated, keep
  global `maxRuns: 1`. When raised, set org `maxRuns` below global so no single org can take
  all slots.
- **Files:** `packages/worker/src/agent-run/workflow.ts` (concurrency array). Values as
  named constants with a comment tying `maxRuns` to the memory budget.
- **Test:** unit assertion on the concurrency config shape (both keys, strategies). Live UAT
  for fairness (below) — unit tests can't prove scheduler ordering.
- **Risk:** MED — a wrong CEL expression (null orgId) breaks ALL scheduling. Phase 0's
  non-null `orgId` contract is the guard; add a dispatch test for the fallback.
- **Verify live (fairness UAT):** enqueue 2 PRs for org A + 1 for org B nearly simultaneously;
  assert B's single review is not stuck behind both of A's (round-robin interleaves). Observe
  order via the Hatchet dashboard queue + `/api/runs` timestamps.
- **Flag:** #3a MUST / NOW. #3b MUST / NEEDS-DAEMON-CHANGE (0.2) + NEEDS-INFRA (memory headroom).

---

## Phase 3 — Worker lifecycle & deploys — #4

### 3.1 [MUST] #4 — Graceful SIGTERM drain — NOW
**Design:** `worker.ts main()` registers `process.on('SIGTERM' | 'SIGINT', …)` → `await
worker.stop()` (SDK graceful stop: stop accepting new work, let the in-flight minutes-long
run finish, then exit). Never hard-kill mid-run.
- **Files:** `packages/worker/src/hello/worker.ts` — capture the `worker` handle (already
  local), add signal handlers that call `worker.stop()` then `process.exit(0)`; guard against
  double-invocation. Confirm `worker.stop()` drains rather than aborts (SDK
  `worker-internal.d.ts:79 stop(): Promise<void>`); if it aborts immediately, fall back to a
  drain loop that flips an "accepting" flag and awaits the in-flight run's teardown.
- **Operator wiring:** the launchd restart procedure must send **SIGTERM and wait**, not
  `kickstart -k` (SIGKILL). Update the documented restart to `launchctl kill SIGTERM
  gui/$UID/com.automata.worker` then poll for exit before reload. The plist `KeepAlive`
  restarts it after graceful exit. (OPERATOR ACTION.)
- **Test:** unit — send a simulated SIGTERM while a fake run is "in flight"; assert
  `worker.stop()` is awaited before exit and the daemon is NOT torn down early.
- **Risk:** MED — if `stop()` doesn't actually drain, a deploy still drops the run. Validate
  the SDK behavior empirically before relying on it (spike: start a run, SIGTERM, confirm it
  completes).
- **Verify live:** start a review run, send SIGTERM to the worker → the run completes and
  posts its review, THEN the process exits (check `worker.log`).
- **Flag:** MUST / NOW / OPERATOR ACTION (launchd restart procedure).

### 3.2 [MUST] #4 — ≥2 workers (rolling restart)
**Design:** run a second worker so a deploy rolls one at a time (the draining one finishes,
the other serves). On the single pilot Mac, two workers share `/tmp`.
- **Blocker resolved by Phase 0.2:** per-run socket + per-run pidfile. Without it, worker B's
  `reclaimOrphanDaemon` (fixed pidfile, `daemon-process.ts:36,182`) could SIGKILL worker A's
  **live** daemon. With per-run resources, the two workers never touch each other's daemon.
- **Global serialization preserved:** the workflow's constant concurrency key `maxRuns: 1`
  (#3a) still ensures only ONE agent-run executes at a time across BOTH workers — the second
  worker is a warm standby for HA/rolling-restart, not extra throughput (throughput is #3b).
- **Files/infra:** a second launchd unit `com.automata.worker-2.plist` (distinct Label, log
  paths) pointing at the same `run-worker.sh`. **NEEDS-INFRA** (operator installs the 2nd
  unit). Alternatively a second box (no shared /tmp) — but the single-Mac pilot makes the
  per-run-socket same-box path the pragmatic choice.
- **Zombie/leaked-worker guard (Hatchet's #1 bug):** ensure each launchd unit reaps the whole
  process group on exit; the daemon already SIGKILLs its own group on teardown
  (`daemon-process.ts` class doc). Add a heartbeat/liveness note to the observability alerts
  (#7): alert on a worker that stops heartbeating.
- **Workflow version pinning across deploy:** confirm in-flight runs stay on their registered
  workflow version during a rolling deploy (research verification caveat — read the versioning
  doc before relying). If not guaranteed, drain fully (3.1) before swapping.
- **Test:** integration/manual — two workers up, dispatch a run, kill one → run unaffected;
  no cross-worker daemon kill (assert via per-run socket/pidfile paths in logs).
- **Risk:** MED — memory: two idle workers + one active agent must fit the box. Two workers do
  NOT mean two concurrent agents at `maxRuns:1`, so memory cost is ~2 idle Node processes +
  1 agent (fine). Only #3b multiplies agents.
- **Verify live:** rolling restart (SIGTERM worker A, it drains + exits + KeepAlive relaunches)
  while worker B holds the fort → zero dropped reviews across the deploy.
- **Flag:** MUST / NEEDS-DAEMON-CHANGE (0.2) + NEEDS-INFRA (2nd launchd unit / operator).

---

## Phase 4 — Observability & advanced flow-control — #7, #8

### 4.1 [SHOULD] #7 — End-to-end OTel trace join
**Design:** enable the TS OTel instrumentor with `enableHatchetCollector:false`, export to our
own OTLP collector, propagate W3C `traceparent` www → worker → `/api/daemon-event` → GitHub
post. Dimension SLOs on `orgId`.
- **Files:**
  - www `dispatch.ts` — inject current trace context into `input.traceparent` (Phase 0 field);
    span "dispatch agent-run" with `orgId`/`prNumber`/`threadId` attrs.
  - `packages/worker` — init the Hatchet OTel instrumentor at boot
    (`worker.ts`/new `otel.ts`); in the run task, start a child span from `input.traceparent`;
    propagate `traceparent` on `www-client` daemon-event POST headers.
  - www daemon-event route — continue the trace from the inbound `traceparent` so the GitHub
    post is in-trace.
- **Alerts (per `orgId`):** SCHEDULING_TIMED_OUT, heartbeat gap (dead worker), credits-
  exhausted stall (the #1 stalled cause — memory `project_prod_observability`), P95 run
  latency, failure/retry rate, queue depth.
- **Infra:** an OTLP collector endpoint + secret (`OTEL_EXPORTER_OTLP_ENDPOINT`) on the
  worker box and a www secret via `wrangler secret put`. **NEEDS-INFRA.**
- **Test:** unit — worker starts a span from a given `traceparent` and the daemon-event POST
  carries a matching one. End-to-end trace continuity is a live check.
- **Risk:** LOW (observability-only; no control-flow change). Keep prompt/token OUT of span
  attributes (H2).
- **Verify live:** one dispatched review yields a single connected trace dispatch→worker→post
  in the collector, tagged with `orgId`.
- **Flag:** SHOULD / NEEDS-INFRA (collector + secrets).

### 4.2 [SHOULD] #8 — Supersede stale in-flight review on new push + Task Slot Cost
**Design — supersede (www-side, NOT task `CANCEL_IN_PROGRESS`):** the current task explicitly
QUEUEs rather than cancels ("an in-flight agent turn must never be killed", `workflow.ts:25`),
and one task serves BOTH reviews and mentions — so a blanket `CANCEL_IN_PROGRESS` concurrency
strategy would wrongly kill mention turns. Instead, **www cancels the prior run for the same
PR when a new review is dispatched**:
- Track the run's `externalId` (returned by `triggerAgentRun`, `transport.ts:53`) keyed by
  `org:repo:pr` (a small Neon table or reuse an existing run-tracking store).
- On dispatch for a **review** thread whose `org:repo:pr` has a live in-flight run, call the
  Hatchet **REST cancel** endpoint for the prior `externalId` before/after triggering the new
  one (CF Workers REST-only — a new `cancelAgentRun` in `transport.ts`). Mentions never
  supersede.
- **Files:** `apps/www/src/agent/hatchet/transport.ts` (`cancelAgentRun`), `dispatch.ts`
  (record externalId; supersede-on-review-dispatch), a run-tracking model in
  `@terragon/shared/model` or a new tiny table.
- **Design — Task Slot Cost:** set `slotCost: N` on the run task to model agent memory weight
  so the physical slot count reflects real capacity when #3b raises concurrency. Meaningless
  at `maxRuns:1`; **defer wiring until #3b/#4b raise concurrency** (mark NEEDS-INFRA-dependent).
- **Test:** www unit — a second review dispatch for the same PR cancels the first run's
  externalId via REST; a mention dispatch does NOT cancel.
- **Risk:** MED — cancelling mid-run must still run the worker's `finally` teardown (it does:
  Hatchet cancel → `ctx.cancelled`/abort → `pollUntilTerminal` returns `cancelled` → daemon
  teardown, `workflow.ts:119`). A cancelled review must NOT post a stale verdict — confirm the
  cancel path does not reach the single-writer post (a cancelled run has no terminal
  daemon-event, so the finish hook doesn't fire — good).
- **Verify live:** push twice quickly to a PR → only the newest review is posted; the older
  run shows CANCELLED in the dashboard, no stale verdict on the PR.
- **Flag:** #8 supersede SHOULD / NOW (www + REST). Slot cost SHOULD / NEEDS-INFRA (gated on #3b).

---

## "Concurrency > 1 is gated on memory" (applies to #3b, #4b)

The orch-agents ENOMEM wall (per project memory: 4+ concurrent SDK sessions tripped
`fork/posix_spawn` on a 7.6GB box; safe only after an 8GiB swap file) is the precedent. Each
agent-run spawns a full `claude` agent. Before raising global `maxRuns` above 1: measure
per-agent RSS on the pilot Mac, confirm `N × RSS + headroom < RAM (+ swap)`, and only then
raise `maxRuns` with `slotCost` reflecting the weight. Keep `maxRuns:1` until this is done —
#3a (fair ordering) and #4a/#4b-HA (rolling restart) deliver the MUST value without it.

## Operator-action checklist (flag every one to team-lead)

| Action | Where | Gap | Phase |
|--------|-------|-----|-------|
| Edit `~/.automata/run-worker.sh` to call `assert-auth-enabled.sh` before `pnpm run worker` | pilot Mac | #5 | 1 |
| Change restart procedure: `launchctl kill SIGTERM …` + wait, drop `kickstart -k` | pilot Mac launchd | #4 | 3 |
| Install 2nd launchd unit `com.automata.worker-2.plist` | pilot Mac | #4 | 3 |
| Provision OTLP collector + set `OTEL_EXPORTER_OTLP_ENDPOINT` (worker box) + www `wrangler secret put` | box + CF | #7 | 4 |
| Confirm `getStalledThreads` cutoff > 30m Hatchet executionTimeout | www code (verify) | #2 | 1 |
| Rebuild `@terragon/daemon` after 0.2 (worker consumes `packages/daemon/dist`) | pilot Mac | #4/#3b | 0 |
| Redeploy www (wrangler) for dispatch/wire-contract/#8 changes | CF | #3/#7/#8 | 0/2/4 |
| Restart Hatchet engine only if compose/auth config changes (it shouldn't) | box | #5 | 1 |
| Install the 2 launchd units + wire `assert-auth-enabled.sh` in `run-worker.sh` per `packages/worker/deploy/README.md` | pilot Mac | #4/#5 | 3 |
| Apply the `hatchet_run` table DDL to prod Neon (single-table, NOT a blanket `drizzle-kit push`) — the repo is push-based, so `schema.ts` is source-of-truth; extract just the `hatchet_run` CREATE TABLE + 2 indexes and apply via the migration path the operator uses for Neon | Neon | #8 | 4 |

### Phase 4 — still OPEN / NEEDS-INFRA (not built here)

- **#7 OTLP collector export** — the code injects/propagates/logs a W3C `traceparent`
  (dispatch → worker → daemon-event → GitHub post), but there is **no collector
  wiring**: no OpenTelemetry SDK is bundled (CF Workers budget), no OTLP exporter, no
  `OTEL_EXPORTER_OTLP_ENDPOINT`. Trace JOIN is provable from logs today; full
  collector export + per-`orgId` SLO dashboards + alerts (SCHEDULING_TIMED_OUT,
  heartbeat gap, credits-exhausted stall, P95, failure rate, queue depth) remain
  operator NEEDS-INFRA.
- **#8 `slotCost`** — DEFERRED (a one-line marker sits at the run task in
  `workflow.ts`); wire only when #3b raises the global concurrency cap.

## Architect validation outcomes (2026-07-25) — BINDING amendments

System-architect verified every disputed claim against the installed SDK (1.26.0 `.d.ts` +
compiled `.js`) and in-tree code. These amendments SUPERSEDE the sections above where they
conflict:

1. **1.4 mechanism #2 (engine idempotency key) is DROPPED — REJECTED.** Task-level
   `idempotency` does not exist in SDK 1.26.0 (workflow-level only), and keying on
   `input.threadId` would be HARMFUL: threadId is stable across a thread's life, so a
   sliding-TTL dedup would swallow legitimate multi-turn follow-up runs. The at-least-once
   window is already closed by `retries: 0` + workflow `maxRuns: 1` + post-completion
   next-message 204/401 no-op + the verdict/HEAD-idempotent single-writer. Keep mech #1
   (explicit `retries: 0` + comment) and mech #3 (redelivery proof test) only.
2. **0.2 reclaim redesign (0.2 splits into 0.2a + 0.2b).** Per-run pidfile as planned
   DEFEATS the rogue-daemon guard (run B would never reap run A's crashed orphan).
   - **0.2a (ships now):** daemon `--socket-path` flag; worker derives a per-run socket.
   - **0.2b (blocks 3.2):** namespace `/tmp/automata-agent-run/<workerId>/<threadId>.{sock,pid}`
     where `<workerId>` is a stable per-worker-process id persisted in a boot lock-file
     (containing the worker pid). Reclaim ONCE at worker boot: scan SIBLING `<workerId>/`
     dirs; for any whose recorded worker pid is dead (`process.kill(pid, 0)` throws),
     SIGKILL all daemon pids inside and remove the dir. A live worker's dir is never
     touched (safe for ≥2 workers); a dead worker's orphans are always reaped (rogue
     guard preserved). Per-run `start()` cleans only its own stale socket.
3. **`onFailure({ fn })` — no `name` option** (`CreateOnFailureTaskOpts` omits `name`).
4. **onFailure cannot cover the revoked-token failure class** (S12 family): it auths with
   `input.daemonToken`, which is already dead in that class → the POST 401s. The stalled-
   thread watchdog is the ONLY backstop there — document this at the call site.
5. **Stalled-cron cutoff is 60m** (`getStalledThreads` default `cutoffSecs=60*60`,
   `packages/shared/src/model/threads.ts:1194,1209`) — EQUAL to the worst-case legit run
   (30m schedule + 30m execution). Raise the remote cutoff to ~75m (or make it
   remote-aware) so a late-starting run isn't reaped at the boundary.
6. **`triggerAgentRun` does NOT return an externalId today** — `transport.ts:53` casts the
   REST response to `{externalId?}` but the id lives at `run.metadata.id`
   (`V1WorkflowRunDetails`). Fix in Phase 0 (parse and return `json.run.metadata.id`) so
   ids are captured from first dispatch (#8 prereq). REST cancel exists and is CF-safe:
   `POST /api/v1/stable/tenants/{tenant}/tasks/cancel` with `{externalIds: [...]}` —
   live-verify it accepts the trigger-returned workflow-run id.
7. **#8 must add a www-side terminal transition** for the superseded thread: a cancelled
   run emits NO terminal daemon-event (worker SIGKILLs the daemon in `finally`), so
   without an explicit transition the old thread zombies as "working" until the watchdog.
8. **3.1 needs NO custom SIGTERM handler** — the SDK already installs
   `process.on('SIGTERM'|'SIGINT') → exitGracefully(true)` which pauses intake and
   `await Promise.all(this.futures)` (true drain, unbounded). A second handler would race
   it. 3.1's deliverable is OPERATOR-ONLY: launchd restart = SIGTERM + wait (drop
   `kickstart -k`), plus a boot log line confirming drain semantics.
9. **Workflow-conversion output shape change is safe** — nothing in apps/www consumes the
   trigger response body or `AgentRunOutput` (fire-and-forget trigger).
10. **custom-error needs no validator widening** — `/api/daemon-event` route body is a bare
    cast (no zod); `handle-daemon-event.ts` tolerates a minimal
    `{type:'custom-error', error_info}`; terminal transition is CAS-idempotent
    (`didUpdateStatus` gating the finish hook).
11. **#3a fairness is only provable LIVE** — config shape type-checks, but engine
    round-robin-across-orgs behavior is scheduler-side. #3a is "delivered" only when the
    2-org interleave UAT is observed, not on merge.

## LIVE UAT RESULTS (2026-07-25) — executed, observed, verified

Deployed www (wrangler versions ff5e770d → fe9f1da7) + rolled both workers on the pilot
Mac. Evidence per gap:

- **E2E ×3 through the new plane** (UAT PR be-automata/automata#1, pushes 4374fee /
  e3505a2 / db21417): webhook → new www (orgId/prNumber/traceparent) → REST trigger →
  workflow `agent-run` child task `run` → stacked CEL concurrency (0 rows in
  `v1_cel_evaluation_failures_olap`) → per-run socket daemon → review posted by
  `automata-ai-bot[bot]`. Exactly ONE review at every HEAD.
- **#1 exactly-once under REAL redelivery:** worker SIGKILLed mid-run (probe db21417) →
  engine re-assigned the SAME task run to the relaunched worker → agent re-executed →
  exactly ONE review at HEAD. (Lost-worker reassignment is at-least-once at the
  ASSIGNMENT layer — `retries: 0` does not gate it; the single-writer HEAD-guard is
  what held.)
- **#4 drain + HA:** SIGTERM → SDK "Gracefully exiting… Successfully finished pending
  tasks" observed twice; KeepAlive relaunch; TWO units co-running (A+B), both
  listeners connected. Worker death mid-run did NOT lose the review (reassignment).
- **#2b reclaim:** relaunched worker logged `reclaim: removed dead worker dir
  w-51246-…`/`w-67671-…` — dead sibling reaped (orphan daemon group-killed), live
  worker's dir untouched by unit B.
- **#5 auth gate:** shell+TS gates both pass live (`garbage=403, real=200`, image pin
  clean); worker refused to boot until the gate passed (fail-closed proven by the
  three boot failures during fixing).
- **#7 trace join:** traceparent minted at dispatch, observed in worker step logs
  (`trace=00-…`) across all three runs, forwarded on www-client calls.
- **Frontend e2e (chrome-devtools):** landing + login render on the final deploy, zero
  console errors, authed API 401s unauthenticated.
- **Live-caught fix-forwards (commit 587bf75):** run-worker.sh signal chain (pnpm
  swallows SIGTERM → exec-direct `node --import tsx`), .sh JWT-claim fallback, probe
  endpoint `since`+`only_tasks` required, image-tag-scoped `-dev` check, comment-line
  exclusion. Plus the NEXT_PUBLIC build-inlining regression (raw-process.env vars
  envsafe never flags → client throw) caught by the browser e2e and redeployed.

**#8 double-push UAT (2026-07-26) — LIVE-PROVEN.** `hatchet_run` DDL applied to prod
Neon (scoped single-table, verified 9 columns + 2 indexes). Triple-push sequence
(2b1485f → 81d97b3 → edae896, PR be-automata/automata#1) produced a DOUBLE supersede
chain: each newer dispatch REST-cancelled the prior in-flight run (engine logged
`Task run cancelling… → cancelled` twice, 13s from push to cancel), rows flipped
`in_flight → superseded`, the superseded thread transitioned terminal
(`complete`/`errorMessage="superseded"` observed in prod), and the final HEAD got
exactly ONE review with ZERO reviews at both superseded HEADs. Round-robin even
alternated the runs A→B→A across the two workers.
- Minor nit (non-blocking): one superseded thread ended `errorMessage=null` — a later
  write overwrote the supersede reason after the terminal transition (thread correctly
  terminal, purely cosmetic; trace which writer clears errorMessage post-terminal).
- External anomaly observed (NOT ours): GitHub delivered probe A's `synchronize`
  webhook ~12h after the push (hook deliveries log shows the gap; all 200s, no
  redeliveries). Our plane dispatched within 3s of delivery.

**Still open (operator-gated):**
- #3a ROUND-ROBIN fairness ORDERING across orgs: config live-validated; the 2-org
  interleave observation awaits a second live org (amendment 11).
- #7 OTLP collector export + per-org SLO alerts (NEEDS-INFRA).

## Verification-caveat reads before building (from the research doc)
- ~~Task-level idempotency~~ — settled: does not exist at task level in 1.26.0; DROPPED (amendment 1).
- ~~`worker.stop()` drains vs aborts~~ — settled: drains (amendment 8).
- Confirm **workflow version pinning** for in-flight runs across a deploy (3.2) before
  claiming zero-downtime; if unconfirmed, fully drain before swap.
- ~~daemon-event validator accepts synthesized `custom-error`~~ — settled: yes (amendment 10).
```
