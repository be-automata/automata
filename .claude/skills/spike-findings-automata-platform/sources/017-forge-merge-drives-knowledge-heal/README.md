---
spike: 017
name: forge-merge-drives-knowledge-heal
type: integration
validates: "Given knowledge grounded on a forge-hosted repo, when a server-side merge lands (no GitHub event), then the ref-update hook triggers reconcile, flags match the git-diff oracle, approved edits land as commits through the push gate with provenance trailers"
verdict: VALIDATED
related: [004-server-side-merge-no-clone, 003-push-time-policy-gate, 014-knowledge-self-heal-loop, 019-atomic-claims-by-model]
tags: [knowledge, forge, self-heal, integration, provenance, push-gate]
---

# Spike 017: Forge merges drive the knowledge self-heal loop

## What This Validates
Spike 014's self-heal loop is triggered by GitHub's `github-pr-merged` intent. This spike removes that last GitHub dependency. The pieces involved:
- **Source repo:** a bare repo on our own forge.
- **Merges:** server-side (spike 004: `merge-tree --write-tree` + `commit-tree` + `update-ref` CAS under a per-repo lock).
- **Trigger:** a `reference-transaction` hook on the source repo starts the reconcile.
- **Knowledge storage:** the knowledge page and its claims sidecar live in a second forge repo.
- **Writes:** every write to that repo goes through a per-run token at the edge plus a knowledge-aware `pre-receive` gate (spike 003).

That gate admits a commit only if it carries provenance to a real merge and an approval recorded in the decision ledger.

## Research
| Trigger option | Fires on | Pros | Cons | Status |
|---|---|---|---|---|
| GitHub `pull_request.closed+merged` webhook | GitHub merges only | Exists today | Depends on GitHub; misses forge-side merges | What we replace |
| `post-receive` hook | `git push` only | Standard | **Doesn't fire for server-side `update-ref`**, which is exactly how forge merges land | Rejected |
| **`reference-transaction` hook** (git ≥ 2.28) | Every ref update, including plumbing `update-ref`; states prepared/committed/aborted | Catches merges, pushes and admin moves; only `committed` is acted on | Fires for every ref (filter `refs/heads/main`) and every main move (unrelated commits too) | **Chosen** |
| In-process callback after `update-ref` | Only our merge service | Simple | Misses any other writer | Kept as a fallback idea |

| Write path for knowledge | Pros | Cons | Status |
|---|---|---|---|
| Docs-only PR on GitHub (OpenWiki) | Reviewable | GitHub again; approvers don't live in PRs | Rejected (014) |
| **Commits to a knowledge forge repo through the push gate**, with trailers `Knowledge-Op`, `Source-Commit` and `Approved-By` checked against a decision ledger | Every knowledge change is a git commit with machine-checked provenance; history and blame come free | We operate the gate | **Chosen** |

## How to Run
```bash
cd .planning/spikes/017-forge-merge-drives-knowledge-heal
node --experimental-strip-types --no-warnings scenarios.ts   # 19 self-verifying checks, exit 0/1
```
- Run it outside the Claude sandbox: Seatbelt denies writing `.git/hooks` in nested repos.
- It reads the claims that spike 019's model seeded (`../019-atomic-claims-by-model/seed.json`), so it needs no model calls.

## What to Expect
- Five merge lines with `FP=0 FN=0` and `diff==real:true`.
- Then PASS lines for the trigger, oracle, drift and provenance checks, and for 11 gate cases: 10 refusals plus 1 approved control.
- Then `19/19 checks passed`.

## Observability
- `work/gate-audit.jsonl`: the edge's `refused` events and the gate's `accepted` / `rejected` events, with reasons and `gateMs`.
- `work/decisions.jsonl`: the approval ledger (`opId`, `sourceCommit`, `by`).
- `work/heal-queue.jsonl`: the trigger queue that the hook writes.
- `events.jsonl`: queue, heal, negative and check events.
- `results.json`: per-merge ops, commits and push results, the knowledge repo log, and latency.

