# UAT-367-2026-10-19 — agent-uid loopback fence (#367), production execution box

**Verdict:** PASS — 12 of 12 criteria (C12 graded at 16:51 UTC on the 30-run hold: 31 completed, 0 failed).
**Change:** PR #383 (observe step, merge 5b57010) + PR #388 (enforce step, merge 3e344b7). Issue #367.
**Environment:** `automata-exec-1` (the production execution box; the fence exists only there). Deployed HEAD 3e344b765 contains both merge commits.
**Lane:** api/CLI — recorded commands and outputs on the box; probes as uid 999 and 2001 from a throwaway cgroup under the worker unit (`nft-verify.sh`).

## Criteria

| id | criterion | verdict | evidence |
|---|---|---|---|
| C1 | mechanism pre-proven on the real subtree | PASS | spike (nobody client) + C5 |
| C2 | refused rows reset < 1 s, both uids | PASS | `22-…-nft-verify-enforce.txt` (24–34 ms) |
| C3 | allow rows connect; DNS resolves; :25432 accepts | PASS | same |
| C4 | ::1 parity | PASS | same (::1:22 refused; ::1 own listener admitted) |
| C5 | restart ⇒ unit reload, C2/C3 hold | PASS | `09-…-journal-loader-lines.txt` 14:19:09 + `07-…-unit-state.txt` + verify 15:33 |
| C6 | fail-closed on a bad cgroup path | PASS | journal 13:47:09 FAIL / exit-code |
| C7 | egress table unchanged, Docker intact | PASS | `05-…-egress-conf-vs-checkout.diff` exit 0, `01-…-egress-table.txt`, `03-…-docker-rules-count.txt` |
| C8 | review run + DB-suite + loopback-server task runs under enforce | PASS | `10-…-runs-under-enforce.txt`; PR #392 (DB suite exit 0, getent exit 0, loopback suites 111/114 — 3 failures from NODE_USE_ENV_PROXY, 114/114 with it unset) |
| C9 | observe log holds only refused rows | PASS | `15-…-observe-window-log.txt` (verifier probes only) |
| C10 | test cards present | PASS | `26-…-test-cards.txt` (9/9; proxy 6) |
| C11 | CI green, egress assertions unchanged | PASS | `27-…-ci-pr-checks.txt` |
| C12 | 30 runs under enforce, none fence-failed (regression, issue gate) | PASS | per-run ledger, corrected (evidence 31, which supersedes 29 and 30): 34 runs started under enforce in the window; 31 started AND completed inside it (rows 1, 2, 4–14, 16–33); 1 completed 27 s after the capture (row 34); 0 failed; 2 ended without a completion line and neither is a fence effect: row 15 (review pr=394) is logged "cancelled under newest-wins → superseded", row 3 (task) was torn down 10 s after boot as the next task run on the same repo started, with no ECONNREFUSED or Connection refused string. Restart overlap is computed from each run's own last log line: none of the 34 runs overlaps a restart (14:19:09, 16:31:24, 16:37:22). Evidence 29's "4 completed after T1" counted runs that also started after T1, and evidence 30's restart column treated a missing completion as open-ended; evidence 31 states both corrections. Counters in evidence 28 date from the 16:37 reload (its header says 14:19) |

## Deviations

- Observe window shortened from 7 days / 30 runs to ~10 min / 3 runs (operator decision); the 30-run half was then held under enforce (C12 PASS); the 7-day half cannot elapse in-session.
- Four reject lines instead of three (bridge tcp needs `reject with tcp reset`; measured 1 s timeout otherwise).
- Proxy also refuses host-local targets; NO_PROXY gains ::1 (the proxy was a tunnel through the fence).
- Environment is production, not develop/staging.

## Findings

- info: an agent task run polls localhost:8888 (engine API) and is refused; the run keeps working.
- info: 3 egress-proxy unit tests fail inside a task run because of NODE_USE_ENV_PROXY; not the fence.
- low: shared policy validator accepts private-range allowlist entries the box proxy refuses (documented gap).
- info: table counters reset on every (re)load.

## Manifest gaps

None: ssh key name and gh auth were the only requirements, both present.

## Run history

- 2026-10-19 15:33 UTC — first run (this record); page v1–v2.
- 2026-10-19 16:51 UTC — C12 graded PASS on the 30-run hold; page v3.
- 2026-10-19 — review rounds on PR #398: deviation wording (v4), run-count reconciliation (v5), per-run ledger (v6), corrected ledger as evidence 31 (v7).
