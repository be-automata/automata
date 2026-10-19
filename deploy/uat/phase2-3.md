# Phase 2 ticket 3 (#371) — memory-headroom admission: production UAT

Box: `automata-exec-1` (Hetzner CX33, 7.6 GB; `CommitLimit` ≈ 12.3 GB, idle `Committed_AS`
≈ 2.6 GB). Worker commit: _(filled at deploy)_.

## Rollout

Deployed with the defaults (`WORKER_HEADROOM_FLOOR=1G`, `WORKER_HEADROOM_COMMIT_FRACTION=0.9`,
run commit = `WORKER_RUN_MEMORY_MAX`, `WORKER_ADMISSION_MAX_DEFERRALS=8`). Boot line
`memory headroom check armed: floor=… fraction=… runCommit=… maxDeferrals=… budgetS=…` recorded below. Rollback without a deploy: floor `0` + fraction `1.0`.

## Drill — epic AC 5 (#371 UAT 1–3)

| #   | Check                                                                                                                                                                                                                               | Evidence  |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------- |
| 1   | Boot: `memory headroom check armed: floor=… fraction=… runCommit=… maxDeferrals=… budgetS=…`; `retries` on the registered run task = `WORKER_ADMISSION_MAX_DEFERRALS`                                                               | _pending_ |
| 2   | With a memory hog outside the worker cgroup (`stress-ng --vm 1 --vm-bytes 4G`) a real review is DEFERRED: journal `box.headroom_rejected` with the three values; engine shows QUEUED, `retryCount ≥ 1`; nothing on disk for the run | _pending_ |
| 3   | Hog stopped: the SAME run (same `workflowRunExternalId`) completes and posts its verdict                                                                                                                                            | _pending_ |
| 4   | `Committed_AS` never exceeded `fraction × CommitLimit` during the drill (sampler TSV)                                                                                                                                               | _pending_ |
| 5   | A plain error after admission (forced) reaches the engine as non-retryable: the run FAILS once, is never re-executed                                                                                                                | _pending_ |

## Notes

_(filled during the drill)_
