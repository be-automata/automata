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

**Production tuple — concurrency 3 (ticket option (a), the epic's DoD; operator decision
2026-10-19).** Measured on the box (sampler `/var/tmp/automata-mem-samples.tsv`, 36 runs; journal,
7 d): review-lane peak p95 0.15 GiB; task-lane median 0.26 GiB but max 4.49 GiB sampled and 6
OOM-kill / `memoryStarvation` lines at the 5000M ceiling. So the ceiling cannot drop below 5000M
without killing task runs — option (b) (cx33, lower ceiling) is out. **Chosen: resize to cx43
(16 GB RAM, 8 vCPU; the epic's authorized RAM-trigger move — the OOM evidence fires it) and run
`WORKER_BOX_SLOTS=3 WORKER_GLOBAL_MAX_RUNS=3 WORKER_PER_ORG_MAX_RUNS=2 WORKER_RUN_MEMORY_MAX=5000M`
with `vm.overcommit_ratio=80`.** The arithmetic that makes three 5000M runs admissible: at the
kernel default `overcommit_ratio` 50, cx43's `CommitLimit` = 8 GB swap + 0.5 × 16 GB = 16 GB, and
the #371 commit arm (0.9 × 16 = 14.4 GiB) admits two runs beside the ≈ 2.6 GiB base (12.4 GiB) but
defers the third; the #372 boot check uses the SAME budget and refuses the tuple outright. In
real units (5000M = 5.24 GB; swap 8 388 604 kB = 8.59 GB; cx43 `MemTotal` ≈ 15.9 GB): at
`overcommit_ratio` 80, `CommitLimit` ≈ 8.59 + 12.7 = 21.3 GB and the budget is 0.9 × 21.3 =
19.2 GB. The boot check passes (3 × 5.24 + 2.15 base = 17.9 GB < 19.2 GB, a 1.3 GB margin — a run
commit above ≈ 5.4 GB would refuse). At run time the commit arm admits the third run while
`Committed_AS` + 3 × 5.24 ≤ 19.2 GB, i.e. while the live base is ≤ 3.5 GB: at the idle LOW end
(2.7 GB) the margin is 0.8 GB, at the observed high end (3.5 GB) it is ~0 — so a third run deferred
for a few seconds after the resize is the check working, not a regression; a sustained deferral
means the base grew and the move is `overcommit_ratio` 90 or a 4500M ceiling. 3 × 5.24 = 15.7 GB
stays under the 15.9 GB of RAM so the
`warnIfSlotsExceedMemory` warning stays quiet (swap absorbs a peak). `vm.overcommit_memory` stays 0
(heuristic): `CommitLimit` is the headroom check's budget signal, not a kernel-enforced cap.
Code defaults stay 1/1/1 so an unprovisioned box still boots. Per-org 2 < global 3 so no single
org can hold every slot; fairness across orgs is GROUP_ROUND_ROBIN's ordering. The sysctl lands
with the resize (`/etc/sysctl.d/90-automata-overcommit.conf`) and is recorded in row 2.

**Supersede waste — accept and measure.** `newest-wins` keeps a verdict current with the
latest push; moving high-churn repos to `complete-run-discard` would trade compute for stale
verdicts. The worker writes `box.supersede_waste {runId, threadId, lane, policy, executionMs}` to the ENGINE task log (`ctx.log`, not the journal) on every superseded terminal it posts, measured from the task fn's start (admission and headroom waits included — the same window as the engine's `finishedAt − startedAt`); the 7-day fraction is #373's trigger, revisited above ~20 %.

## Drill — epic AC 6 and AC 8 (#372 UAT 1–3)

| #   | Check                                                                                                                                                                                                                                                                                                                      | Evidence  |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------- |
| 1   | AC 8: `WORKER_GLOBAL_MAX_RUNS=3` with `WORKER_BOX_SLOTS=1`, restart → journal `FATAL: worker configuration is invalid … WORKER_GLOBAL_MAX_RUNS=3 but WORKER_BOX_SLOTS=1`; restore → boots                                                                                                                                  | _pending_ |
| 2   | The chosen tuple applied (after the cx43 resize and `vm.overcommit_ratio=80`; slot accounts `automata-agent-1/-2`, Runas, nft set, traverse ACL, hidepid remount + drop-in re-armed per §6): boot line `box slots: 3 …`, engine Worker row `slotConfig.limit = 3`; two real PRs on different repos run concurrently (AC 3) | _pending_ |
| 3   | AC 6 engine half: `burst.integration.test.ts` (42 runs, caps 3/2, 3 slots) green in CI; box half: a synthetic burst of 42 dispatches at the applied tuple leaves `journalctl -p err` free of `ENOMEM`/`posix_spawn`, engine + Postgres up, every run terminal                                                              | _pending_ |
| 4   | Baseline above recorded; AC 7 (p90 below baseline, zero `SCHEDULING_TIMED_OUT`) and AC 9 (waste fraction) re-queried 7 days after the raise                                                                                                                                                                                | _pending_ |

## Notes

_(filled during the drill)_