## Investigation Trail
1. **Hook choice.** `post-receive` never fires for server-side merges, because nothing is pushed: our merge service calls `update-ref`. `reference-transaction` does fire. Every main move enqueues an event, including the unrelated commit landed before each merge, so the worker drops events whose `git diff --quiet old new -- <file>` is clean. That gave 5 heals from 10 events. A failed CAS (`update-ref` with a stale old value) enqueues **nothing**, because only `committed` is acted on.
2. **The oracle stays honest on the forge.** The forge's own merge diff (`event.old..event.new`, hermetic, `--no-color`) is byte-equal to the real repo's diff for all 5 merges. Flags match it with 0 FP / 0 FN.
3. **First run: the gate rejected the seed.** Creating a page changes every claim id from absent to present, and rule K4 wants an approved op per changed claim. That strictness is right; the seed needed its own decision type. A brand-new sidecar is approved as a whole by one `seed:<page>` decision.
4. **Trailer parsing gotcha.** `%(trailers:key=X,valueonly)` appends a newline per value, which split the log into extra lines and failed the provenance check. Use `separator=%x20`. The hook trims values.
5. **Hook env gotcha (avoided by design).** Inside `pre-receive`, git sets `GIT_DIR` and quarantine object-directory variables. The K2 check runs `git -C source.git merge-base --is-ancestor`, and with the inherited env it would read the **knowledge** repo's objects. The hook strips `GIT_*` (except the hermetic config pair) for that call.
6. **A hole found by review, not by a failing test.** An approved edit to claim X could also append free text to `pages/*.md` that belongs to no claim, and it would pass, because K3 and K4 only reason about claim statements. Added rule **K6**: an agent-written page must equal the render of its claims. The new `pageSmuggle` case is rejected.
7. **No incremental seeding here, on purpose.** Like spike 014, this uses base-seeded claims, so #304 (which edits text inserted after the base) flags nothing. Spike 019 showed the fix (incremental seeding). It's orthogonal to the trigger and gate plumbing tested here.

## Results
**VALIDATED. 19/19 checks pass, and strict `tsc` is clean.**

| Merge (replayed server-side on the forge) | Flagged = oracle | FP/FN | Knowledge commits pushed through the gate |
|---|---|---|---|
| #259 self-heal fix loop | 0 = 0 | 0/0 | none |
| #272 benchmark harness | 0 = 0 | 0/0 | none |
| #287 label rename | 2 = 2 | 0/0 | 1 approved update commit (2 ops) |
| #304 task-run home move | 0 = 0 | 0/0 | none |
| #306 org env vars | 1 = 1 | 0/0 | 1 `auto:repin` commit (442 repins) + 1 approved update commit |

| Gate case | Stopped at | Reason the writer sees |
|---|---|---|
| Commit with no trailers | gate | missing provenance trailers |
| Forged `Approved-By` (no ledger entry) | gate | op has no approved decision by ops-lead for `<src>` |
| Text change disguised as `auto:repin` | gate | auto:repin may only move evidence pins |
| Invented `Source-Commit` | gate | not on the source repo's main |
| Approval for claim Y used to change claim X | gate | claim X changed without an approved op |
| Approval from an older merge reused | gate | no approved decision for this source commit |
| File outside `pages/**`, `.claims/**` | gate | outside allowed paths |
| Approved edit plus smuggled page text | gate | page text is not the render of its claims |
| Token minted for `source.git` | edge | token is for source.git, not knowledge.git |
| Token replayed after its run ended | edge | token revoked |
| **Control:** an approved edit with a ledger entry | accepted | — |

- Merge landed → knowledge pushed: **p50 334 ms**, max 774 ms. The max is the #306 merge with 442 repins. No model is involved; the updater is a deterministic stand-in, and 019 proves the real one.
- Gate per push: p50 46 ms, max 85 ms, across 12 pushes. That includes a Node process spawn; 003 measured 12 ms for the rules alone.

**Signal for the build:**
- **Trigger on `reference-transaction` (committed) on the forge,** not `post-receive` and not GitHub. Filter `refs/heads/main`, and skip events whose diff doesn't touch grounded files. This makes the knowledge loop work for forge merges, agent pushes and admin moves alike, and it's the same hook point a GitHub projection (001) would hang off.
- **Knowledge belongs in a forge repo:** `pages/` plus `.claims/` sidecars, with the decision ledger in Postgres (`knowledge_op` decisions). Every change is a commit whose trailers the gate checks:
  - **K1:** trailers present.
  - **K2:** source reachable.
  - **K3:** ledger approval matching op, source and approver.
  - **K4:** every changed claim covered.
  - **K5:** `auto:repin` may only move pins.
  - **K6:** the page renders from its claims.

  "Agents propose, humans approve" thus becomes **enforced at the storage layer**, not just in UI convention.
- **The approval is bound to (op, source commit, approver).** Approvals can't be reused across merges or claims. A brand-new page uses a single `seed:<page>` decision.
- **Writer tokens are per heal run,** scoped to `knowledge.git`, `refs/heads/main` and `pages/**` + `.claims/**`, and revoked when the run ends (spike 003 format).
- **Human edits to pages** need a separate path, such as a human credential and a review op that re-grounds claims. K6 deliberately binds only agent-written commits. **This is not covered here.**
- **Not covered:**
  - concurrent heals racing on knowledge main (the gate's fast-forward rule would reject the loser, which needs a rebase-and-retry loop);
  - a ledger stored in Postgres instead of a file;
  - the queue surviving a worker crash (the queue is a file; production needs a durable job per event).
