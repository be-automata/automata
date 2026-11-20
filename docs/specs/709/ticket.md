## Why

The cell plan refuses every cell with `egress_not_enforced` unless the `opensandbox/runc` execution profile has unexpired conformance evidence. That evidence comes from an `OPENSANDBOX_IT` run and lasts 30 days. During the #656 production UAT on 2026-11-19 the first cell run failed for exactly this reason: production had the profile but no evidence, and the deploy README's "OpenSandbox cells" section has no step that pushes it. A fresh run at `34c43ad8` passed 12/12, and `push-evidence.sh` recorded 9 rows **expiring 2026-12-19**.

Nothing renews it and nothing warns before it lapses. On 2026-12-19 every cell plan will start refusing, and runs will silently fall back to the box. This ticket makes the evidence a documented, scheduled and monitored part of operating cells.

## Reality check (verified at `main` = `34c43ad8`, 2026-11-19)

| Claim | Where | State |
|:--|:--|:--|
| The guard | `packages/shared/src/model/cell-egress-guard.ts` (unexpired `evidence.source: conformance` required) | exists |
| The ingest route | `apps/www/src/app/api/internal/profile-evidence/opensandbox/route.ts:41,106` (evidence must be measured within 24 h, at most 5 min in the future), `:141-147` (returns `expiresAt`) | exists |
| The push script | `packages/sandbox/opensandbox-it/push-evidence.sh` (header `x-automata-profile-evidence-token`, secret from `/etc/automata/profile-evidence.env` on the box) | exists |
| The secret install | `packages/worker/deploy/README.md:666-690` | documented |
| The "OpenSandbox cells" runbook | `packages/worker/deploy/README.md:1250-1320` | **no evidence step, no renewal** |
| A schedule or an alert | — | **does not exist** |
| The cron host | `apps/www/src/server-lib/cron.ts:430-489` (the cell reconciler on `*/10`) | exists |

## Scope

1. **Runbook:** add the evidence push to "OpenSandbox cells", before `OPENSANDBOX_URL` is set, with the renewal rule (re-run within 30 days; push within 24 h of the run).
2. **Schedule:** a systemd timer on the box (installed by the provisioning script, beside the other units) that runs `OPENSANDBOX_IT` and `push-evidence.sh` weekly, only when the worker is idle of cell runs, and logs the returned `expiresAt`.
3. **Alert:** a www cron check (in the existing `cron.ts` schedule) that logs an error line and opens a GitHub issue (the same mechanism `synthetic.yml` uses, or an equivalent) when the newest `opensandbox/runc` evidence expires within 7 days or has expired while `OPENSANDBOX_URL` is set.
4. **Visibility:** `cell-plan`'s `egress_not_enforced` refusal is counted in the log line already there; the alert names it.

## Out of scope

- Tightening the IT verdicts (#654).
- Kata profiles.

## Acceptance criteria

1. The README "OpenSandbox cells" section lists the evidence push as a numbered step before `OPENSANDBOX_URL`, and the renewal rule.
2. The timer runs on the box, pushes fresh evidence, and the newest evidence's `expires_at` moves forward (shown by a read-only query).
3. The timer skips (and logs why) when a cell run is live.
4. With evidence expiring within 7 days, the alert fires once (no duplicate issue while one is open); with fresh evidence it does not.
5. No secret appears in the timer's journal or the alert.

## Tests

- Unit (`apps/www`): the expiry check (fresh / within 7 days / expired / cells unconfigured).
- Box: a dry run of the timer's script with `--dry-run` printing the plan.

## UAT

Run the timer once by hand on `automata-exec-1` (`systemctl start`), confirm the new `expires_at`, and confirm the alert check reports "ok" on the next cron tick.

## Decisions (2026-11-19, owner took the recommendations)

- **OD-1 — alert channel: a GitHub issue labelled `cell-evidence`**, one open at a time, like `synthetic-failure` (`.github/workflows/synthetic.yml`). Confidence 7.
- **OD-2 — cadence: weekly.** Four chances before a 30-day expiry. Confidence 7.

## Risks and rollback

- An IT run uses box CPU and Docker; the idle check bounds it. Rollback: disable the timer; evidence still lasts 30 days from the last push.

## Definition of done

AC 1-5 met with evidence, gates green, PR approved, timer installed and its first run recorded here, before 2026-12-12.

## References

#634, #656 (UAT comment of 2026-11-19), #654, ADR-014.

