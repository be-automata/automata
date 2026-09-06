# ADR-007 — Supersession authority and the one-agent box budget

- **Status:** Supersession half: **Accepted** (PR #175 → `e3dcc1b`, live-proven 2026-09-02). Box-budget half: Stage A **Accepted** (PR #177 → `b11762f`, drill-proven); Stage B1 (#183 → PR #186 → `88e8e75`, kernel lock + one-unit topology) **Accepted** (live-proven 2026-09-06: U1 SIGKILL mid-run → 0 holders at once, redelivery admitted 32 s later with no staleness wait; U2 one `lockf` holder; U3 one unit); Stage B2 (#184) pending; memory ceiling deferred 2026-09-05.
- **Date:** 2026-09-02
- **Issues:** #165 (supersession sole authority), #152 (concurrency budget consolidation), epic #125
- **Supersedes / superseded by:** —

## Context

Epic #125 made a PR review's supersession behavior a configurable policy: the repo's
`supersedePolicy` (`newest-wins` / `complete-run-queue` / `complete-run-discard`) selects a
Hatchet workflow variant whose per-PR concurrency strategy (CANCEL_IN_PROGRESS /
GROUP_ROUND_ROBIN / CANCEL_NEWEST) cancels, queues, or drops runs when a newer push
arrives. Two structural questions were left open at delivery:

1. **Who terminates a prior run?** The legacy path (`app-side` policy, the
   `supersedePolicy` feature flag OFF) had www cancel prior runs itself, in TWO places
   (dispatch's `supersedePriorReviewRuns`, the automation's archive-prior-threads block).
   #143 gated both on the repo's _current_ policy — leaving two termination authorities
   plus policy-flip races in both directions (a queued engine-owned run cancelled by www;
   a legacy run stranded into a duplicate review).
2. **What enforces "one agent at a time" on the box?** Hatchet offers no cross-workflow
   concurrency primitive: concurrency entries are scoped per workflow with the strategy
   fixed at definition time (docs; live-proven by the #128 E2E — an `agent-run-strict` run
   started 193 ms into a live `agent-run-newest` run), worker `slots` cap per worker
   _process_, and rate limits are starts-per-window. The interim belt is
   `packages/worker/src/agent-run/box-slot.ts`, a bespoke lease whose dead-holder reclaim
   is a 45-second staleness _assumption_ — it cannot observe whether the previous
   holder's agent process group actually died.

## Decision

1. **The engine is the sole AUTOMATIC cancelling authority for review runs.** www
   dispatches and stamps; it owns no supersession path. The `app-side` policy is removed
   from the policy space and the `supersedePolicy` feature flag retired; every review
   dispatch resolves an engine policy and routes to its variant. The only other way a
   review run stops is an explicit user action (`user-cancelled`). (#165)
2. **The policy snapshot on the run governs that run's whole lifecycle.** The C4 sweep,
   the recheck ledger, and the discard labelling read `hatchet_run.supersede_policy` —
   never the repo's current setting. A stored retired value reads as "no override".
3. **Cross-variant isolation on a policy flip is an accepted property.** A run finishes
   under the policy it was dispatched with; an admin who flips policy mid-review can get
   one duplicate review. A flip is an explicit admin action, not a push.
4. **The one-agent box budget is enforced on the HOST, at the contended resource.**
   The production agent is a host PROCESS GROUP (daemon spawned detached under the
   dedicated agent uid), not a container — the budget mechanisms are process-plane:
   - **Stage A (shipped, #177):** admission reap — before the box-slot acquire, every
     run admission (a) reclaims dead sibling workers' orphan daemon groups
     (`reclaimDeadWorkerRuns`, previously boot-only) and (b) SIGKILLs any recorded
     process group for the admitted run's own threadId (`reapOwnThreadAttempts`),
     so an engine redelivery can never share the box with its dead predecessor.
     Safe with no engine status read: redelivery only follows session lapse, www's
     per-thread token dedup bars concurrent double-dispatch, and `slots: 1` on the
     box's single worker unit makes the box single-flight; the kernel lock covers
     the crash-relaunch overlap. Drill-proven live (worker SIGKILL mid-run → orphan
     group reaped → 36 s redelivery, clean).
   - **Stage B1 (shipped with #183):** kernel lock + one-unit topology + `box-slot.ts`
     retirement. **Stage B2 (#184, pending):** uid-scan reaper. **Memory ceiling:**
     deferred 2026-09-05 (macOS has no cgroups; arrives with a containerized
     topology).
5. **The host budget never cancels.** It may delay or reject _admission_ of a run (a
   typed, retryable error); terminating a running review remains the engine's (or the
   user's) act alone.

## Consequences

- Exactly one grep-provable supersession writer: none in www (`archiveAndStopThread` has
  no caller on any dispatch/automation path); the engine's concurrency strategies and the
  C4 sweep's typed terminals are the whole mechanism.
- Policy-flip races are structurally impossible rather than gated: there is no second
  writer to disagree with the first.
- The dispatch seam (ADR-003) is dispatch-and-stamp only; the per-org execution plane's
  concurrency discussion (ADR-002) is scoped per workflow, with the box budget host-side.
- Rollout is one-way for the settings rows (`app-side` → NULL → resolves `newest-wins`,
  identical under old and new builds), verified post-migration by counting late writes of
  the retired value.

## Amendment (2026-09-05, #152 Stage B)

- **Status:** Items 1–2 **Accepted** (Stage B1, PR #186 → `88e8e75`, live-proven 2026-09-06); items 3–4 Proposed with #184 (Stage B2); item 5 stays **Deferred** (2026-09-05).
- **Context source (as of `e2716a4`, pre-#183):** `box-slot.ts:178-184` (time-based reclaim), `workflow.ts:473-478` /
  `:698-715` (acquire and release ordering), `daemon-process.ts:353-370` (pid file removed
  before the kill), `spawn-as-user.ts:148-159` (pgid-only kill builder),
  `sudoers.d-automata:36,58` (bare `/bin/kill` as AGENT), `hello/worker.ts:106-114`
  (`slots: 1`), `deploy/README.md:7-25`.
- **Deciders:** TL. **Relates to:** ADR-002 amendment `:541-548`; ADR-007 decisions 4–5.

1. **Mechanism.** Decision 4's "kernel flock" is delivered as flock(2) held by a stock
   lock-helper child (`/usr/bin/lockf -k -s -w` on darwin, `flock -x -o` (util-linux) on
   linux) whose stdin is the worker's lifeline: the kernel releases the lock when the
   helper's command exits, which follows the worker's death (pipe EOF) or an explicit
   release. No heartbeat, no mtime, no staleness constant exists in the worker.
2. **Topology.** One worker unit per box; `com.automata.worker-2` is retired. `slots: 1`
   on that unit is the engine-native cross-workflow cap; the engine's global concurrency
   key remains per workflow and is not the box budget. The warm-standby property is given
   up: a deploy-time drain leaves queued runs on their `scheduleTimeout` clock.
3. **Reclamation is not cancellation (Decision 5 clarified).** The host budget never
   signals a process of the run that holds the box lock before that run's finally.
   Processes owned by the agent uid whose run has reached its finally, or whose worker is
   dead, are residue; killing them at boot, admission, or teardown is reclamation. A
   uid-wide `kill -9 -- -1` as the agent uid is issued only by the box-lock holder.
   (Stage B2)
4. **Signal seam.** Process-plane reap results are emitted as run-scoped `box.*` log
   events and a host-plane `box-budget.json`; `scheduling-health.json` stays engine-DB
   only. (Stage B2)
5. **Memory ceiling.** Deferred (2026-09-05); arrives with a containerized topology.

## Anti-deviation invariants

- **I1** Exactly one host-exclusion primitive, kernel-released; no `staleMs`/`heartbeat`
  in `packages/worker/src`.
- **I2** The lock is acquired at admission after both Stage A reaps and released last in
  the run's finally, after `daemon.teardown()` and the teardown uid-scan.
- **I3** One worker unit per box; `slots: 1`; the `definition.ts` global key is documented
  as per-workflow, never as the box cap.
- **I4** A uid-wide kill is issued only while holding the box lock; never when
  `WORKER_AGENT_USER` is empty; that limitation is logged once at boot.
- **I5** The host budget never signals the lock-holding run's processes before its
  finally (Decision 5).
- **I6** Tests that must stay green: `supersede.integration.test.ts` "different variants
  never overlap" against the real lock; a cross-process SIGKILL-holder → immediate
  re-acquire case; a uid-scan case proving the admitted run's own group is untouched.
