# Supersede policy (#125/#165) — rollback runbook

Since #165 (ADR-007) the engine is the SOLE automatic supersession authority:
the `supersedePolicy` feature flag, the `app-side` policy value, and every
www-side cancel path (`supersedePriorReviewRuns`, the automation's
prior-thread archival) are DELETED from the code. There is no flag to flip.

## 1. Roll back the code (the only step 1 that exists now)

Revert the #165 PR (or redeploy the previous build): the flag definition and
the app-side cancel pass return with it. Data needs nothing — the retire
migration only NULLed `app-side` settings rows, and a NULL row resolves to
`newest-wins` under the old build too (its default), so behavior is stable
across the rollback. In-flight and queued native runs are unaffected by the
deploy — drain them in step 2 if the incident requires a quiet engine.

## 2. Drain queued native runs

The three variants (`agent-run-newest`, `agent-run-strict`, `agent-run-discard`)
may still hold QUEUED runs. Bulk-cancel them through the engine REST API with
the tenant token (`HATCHET_API_URL` / `HATCHET_TENANT_ID` / `HATCHET_API_TOKEN`
from the www worker secrets):

Cancel the QUEUED runs first, then the RUNNING ones. Either order ends the
same way (nothing live, no drained run completes); QUEUED-first minimises the
window in which a just-freed slot admits a run that is then cancelled on its
first tick (observed on the isolated engine during the drill).

```bash
drain() {  # $1 = QUEUED | RUNNING
  curl -s -H "Authorization: Bearer $HATCHET_API_TOKEN" \
    "$HATCHET_API_URL/api/v1/stable/tenants/$HATCHET_TENANT_ID/workflow-runs?statuses=$1" \
    | jq -r '.rows[] | select(.workflowName | startswith("agent-run-")) | .metadata.id' \
    | jq -Rn '{externalIds: [inputs]}' \
    | curl -s -X POST -H "Authorization: Bearer $HATCHET_API_TOKEN" -H "Content-Type: application/json" \
        -d @- "$HATCHET_API_URL/api/v1/stable/tenants/$HATCHET_TENANT_ID/tasks/cancel"
}
drain QUEUED
drain RUNNING
```

Verify: the same list query returns zero rows for the variants. What the drain
guarantees (proven by the drill): every drained run ends CANCELLED and none
completes; a run the engine admitted in the same instant a cancel freed the
box slot may START and is cancelled on its first tick (cancels are delivered
asynchronously) — that is at most one agent turn's first seconds, never a
review. The worker's cancel hook posts a `superseded` terminal for each
cancelled run that carried a native policy; anything it misses is picked up by
the sweep (step 3) within ~10 minutes as `user-cancelled`.

## 3. Sweep stays on

`runSupersedeSweep` (every minute, scheduled-tasks cron) is additive and safe
under flag OFF: it only ever writes a terminal to a thread that has none. Leave
it on. Kill switch: `SUPERSEDE_SWEEP_ENABLED=false` on the www worker (the
timing knobs `SUPERSEDE_SWEEP_CANCELLED_AFTER_MS` /
`SUPERSEDE_SWEEP_ORPHAN_AFTER_MS` accept positive integers only).

## Retirement of the app-side path — EXECUTED (#165)

The success criteria that used to live here were met during the 2026-08-25
live UAT (zero app-side cancel passes under native policies after #143; every
cancelled native run reached a typed terminal within the sweep bound) and
#165 retired the path. `hatchet_run` itself STAYS: it is the sweep's
cause-inference source and the recheck ledger's spine; the engine still does
not dedupe delivery ids (the #128 characterization case), so the per-thread
double-dispatch guard remains load-bearing.
