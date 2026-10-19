# ADR-007 — Supersession authority and the one-agent box budget

- **Status:** Supersession half: **Accepted** (PR #175 → `e3dcc1b`, live-proven 2026-09-02). Box-budget half: Stage A **Accepted** (PR #177 → `b11762f`, drill-proven); Stage B1 (#183 → PR #186 → `88e8e75`, kernel lock + one-unit topology) **Accepted** (live-proven 2026-09-06: U1 SIGKILL mid-run → 0 holders at once, redelivery admitted 32 s later with no staleness wait; U2 one `lockf` holder; U3 one unit); Stage B2 (#184 → PR #189 → `32a2ebe`, uid-scan reaper) **Accepted** (live-proven 2026-09-06: boot scan under a try-lock on every relaunch; U5 SIGKILL mid-run → the relaunched worker's boot scan reaped the orphaned agent subtree; U6 EPERM negative held); memory ceiling **Accepted** (#204 → PR `457b10e`, 2026-09-30: a DELEGATED cgroup v2 subtree per run, not a transient scope — `run-cgroup.ts`, `10-ceiling.conf`); counting budget (#205, epic #193 ticket 2): N kernel slot locks, one agent account per slot — see the 2026-10-18 amendment below.
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
     retirement. **Stage B2 (#184):** uid-scan reaper — a uid-wide `kill -9 -- -1` as the
     agent uid at boot/admission/teardown, only under the box lock (shipped with #184,
     PR #189 → `32a2ebe`, live-proven 2026-09-06). **Memory ceiling:**
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

- **Status:** Items 1–2 **Accepted** (Stage B1, PR #186 → `88e8e75`, live-proven 2026-09-06); items 3–4 **Accepted** (Stage B2, PR #189 → `32a2ebe`, live-proven 2026-09-06); item 5 stays **Deferred** (2026-09-05).
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
   The only agent-uid processes outside a run are macOS's per-user launchd helpers
   (`distnoted`, `lsd`, `csnameddatad`, `secd`, `contactsd`), which respawn on demand;
   the reaper excludes them from its counts and reports them as `helpers`. Root cause
   of the escape: the daemon spawns the agent `detached` (its own session and process
   group), so any WORKER-driven daemon kill orphans the agent subtree. (Stage B2, #184)
4. **Signal seam.** Process-plane reap results are emitted as run-scoped `box.*` log
   events and a host-plane `box-budget.json`; `scheduling-health.json` stays engine-DB
   only. (Stage B2, #184)
5. **Memory ceiling.** Shipped by #204 (2026-09-30) as a delegated cgroup v2 subtree
   per run (`memory.max`, `memory.swap.max=0`, `memory.oom.group=1`, `cgroup.kill` at
   teardown); the systemd transient scope the epic proposed is not creatable by the
   worker's service account (polkit), and the delegated subtree needs no privilege.

## Amendment (2026-10-18, #205 / epic #193 ticket 2) — the counting budget

The exclusive lock is generalised to **N slots** (`WORKER_BOX_SLOTS`, default 1 = the
shape above, byte-identical): slot i is an exclusive `flock(2)` on `box.lock.<i>` (slot 0
keeps `box.lock`), a run holds exactly one, and **slot i runs as its own agent account**
(`${WORKER_AGENT_USER}-${i}`; slot 0 keeps the base name). The account is the fence
between concurrent runs — a run's credential HOME, broker sockets and `/proc/<pid>/environ`
are readable by any process of the SAME uid, so one account at N > 1 would be a cross-run
(under per-org 2, cross-org) credential exposure that no counting primitive closes. The
uid-wide reap stays: `kill -9 -- -1` issued AS slot i's account under slot i's lock reaches
only slot i's processes (kernel `kill(2)` permission check), so the "replace the uid-wide
kill" item dissolves. Per-run artefacts (daemon socket, pidfile, gh-broker socket) live in
`<root>/<workerId>/s<i>/`, granted to that slot's account and the worker alone — the daemon
socket authenticates no caller, so a shared dir would have let slot i inject a message into
slot j's run; the shared dir hands slot accounts traverse only. The slot dir IS the record
of a run's account: a pidfile under `s<i>/` belongs to slot i's account, and the Stage A
reclaimers kill a dead group as that account (only dir names the worker itself would create,
owned by the worker, are read as slots — the agent can create dirs in the shared dir). The slot is acquired BEFORE the clone (the clone's grant needs the
slot's account). Loopback TCP is not uid-fenced, so at N > 1 the per-run egress proxy
carries a per-run credential (`Proxy-Authorization`, 407 otherwise; `egress-proxy.ts`) —
a sibling slot can see the port but cannot use the allowlist or the audit trail behind
it; the credential rides only in the proxy env URLs' userinfo and, for gstack's browse
Chromium, in `BROWSE_PROXY_USER`/`BROWSE_PROXY_PASS` (Playwright proxy credentials) — never
in a URL that reaches an argv or a log line; the git and gh brokers already fence by a per-run bearer. The three early admission
catches clean the workdir BEFORE releasing the slot, same as the finally (I2), because a
parked waiter takes a freed slot immediately — any in-process release wakes every parked
waiter to re-sweep all slots (event-driven, not the polling I1 forbids; the kernel wait on
the rotated slot remains the cross-process authority). A slot whose helper died (LOST) stays
reserved in-process until its run's own release — the kernel alone would re-admit it to a
second run on the same uid. Every run dir is 0700 before its grants: with traverse on the
workdir root, a sibling slot could otherwise read another run's clone. A 407 from a credentialed proxy is
audited as a `proxy-auth` deny. The boot scan also reaps slot accounts above the current N.
N > 1 requires the #204 ceiling; the box refuses otherwise. The engine's
`slots` equals N; its per-variant caps are #372's. `box-budget.json` and
`escapeesSinceBoot` are box-wide aggregates across slots (last reap writes the snapshot).

## Amendment (2026-10-19, #371 / epic #193 ticket 3) — the headroom check

Decision 5 permits the host budget to **delay** admission; this is the first mechanism that
does so on a resource other than the slot count. Under its slot and BEFORE the clone, a run
reads `/proc/meminfo` and is admitted only if both arms hold — `MemAvailable − reserved ≥
floor` and `Committed_AS + reserved + runCommit ≤ fraction × CommitLimit` (`headroom.ts`,
knobs in `deploy/README.md`). Admissions are serialised by an in-process mutex and an
admitted run **reserves** `runCommit` until its agent is alive (the first thread status past
`booting`), so two concurrent admissions cannot both pass on the same headroom. A refusal
releases the slot (nothing of the run is on disk) and throws `AdmissionDeferredError` — the
ONE plain error the run task lets escape: the engine re-queues the attempt (QUEUED, never
FAILED or CANCELLED) with `retries` = `WORKER_ADMISSION_MAX_DEFERRALS` and exponential
backoff, and the whole deferral budget must fit the www stalled cutoff (boot refuses a
budget that does not). **Exactly-once is preserved by construction**: every error thrown
after admission is rethrown as `NonRetryableError` (`fenceNonRetryable`), so a retry can
only ever re-run the admission, never the agent. A cancel during backoff is the engine's
cancel of a QUEUED attempt — no worker code runs. The check is inert (`floor 0` and
`fraction 1.0`, or no `/proc/meminfo`) without a deploy; the retries stay registered on every
host, and with the check inert nothing ever throws the deferral, so they are never used. An
unreadable `/proc/meminfo` at admission (boot proved it readable) fails OPEN with one
`box.headroom_unreadable` line — a transient kernel read must not idle the box; the deferral
budget assumes a priority-4 retry is scheduled promptly (admission-retry.ts states the risk:
a retry that waits a full scheduleTimeout is reaped by www as stalled). Decision 5 stands: nothing here signals a
lock-holding run.

## Anti-deviation invariants

- **I1** Exactly one host-exclusion primitive, kernel-released; no `staleMs`/`heartbeat`
  in `packages/worker/src`. (N slot files are N instances of that one primitive.)
- **I2** The slot is acquired at admission after both Stage A reaps and released last in
  the run's finally, after `daemon.teardown()` and the teardown uid-scan. The headroom
  check (#371) runs under the slot and before the clone; its refusal releases the slot and
  is the only retryable error the run task throws.
- **I3** One worker unit per box; engine `slots` = `WORKER_BOX_SLOTS` = the number of kernel
  slot locks; the `definition.ts` global key is documented as per-workflow, never as the
  box cap.
- **I4** A uid-wide kill is issued only AS a slot's own account while holding that slot's
  lock (the boot scan holds every slot); never when `WORKER_AGENT_USER` is empty; that
  limitation is logged once at boot. One agent account per slot, never shared.
- **I5** The host budget never signals the lock-holding run's processes before its
  finally (Decision 5).
- **I6** Tests that must stay green: `supersede.integration.test.ts` "different variants
  never overlap" against the real lock; a cross-process SIGKILL-holder → immediate
  re-acquire case; a uid-scan case proving the admitted run's own group is untouched.
