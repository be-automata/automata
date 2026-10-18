---
spike: 003
name: push-time-policy-gate
type: standard
validates: "Given a per-run short-lived credential, when an agent pushes a secret / manifest violation / out-of-scope path, then pre-receive rejects with a reason; expired or replayed tokens are refused; the gate adds < 200 ms"
verdict: VALIDATED
related: [002-forge-substrate, 001-github-projection-mirror]
tags: [policy, pre-receive, credentials, secrets, opengap, gitleaks]
---

# Spike 003: Push-time policy gate

## What This Validates
Can the forge be the *trust plane*? The edge verifies a per-run credential, and a `pre-receive` hook enforces policy on the
pushed objects before any ref moves. Rejection reasons come back to the agent as `remote:` lines, which it can read and act on.

## Research
| Approach | Where it runs | Pros | Cons | Status |
|---|---|---|---|---|
| GitHub push rulesets / secret-scanning push protection | GitHub | Free on public repos; no infra | Paid (GHAS) on private repos; no per-*run* identity; can't scope one agent run to paths/refs | Baseline |
| Client-side `opengap validate` in Actions (GitAgent) | After the push | Easy | Runs *after* the bad commit exists; hooks fail open (gitagent gaps.md G5) | What we beat |
| **Edge token check + `pre-receive` over quarantined objects** | Our forge, before the ref update | Atomic: nothing lands if any rule fails; agent-readable reasons | We operate it | **Chosen** |
| `update` hook per ref | Our forge | Per-ref decisions | Partial pushes can land | Rejected |

**Token:** HMAC-signed claims `{runId, repo, refPrefix, paths, exp, jti}`. It's revocable by `jti` when the run ends.
It travels to git through env-scoped config (`GIT_CONFIG_*` → `http.extraHeader`), never argv.
In production the credential broker (#81) mints it.

## How to Run
```bash
cd .planning/spikes/003-push-time-policy-gate
node scenarios.mjs      # needs ../002-forge-substrate/work/seed.git (./setup.sh seed there); binds :3303
node render.mjs && open console.html
```

## What to Expect
15 PASS lines. In `console.html`: KPI cards for accepted, rejected and edge-refused pushes plus gate p95; the scenario table;
and the audit log (`edge/refused`, `gate/accepted|rejected` with reasons and `gateMs`).

## Observability
`events.jsonl` is the audit ledger. The edge writes `refused` and `revoked`; the hook writes `accepted` or `rejected` with runId, refs, reasons, gateMs and scanner. Results go to `results.json`, which `render.mjs` turns into `console.html`.

## Investigation Trail
1. **First run: 14/15.** G13 failed, which was the point of probing it. A secret added in commit 1 and removed in commit 2 *of the same push*
   passed, because the hook scanned the **net diff** (`git diff base new`). The secret is still in history. Spike 001 would then have projected that history to GitHub,
   which is exactly the leak push protection exists to stop.
   **Fix:** scan every new commit with one `git log -p base..new` process. G13 now rejects, and latency didn't move.
2. **Edge vs. hook split.** Credential failures (expired, revoked or replayed, wrong repo, tampered claims) are refused at HTTP **before any pack upload**.
   Content failures run in `pre-receive` against quarantined objects. Nothing lands, so there's nothing to clean up.
3. **Tampering is caught.** Re-encoding the claims to widen `paths: ["**"]` and `refPrefix: "refs/heads/"` fails the HMAC, so the push is refused (G10).
4. **Scanner accuracy.** My fake AWS key was hex, which isn't a real AWS alphabet. The built-in regex flagged it, but gitleaks correctly ignored it.
   A realistic base32 key *is* caught by gitleaks. So the regex is broader (more false positives) and gitleaks is more precise.
   Production should run gitleaks, plus a small custom rule pack for our own token formats (the run token, `sk-ant-`).
5. **Latency.** Over 20 accepted pushes of 50-line files: regex gate **p50 11 ms / p95 12 ms**, gitleaks gate **p50 27 ms / p95 28 ms**.
   (An earlier run had a gitleaks p95 of 58 ms, from cold-start variance.)

## Results
**VALIDATED, 15/15.**

| # | Attack or case | Where it's stopped | Agent sees |
|---|---|---|---|
| G1 | In-scope push | — (accepted, 14 ms) | `push accepted (… run run-1)` |
| G2 | AWS key in file | pre-receive | `secret detected: aws-access-key` |
| G3 | `.github/workflows/pwn.yml` (CI tamper) | pre-receive | `outside allowed paths [...]` |
| G4 | Push to `main` | pre-receive | `outside this run's ref scope` |
| G5 | `agent.yaml` without description, `version: latest`, no SOUL.md | pre-receive | All 3 OpenGAP violations |
| G6 | Valid OpenGAP agent | — (accepted) | — |
| G7 | Expired token | edge (403) | `token expired at …` |
| G8 | Token replayed after the run ended | edge | `token revoked (run run-8 ended)` |
| G9 | Token for another repo | edge | `token is for other.git` |
| G10 | Tampered claims | edge | `bad signature` |
| G11 | Force-push / history rewrite | pre-receive | `non-fast-forward refused` |
| G12 | Anonymous push | edge (401) | auth required |
| G13 | Secret added and then removed in one push | pre-receive (per-commit scan) | `secret detected: github-token` |
| G14/15 | Latency | — | regex p95 12 ms; gitleaks p95 28 ms (budget was 200 ms) |

**Signal for the build:**
- Policy at push time costs **under 30 ms**. That makes it a cheap, defensible differentiator next to GitHub's paid push protection, and it's per-run, which GitHub can't express at all.
- **Scan every commit, never the net diff.** This rule is load-bearing because spike 001 projects history, not snapshots.
- Revocation is an in-memory Set in this spike. Production needs a shared store (Redis/Postgres) and a revoke-on-run-end hook in the worker.
- **Not covered:**
  - Large-push behaviour (scan time grows with the size of the diff).
  - Rejecting binary blobs.
  - Separation-of-duties rules (for example, an agent can't approve its own change). That needs the merge service (spike 004) to check approver ≠ author.
