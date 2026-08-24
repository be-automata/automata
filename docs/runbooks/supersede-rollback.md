# Supersede policy (#125) — rollback runbook

Rolling the feature back is three steps, each independently reversible. The
drill below was executed once in dev (the isolated hatchet-lite stack, see the
"drill" test in `packages/worker/src/agent-run/supersede.integration.test.ts`).

## 1. Flag OFF

Admin → Feature flags → `supersedePolicy` → global OFF (and clear any per-user
overrides). Effect is immediate for NEW dispatches: they hit the legacy
`agent-run` workflow with the byte-identical payload (guarded by
`apps/www/src/agent/hatchet/__fixtures__/transport.golden.json`) and the
app-side (#8) supersede pass is back in charge. In-flight and queued native
runs are unaffected by the flag — drain them in step 2.

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
it on; disable by env (`SUPERSEDE_SWEEP_CANCELLED_AFTER_MS` /
`SUPERSEDE_SWEEP_ORPHAN_AFTER_MS` are the only knobs) only if it misbehaves.

## Success criteria for retiring `hatchet_run` (app-side supersede)

Retire the app-side path (and this table's supersede role) only when ALL hold
for two consecutive pilot weeks with the flag ON:

1. zero runs took the app-side cancel pass (`[hatchet] superseding prior…`
   log line absent);
2. every cancelled native run reached a typed terminal within the sweep bound
   (no thread ever reaped by the 75m stalled watchdog with a NULL
   `terminal_cause`);
3. the engine version dedupes delivery ids (the #128 characterization case
   flips) — until then `hatchet_run` is also the sweep's cause-inference source.
