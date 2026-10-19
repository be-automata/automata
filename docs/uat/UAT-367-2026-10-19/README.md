# UAT-367-2026-10-19 — agent-uid loopback fence (#367), production execution box

**Verdict:** PASS — 11 of 12 criteria; C12 (30 real runs under enforce) BLOCKED on the run count only, with no failure observed.
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
| C12 | 30 runs under enforce, none fence-failed (regression, issue gate) | BLOCKED | `11-…-runs-completed-count.txt` = 18, failed 0, refused-in-logs 0, host-local 0 |

## Deviations

- Observe window shortened from 7 days / 30 runs to ~10 min / 3 runs (operator decision); C12 tracks the 30-run half.
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

- 2026-10-19 15:33 UTC — first run (this record).
