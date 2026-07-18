# scripts/uat — executable UAT harness

Self-contained runner for the ADR-036 effect-intent parity suite. Each case **self-provisions** its
own fixtures (branch/PR/issue/mentions), **observes** via GitHub-as-record (+ OLAP/wrangler when
available), **asserts** the rubric programmatically, and **cleans up** idempotently.

Narrative + rubrics: [`docs/uat/adr-036-effect-intent.md`](../../docs/uat/adr-036-effect-intent.md).
Params + preflight: [`docs/uat/README.md`](../../docs/uat/README.md).

## Run
```bash
pnpm install                 # first time (installs tsx)
gh auth status               # must be authenticated as an OAuth-LINKED platform user
REPO=be-automata/automata BOT_HANDLE=automata-ai-bot pnpm uat        # all runnable cases
pnpm uat S1 S2 S3            # a subset
pnpm uat --list             # list case ids
```
Preflight runs first and **hard-stops** (exit 2) with exactly what's missing (handle not inlined,
www unreachable, gh not linked). The suite exits **1** if any case FAILs, **0** if all pass/skip.
Machine-readable results land in `scripts/uat/results/uat-<runId>.json` (evidence for the matrix).

## Case → code map
| case | entry | self-provisions |
|---|---|---|
| S1/S2/S3 | `cases.ts` `S1_S3()` | one fixture PR, opened→partial→full lifecycle |
| S4, S9 | `S4()`, `S9()` | mention on the shared mention-PR |
| S5 | `S5(pr)` | re-review (needs a verdict at HEAD) |
| S6 | `S6()` | own unfixed-defect PR (bot commits the fix) |
| S7 | `S7(pr)` | `/request-changes` command |
| S8 | `S8(pr)` | verdict upgrade (runner pushes full-fix → APPROVED first) |
| S12 | `S12(N)` | N burst issues (currently FAIL — mid-run token revocation) |
| S10/S11/S13/S14 | `phase2()` | self-report SKIPPED(phase-2-gated) |

## Evidence degradation
GitHub-as-record drives all PASS/FAIL assertions (the product's own source of truth). OLAP run-ids
and `dup_reconciled` telemetry are *supplementary*; when `docker`/`wrangler` aren't in the runner's
env, those notes downgrade to `EVIDENCE-PARTIAL` — they never flip a GitHub-verifiable PASS to FAIL.

> Idempotent: branch/issue names carry `$UAT_RUN_ID` so repeat/parallel runs never collide, and every
> case cleans up its PRs/issues/branches/worktrees in a `finally`.
