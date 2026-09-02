# ADR-007 — Supersession authority and the one-agent box budget

- **Status:** Proposed (Accepted when #165's and #152 Stage 2's PRs merge)
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
   #143 gated both on the repo's *current* policy — leaving two termination authorities
   plus policy-flip races in both directions (a queued engine-owned run cancelled by www;
   a legacy run stranded into a duplicate review).
2. **What enforces "one agent at a time" on the box?** Hatchet offers no cross-workflow
   concurrency primitive: concurrency entries are scoped per workflow with the strategy
   fixed at definition time (docs; live-proven by the #128 E2E — an `agent-run-strict` run
   started 193 ms into a live `agent-run-newest` run), worker `slots` cap per worker
   *process*, and rate limits are starts-per-window. The interim belt is
   `packages/worker/src/agent-run/box-slot.ts`, a bespoke lease whose dead-holder reclaim
   is a 45-second staleness *assumption* — it cannot observe whether the previous
   holder's agent container actually died.

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
   (#152 Stage 2): kernel `flock` for cross-process exclusion (released by the kernel on
   process death — no heartbeat, no staleness), an admission reaper that reconciles agent
   container labels with engine workflow-run status *before* any container is created
   (fail-closed on unknown state; deliberately no mode that admits beside a live foreign
   container), and a per-container `--memory` ceiling so a runaway agent degrades to one
   OOM-killed container instead of a box-wide ENOMEM. Consequences: one worker process
   per box, `slots: 1` as the engine-native cross-workflow cap, `box-slot.ts` retired.
5. **The host budget never cancels.** It may delay or reject *admission* of a run (a
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
