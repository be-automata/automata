# Execution-plane worker — operator deploy assets

Repo-tracked launchd templates + runbook for the Automata `agent-run` worker on the
pilot Mac (enterprise-hardening Phase 3, gap #4). Real customer boxes get a systemd
unit; this is the dev-Mac launchd analog.

Two units are provided:

- `com.automata.worker.plist` — unit A (primary).
- `com.automata.worker-2.plist` — unit B (warm standby for HA / rolling restarts).

Both are **templates**. Replace the `__HOME__` and `__REPO__` tokens for the box,
then install to `~/Library/LaunchAgents/`.

> **≥2 workers is safe ONLY because of Phase 0.2b per-worker namespace reclaim.**
> Each worker process owns `/tmp/automata-agent-run/<workerId>/`
> (`workerId = w-<pid>-<uuid>`, unique per process); boot-time reclaim reaps orphans
> only under a **sibling** dir whose lock pid is confirmed dead, so a live worker's
> daemons are never SIGKILLed. Without it, unit B's reclaim could kill unit A's live
> daemon.

Unit B is a standby, **not** extra throughput: the workflow's global concurrency cap
(`GLOBAL_MAX_RUNS = 1` in `src/agent-run/workflow.ts`) still serializes to ONE
agent-run at a time across both units. Extra throughput is gap #3b (raise the cap),
gated on a memory-headroom check.

## `run-worker.sh` wiring (both units run this)

Both units exec `~/.automata/run-worker.sh`. It MUST call the fail-closed auth gate
BEFORE starting the worker, so a `-dev` / auth-disabled hatchet-lite engine (public
signing key → tenancy void) never gets a worker:

```bash
#!/bin/bash
export PATH="…"                       # node/pnpm on PATH
cd <repo>/packages/worker
set -a; source ~/.automata/worker-box.env; set +a
# #5 fail-closed gate — exits non-zero (blocks boot) if auth is off or the image drifted.
bash scripts/assert-auth-enabled.sh || exit 1
# Daemon bundle must be current (worker consumes packages/daemon/dist).
pnpm run daemon:build || exit 1
exec node --import tsx src/hello/worker.ts
```

> **SIGNAL CONTRACT (gap #4) — the script MUST end in `exec node …`.** A
> `pnpm run` / `dotenv --` wrapper chain (launchd → pnpm → pnpm → sh → tsx → node)
> swallows launchd's SIGTERM at the top pnpm layer, so `launchctl kill TERM` never
> reaches the worker and the drain contract silently breaks — live-verified
> 2026-07-25. Sourcing the env in-shell and loading tsx IN-PROCESS
> (`node --import tsx`) leaves the worker as the service's direct process, so the
> SDK's own SIGTERM handler receives the signal and drains.

`assert-auth-enabled.sh` needs `HATCHET_API_URL`, `HATCHET_TENANT_ID`, and
`HATCHET_API_TOKEN` (or `HATCHET_CLIENT_TOKEN`) in the env — the same
`worker-box.env` the worker loads. The worker's TS boot gate
(`assertAuthEnabledFromEnv`) is the second, cross-platform layer, so even a box whose
`run-worker.sh` was not updated still fails closed.

## Install

```bash
# Fill the template tokens for this box.
HOME_DIR="$HOME"
REPO="/absolute/path/to/automata-platform"
for unit in com.automata.worker com.automata.worker-2; do
  sed -e "s|__HOME__|$HOME_DIR|g" -e "s|__REPO__|$REPO|g" \
    "$REPO/packages/worker/deploy/$unit.plist" \
    > "$HOME/Library/LaunchAgents/$unit.plist"
done

# Load unit A (primary), then unit B (standby).
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.automata.worker.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.automata.worker-2.plist
```

Confirm each booted and shows the drain-contract log line
(`SIGTERM/SIGINT → SDK graceful drain …`) in its `*.log`.

## Graceful restart (NEVER `kickstart -k` mid-run)

The Hatchet SDK installs its own `SIGTERM`/`SIGINT` handler that pauses task
assignment on the engine and then **awaits the in-flight run to completion** before
exiting (plan amendment 8). There is deliberately **no custom signal handler** in
`worker.ts` — a second handler would race the SDK's and risk tearing the daemon down
mid-run. So restart = **SIGTERM + wait**, never SIGKILL:

```bash
# Send SIGTERM (graceful) — NOT `launchctl kickstart -k`, which is SIGKILL and drops
# the in-flight review.
launchctl kill TERM gui/$UID/com.automata.worker

# Poll for exit before relying on the relaunch. KeepAlive brings it back on new code.
while launchctl print gui/$UID/com.automata.worker 2>/dev/null | grep -q 'state = running'; do
  sleep 2
done
```

`launchctl kickstart -k` sends **SIGKILL** — it is the drop we are preventing. Do not
use it on a unit that may be mid-run.

## Rolling-restart runbook (zero dropped reviews across a deploy)

Restart the two units **one at a time** so the other keeps serving:

1. Pull + rebuild on the box (see "Daemon rebuild" — the worker consumes the daemon
   `dist/`).
2. Drain **unit A**: `launchctl kill TERM gui/$UID/com.automata.worker`; poll for exit
   (above). Unit B keeps serving. KeepAlive relaunches A on the new code.
3. Confirm A is back and healthy (drain-contract log line, no boot errors).
4. Repeat for **unit B** (`com.automata.worker-2`).

> **Workflow version pinning caveat:** confirm in-flight runs stay on their registered
> workflow version across the swap before claiming zero-downtime. If unconfirmed,
> fully drain (step 2 wait) before the code changes take effect — do not overlap a
> code swap with a run mid-flight.

## Daemon rebuild (required after any daemon change, e.g. Phase 0.2a)

The worker consumes the compiled daemon (`packages/daemon/dist/`), not its source.
`pnpm run worker` runs `daemon:build` first, but after a `git pull` that touched
`packages/daemon`, rebuild explicitly before restarting so the drained-then-relaunched
worker picks up the new daemon bundle:

```bash
pnpm --filter @terragon/daemon run build
```

## Zombie / leaked-worker guard

Each daemon SIGKILLs its own process group on teardown, and boot-time reclaim reaps a
dead sibling worker's orphaned daemons. Add a worker-liveness alert (gap #7): alert on
a worker that stops heartbeating so a silently-dead unit is noticed before it starves
HA.

## Scheduling deadlock: diagnosis and recovery (#69)

Two independent engine-side defects can wedge the box's single agent-run slot:
**concurrency-group rot** (a corrupted strategy-chain pointer leaves the active chain
dead-ending — tasks sit `QUEUED` forever with an idle worker) and **SIGKILL slot
exhaustion** (a worker killed without drain never releases its `v1_concurrency_slot`
row). Both are 100% throughput loss with no automatic recovery unless the mechanisms
below are enabled. See `docs/plans/69-scheduling-deadlock-recovery.md` for the full
design and the live evidence this diagnosis is built from.

### Everything here is OFF by default

`HATCHET_ENGINE_DATABASE_URL` unset is the master gate: a box that only ever runs
plain `hatchet:up` has no published engine-DB port to point it at, never sets the URL,
and is byte-identical to a box that predates this ticket. Nothing here changes that
default.

### Diagnosis (read-only, works on any box with docker access — no opt-in required)

```bash
# Step-level rot (§3.1.2) — non-empty rows mean an active strategy's parent
# pointer leads outside its own live chain.
docker exec automata-hatchet-postgres-1 psql -U hatchet -d hatchet -c "
  SELECT c.id, c.step_id, c.expression, c.parent_strategy_id,
         p.id IS NULL AS parent_missing, COALESCE(p.is_active, false) AS parent_is_active,
         p.step_id AS parent_step_id
    FROM v1_step_concurrency c
    LEFT JOIN v1_step_concurrency p ON p.id = c.parent_strategy_id AND p.tenant_id = c.tenant_id
   WHERE c.is_active AND c.parent_strategy_id IS NOT NULL
     AND (p.id IS NULL OR NOT p.is_active OR p.step_id <> c.step_id)
   ORDER BY c.id;"

# Workflow-level rot (§3.1.4) — non-empty rows mean an active chain names a
# nonexistent or foreign-version child strategy.
docker exec automata-hatchet-postgres-1 psql -U hatchet -d hatchet -c "
  SELECT c.id, c.workflow_version_id, c.expression, c.child_strategy_ids, x.child_id
    FROM v1_workflow_concurrency c
    CROSS JOIN LATERAL unnest(COALESCE(c.child_strategy_ids, '{}'::bigint[])) AS x(child_id)
    LEFT JOIN v1_workflow_concurrency k ON k.id = x.child_id
           AND k.workflow_id = c.workflow_id AND k.workflow_version_id = c.workflow_version_id
   WHERE c.is_active AND k.id IS NULL
   ORDER BY c.id;"

# Leaked slots (§3.2) — a filled slot with no live runtime, or one owned by a
# dead worker generation.
docker exec automata-hatchet-postgres-1 psql -U hatchet -d hatchet -c "
  SELECT s.task_id, s.key, s.is_filled, r.worker_id, w.\"lastHeartbeatAt\"
    FROM v1_concurrency_slot s
    LEFT JOIN v1_task_runtime r ON r.task_id = s.task_id AND r.task_inserted_at = s.task_inserted_at
                                AND r.retry_count = s.task_retry_count AND r.evicted_at IS NULL
    LEFT JOIN \"Worker\" w ON w.id = r.worker_id
   WHERE s.is_filled;"

# Stuck-QUEUED tasks (§3.3) — QUEUED past the schedule-timeout half-life.
docker exec automata-hatchet-postgres-1 psql -U hatchet -d hatchet -c "
  SELECT external_id, workflow_run_id, inserted_at,
         EXTRACT(epoch FROM (now() - inserted_at))::int AS queued_for_s
    FROM v1_tasks_olap
   WHERE readable_status = 'QUEUED' AND inserted_at >= now() - interval '7 days'
   ORDER BY inserted_at;"
```

### Reading `scheduling-health.json`

Once maintenance is enabled the worker atomically writes
`<runNamespaceRoot>/scheduling-health.json` (default `/tmp/automata-agent-run/`) on
every tick. `healthy: true` means all detectors returned zero findings. Non-zero
`rot.stepLevel`/`rot.workflowLevel` or `slots.reclaimable` with `mode: "dry-run"` means
the box is corrupted or leaking but nothing has been written yet — this is expected
during the observation window (see Promotion below). A structured log line
(`event: "scheduling.rot_detected"` / `"scheduling.rot_repaired"` /
`"scheduling.slots_reclaimed"` / `"scheduling.stuck_queued"` / `"scheduling.tick_error"`
/ `"scheduling.tick_skipped_locked"`) is emitted to `worker.log` on every tick with a
non-empty finding.

### Recovery-latency bounds — alert on the ALERTABLE figure, not 5 minutes

```
nominal   = HATCHET_WORKER_DEAD_AFTER_S (600s) + HATCHET_MAINT_INTERVAL_S (60s)  ≈ 11 min
alertable = HATCHET_WORKER_DEAD_AFTER_S (600s) + 2 × HATCHET_MAINT_INTERVAL_S    ≈ 12 min
```

The alertable figure accounts for one lost `pg_try_advisory_lock` race between the two
launchd units (§3.4) — publishing the nominal figure as an ops alert threshold would
page on healthy contention. It is **not** 5 minutes, and it is **not** bounded by
`scheduleTimeout` (that gate was deliberately removed, §3.2.2). A box needing faster
recovery lowers `HATCHET_WORKER_DEAD_AFTER_S`, accepting a proportionally larger
network-partition hazard (§3.2.1).

### Opting in

```bash
# 1. Bring the engine up with the loopback-only maintenance overlay (never
#    edits docker-compose.hatchet.yml; a box that skips this stays port-free).
pnpm --filter @terragon/worker hatchet:up:maintenance

# 2. Point the worker at it and restart with SIGTERM + wait (never
#    `launchctl kickstart -k`, which is SIGKILL — see "Graceful restart" above).
echo 'HATCHET_ENGINE_DATABASE_URL=postgresql://hatchet:hatchet@127.0.0.1:55433/hatchet?sslmode=disable' \
  >> ~/.automata/worker-box.env
launchctl kill TERM gui/$UID/com.automata.worker
```

At this point `WORKER_SCHEDULING_MAINTENANCE` defaults to `dry-run`:
mechanisms 1 (rot repair) and 2 (slot reclaim) detect and log but never write.
Mechanism 3 (stuck-QUEUED detection) is read-only and on by default.

### Promotion procedure (dry-run → on)

1. Observe ≥24h of `scheduling-health.json`. Confirm the reported rot rows match a
   manual diagnosis query above and `slots.reclaimable = 0` on a healthy box.
2. Flip `WORKER_CONCURRENCY_ROT_REPAIR=on`, restart (SIGTERM + wait), confirm the
   one-time repair fires and subsequent ticks report `rot.repaired = 0`.
3. Flip `WORKER_SLOT_RECLAIM=on` **separately, at least a day later**, and only after
   reviewing the partition guard (§3.2.1) against this box's network reliability. A box
   on flaky connectivity should stay at `dry-run` indefinitely for this mechanism —
   detection still works, and the manual reclaim query above covers the rare real case.

### Kill switches (rollback)

Unset any of these and SIGTERM-restart — an untouched box (no `HATCHET_ENGINE_DATABASE_URL`)
is the strongest rollback available, since nothing runs at all:

| Env var | Effect when unset/off |
|---|---|
| `HATCHET_ENGINE_DATABASE_URL` | Master gate. Unset → all three mechanisms inert. |
| `WORKER_SCHEDULING_MAINTENANCE=off` | Mechanisms 1 & 2 fully disabled (no detect, no write). |
| `WORKER_CONCURRENCY_ROT_REPAIR=off` | Rot repair specifically disabled (detection via mechanism 3 unaffected). |
| `WORKER_SLOT_RECLAIM=off` | Slot reclaim specifically disabled. |
| `WORKER_STUCK_QUEUED_DETECT=off` | Read-only detection disabled (rarely needed). |

To roll back a repair that already happened: the repair only NULLs a dangling parent
pointer / strips dangling child ids — it never deletes a row or flips `is_active`.
Restarting the worker re-registers the workflow and mints a fresh chain; there is no
state to manually restore.
