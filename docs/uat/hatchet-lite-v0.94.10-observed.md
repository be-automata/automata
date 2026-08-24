# hatchet-lite v0.94.10 — observed scheduling semantics (#125 C3, 2026-08-24)

Single home for the engine-version-pinned facts the worker's registration shapes
rely on. Proven by `packages/worker/src/agent-run/supersede.integration.test.ts`
(`HATCHET_IT=1`, isolated stack — see `hatchet-it-harness.ts`) with a real SDK
1.26.0 worker and a stub task fn registered from the SHIPPED
`buildAgentRunDefinition` shapes. Each fact is frozen by a CHARACTERIZATION case;
an engine upgrade that changes one breaks that case on purpose — update the fact
here and the case together.

## 1. Cross-org ordering under the global cap is FIFO

Org A backlog of 3 runs (3 PRs) + org B 1 run, dispatched last, under
`GLOBAL_MAX_RUNS = 1`: start order is `a1 → a2 → a3 → b1`, reproducibly.
The global key (`'agent-run-global-memory-budget'`) is ONE concurrency group,
and `GROUP_ROUND_ROBIN` over a single group is FIFO; the per-org entry
(`input.orgId`, cap 1) only serializes within an org. The pre-#128 claim that
"one org's backlog can never head-of-line-block another" (Phase 2 #3a) is NOT
delivered at global cap 1. Cross-org fairness needs `GLOBAL_MAX_RUNS > 1`
(memory-gated, #3b) or an engine ordering primitive.

## 2. `CANCEL_IN_PROGRESS` cancels an older run that is still QUEUED

With the global slot occupied by an unrelated run, X1 then X2 on the same
`prKey`: X1 is CANCELLED while still QUEUED and never executes; X2 completes.
The per-PR strategy applies to queued runs, not only running ones.

## 3. Delivery-id idempotency is inert

SDK 1.26.0 registers `idempotency` from the WORKFLOW declaration only (a
task-level option is dropped — `worker-internal.js`). Even at workflow level,
v0.94.10 accepts the registration but persists no workflow idempotency config
(its schema has `v1_idempotency_key` for durable-event keys only; the binary
carries `ClaimIdempotencyKeys`/`ShouldSkip` but nothing stores the CEL/TTL):
the same `deliveryId` triggered twice — over REST and over the SDK — executes
TWICE and `v1_idempotency_key` stays at 0 rows. The config stays registered so
nothing else changes the day the engine honours it; until then www's per-thread
double-dispatch guard and the C4 sweep are the protection, and #127 AC4's
dedupe half is an open deviation.

## 4. No scheduling rot across ephemeral per-PR groups

50 sequential runs, each its own per-PR concurrency group (the shape #69 feared
would multiply rot): trigger→start latency of run 50 ≤ 2× run 1, and zero
QUEUED/RUNNING runs remain after the drain. This is #69's regression guard.

## Also verified (not characterizations — the intended semantics hold)

- `agent-run-newest` (`CANCEL_IN_PROGRESS`): the live run is CANCELLED, the
  stub observes `ctx.cancelled`, the newcomer completes.
- `agent-run-discard` (`CANCEL_NEWEST`): the newcomer is CANCELLED without ever
  executing; the incumbent completes.
- `agent-run-strict` (`GROUP_ROUND_ROBIN`): strict FIFO per `prKey`, no overlap.
