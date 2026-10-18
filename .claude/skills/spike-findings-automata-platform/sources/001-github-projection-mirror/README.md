---
spike: 001
name: github-projection-mirror
type: standard
validates: "Given our forge is the source of truth, when an agent branch lands and a human pushes to the GitHub side concurrently, then forge→GitHub mirror + PR open is idempotent and divergence is detected and surfaced, never force-overwritten"
verdict: VALIDATED
related: [004-server-side-merge-no-clone]
tags: [github, projection, mirror, force-with-lease, idempotency, pr]
---

# Spike 001: GitHub projection mirror

## What This Validates
GitHub can be treated as a *projection* of the forge without losing human work. Agent branches live in the forge
(`agent/<name>`). They are mirrored to GitHub as `spike/forge-<name>`, with a lease on the last SHA we projected.
A draft PR is opened or refreshed, and opening it twice is harmless.

## Research
| Approach | Mechanism | Pros | Cons | Status |
|---|---|---|---|---|
| Plain `git push --mirror` | Overwrite everything | Simple | Destroys human commits pushed to GitHub | Rejected |
| `--force-with-lease=<ref>:<last-projected-sha>` | Push only if GitHub still holds what we last wrote | Atomic per ref; GitHub enforces it | Needs a persisted lease per branch | **Chosen** |
| Two-way sync (Entire-style mirror reading from GitHub) | GitHub as source of record | No divergence model needed | Puts GitHub back as the bottleneck; that's the opposite thesis | Not this spike |
| GitHub App plus the Contents/Git Data API | Write via REST | Fine-grained tokens | Every write counts against the secondary limit of 80 content-creation calls/min | Later, for production auth |

Credentials come from gh's credential helper (`-c credential.helper=!gh auth git-credential`), never a token in argv.
That follows the lesson in memory: git auth headers leak through failure text.

## How to Run
```bash
cd .planning/spikes/001-github-projection-mirror
node scenarios.mjs            # needs network + gh auth; touches only spike/forge-* on be-automata/astro-web
node render.mjs && open console.html
node scenarios.mjs --cleanup  # closes [spike] PRs, deletes spike/forge-* branches
```
Run outside the Claude sandbox, because it needs github.com and the gh keychain.

## What to Expect
8 PASS lines. `console.html` shows KPI cards (scenarios, API calls, pushes, divergences, race adoptions), the scenario table, and a filterable event log with Export JSON.

## Observability
`events.jsonl` (ISO timestamp, category, event) + `results.json` → `console.html` (Export button).

## Investigation Trail
1. **First run: 6/6 PASS, but S6 was a false pass.** Two projectors raced on a new branch, and one *crashed* creating the PR.
   The scenario only counted PRs (1), so it looked fine. Root cause: `gh api` puts the 422 body ("A pull request already exists…")
   on **stdout**, while `err.message` only says "Validation Failed (HTTP 422)". Fix: match on `err.stdout` too, and make S6 strict
   so both projectors must succeed.
2. **The lease race converges.** When the second projector's lease fails because the first already pushed the *same* SHA,
   it's classified as `lease-race-converged`, not divergence. Without that check, every concurrent projection would raise a false "human edited this" alarm.
3. **The second run didn't hit the PR-create race.** The push lease serialized the two projectors, so the second found the PR on lookup.
   Added **S7**, which forces the race deterministically: two `ensurePr` calls with empty caches. The adoption path
   (`create-race-adopted`) is now exercised. Both callers resolve to PR #8.
4. **Edge case found by probing: a human deletes the projected branch.** Before the fix, the projector's inbound `fetch` would throw.
   Added a `deleted-upstream` classification. The forge doesn't resurrect a branch a human deleted (**S8**), and GitHub auto-closes the PR.
5. **Reconciliation is fully server-side (S5).** `merge-tree --write-tree` + `commit-tree` + `update-ref <new> <old>` (CAS), no worktree.
   The merge commit has both the agent's and the human's tips as parents, so the next projection is a plain fast-forward.

## Results
**VALIDATED.** All 8 scenarios pass against real GitHub (`be-automata/astro-web`). The full run took 33 s and used 14 REST calls.

| # | Scenario | Outcome |
|---|---|---|
| S1 | First projection | Pushed, and a draft PR opened (2 API calls) |
| S2 | Re-projection with no change | No push; still 1 PR (1 call, a body PATCH that can be skipped) |
| S3 | Agent adds commits | Fast-forward lands on the same PR |
| S4 | Human pushes to GitHub while the agent pushes to the forge | **DIVERGED** detected. The human commit stays on GitHub and is imported into `refs/forge/inbound/*` |
| S5 | Server-side reconcile | Merge commit fast-forwards GitHub, keeping the human commit |
| S6 | Two projectors on a new branch | Both succeed with 1 PR (lease race converged) |
| S7 | Forced PR-create race | Both calls get the same PR number (adoption path) |
| S8 | Human deletes the branch | `deleted-upstream`, not resurrected |

**Signal for the build:**
- **API budget:** about 2 REST calls per new branch and 1 per refresh. Skip the PATCH on a no-op and it's 0.
  GitHub's secondary limit of 500 content-creation calls an hour therefore caps us at about 500 *new projected PRs an hour per installation*. Pushes don't count toward that.
  That's comfortably above a human review queue's intake, which is the point: agents work at forge speed, and humans see one PR per unit of work.
- **Lease state is load-bearing.** If the per-branch lease store is lost, the safe fallback is to read the GitHub tip as the lease, never "".
  Production needs it in Postgres with CAS.
- **Not covered here** (spike 004 covers it): reconcile when agent and human edits *conflict*. Here they touched different files.
- **Not covered:** human force-push or rewrite. The lease also catches it (it's just a different SHA), but the history the forge imports would need the inbound diff surfaced to the agent.
