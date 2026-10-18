# Agent Forge: our own git core, with GitHub as a projection

## Requirements
- **GitHub stays where humans live.** The forge never force-overwrites a human change on GitHub; it surfaces divergence instead. (001)
- **Agents never hold a GitHub credential.** Push credentials are short-lived, scoped to one run, and refused when replayed. (Automata invariant)
- **The projection lease for each branch is durable state** (Postgres CAS). If the lease is lost, fall back to the GitHub tip, never to "absent". (001)
- **The agent hot path runs on a git core we own, not Forgejo.** Merges happen server-side with a per-repo lock and never use a clone. (002)
- **Push policy scans EVERY new commit** (`git log -p`), never the net diff, because the projection publishes history. (003)
- **Forge git runs hermetically** (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`). Merge semantics are pinned, never inherited from the host. (004)
- **The conflict payload is a versioned product API:** `{base, head, conflictTree, files[{path, base, ours, theirs, withMarkers}]}`. (004)
- **Interop:** read OpenGAP `agent.yaml`, and emit Entire-compatible checkpoint trailers.

## How to Build It

### 1. Substrate (002)
- Serve smart-HTTP (`git http-backend`, later `upload-pack` / `receive-pack` run directly) behind our own Node or Go server, plus `/api/merge`.
- **Per-repo merge lock.** It is per repo, not global; different repos merge in parallel. A promise-chain mutex:
  ```js
  const locks = new Map();
  async function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve(); let rel; const next = new Promise((r) => (rel = r));
    locks.set(key, prev.then(() => next)); await prev; try { return await fn(); } finally { rel(); }
  }
  ```
  Production needs a lock shared across processes, such as a Postgres advisory lock keyed by repo.

### 2. Server-side merge (004)
```js
const HERMETIC = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const tree   = (await g(repo, ["merge-tree", "--write-tree", base, head])).split("\n")[0];   // git >= 2.38
const commit = await g(repo, ["commit-tree", tree, "-p", base, "-p", head, "-m", `merge ${branch}`]);
await g(repo, ["update-ref", "refs/heads/main", commit, base]);                              // CAS: fails if main moved
```
- **On conflict**, return the payload. For each conflicted path, `withMarkers` comes from `cat-file -p <conflictTree>:<path>`.
- **The agent resolves without a checkout:** temp index → `commit-tree -p head -p base` → `update-ref refs/heads/<branch> <new> <head>` → resubmit.
- Assert that no marker lines reach main.

### 3. Push-time policy gate (003)
- **Token:** HMAC-SHA256 over the claims `{runId, repo, refPrefix, paths, exp, jti}`.
  - Verify it at the HTTP edge *before* any pack upload. That covers expired, revoked (jti), wrong-repo and tampered tokens.
  - Pass it to git through env-scoped config (`GIT_CONFIG_COUNT/KEY_0/VALUE_0` → `http.extraHeader`), never through argv or the URL.
  - In production the credential broker (#81) mints it.
- **`pre-receive` over quarantined objects** (atomic: nothing lands if any rule fails):
  ```js
  git(["log", "-p", "--unified=0", "--no-color", "--format=", `${old}..${new}`])   // one process, every commit
  ```
  Rules:
  - a secret scan: gitleaks plus a custom pack for the run token and `sk-ant-`;
  - path scope (block `.github/workflows/**`);
  - ref scope;
  - OpenGAP manifest checks;
  - non-fast-forward refused.

  Rejection reasons go back as `remote:` lines that the agent can act on.
- **Revocation:** a shared store (Redis or Postgres), plus revoke-on-run-end in the worker.

### 4. GitHub projection (001)
- Mirror forge `agent/<name>` to GitHub `<prefix>-<name>` with `git push --force-with-lease=refs/heads/<dst>:<lastProjectedSha>`.
- Credentials come from `-c credential.helper=!gh auth git-credential` or a GitHub App token through env-scoped config.
- **Classify a lease failure:**
  - GitHub tip == our sha: `lease-race-converged`. This is not a divergence.
  - Branch gone: `deleted-upstream`. Never resurrect it.
  - Anything else: `diverged`. Import the human commits into `refs/forge/inbound/*` and reconcile server-side with `merge-tree`. The merge commit, with both tips as parents, then fast-forwards GitHub.
- **PR open is idempotent.** On a 422 "already exists", adopt the existing PR (`create-race-adopted`). On a no-op re-projection, skip the body PATCH.

## What to Avoid
- **Forgejo on the hot path.** Its merge path (async mergeability check → temp clone → merge → push) gave p50 47.8 s at 50 sessions, with 405s and 409s. Forgejo is a candidate *human* UI at most.
- **Lock-free optimistic CAS on a hot ref.** It caused 743 retries (15.7 attempts per merge). Use the per-repo lock.
- **Ambient git config.** On this box `merge.ff=only` aborted merges and `merge.conflictStyle=diff3` broke the marker resolver. Use hermetic env on every forge git call.
- **Net-diff secret scanning.** A secret added and then removed within one push survives in history, which the projection would publish.
- **Matching `gh api` errors on `err.message` alone.** The 422 body is on **stdout**.
- **`git push --mirror`.** It destroys human commits.
- **Tokens in argv or URLs.** They leak through failure text; route git through `gitExec` + `redactSecrets`.

## Constraints
| measure | value |
|---|---|
| Bare + lock, 50 sessions | merge p50 715 ms / p95 1,090 ms, 8.2 merges/s, 1.0 attempts |
| Bare + lock, 200 sessions | 200/200 merged, p95 5.7 s; about 4 git spawns per merge cap it at about 4–8/s per repo |
| Server-side merge vs clone-merge-push (50 branches) | 40 vs 1.13 merges/s; p95 973 ms vs 35.9 s; identical 41/9 outcomes |
| Policy gate | regex p95 12 ms, gitleaks p95 28 ms (200 ms budget) |
| GitHub projection | about 2 REST calls per new branch, 1 (or 0) per refresh; the secondary limit gives about 500 new PRs/hour per installation |

- git must be ≥ 2.38 for `merge-tree --write-tree`.
- The conflict payload is about 34 KB for a 300-line file. For large files, send hunks plus blob OIDs.
- **Not covered:**
  - semantic conflicts that merge cleanly but break the build (needs post-merge verification and auto-revert);
  - approver ≠ author at merge;
  - rename and binary conflicts;
  - large-push scan time;
  - human force-push imports.

## Agent Forge frontier (005–007)
- **End-to-end pipeline (005, VALIDATED 10/10 against real GitHub):** edge → gate → merge → projector.
  - **The projector re-checks provenance.** Anything that writes refs outside receive-pack bypasses the gate, so the projector is the choke point to GitHub. Nothing reaches GitHub without gate provenance.
  - **Ledger:** keep the provenance ledger (commit sha → source, runId) in Postgres.
  - **Diverged commits:** imported human commits are tagged `projection/diverged`. Open policy question: should they be secret-scanned on import?
  - **Agent recovery:** a refused non-fast-forward follows git's normal fetch-first flow, because git's own client refuses before the server hint.
- **Post-merge verify and auto-revert (006, VALIDATED 7/7):**
  - Verify runs per merge commit. A revert is computed against the **live tip**, never "reset to the last green", which would drop good merges.
  - Server-side revert takes about 170 ms, including a retry.
  - **Project only verified tips**, or label the PR "verifying".
  - **Approver ≠ author keys on gate provenance (runId)**, never on client-controlled commit metadata.
  - Materialize commits with `git archive <sha> | tar -x`.
- **Clone egress economics (007, PARTIAL):**
  - The default agent checkout is the **warm box** (013).
  - A cold start uses **bundle-uri from R2** plus a delta fetch. Never do a cold full clone.
  - **Host the forge where the agents run** (Hetzner), not behind AWS egress. A naive full clone of a vite-sized repo costs about $39 per repo per month on AWS; a warm box costs $0.18.
  - Shallow clones break history-dependent workflows. Prefer blobless + sparse when cold.
  - Egress under the default architecture is ≤ $1 per repo per month.

## Session 3 additions
- **Hook point for anything that reacts to merges (017):** use `reference-transaction` (`committed`). `post-receive` never fires for server-side merges done with `update-ref`. Strip the `GIT_*` environment inside hooks before running git against another repo.
- **The same gate pattern secures non-code repos.** The knowledge repo uses per-run writer tokens plus trailer checks against a decision ledger (see `references/grounded-knowledge.md`).
- **Long-lived agents (016):** push tokens are per *wake*, not per run, and the edge refuses a token whose `wakeId` isn't current.
- **Harden hermetic git further** (entire-graph ADR 0004 and trust docs, `sources/research_entire-graph_20261018.md`):
  - refuse active `[include]`/`[includeIf]`/promisor config;
  - set `core.fsmonitor=false`;
  - scope `safe.directory` to discovery candidates only;
  - **never run `git status`-style probes on untrusted repos**, because clean/process filters execute repository-chosen commands.
- **Competitor:** Entire ships native repos plus GitHub mirrors. Its native branches are not backed up, are single-region, never sync back, and have no documented conflict model; our projection lease (001) is the stronger story.

## Origin
Synthesized from spikes: 001–007 (the parallel "Agent Forge" session), with notes from 016 and 017.
Sources: `sources/005-forge-pipeline-e2e/`, `sources/006-post-merge-verify-revert/`, `sources/007-clone-egress-economics/`.
Source files are in `sources/001-github-projection-mirror/`, `sources/002-forge-substrate/`, `sources/003-push-time-policy-gate/` and `sources/004-server-side-merge-no-clone/`. The market synthesis is in `sources/RESEARCH.md`.
