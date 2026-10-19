# Phase 2 ticket 4 (#372) — env-driven caps, whole-tuple validation, the raise: production UAT

Box: `automata-exec-1` (Hetzner cx33 at the time of writing: 4 vCPU, 8 GB RAM, 8 GB swap,
`CommitLimit` 12 357 216 kB, `vm.overcommit_ratio` 50, idle `Committed_AS` ≈ 2.6–3.5 GB). Worker
commit: _(filled at deploy)_.

## Pre-raise baseline (epic AC 7 / AC 9 — recorded 2026-10-19 14:07 UTC, 7-day window)

Source: the engine's windowed collection route
(`GET /api/v1/stable/tenants/<t>/workflow-runs?since=<7d>&limit=200&offset=…&only_tasks=true`,
rows with `actionId` ending `:run`; queue wait = `startedAt − createdAt`, execution =
`finishedAt − startedAt`). 279 run tasks: 271 COMPLETED, 4 FAILED, 1 CANCELLED, 2 QUEUED,
1 RUNNING at read time.

| Metric                                     | Value                                                |
| :----------------------------------------- | :--------------------------------------------------- |
| queue-wait p50 / p90 / max                 | 0 s / **2 s** / 1 798 s (one run waited a full 30 m) |
| `SCHEDULING_TIMED_OUT` (error text match)  | **0**                                                |
| supersede waste (Σ CANCELLED exec / Σ all) | **0.0 %** (1 s of 16 305 s)                          |

The epic's "pre-raise 6.6 minutes p90" is not what this box shows this week (cap 1 was
mostly idle; the 55.8-minute max is in the epic's September data). AC 7 is therefore judged
against THIS baseline a week after the raise.

## Decisions recorded (ticket items 5 and 6)

**Production tuple — a NAMED DEVIATION from both ticket options.** The ticket offered (a)
cx43 with global 3 / per-org 2 or (b) cx33 with global 2 / per-org 2 and a lower ceiling.
Measured on the box (sampler `/var/tmp/automata-mem-samples.tsv`, 36 runs; journal, 7 d):
review-lane peak p95 0.15 GiB; task-lane median 0.26 GiB but max 4.49 GiB sampled and 6
OOM-kill / `memoryStarvation` lines at the 5000M ceiling. So the ceiling cannot drop below
5000M without killing task runs — (b) is out. On cx43 (16 GB, 8 GB swap → `CommitLimit` ≈ 16 GB)
the #371 commit arm admits two 5000M runs beside the base (2.6 + 4.9 + 4.9 = 12.4 GiB <
0.9 × 16 = 14.4 GiB) but not three (17.3 GiB), and 3 × 5 GB also exceeds 16 GB RAM — so (a)'s
global 3 would make the headroom check defer every third run until it failed. **Chosen:
resize to cx43 (the epic's authorized RAM-trigger move; the OOM evidence fires it) and run
`WORKER_BOX_SLOTS=2 WORKER_GLOBAL_MAX_RUNS=2 WORKER_PER_ORG_MAX_RUNS=2
WORKER_RUN_MEMORY_MAX=5000M`.** Global 3 is revisited with #373's 7-day data (it needs either
`vm.overcommit_ratio` ≥ 80 or a per-lane ceiling). Per-org = global because a single-org box
must be able to use both slots; fairness across orgs stays GROUP_ROUND_ROBIN's ordering.

**Supersede waste — accept and measure.** `newest-wins` keeps a verdict current with the
latest push; moving high-churn repos to `complete-run-discard` would trade compute for stale
verdicts. The worker logs `box.supersede_waste {runId, threadId, lane, policy, executionMs}` on
every superseded terminal; the 7-day fraction is #373's trigger, revisited above ~20 %.

## Drill — epic AC 6 and AC 8 (#372 UAT 1–3)

| #   | Check                                                                                                                                                                                                                                                         | Evidence  |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------- |
| 1   | AC 8: `WORKER_GLOBAL_MAX_RUNS=3` with `WORKER_BOX_SLOTS=1`, restart → journal `FATAL: worker configuration is invalid … WORKER_GLOBAL_MAX_RUNS=3 but WORKER_BOX_SLOTS=1`; restore → boots                                                                     | _pending_ |
| 2   | The chosen tuple applied (after the cx43 resize, N = 2 provisioning re-armed incl. the hidepid drop-in): boot line `box slots: 2 …`, engine Worker row `slotConfig.limit = 2`; two real PRs on different repos run concurrently (AC 3)                        | _pending_ |
| 3   | AC 6 engine half: `burst.integration.test.ts` (42 runs, caps 3/2, 3 slots) green in CI; box half: a synthetic burst of 42 dispatches at the applied tuple leaves `journalctl -p err` free of `ENOMEM`/`posix_spawn`, engine + Postgres up, every run terminal | _pending_ |
| 4   | Baseline above recorded; AC 7 (p90 below baseline, zero `SCHEDULING_TIMED_OUT`) and AC 9 (waste fraction) re-queried 7 days after the raise                                                                                                                   | _pending_ |

## Notes

_(filled during the drill)_
