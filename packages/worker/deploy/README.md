# Execution-plane worker — operator deploy assets

Repo-tracked launchd templates + runbook for the Automata `agent-run` worker on the
pilot Mac (enterprise-hardening Phase 3, gap #4). Real customer boxes get a systemd
unit; this is the dev-Mac launchd analog.

One unit is provided:

- `com.automata.worker.plist` — the worker unit.

It is a **template**. Replace the `__HOME__` and `__REPO__` tokens for the box,
then install to `~/Library/LaunchAgents/`.

**The concurrency tuple is ONE setting (#372).** `WORKER_BOX_SLOTS` (default 1)
agent-runs execute at a time on the box: engine `slots` on the single unit plus N
kernel slot locks (`src/agent-run/box-lock.ts`), one agent account per slot (#205;
`AGENT-UID-PROVISIONING.md` §6). `WORKER_GLOBAL_MAX_RUNS` (default 1) is the
engine's `'agent-run-global-memory-budget'` cap and `WORKER_PER_ORG_MAX_RUNS`
(default 1) the per-org fairness cap, both registered on every workflow VARIANT by
`src/agent-run/definition.ts` (the global key caps each variant separately and is
not the box budget; every run has `slotCost: 1`). The config loader refuses — at boot AND at every run — an explicit
`WORKER_GLOBAL_MAX_RUNS ≠ WORKER_BOX_SLOTS` (unset follows the slots), `WORKER_PER_ORG_MAX_RUNS > WORKER_GLOBAL_MAX_RUNS`, and N > 1
without the uid drop or the #204 ceiling. ONCE at boot (Linux, N > 1, ceiling on,
commit arm not inert: `WORKER_HEADROOM_COMMIT_FRACTION < 1`) the worker also
refuses `WORKER_BOX_SLOTS × WORKER_HEADROOM_RUN_COMMIT + 2 GiB base >
WORKER_HEADROOM_COMMIT_FRACTION × CommitLimit` — the #371 admission inequality with a fixed 2 GiB base, so it is a LOWER bound: a
tuple that fails to boot could never be admitted, while a tuple that boots can
still see its Nth run deferred when the live `Committed_AS` base is above 2 GiB
(2.6–3.5 GB idle on the pilot; the sizing in `deploy/uat/phase2-4.md` works the
runtime margin out). Run commit = `WORKER_RUN_MEMORY_MAX` by default, fraction
0.9; CommitLimit = swap + overcommit_ratio × RAM. Raise all of `WORKER_BOX_SLOTS`,
`WORKER_GLOBAL_MAX_RUNS`, `WORKER_PER_ORG_MAX_RUNS` together, with
`WORKER_RUN_MEMORY_MAX` and the swap sized for N runs; the memory-headroom check
(#371) is the runtime guard behind this boot guard. N > 1 is Linux-only.
Production tuple and derivation: `deploy/uat/phase2-4.md`.

## `run-worker.sh` wiring

The unit execs `~/.automata/run-worker.sh`. It MUST call the fail-closed auth gate
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
# #108 agent-uid mode ONLY: publish the just-built bundle where the agent uid can
# read it, so WORKER_DAEMON_DIST always matches the build. Own that ONE directory
# as the operator (`sudo chown $(id -un) /usr/local/automata/daemon`) so this
# needs no extra sudo grant.
if [ -n "${WORKER_AGENT_USER:-}" ]; then
  install -m 0444 dist/../../daemon/dist/index.js /usr/local/automata/daemon/index.js || exit 1
  # The launcher stages the bundle, so the launcher names it: without this the
  # worker runs the checkout's dist and the staged copy is dead weight.
  export WORKER_DAEMON_DIST=/usr/local/automata/daemon/index.js
fi
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

## Agent-uid mode (#108)

`WORKER_AGENT_USER` runs the agent child as a dedicated unprivileged role
account so the PF egress anchor can fence it without fencing the operator.
It is OFF by default — empty means byte-for-byte the behaviour above.

Host provisioning (role account, `/usr/local/automata` tree, sudoers, PF wrapper
conf + preflight/verify scripts + boot LaunchDaemon) and the verification gates
are in `AGENT-UID-PROVISIONING.md`. Two things that will otherwise bite:

- `WORKER_AGENT_USER` without `WORKER_WORKDIR_ROOT` is a hard boot failure. The
  default root is `os.tmpdir()` — 0700, owned by the worker's uid, untraversable
  by any other.
- `WORKER_NODE_BIN` must be node **≥22.21.0 (22.x) or ≥24.0.0**. The worker
  probes it at boot and refuses to start below that floor. The Linux box runs
  exactly `nodejs=24.21.0-1nodesource1`, held with `apt-mark hold`
  (`cloud-init.yaml`); see "Upgrading Node on a live box" below.
- `WORKER_RUN_MEMORY_MAX` (#204) is the per-run memory ceiling and **requires**
  `WORKER_AGENT_USER` plus the `automata-worker.service.d/10-ceiling.conf`
  drop-in; set without either, the worker refuses to boot.
- Memory-headroom admission (#371, Linux only; inert where `/proc/meminfo` is
  absent): a run is admitted under its slot only if `MemAvailable − reserved ≥
WORKER_HEADROOM_FLOOR` (default `1G`; `0` = inert) AND `Committed_AS +
reserved + WORKER_HEADROOM_RUN_COMMIT ≤ WORKER_HEADROOM_COMMIT_FRACTION ×
CommitLimit` (fraction default `0.9`; `1.0` = inert on that arm; run commit
  defaults to `WORKER_RUN_MEMORY_MAX`, else `1300M`; boot refuses a run commit above fraction × the box's `CommitLimit`, which no idle box could admit). A refusal gives the slot
  back and the run WAITS IN PROCESS (backoff ×2 from 2 s, capped at 120 s), then
  takes a slot and asks again, up to `WORKER_ADMISSION_MAX_DEFERRALS` times
  (default 8 = 366 s; the whole budget must fit the 12-minute deferral window —
  boot refuses otherwise); past the budget the run fails final. The task keeps
  `retries: 0`: the engine sees RUNNING throughout, never a retry (an engine
  retry would re-enter the per-PR supersede group as the newest item and cancel
  the genuinely newer run — measured). A waiting run keeps its engine slot
  (engine slots = `WORKER_BOX_SLOTS`), so during a shortage the box runs at
  most N − (deferred runs) agents and the engine's queue waits its 30 m
  scheduleTimeout; a sustained hog fails each dispatched run after the budget
  with the reason in its banner. The budget counts wall clock from the first
  refusal (slot re-acquire waits included). Journal lines `box.headroom_rejected` /
  `box.headroom_deferred_wait` / `box.headroom_ok` carry the decision and the
  three memory values.
  **Restart etiquette:** a deferred run holds NO run cgroup, box lock or run
  dir, so a cgroup-based "nothing in flight" check misses it; a restart issued
  during a deferral pauses the worker and BLOCKS in the SDK drain until that run
  is admitted-and-finished or fails final (up to the 12-minute budget), and a
  failure that ends the drain is redelivered to the next worker and re-executed.
  Before restarting: `systemctl list-jobs` (a pending stop = a drain in
  progress), the engine worker row (paused), and the journal for a `Task run
  starting` without a `completed`/`failed` in the last 30 minutes or a
  `box.headroom_deferred_wait` in the last 12.
  Rollback without a deploy: `WORKER_HEADROOM_FLOOR=0` and
  `WORKER_HEADROOM_COMMIT_FRACTION=1.0`.

## Engine-liveness watchdog (#215)

`WORKER_LIVENESS_STALE_S` is the number of seconds of engine-observed heartbeat
staleness after which the worker exits non-zero. It exists because the worker can
wedge _alive_: the SDK's gRPC connection to the engine breaks, it never reconnects
and never throws, and the process stays up — so the only honest signal is this
worker's own `Worker.lastHeartbeatAt` read back from the engine over REST.
It is OFF by default — unset means byte-for-byte the behaviour above, no timer
and no probe. Suggested starting value `900`.

`WORKER_LIVENESS_POLL_S` is the tick period, default `60`; it is only read when
the watchdog is on. Two things that will otherwise bite:

- `WORKER_LIVENESS_POLL_S` at or above `WORKER_LIVENESS_STALE_S` is a hard boot
  failure. A watchdog that ticks no more often than its own threshold cannot
  observe staleness, so the box would look guarded and be guarded by nothing.
- `WORKER_LIVENESS_STALE_S` below `300` is refused. An idle worker is not a
  wedged worker, and a hair-trigger restart-loops a healthy box.

Recovery is the unit's existing `Restart=always` / `RestartSec=15` — **nothing
needs adding on the systemd side**. An unreadable probe (network error, non-2xx,
an unexpected body, no row for this worker) is never a restart: it reads as
UNKNOWN for as long as it lasts, however long that is.

A worker is **unguarded for its first `WORKER_LIVENESS_STALE_S` of life** (15
minutes at the suggested `900`), and that is deliberate. The engine's `Worker`
row is minted inside `worker.start()`, not when the worker registers its
workflows, so for the first moments of every boot the only row under this
worker's name is the DEAD PREDECESSOR's — whose heartbeat, after exactly the
wedge this watchdog exists to catch, is staler than the threshold by
construction. Without the grace the new process would read its predecessor's
corpse, declare itself wedged and exit, and `Restart=always` would relaunch it
into the same verdict every `RestartSec` until the engine expired the row. The
grace is bounded by one threshold window: a process older than that which is
still reading a stale heartbeat does exit.

## Payload seal key (#380)

Every run's secrets — the GitHub installation token, the optional read-only
token, the daemon token, the owner's repo environment variables (`repoEnv`)
and the self-heal check/gate token — arrive in the Hatchet input **sealed** to
this plane's X25519 public key (AAD = a SHA-256 of the whole persisted input,
so a copied envelope cannot be re-triggered with any field changed), so the
engine's Postgres, its backups and the run API hold ciphertext only (ADR-003
F4, resolved). A key mismatch or a lost ring therefore blocks ALL of them: a
task run without its repo env is not a degraded run, it does not start. The private half is the ring in
`WORKER_PAYLOAD_SEAL_KEY_FILE` (default `/etc/automata/payload-seal.key`,
`{"keys":[…]}`, mode 0400, owned by the service user).

```bash
# On the box, as root (the worker must be idle — no run in flight):
cd /opt/automata-platform/packages/worker   # the checkout run-worker.sh uses
pnpm exec tsx scripts/gen-payload-seal-key.ts          # prints <kid>:<base64url>
systemctl restart automata-worker                      # boot log: "payload seal: 1 key(s) usable (<kid>)"
# Then on www:
wrangler secret put HATCHET_PAYLOAD_SEAL_KEY          # paste the printed line
```

The worker refuses to boot when the file is present but unparseable or any key
fails its own seal→unseal probe. During rollout step 1 an **absent** file is
tolerated (the worker then reads only the legacy plain-text input); strict mode
(PR 2) makes it mandatory and refuses plain-text inputs.

**Rotation, in this order:** (1) `gen-payload-seal-key.ts --rotate` adds a new
key at the FRONT of the ring and keeps the old one; (2) restart the worker with
no run in flight — the ring is read ONCE per process — and confirm the boot
line lists the new kid; (3) only then switch www's `HATCHET_PAYLOAD_SEAL_KEY`
to the printed line (a dispatch sealed to a kid the running worker has not
loaded fails `unknown-kid`); (4) retire the old entry only when ≥24h have
passed since the switch and no `hatchetRun` row dispatched before it belongs
to a non-terminal thread — edit the file and restart again. Compare the `kid`
www logs at dispatch (`run secrets sealed`) with the kid list in the boot line:
a mismatch shows up as `unseal failed (reason=unknown-kid|tag)` on the first
run and is reconciled by the sweep (`run-failed-unreported`). Every run also
journals `token.revoke {"kind":"installation"|"read","status":204}` at its end.

## Install

```bash
# Fill the template tokens for this box.
HOME_DIR="$HOME"
REPO="/absolute/path/to/automata-platform"
unit=com.automata.worker
sed -e "s|__HOME__|$HOME_DIR|g" -e "s|__REPO__|$REPO|g" \
  "$REPO/packages/worker/deploy/$unit.plist" \
  > "$HOME/Library/LaunchAgents/$unit.plist"

# Load the worker unit.
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.automata.worker.plist
```

Confirm it booted and shows the drain-contract log line
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

## Graceful restart (single unit) + deploy idle

There is only one unit and no standby, so a deploy is a single drain-and-relaunch,
not a rolling restart:

1. Pull + rebuild on the box (see "Daemon rebuild" — the worker consumes the daemon
   `dist/`).
2. Drain: `launchctl kill TERM gui/$UID/com.automata.worker`; poll for exit (see
   "Graceful restart" above). KeepAlive relaunches it on the new code.
3. Confirm it is back and healthy (drain-contract log line, no boot errors).

> **Deploy when idle.** With one unit and no standby, runs queued on OTHER workflow
> variants sit on their 30-minute `scheduleTimeout` (`definition.ts:171-172`) while
> this unit drains a long in-flight run — a long drain can leave them
> `SCHEDULING_TIMED_OUT`. Deploy when the box is idle, not mid-run.

> **A drained run's terminal can be redelivered (#386).** On SIGTERM the SDK
> (v1.26.0 `exitGracefully`) pauses the worker, stops its heartbeat and
> unsubscribes BEFORE it waits for in-flight runs; each run still sends its own
> COMPLETED/FAILED event before the drain ends. The engine can nevertheless hand the
> same workflow run (attempt 0) to the relaunched process — seen in prod when a
> run deferring on memory headroom failed five minutes into a drain. The worker
> therefore records every run id that reached a terminal in
> `<WORKER_RUN_NAMESPACE_ROOT>/run-terminals/` (kept 24h; `PrivateTmp=no` keeps
> it across a restart) and refuses a redelivered attempt of a recorded id with
> `RunAlreadyTerminalError` (journal: `redelivered attempt refused, not
> re-executed`) — no clone, no daemon. A run that never ended (worker crash
> mid-run, #152) has no entry and is re-executed as before. A deferring run
> (`box.headroom_deferred_wait`) holds the drain for up to its 12-minute budget,
> and has no cgroup yet, so a cgroup idle check does not see it.

> **Workflow version pinning caveat:** confirm in-flight runs stay on their registered
> workflow version across the swap before claiming zero-downtime. If unconfirmed,
> fully drain (step 2 wait) before the code changes take effect — do not overlap a
> code swap with a run mid-flight.

## Upgrading Node on a live box (Linux)

The box runs one exact NodeSource build, held with `apt-mark hold`. A major bump
is a maintenance window, not a deploy: apt swaps `/usr/bin/node` underneath the
running worker, so every run started afterwards gets its daemon and agent on the
new Node while the worker is still on the old one. **Stop the worker first.**

NodeSource publishes one repo per major, so once the repo is switched the old
major can no longer be installed from apt. Download the rollback package
**before** anything else:

```bash
# 0. rollback package, while the 22.x repo is still configured
install -d -m 0700 /var/lib/automata/rollback
cd /var/lib/automata/rollback && apt-get download nodejs=22.23.3-1nodesource1

# 1. idle check by cgroup (not by uid), then stop
ls /sys/fs/cgroup/automata-runs.slice/ 2>/dev/null   # no run-* dirs = idle
systemctl stop automata-worker      # 0s with nothing in flight; if it hangs
                                    # draining an empty box: systemctl kill -s SIGKILL automata-worker

# 2. switch the repo, install the exact build, hold it
apt-mark unhold nodejs || true
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource.sh && bash /tmp/nodesource.sh
apt-get install -y --allow-change-held-packages nodejs=24.21.0-1nodesource1
apt-mark hold nodejs

# 3. reinstall the checkout AS ROOT (node_modules is root-owned; as automata it breaks)
cd /opt/automata-platform && CI=1 pnpm install --frozen-lockfile; echo "exit=$?"

# 4. verify before starting
node -v && pnpm -v
runuser -u automata-agent -- /usr/local/bin/claude --version
systemctl start automata-worker
journalctl -u automata-worker -f    # "listening for actions" + liveness heartbeat
```

Then confirm one review run completes. Keep the window under the 30-minute
`scheduleTimeout` so queued runs do not expire.

**Rollback:** stop the worker, `dpkg -i /var/lib/automata/rollback/nodejs_22.23.3-1nodesource1_amd64.deb`,
`apt-mark hold nodejs`, repeat step 3, start. (Point `nodesource.sources` back at
`node_22.x` if apt should keep resolving 22.)

## Harness batteries on the execution box

gstack, GSD and ruflo (with its MCP server) are installed by the same root
`linux/install-batteries.sh` run as the review batteries, from
`harness.json` and the lockfiles under `batteries/<id>/`. The full runbook
(what lands where, how a pack is built, the production step, rollback, the
container drill) is "Harness batteries on the execution box" in
`deploy/PILOT-RUNBOOK.md`. The checks an operator runs:

```bash
automata-batteries doctor                 # human summary; exit 0 = every pack OK
automata-batteries doctor --json | jq '.ok, .harness, [.packs[] | {id, ok, stampValid, nodeAbiMatch}]'
automata-batteries verify-as-agent        # root: every check AS automata-agent,
                                          # incl. a sandboxed Chromium launch
cat /usr/local/lib/automata-batteries/harness.sha256   # absent = last harness install failed
```

A harness failure never invalidates the review batteries' `manifest.sha256`;
it only leaves `harness.sha256.invalid` behind.

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
a worker that stops heartbeating so a silently-dead unit is noticed before queued runs
hit their `scheduleTimeout`.

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

### Reading `box-budget.json`

The uid-scan reaper (#184, `uid-reaper.ts`) writes
`<runNamespaceRoot>/box-budget.json` after every non-skipped, non-errored scan
(boot, run admission, and run teardown), atomically, with the shape:

```json
{
  "ts": "2026-09-06T12:00:00.000Z",
  "phase": "boot" | "admission" | "teardown",
  "threadId": "…",   // optional — absent on boot scans (no run owns them)
  "scanned": 0,
  "killed": 0,
  "residual": 0,
  "failed": 0,
  "escapeesSinceBoot": 0
}
```

`scanned`/`killed`/`residual`/`failed` describe the agent-uid processes reaped
by that one scan; `escapeesSinceBoot` accumulates `killed` across every scan
since the worker started. The five macOS per-user launchd helpers
(`distnoted`, `lsd`, `csnameddatad`, `secd`, `contactsd`) are excluded from
every one of those counts — they respawn on demand and are not agent-run
state. `groups` (distinct pgids among the targets) and `helpers` (the excluded
helper count) appear only in the `box.escapees_reaped` log line, never in the
file.

Every non-skipped scan logs `box.escapees_reaped` with the same counts plus
`groups` and `helpers`. `box.escapees_residual` is logged only when
`residual > 0` after the scan's kill — **this is the operator's cue**: it
means the uid-wide `sudo -n -u _automata-agent -- /bin/kill -9 -- -1` did not
clear everything within its bound. `residual > 0` can also mean the residual
re-scan itself failed (a `box.escapees_scan_failed` with `stage: "residual"`
precedes it); in that case the pre-kill target list is reported conservatively
as `residual`, so the kill may well have landed — confirm with the `ps` below
before acting. The log line's `sample` lists up to five command basenames, not
pgids. The manual hatch: find their pgids with
`ps -axo pid,pgid,uid,comm | grep <name>` (or `pgrep -u _automata-agent -l`),
then `sudo -n -u _automata-agent /bin/kill -9 -- -<pgid>`. `box.budget_write_failed` means
the `box-budget.json` write itself failed (e.g. an unwritable
`runNamespaceRoot`) — the scan and kill still ran; only the file is missing.
`box.escapees_scan_failed` carries a `stage`: `scan` means `ps`, `id -u` or the
`WORKER_AGENT_USER` name check failed BEFORE the kill and nothing was killed;
`residual` means the kill WAS issued and only the post-kill re-scan failed, so
the pre-kill target list is reported conservatively as `residual` (see above);
`unexpected` is the belt-and-braces catch and may be either. Each enumerator
is bounded to 2 s (SIGKILLed on timeout) so a hung `ps` or a wedged directory
service surfaces here instead of holding the run's finally open.
`box.escapees_kill_failed` means the sudo kill could not be spawned (`failed: 1`
in the reaped line). `box.escapees_kill_nonzero` means the kill process exited
non-zero and carries `code`, `signal` and a `stderr` tail: an empty tail is
`kill`'s own ESRCH exit 1 (the set emptied under us, not a failure); a tail
matching `sudo:` / `password` / `not allowed` / `command not found` is a REFUSED
sudo (no NOPASSWD grant) — the signal was never sent, so that scan reports
`failed: 1`, `killed: 0` and `residual` = `scanned`; fix the sudoers grant, do not
hunt pgids. `box.escapees_scan_skipped` with `reason: "lock lost"` means the
run's box-lock helper died mid-run (a `box lock LOST by …` line precedes it), so
the teardown scan was NOT run — another run may already own the box and its
live agent would be collateral of a uid-wide kill; the next admission scan
reclaims instead. All of these are fail-open: the run continues, the box stays
single-flight, and the next phase re-scans.

When `WORKER_AGENT_USER` is empty, the boot log prints `box uid-scan
disabled: WORKER_AGENT_USER is empty` and no scan, lock, or `box-budget.json`
write happens at all.

### Recovery-latency bounds — alert on the ALERTABLE figure, not 5 minutes

```
nominal   = HATCHET_WORKER_DEAD_AFTER_S (600s) + HATCHET_MAINT_INTERVAL_S (60s)  ≈ 11 min
alertable = HATCHET_WORKER_DEAD_AFTER_S (600s) + 2 × HATCHET_MAINT_INTERVAL_S    ≈ 12 min
```

The alertable figure accounts for one skipped maintenance tick — a tick overlapping a
long previous tick loses the `pg_try_advisory_lock`, or a worker restart lands
mid-interval (§3.4) —
publishing the nominal figure as an ops alert threshold would page on healthy
contention. It is **not** 5 minutes, and it is **not** bounded by
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

| Env var                             | Effect when unset/off                                                    |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `HATCHET_ENGINE_DATABASE_URL`       | Master gate. Unset → all three mechanisms inert.                         |
| `WORKER_SCHEDULING_MAINTENANCE=off` | Mechanisms 1 & 2 fully disabled (no detect, no write).                   |
| `WORKER_CONCURRENCY_ROT_REPAIR=off` | Rot repair specifically disabled (detection via mechanism 3 unaffected). |
| `WORKER_SLOT_RECLAIM=off`           | Slot reclaim specifically disabled.                                      |
| `WORKER_STUCK_QUEUED_DETECT=off`    | Read-only detection disabled (rarely needed).                            |

To roll back a repair that already happened: the repair only NULLs a dangling parent
pointer / strips dangling child ids — it never deletes a row or flips `is_active`.
Restarting the worker re-registers the workflow and mints a fresh chain; there is no
state to manually restore.

## Engine dashboard hygiene (Linux box, hatchet-lite)

hatchet-lite seeds `admin@example.com` / `Admin123!!` and allows open self-registration.
Behind the `automata-hatchet` tunnel that is a public login to the production engine as
tenant OWNER — run inputs carry daemon and installation tokens, and an owner mints API
tokens. Found and closed on 2026-10-18; every new engine (a second tenant's stack, a box
rebuilt from cloud-init, an IT stack promoted) repeats these steps BEFORE its REST port is
tunnelled.

1. **Rotate the seed password.** The `/api/v1/users/password` route answers 403 for the
   seed user, so set the bcrypt hash directly (pgcrypto on the engine DB; `$2a$` is what
   Go's bcrypt expects), then invalidate every session:

   ```bash
   NEW="$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)"
   PG="docker exec -i automata-hatchet-postgres-1 psql -U hatchet -d hatchet -Atq"
   $PG -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"
   HASH="$($PG -c "select crypt('$NEW', gen_salt('bf', 10))")"
   $PG -c "update \"UserPassword\" set hash='$HASH' where \"userId\"=(select id from \"User\" where email='admin@example.com')"
   $PG -c "delete from \"UserSession\""
   umask 077; printf '%s' "$NEW" > /root/.automata/hatchet-admin.pass
   ```

2. **Rename the seed admin into the operator's domain** — the restriction below refuses
   an out-of-domain LOGIN too (verified on a throwaway stack), so this comes first:

   ```bash
   $PG -c "update \"User\" set email='ops@beautomata.com' where email='admin@example.com'"
   ```

3. **Restrict sign-up and login to the domain.** `docker-compose.hatchet.prod.yml` sets
   `SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS: beautomata.com`; apply it with the engine idle
   (no run cgroup with processes, see "Restart etiquette"):

   ```bash
   cd /opt/automata-platform/packages/worker
   docker compose -f docker-compose.hatchet.yml -f docker-compose.hatchet.prod.yml up -d hatchet-lite
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8888/api/v1/users/register \
     -H 'Content-Type: application/json' -d '{"email":"x@invalid.test","password":"Probe123!!probe","name":"p"}'   # not 200
   ```

   API tokens (www's `HATCHET_API_TOKEN`, the worker's `HATCHET_CLIENT_TOKEN`) are not
   email logins and keep working. The worker's gRPC session survives an engine restart
   only sometimes (see the liveness watchdog, #215); restart the worker afterwards if
   `box lock acquired` lines stop.
