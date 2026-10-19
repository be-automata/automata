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

## Notes

_(filled during the drill)_
