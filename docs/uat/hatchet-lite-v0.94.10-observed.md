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

## 5. Concurrency groups are scoped per workflow

A run on `agent-run-strict` started 193ms into a live `agent-run-newest` run:
the `'agent-run-global-memory-budget'` key — a constant expression meant as a
box-wide cap — is a separate group per workflow version. With the four
variants registered the engine alone would allow up to four concurrent
agent-runs on a box budgeted for one. The worker therefore enforces the box
budget itself (since #183: `packages/worker/src/agent-run/box-lock.ts`, a kernel
flock(2) held by a `lockf`/`flock` helper child, released by the kernel when the
holder dies — no heartbeat, no staleness reclaim; it replaced the #125 C4
`box-slot.ts` owner-file scheme, and the box now runs one worker unit); the E2E's next case proves runs on different variants no longer
overlap with it in place.

Also observed, INTERMITTENTLY, on `agent-run-strict` (three stacked
`GROUP_ROUND_ROBIN` entries): two runs with different `prKey`s and different
orgs RUNNING at the same time — the per-workflow cap is not even reliable
within that variant (the #69 stacked-GRR family). Not frozen as a case because
it is intermittent; it is the second reason the box slot, not the engine, is
the enforcement point for the one-agent budget.

## 6. Concurrent triggers lose no run (#395 verdict, 2026-11-17)

42 trigger POSTs fired at once (`Promise.all`) on `agent-run-strict` at caps 3/2
with a `slots: 3` worker: every run reaches COMPLETED **and** executes. Measured
on an idle machine in nine runs (378 concurrent triggers, 378 executions, 0%
loss); frozen by the `#395` case in `burst.integration.test.ts`, no longer
skipped.

The 2026-10-19 report ("31 of 42 COMPLETED without executing") was a harness
artefact, reproduced on demand: two HATCHET_IT processes on one machine shared
the ONE fixed IT stack (`automata-hatchet-it`, fixed ports, `up -d` silently
joins, `bootstrapTenant` always resolves the default tenant), so two workers
served one tenant and one workflow. The engine spread each process's runs over
both; each suite's stub only sees its own. In the drill, B saw 42/42 terminal
and 17 executed; A's worker had run the other 25. No trigger-side collapse, no
OLAP/status artefact, no engine scheduling fault, and no production exposure
(one worker unit per box, its own tenant). Since #395 the harness holds a
machine-wide kernel flock for the life of the stack (`hatchet-it-harness.ts`,
`acquireItStackLock`), so a second process waits instead of joining, and both
burst cases assert a sole worker on the tenant. No upstream issue matches;
hatchet-dev/hatchet#4494 (a dropped task left QUEUED with a leaked slot) and
#4778 (positional GRR capacity) are different symptoms.

## Also verified (not characterizations — the intended semantics hold)

- `agent-run-newest` (`CANCEL_IN_PROGRESS`): the live run is CANCELLED, the
  stub observes `ctx.cancelled`, the newcomer completes.
- `agent-run-discard` (`CANCEL_NEWEST`): the newcomer is CANCELLED without ever
  executing; the incumbent completes.
- `agent-run-strict` (`GROUP_ROUND_ROBIN`): strict FIFO per `prKey`, no overlap.

## 7. `ctx.refreshTimeout` is additive (#742, 2026-11-21)

Measured by `refresh-timeout.integration.test.ts` (HATCHET_IT, `retries: 0`, the
shipped `agent-run-discard` shape with `executionTimeout` scaled to 10 s):

| Case       | Refresh            | Run time | Result                                                                                            |
| ---------- | ------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| R0 control | none               | 15 s     | FAILED, one attempt (the registered timeout bites)                                                |
| R1         | `"20s"` at t = 1 s | 15 s     | COMPLETED, one attempt (`ctx.refreshTimeout` is a function on the SDK context)                    |
| R2         | `"10s"` at t = 4 s | 17 s     | COMPLETED: **additive** (deadline 10 + 10 = 20 s; reset-from-now would have cancelled it at 14 s) |
| R3         | `"10s"` at t = 1 s | 60 s     | FAILED, and still exactly one attempt after a 6 s settle                                          |

Consequences for the worker:

- A refresh ADDS its interval to the run's current deadline. A task registered with
  `"30m"` reaches the 60-minute task-lane budget with `refreshTimeout("30m")`
  (`TASK_LANE_REFRESH` in `run-budget.ts`); `"60m"` would give 90.
- `retries: 0` still means a timed-out refreshed run is never re-executed (the #371 fact,
  extended to the refreshed case).
- The IT fails if `TASK_LANE_REFRESH` and the engine disagree.
