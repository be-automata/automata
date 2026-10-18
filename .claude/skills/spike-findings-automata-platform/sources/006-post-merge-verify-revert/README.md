---
spike: 006
name: post-merge-verify-revert
type: standard
validates: "Given a change that merges cleanly but breaks tests, when the verify runner runs post-merge, then the forge auto-reverts server-side (no clone), the projection shows the revert, approver≠author is enforced at merge, and time-to-revert is measured"
verdict: VALIDATED
related: [004-server-side-merge-no-clone, 005-forge-pipeline-e2e]
tags: [verify, revert, semantic-conflict, sod, flaky]
---

# Spike 006: Post-merge verify and server-side auto-revert

## What This Validates
This spike covers the gap every earlier spike flagged as "not covered": a **semantic conflict**.
Two agent changes merge cleanly as text, but the result is broken. The pattern under test is Scion's: merge without a queue, verify after the merge, revert fast.
It also tests separation of duties, keyed on push provenance (spike 005) rather than on commit author fields, which can be forged.

## How to Run
```bash
cd .planning/spikes/006-post-merge-verify-revert
node verify.mjs            # local only; no network, no ports
node render.mjs && open console.html
```

## Research
| Approach | Pros | Cons | Status |
|---|---|---|---|
| Pre-merge CI per change (GitHub required checks) | Nothing broken lands | Serializes; every change re-tests against a moving base; this is the queue Scion removed | Rejected for the agent hot path |
| Merge queue with batch bisect | Safe, amortized | A global lock; latency grows with the queue | Out of scope |
| **Merge, then verify, then auto-revert on red** (Scion's model) | No queue; cost scales with the change; red windows are short | Main can be red for one verify window | **Chosen** |

**Verify** materializes the merge commit's tree with `git archive | tar` (no clone, no history) and runs the project's tests.
**Revert** is server-side: `merge-tree --write-tree --merge-base=<M> <tip> <M^1>` applies "undo M" on top of the *current* tip, so merges that landed later survive.

## Investigation Trail
1. **First run: 1/7.** The baseline was red. That was a harness bug: `node --test test/` treats the directory as a file. Switched to Node's default discovery.
2. **6/7.** V4 counted reverts in `log -5`, but every commit was made in the same second, so date ordering was arbitrary. Now it greps the projected branch for `auto-revert`. These were both harness bugs; the forge behaved correctly in both runs.
3. **The semantic conflict is real.**
   - Sub-agent A renames `calc→compute` and updates its callers.
   - Sub-agent B branched earlier and adds a new caller of `calc`.
   - `merge-tree` reports **no conflict**, but the merged tree fails `test/summary.test.mjs` (an import error).
   - Verify catches it, and the revert restores a tree **byte-identical** to the last green state.
4. **Lagged verify (V3).** Bad merge D lands, then good merge E, then D's verify runs. The revert removes only D and keeps E's `docs/NOTES.md`. That's what a no-queue system needs, because verify always trails merges.
5. **Flake guard (V6).** A test that fails only on attempt 1 is retried once and **not reverted**. The ledger shows `retry`, then `green`.
   The cost: a real break pays for one extra test run before the revert (the ledger shows a retry before each of the two real reverts).
6. **Separation of duties (V5).** An approver whose run pushed any commit in the range is refused. A commit forged with `user.name=Senior Reviewer` but pushed by the same run is still refused, because the check reads the ledger's runId, not the author field. A different run's approval merges.

## Results
**VALIDATED, 7/7.**

| # | Scenario | Outcome |
|---|---|---|
| V0 | Baseline | green |
| V1 | Good change | merged, green, kept |
| V2 | Semantic conflict (clean textual merge) | caught (`test/summary.test.mjs`); auto-reverted in **169 ms**, including one retry; tree equals the last green state |
| V3 | Lagged verify | only the bad merge reverted (171 ms); the later good merge kept |
| V4 | Projection | both `forge: auto-revert …` commits on the projected branch, with the failing tests in the message |
| V5 | Approver = pushing run, including a spoofed author name | refused; a different run's approval merges |
| V6 | Flaky test | retried once; no false revert |

**Signal for the build:**
- **The fixture is tiny.** At about 170 ms, time-to-revert is dominated by test runtime. In production, the verify window equals the project's test time, plus one retry on failure.
- During that window the task branch can be red. Projection should either wait for green, or label the PR "verifying". **The build should project only verified tips.** That's one config flag on the projector.
- Order matters: verify runs per merge commit, and a revert is computed against the live tip. Never "reset to the last green", because that would drop good merges (V3).
- Separation of duties must key on provenance (runId from the gate ledger). Commit metadata is client-controlled.
- **Not covered:**
  - Tests whose environment differs from production (verify runs `node --test` in a clean temp dir).
  - Long test suites, where test impact analysis or sharding would be needed.
  - Reverting a merge that later merges depend on semantically. That gives a conflicting revert, which needs agent resolution through the 004 conflict payload.
