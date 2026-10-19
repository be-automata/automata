# Phase 2 ticket 3 (#371) — memory-headroom admission: production UAT

Box: `automata-exec-1` (Hetzner CX33, 7.6 GB; `CommitLimit` ≈ 12.3 GB, idle `Committed_AS`
≈ 2.6 GB). Worker commit: _(filled at deploy)_.

## Rollout

Deployed with the defaults (`WORKER_HEADROOM_FLOOR=1G`, `WORKER_HEADROOM_COMMIT_FRACTION=0.9`,
run commit = `WORKER_RUN_MEMORY_MAX`, `WORKER_ADMISSION_MAX_DEFERRALS=8`). Boot line
`memory headroom check armed: floor=… fraction=… runCommit=… maxDeferrals=… budgetS=…` recorded below. Rollback without a deploy: floor `0` + fraction `1.0`.

## Drill — epic AC 5 (#371 UAT 1–3)

| #   | Check                                                                                                                                                                                                                                                                                                                            | Evidence  |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------- |
| 1   | Boot: `memory headroom check armed: floor=… fraction=… runCommit=… maxDeferrals=… budgetS=…`; the registered run task keeps `retries: 0`                                                                                                                                                                                         | _pending_ |
| 2   | With a memory hog outside the worker cgroup (`stress-ng --vm 1 --vm-bytes 4G`) a real review is DEFERRED: journal `box.headroom_rejected` with the three values, then `box.headroom_deferred_wait` (deferral n, waitS); engine shows RUNNING, `retryCount` 0; nothing on disk for the run; the slot file is free during the wait | _pending_ |
| 3   | Hog stopped: the SAME run (same `workflowRunExternalId`, one attempt) logs `box.headroom_ok`, completes and posts its verdict                                                                                                                                                                                                    | _pending_ |
| 4   | `Committed_AS` never exceeded `fraction × CommitLimit` during the drill (sampler TSV)                                                                                                                                                                                                                                            | _pending_ |
| 5   | Budget exhausted (hog held past `budgetS`): the run FAILS once with `AdmissionBudgetExhaustedError` ("no memory headroom after N deferral(s)"), is never re-executed, nothing on disk                                                                                                                                            | _pending_ |
| 6   | Queued-behind-a-deferral (N = 1): a second review dispatched while the first is deferred stays QUEUED at the engine (the deferred run holds the engine slot); it starts when the first ends — recorded, never failed by the worker                                                                                               | _pending_ |

## Notes

**Why N = 2 is not the steady state on this box (and #371 says so).** With the box's own
numbers — run commit = `WORKER_RUN_MEMORY_MAX` = 5000M ≈ 4.9 GiB, idle `Committed_AS` ≈ 2.4 GiB,
`CommitLimit` ≈ 11.8 GiB × 0.9 ≈ 10.6 GiB — one admitted run plus a second arriving is
2.4 + 4.9 + 4.9 ≈ 12.2 GiB > 10.6 GiB: the commit arm defers every second concurrent run, and if
the first outlasts the 366 s budget the second fails final. Shrinking the reservation by the
run's anonymous memory does not change the sum (it moves bytes from `reserved` into
`Committed_AS`). So #371 at N = 2 on a CX33 turns "waits at the engine" into "dispatched,
deferred, fails after ≈ 6 min" — the check working as specified, not failing. The #205 N = 2
drill (`phase2-2.md`) was therefore captured on the pre-#371 code, and the box returns to
`WORKER_BOX_SLOTS=1` BEFORE the restart that brings #371 up. Raising N here needs a lower
`WORKER_RUN_MEMORY_MAX` or more memory, and the arithmetic above is the sizing rule.

_(drill evidence filled below)_
