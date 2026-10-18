---
spike: 002
name: forge-substrate
type: comparison
validates: "Given 50 concurrent agent sessions, when each creates a branch, pushes 5 commits and requests a merge via API, then p95 push/merge latency is measured — Forgejo (002a) vs bare smart-HTTP + server-side merge (002b)"
verdict: "WINNER: 002b bare-git (with per-repo merge lock)"
related: [001-github-projection-mirror, 004-server-side-merge-no-clone]
tags: [forgejo, git-http-backend, benchmark, merge, substrate]
---

# Spike 002: Forge substrate (Forgejo vs a bare git core)

## What This Validates
Which substrate should carry the *agent hot path* (clone, push, merge)? We ran the same workload against both.
Each session clones, makes 5 commits and pushes each one, then requests a merge to main.

## Research
| Approach | What it is | Pros | Cons |
|---|---|---|---|
| 002a Forgejo 15.0.8 (docker, sqlite) | Full forge: UI, permissions, PRs, Actions-compatible CI | Free human UI, GPLv3+, Gitea-compatible API | The merge path is PR, then async mergeability check, then **temp-clone merge plus push**. Codeberg community is hostile to AI work |
| 002b `git http-backend` + Node | Smart-HTTP CGI plus our own `/api/merge` (merge-tree → commit-tree → update-ref CAS) | We own the merge semantics, it's tiny, there's no DB on the hot path | No UI, auth or permissions yet; one process spawn per git request |
| Pierre code.storage (not run) | Hosted git storage API | Ephemeral branches, SDKs | Vendor lock-in; $1/GB-mo × 3 replicas; it *is* the competitor's infrastructure |

## How to Run
```bash
cd .planning/spikes/002-forge-substrate
./setup.sh seed && ./setup.sh reset-bare && ./setup.sh forgejo     # docker (OrbStack) + github clone of the seed
FORGE_ROOT=$PWD/work/bare-root PORT=3301 [MERGE_LOCK=1] node bare-server.mjs &
node bench.mjs --target bare --sessions 50 [--tag lock]
./setup.sh reset-forgejo && node bench.mjs --target forgejo --sessions 50
node render.mjs && open console.html ; ./setup.sh down
```

## What to Expect
`console.html` shows p50/p95 merge bars per run, the summary table, a per-session latency chart with a run picker, and the Forgejo response-code breakdown.

## Investigation Trail
1. **Smoke test (5 sessions).** Both substrates work. Forgejo clones faster (107 vs 250 ms), because CGI pays a process spawn per request. Merges are already 10x apart (p50 83 ms vs 1.4 s).
2. **50 sessions.**
   - **Bare:** 50/50 merged in 7.4 s. But **743 CAS retries**, an average of 15.7 attempts per merge. Optimistic ref-CAS with no coordination thrashes when every session targets the same ref.
   - **Forgejo:** 50/50 eventually merged, but merge p50 was **47.8 s** and p95 67 s (0.69 merges/s).
3. **Why is Forgejo slow?** I instrumented the merge response codes over 20 sessions:
   - `405 "Please try again later"` ×56: the mergeability checker hadn't finished.
   - `409 "PushRejected"` ×14 and `409 "merge push out of date"` ×3: its temp-clone merge loses the race when it pushes back.

   So this is architectural (an async check queue plus clone-merge-push), not SQLite. Latency grows faster than linearly: p50 is 3.7 s at 20 sessions and 47.8 s at 50.
4. **Variant 002b + MERGE_LOCK.** A per-repo in-process lock around the merge critical section, with no queue service and no clone.
   **0 retries**, merge p50 715 ms / p95 1,090 ms (2.4x better than lock-free), 8.2 merges/s.
5. **200 sessions, bare with lock.** 200/200 merged with 0 errors and 0 retries. Merge p95 was 5.7 s, and merge throughput was bounded at about 4–8/s by spawning about 4 git processes per merge.
   Push p95 reached 6.2 s, but 200 git clients plus 200 CGI processes were sharing one laptop, so that number is partly the test setup and not the server's ceiling.

## Results
**WINNER: 002b, a bare git core we own, with a per-repo merge lock.**

| run | merge p50 | merge p95 | merges/s | attempts | push p95 |
|---|---|---|---|---|---|
| Forgejo, 50 | 47,790 ms | 67,108 ms | 0.69 | 19.4 | 1,663 ms |
| Bare lock-free, 50 | 1,745 | 2,837 | 6.79 | 15.7 | 640 |
| **Bare + lock, 50** | **715** | **1,090** | **8.18** | **1.0** | 638 |
| Bare + lock, 200 | 4,288 | 5,724 | 3.79 | 1.0 | 6,156* |

\* Client and server were co-located.

**Signal for the build:**
- **Don't put Forgejo on the agent hot path.** Its merge path is the very thing Scion removed: an async check, then clone, merge and push.
  Forgejo is still a candidate *human-facing* UI later, but sharing repos with it means sharing its database's view of PRs. Defer that.
- **Own the merge.** Pure-git server-side merge with a per-repo lock is 67x faster than Forgejo at p50, and never needs a clone.
  The lock is per repo, *not* global. Different repos merge in parallel.
- **Next ceilings to remove:**
  - Process spawn per merge: use libgit2 / `git cat-file --batch` long-lived processes, or a Go core.
  - CGI per request: run `git upload-pack` / `receive-pack` directly behind a real server.
  - Scion's 30k merges/day is only 0.35/s. A single repo here already does about 4–8/s, so throughput is not the risk. **Semantics are** (conflicts and verification), and that's spike 004.
- **Untested:** Forgejo on Postgres. It's unlikely to change the verdict, because the bottleneck is the check queue and the clone, not the database.
