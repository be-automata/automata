---
spike: 005
name: forge-pipeline-e2e
type: integration
validates: "Given one forge (edge + gate + merge + projector), when an agent push lands, merges, projects to GitHub and a human pushes back, then the agent recovers from a refused stale push, every step lands in one audit trail, and nothing reaches GitHub without gate provenance"
verdict: VALIDATED
related: [001-github-projection-mirror, 003-push-time-policy-gate, 004-server-side-merge-no-clone]
tags: [forge, integration, provenance, recovery, github]
---

# Spike 005: Forge pipeline end to end

## What This Validates
Spikes 001, 003 and 004 were each proven on a separate server. This spike runs one forge process that does everything:
- the token edge;
- smart-HTTP;
- the `pre-receive` gate;
- the scoped merge API;
- the GitHub projector.

It adds one new invariant, a **provenance check**: the projector refuses any commit that wasn't
(a) accepted by the gate, (b) created by the forge (a merge or reconcile), or (c) imported from GitHub.

## How to Run
```bash
cd .planning/spikes/005-forge-pipeline-e2e
node scenarios.mjs            # binds :3305; touches only spike/forge-* on be-automata/astro-web
node render.mjs && open console.html
node scenarios.mjs --cleanup
```

## Investigation Trail
1. **Hermetic git also drops credentials.** With `GIT_CONFIG_GLOBAL=/dev/null` (spike 004's rule), the global credential helper disappears too.
   Seeding a clone from the private GitHub repo failed with "could not read Username".
   **Rule:** every GitHub-facing call names its helper explicitly (`-c credential.helper=!gh auth git-credential`, or a GitHub App token passed through env-scoped config).
2. **First full run: 7/9.**
   - P6 failed: the stale agent push never reached the server. **git's own client refuses a non-fast-forward push** ("fetch first") before contacting the remote.
     So the forge's server-side recovery hint only fires when an agent *forces*. git's standard hint ("integrate the remote changes… git pull") is already the right recovery.
   - P7 then failed as a knock-on, because the agent's clone was left mid-recovery.
3. **Restructured into P6 and P6b.**
   - P6: a normal stale push is refused by the client, and the agent recovers with fetch + rebase.
   - P6b: a forced push is refused server-side and comes back with the forge's exact command:
     `git fetch origin && git rebase origin/<branch> && git push origin HEAD:<branch>`.

   Both pass, so agents can't rewrite forge history even when they force.
4. **Provenance holds end to end.** Every commit on the GitHub branch beyond main traces to a ledger record:
   5 `gate/accepted`, 2 `merge/merged`, 1 `forge/reconciled`, 1 `projection/diverged` (the imported human commit).
   A commit written straight into the bare repo (P8, which simulates an admin path or a bug that skipped the gate) is refused by the projector, and GitHub stays unchanged.

## Results
**VALIDATED, 10/10, in 22 s against real GitHub.**

| # | Scenario | Outcome |
|---|---|---|
| P1 | Lead and 2 sub-agents push through the gate | accepted |
| P2 | Fan-in merges run server-side; a merge into `main` is out of scope | merged ×2; `main is outside refs/heads/agent/<run>/*` |
| P3 | Task branch projected with a provenance check | draft PR opened |
| P4 | Human pushes to the GitHub branch | divergence detected; the human commit stays on GitHub and is imported |
| P5 | Server-side reconcile | GitHub fast-forwards; the human commit is kept |
| P6 | Stale agent push | the git client refuses it; fetch + rebase + push succeeds |
| P6b | Forced stale push | the gate refuses it with a recovery command |
| P7 | Agent pushes a GitHub token | rejected at push; GitHub unchanged |
| P8 | Commit that bypassed the gate | the projector refuses it (`refused-provenance`) |
| P9 | Audit of every commit on GitHub | 9/9 traced; 0 unknown |

**Signal for the build:**
- **Provenance-gated projection is the trust plane's keystone.** The gate alone isn't enough, because anything that writes refs without going through receive-pack would bypass it. The projector is the choke point to GitHub, so it re-checks provenance.
- Put the provenance ledger in Postgres (commit sha → source, runId). In this spike it was rebuilt from `events.jsonl` on each projection.
- Imported human commits get `projection/diverged` provenance. Policy question for the build: should human commits also be secret-scanned on import? They bypass the agent gate by design.
- Agent recovery follows git's standard flow. The forge's own hint only matters for `--force`.
