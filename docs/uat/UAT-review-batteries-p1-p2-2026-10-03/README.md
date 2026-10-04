# UAT — Review agent batteries epic, Phases 1–2 (2026-10-03)

**Verdict:** Phase 1 PASS · Phase 2 evidence recorded (spike, no deploy) · Phases 3–6 not shipped.
**Scope:** PR #229 (merged into main as 5f9a6d4). No Jira ticket: the epic is tracked in GitHub
and the repo's planning files.
**Environment:** production execution box `automata-exec-1`. **Build:** 5f9a6d47 (contains the merge),
deployed 2026-10-03 17:16 UTC.
**Validator:** somnio production-validator, PASS_WITH_WARNINGS.
**Report:** `report.html` (artifact URL in `run.json`).

## Cases

| ID | Criterion | Verdict | Evidence |
|----|-----------|---------|----------|
| C1 | Review env keeps safe.directory / user.*, COUNT renumbered | PASS | 01, 13, 04 |
| C2 | Review env holds no GitHub token / extraheader / insteadOf | PASS | 01, 13 |
| C3 | Tests pin both; suite + tsc green | PASS | 00, 01, 02 |
| C4 | Box runs a build containing the merge; bundle has the new code | PASS | 03, 12 |
| C5 | Post-deploy reviews read the diff and post verdicts; 0 "dubious ownership" | PASS | 04, 05 |
| C6 | Regression: worker healthy after deploy | PASS | 03, 04 |
| P2 | Headless capability spike Q1–Q7 | recorded | 06–11 |

## Findings
- Low: the squash commit title cites #228, which is an unrelated PR.
- Low: two identical daemon bundles on the box (`/opt/.../dist` is the one spawned).
- Info: the worker journal does not log each run's lane; closed here by matching runs to reviews.
- Info: Phase 2 Q2/Q7 (two results per sub-agent run, echoed sub-agent verdict) carried into Phases 5/6.

## Terraform
Not applicable (no `*.tf` in the repo).

## Re-run
Reuse `run.json`: same criteria. Prior-UAT matching found no records for these keys or paths.
