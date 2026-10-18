---
spike: 004
name: server-side-merge-no-clone
type: standard
validates: "Given N concurrent changes to one repo, when merged server-side via merge-tree --write-tree + ref CAS (no clone, no queue), then throughput beats clone-merge-push and conflicts return a structured payload an agent can fix"
verdict: VALIDATED
related: [002-forge-substrate, 001-github-projection-mirror, 003-push-time-policy-gate]
tags: [merge, merge-tree, scion, conflicts, cas, hermetic-git]
---

# Spike 004: Server-side merge without a clone (Scion-lite)

## What This Validates
Scion's core idea is that merges happen on the server and cost in proportion to the change, not the repo, with no merge queue.
Can plain git reproduce that? We also tested whether an agent can resolve a conflict **from a payload alone**, with no checkout.

## Research
| Approach | Mechanism | Pros | Cons | Status |
|---|---|---|---|---|
| Clone, merge, push (bots, Forgejo internals) | Worktree per merge; retry on non-fast-forward | Universal | O(repo) I/O per merge; retry storms under contention | Baseline B |
| GitHub merge queue | Global serialized queue plus CI per batch | Safe | Global lock; Scion removed it on purpose | Out of scope |
| **`git merge-tree --write-tree` + `commit-tree` + `update-ref new old`** | Pure object-database merge (git ≥ 2.38); CAS ref update; per-repo lock (from spike 002) | No worktree; proportional to the change | Needs git ≥ 2.38; we own conflict UX | **Chosen, A** |
| libgit2 / a Go core (Scion-style service) | Same, in-process | No process spawns | Engineering cost | Next step |

## How to Run
```bash
cd .planning/spikes/004-server-side-merge-no-clone
node merge-bench.mjs [--n 50 --concurrency 50]
node render.mjs && open console.html
```

## What to Expect
- Two benchmark lines (server-side vs clone-merge-push), with identical merged/conflict counts.
- A fix-loop line: `fixed 9/9`, `markersOnMain:false`.
- `console.html` shows the speedup, a log-scale p95 chart, the head-to-head table, and the actual conflict payload an agent receives.

## Investigation Trail
1. **Fixture.** 50 branches: 30 add disjoint files, 10 edit *different hunks of the same file*, 10 edit *the same line*.
   The expected result is 41 merges and 9 true conflicts.
2. **First run, B looked like it lost 49/50.** That was a measurement bug, not a result. The box's global `merge.ff=only` aborted every non-ff merge,
   and my catch counted any merge failure as a "conflict". Fix: `--no-ff`, and count a conflict only when `diff --diff-filter=U` lists unmerged paths. Anything else is surfaced as an error.
3. **Fair run.** Both strategies produce *identical* outcomes (41 merged / 9 conflict, the same per kind), so correctness is equal and only cost differs.
4. **Second hidden dependency on ambient config.** The conflict payload came back in `diff3` style (`|||||||` base section), because of the same user config.
   The agent's resolver assumed 2-way markers. The edits-present check passed, but marker lines could have reached main undetected.
   **Fix:** run every forge git call hermetically (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), and assert no marker lines on main.
   This becomes a *build requirement*: a forge's merge semantics must be pinned, never inherited from the host.
5. **Fix loop.** The agent receives `{base, head, conflictTree, files:[{path, base, ours, theirs, withMarkers}], messages}`.
   It resolves (in this spike, by keeping both sides) through a temp index and `commit-tree -p head -p base`, then resubmits.
   9/9 merged in 2.2 s. It needed 9 rounds, because every fix touches the same line, so each later payload goes stale. Serial resolution of a true hot spot is inherent, not overhead.
6. **Payload size.** About 34 KB for a 300-line file, because it carries full base/ours/theirs. For large files, send hunks plus blob OIDs and let the agent fetch blobs on demand (Scion-style API).

## Results
**VALIDATED.**

| strategy | merged / conflicts | wall | p50 | p95 | merges/s | attempts |
|---|---|---|---|---|---|---|
| **server-side** (merge-tree + CAS + per-repo lock) | 41 / 9 ✓ | 1.0 s | 522 ms | **973 ms** | **40.0** | 1.0 |
| clone-merge-push | 41 / 9 ✓ | 36.2 s | 24.0 s | 35.9 s | 1.13 | 18.4 |

That's about **35x the throughput and 37x better p95** for the same correctness. Same-file, different-hunk edits merge cleanly (10/10).
Conflicts come back as a machine-readable payload, and an agent resolves them with no clone (9/9), leaving main free of markers.

**Signal for the build:**
- The merge service is a weekend-sized core on stock git ≥ 2.38. Scion's moat is scale (Spanner, a virtual FS), not the merge algorithm.
- **Hermetic git is mandatory** (`GIT_CONFIG_GLOBAL=/dev/null`). Two different user-config settings silently changed behaviour in this spike alone.
- The conflict payload is a product surface. It's what makes "agents fix their own conflicts" real. Version its schema.
- **Not covered:**
  - Semantic conflicts that merge cleanly but break the build. That needs post-merge verification and auto-revert, as Scion does with post-merge testing.
  - Separation-of-duties checks at merge (approver ≠ author).
  - Rename and binary conflicts.
