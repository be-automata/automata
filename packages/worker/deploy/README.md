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
