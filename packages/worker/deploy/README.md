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
kernel slot locks (`src/agent-run/box-lock.ts`), each slot's run a container named
after its slot (#205, ADR-013). `WORKER_GLOBAL_MAX_RUNS` (default 1) is the
engine's `'agent-run-global-memory-budget'` cap and `WORKER_PER_ORG_MAX_RUNS`
(default 1) the per-org fairness cap, both registered on every workflow VARIANT by
`src/agent-run/definition.ts` (the global key caps each variant separately and is
not the box budget; every run has `slotCost: 1`). The config loader refuses — at boot AND at every run — an explicit
`WORKER_GLOBAL_MAX_RUNS ≠ WORKER_BOX_SLOTS` (unset follows the slots), `WORKER_PER_ORG_MAX_RUNS > WORKER_GLOBAL_MAX_RUNS`, and a box
without `WORKER_BATTERIES_IMAGE` or the per-run ceiling `WORKER_RUN_MEMORY_MAX` (every run is a
container, ADR-013). ONCE at boot (Linux, N > 1, ceiling on,
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
# Publish the just-built bundle where the rootless Docker daemon can read it (it
# is bind-mounted read-only into every run container), so WORKER_DAEMON_DIST
# always matches the build. The service account owns that ONE directory.
if [ -d /usr/local/automata/daemon ]; then
  install -m 0444 ../daemon/dist/index.js /usr/local/automata/daemon/index.js || exit 1
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

## Run isolation (ADR-013)

Every agent run, in every lane, is a fresh container from the pinned batteries image on the
rootless Docker daemon ("Container runs" below). The host-uid model (#108: a slot account per
run spawned through `sudo`, the nft/PF egress and loopback fences, a delegated cgroup per run,
the uid reaper, battery packs linked into a per-run HOME) was deleted by the ADR-013 release PR.
The box keeps its host provisioning (slot accounts, sudoers lines, nft tables, unit drop-ins,
the host battery tree) until the P4 cleanup, so reverting that PR is a pure redeploy.

- `WORKER_BATTERIES_IMAGE` (digest-pinned, already in the rootless daemon's store) and
  `WORKER_RUN_MEMORY_MAX` (`--memory`, no swap) are required; without either the worker
  refuses to boot. `WORKER_RUN_TASKS_MAX` (default 4096) is `--pids-limit`.
- The worker's own node (`nodejs=24.21.0-1nodesource1`, held with `apt-mark hold` by
  `cloud-init.yaml`) runs only the worker; the agent and its daemon run on the image's node.
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
  **Restart etiquette:** a deferred run holds NO container, box lock or run
  dir, so a container-based "nothing in flight" check misses it; a restart issued
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
automata-worker-safe-restart                          # boot log: "payload seal: 1 key(s) usable (<kid>)"
# Then on www:
wrangler secret put HATCHET_PAYLOAD_SEAL_KEY          # paste the printed line
```

The worker refuses to boot when the file is present but unparseable or any key
fails its own seal→unseal probe — and, since strict mode (#380 PR 2), also when
the file is **missing**: every input is sealed and plain-text inputs are refused,
so a worker without a usable ring cannot run anything. The boot line reads
`payload seal: N key(s) usable (<kids>) from <path> — strict: sealed inputs only`.

**Rollback order (strict ⇄ dual):** never run a strict www against a worker that
cannot unseal. To go back to the dual window, deploy the PR-1 www first (it
accepts an empty key), then the PR-1 worker; unset `HATCHET_PAYLOAD_SEAL_KEY`
only after the PR-1 www is live.

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

## Safe restart (Linux box) — drain first, never SIGTERM a busy worker

On the execution box every planned restart goes through
`automata-worker-safe-restart` (`deploy/linux/`, installed as root with
`install -m 0755 -o root -g root automata-worker-safe-restart /usr/local/sbin/`),
never a bare `systemctl restart automata-worker`:

```bash
automata-worker-safe-restart              # default drain budget 50 min
automata-worker-safe-restart --timeout-s 600
```

It pauses this box's worker in the engine (`scripts/drain-for-restart.ts`, the
same `isPaused` flag the SDK's own exit sets, minus the signal): no new
assignments, while runs in flight keep going and keep heartbeating. It waits
until the engine reports every slot free (a run waiting on memory headroom still
holds one), then runs `systemctl restart`. The SIGTERM then meets an idle worker,
so no drain outlasts the heartbeat window and the engine has nothing to
redeliver. The relaunched process registers a new worker row, unpaused. Runs
queued meanwhile wait (`REQUEUED_NO_WORKER`) and go to the relaunched worker.

It never restarts a worker that still holds a run: on timeout, an unreadable
engine, or Ctrl-C it unpauses the worker, leaves it running, and exits non-zero
(3 = still busy, 4 = not proven idle). Finding no active worker under this
box's name while the unit runs is also exit 4 — a `WORKER_BOX_ID` or namespace
mismatch, or a worker still registering right after a restart, reads the same.
Check the name, or pass `--allow-no-worker` when you know the worker is down. Proven against hatchet-lite in
`safe-restart.integration.test.ts`. This is what keeps a second box safe: with
two boxes the engine would hand a drained run to the OTHER box while this one
is still running it, which no ledger entry written at the end of a run can stop.

**Every other stop drains too.** The unit's `ExecStop=` runs the same drain
(`--for-stop`) before systemd sends the SIGTERM, so a bare `systemctl restart`
or `stop`, a reboot, or a package upgrade restarting the unit no longer
interrupts a run either. Unlike the wrapper it cannot refuse: it is best-effort
by design. It always exits 0, so a broken engine never wedges a stop or a
shutdown. At its 30-minute deadline it leaves the worker paused, and the
SIGTERM drain and the run-terminal ledger take over. Its `drain:` lines appear
in the unit's journal. A box whose installed unit predates this needs the unit
re-rendered (`sed` over `__USER__`/`__HOME__`/`__REPO__`, as in
AGENT-UID-PROVISIONING.md §7) and `systemctl daemon-reload`.

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
> COMPLETED/FAILED event before the drain ends. But once the drain outlasts the
> engine's heartbeat window the engine marks the run `REASSIGNED`, ignores the
> drained attempt's own event, and hands the same workflow run to the relaunched
> process (measured on hatchet-lite: a 5 s drain is not redelivered, 45 s is —
> `run-terminal-redelivery.integration.test.ts`). Seen in prod when a run
> deferring on memory headroom failed five minutes into a drain. The worker
> therefore records every run id that reached a terminal in
> `<WORKER_RUN_TERMINAL_ROOT>/run-terminals/` (kept 24h) and never re-executes a
> recorded id. In code `WORKER_RUN_TERMINAL_ROOT` defaults to the run namespace
> root under `/tmp`, which `PrivateTmp=no` keeps across a restart but Ubuntu's
> tmpfiles (`D /tmp`) wipes at boot, so on the execution box `run-worker.sh`
> defaults it to `/usr/local/automata/state` (worker-only, under the unit's
> `ReadWritePaths`, created by cloud-init and again by the launcher);
> `worker-box.env` may override it. Boot logs
> `[worker-boot] run-terminal ledger root=<path>` and warns when it is under
> `/tmp`. Of a recorded id, a run whose first attempt returned completes as a
> no-op (output `outcome: already-terminal`, engine COMPLETED, journal
> `redelivered attempt completed as a no-op`); one whose first attempt failed is
> refused with `RunAlreadyTerminalError` (engine FAILED, journal
> `redelivered attempt refused, not re-executed`). Either way no clone, no
> daemon, and one structured line
> `run.redelivery_refused {"runId","prior","priorAt","gapMs","action":"noop"|"refused"}`.
> After any restart with a run in flight, grep the unit's journal for
> `run.redelivery_refused`. First seen live 2026-10-22: a 41 s drain the engine
> REASSIGNED 29 s in, completed as a no-op. A run
> that never ended (worker crash mid-run, #152) has no entry and is re-executed as before. A deferring run
> (`box.headroom_deferred_wait`) holds the drain for up to its 12-minute budget,
> and has no cgroup yet, so a cgroup idle check does not see it.

> **Workflow version pinning caveat:** confirm in-flight runs stay on their registered
> workflow version across the swap before claiming zero-downtime. If unconfirmed,
> fully drain (step 2 wait) before the code changes take effect — do not overlap a
> code swap with a run mid-flight.

## Upgrading Node on a live box (Linux)

The box runs one exact NodeSource build, held with `apt-mark hold`. A major bump
is a maintenance window, not a deploy: apt swaps `/usr/bin/node` underneath the
running worker, so the worker would keep running on the old binary until its
next restart. **Stop the worker first.** (The agent and its daemon run on the
batteries image's own Node, ADR-013.)

NodeSource publishes one repo per major, so once the repo is switched the old
major can no longer be installed from apt. Download the rollback package
**before** anything else:

```bash
# 0. rollback package, while the 22.x repo is still configured
install -d -m 0700 /var/lib/automata/rollback
cd /var/lib/automata/rollback && apt-get download nodejs=22.23.3-1nodesource1

# 1. idle check (no run container on the box), then stop
docker -H unix:///run/automata-docker/docker.sock ps --filter label=automata.box --format '{{.Names}}'   # empty = idle
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
systemctl start automata-worker
journalctl -u automata-worker -f    # "listening for actions" + liveness heartbeat
```

Then confirm one review run completes. Keep the window under the 30-minute
`scheduleTimeout` so queued runs do not expire.

**Rollback:** stop the worker, `dpkg -i /var/lib/automata/rollback/nodejs_22.23.3-1nodesource1_amd64.deb`,
`apt-mark hold nodejs`, repeat step 3, start. (Point `nodesource.sources` back at
`node_22.x` if apt should keep resolving 22.)

## Container runs (ADR-013)

[ADR-013](../../../docs/adr/ADR-013-image-per-run-execution.md): every agent run, in every lane,
is a fresh container from the pinned batteries image on the rootless Docker daemon. It is the only
execution path; there is no switch. The worker refuses to boot unless the rootless daemon answers
and the pinned digest is already in its store; it then removes every run container a dead worker of
this box left behind (label `automata.box`).

| Variable                         | Default                            | Meaning                                                                                            |
| -------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `WORKER_BATTERIES_IMAGE`         | none (required)                    | `ghcr.io/be-automata/automata-batteries@sha256:<digest>`; a tag is refused. Never pulled by a run. |
| `WORKER_CONTAINER_DOCKER_SOCKET` | `/run/automata-docker/docker.sock` | The rootless daemon's socket (group `automata-docker`).                                            |
| `WORKER_RUN_MEMORY_MAX`          | none (required)                    | The slot tuple's ceiling, used as `--memory` and `--memory-swap`.                                  |
| `WORKER_RUN_TASKS_MAX`           | 4096                               | `--pids-limit`.                                                                                    |
| `WORKER_CONTAINER_CPUS`          | 2                                  | `--cpus`.                                                                                          |
| `WORKER_CONTAINER_TMP_SIZE`      | 512M                               | The `/tmp` tmpfs cap (counts against `--memory`).                                                  |
| `WORKER_CONTAINER_SHM_SIZE`      | 256M                               | `--shm-size` (counts against `--memory`).                                                          |
| `WORKER_CONTAINER_RUN_GID`       | unset (no hand-over)               | The rootless daemon user's primary gid: the run dir is handed to it (setgid, group rw).            |

The slot tuple (`WORKER_BOX_SLOTS=3`, `WORKER_GLOBAL_MAX_RUNS=3`, `WORKER_PER_ORG_MAX_RUNS=2`)
works unchanged, and `WORKER_AGENT_USER` is ignored: every run is a container. A container gets no
network (`--network none`); its only exits are the unix sockets the worker forwards into
`<runDir>/sock` (C3, #430), bridged inside the container to `127.0.0.1`: the egress proxy (every
lane, `:3128`), the git and gh brokers (non-review lanes, `:3129` and `http_unix_socket`) and the
box's test Postgres (opted-in repos, `:25432`). The daemon reaches www through the proxy.

The rootless daemon is installed by `deploy/provision-execution-box.sh` (below), which calls this
installer; run it directly only to inspect or re-check a box (root; idempotent):

```bash
packages/worker/deploy/linux/install-rootless-docker.sh --worker-user automata
packages/worker/deploy/linux/install-rootless-docker.sh --worker-user automata --check   # verify only
```

It creates `automata-runner` (no login, no sudo) with its own subuid/subgid range, the
`automata-docker` group (the worker joins it), cgroup v2 delegation for
`user@<uid>.service` (`Delegate=cpu cpuset io memory pids`), lingering, and the user unit
`linux/automata-runner-docker.service`. Then pull by digest, verify, and prove the limits, which
is the ADR-013 P0 blocker. The first published digest (C1) is
`sha256:d4c75aa6ecd404a5771c0ab441518b1def1ac569ea8f130c11afc90a5ca7d56f` (not `sha256:17c1197a…`,
which is its one-layer attestation manifest). It takes **12.5 GB** on disk per daemon store: the
rootless daemon keeps its own copy (data root `~automata-runner/docker`), so check `df` first and
drop any copy in the root daemon's store that nothing uses.

```bash
img=ghcr.io/be-automata/automata-batteries@sha256:d4c75aa6ecd404a5771c0ab441518b1def1ac569ea8f130c11afc90a5ca7d56f
uid=$(id -u automata-runner)
sudo -u automata-runner env XDG_RUNTIME_DIR=/run/user/$uid \
  docker -H unix:///run/automata-docker/docker.sock pull "$img"
sudo -u automata env DOCKER_HOST=unix:///run/automata-docker/docker.sock \
  deploy/images/batteries/verify.sh "$img"
sudo -u automata packages/worker/deploy/linux/prove-container-limits.sh \
  /run/automata-docker/docker.sock "$img"
```

`prove-container-limits.sh` prints one `PASS`/`FAIL` line per probe (memory OOM-kill, pids with a
control run, cpu throttling, and `docker rm -f` reaping a `setsid` child) and exits 0 only when all
pass.

### Provisioning a box: `deploy/provision-execution-box.sh` (ADR-013 P2)

One idempotent script brings a box to the container model (ADR-013 "Fleet"). It reuses
`install-rootless-docker.sh` for the daemon (it does not duplicate it) and does the steps above in
order: packages, rootless daemon, image pull **by digest** into the rootless store (a tag, or a
tag next to a digest, is refused with exit 2 before anything runs: the worker's own rule),
`gh attestation verify oci://…@sha256:… --repo be-automata/automata`, `verify.sh` as the worker
account, then it records the digest in `/etc/automata/batteries-image.state` (`CURRENT=`, and the
digest it replaces as `PREVIOUS=`) and keeps the previous digest pulled (it pulls it back if it is
gone, and never removes an image), so an image rollback is an env change. It skips that pull, with
a WARNING, when it would leave under `PREVIOUS_MIN_FREE_GB` (default 10) free in the rootless store:
two 12.5 GB images on the production box's 75 GB disk left 3.3 GB and `verify.sh` died with ENOSPC.
A rollback on such a box pulls the previous digest first. Root; from a checkout at
the revision being deployed:

```bash
img=ghcr.io/be-automata/automata-batteries@sha256:<digest>
# Production box, before the release (plan P2): rootless daemon + verified digest only.
sudo GH_TOKEN=<read-only token> deploy/provision-execution-box.sh --image "$img" --prepare-only
# Fresh box (throwaway, or a new fleet box): also the worker unit, launcher and env.
sudo GH_TOKEN=<read-only token> deploy/provision-execution-box.sh --image "$img"
# Either, reporting only:
sudo deploy/provision-execution-box.sh --image "$img" --prepare-only --dry-run
```

It prints one `ok|changed|skip <step> <detail>` line per step (installer and `apt` output go to
stderr) and stops at the first `FAIL <step> <detail>` with exit 1. A second run on the same box
prints only `ok` and `skip`. `--dry-run` changes nothing and reports what each step would change;
the read-only checks (attestation, `verify.sh`) still run when the image is already present.
Options: `--worker-user` (default `automata`), `--repo` (default: the checkout holding the script).

- **`--prepare-only`** (the production box until the release PR): the four `worker-*` steps print
  `skip`. No worker unit, launcher, env file, nft table, slot account, sudoers line or drop-in is
  touched, and the host path keeps running. The installer does add the worker account to
  `automata-docker` and to `automata-runner`'s group; a running worker picks those up only at its
  next restart, which it does not need before the release.
- **Full mode** also drops the host-uid fence's `/proc` hidepid (backs up `/etc/fstab`, removes the
  line, remounts `/proc`): under it the runner's user manager cannot see a container's
  subordinate-uid processes and no container starts. `--prepare-only` reports it and skips
  `verify.sh` instead. Full mode also checks the base bring-up (`node` >=22.21 on 22.x or >=24, and
  `pnpm`, from `cloud-init.yaml`: checked, not installed), renders `linux/run-worker.sh.template` to `~/.automata/run-worker.sh` and
  `linux/automata-worker.service` to `/etc/systemd/system/` (enabled, **never started or restarted**:
  restart the worker yourself at an idle moment), and sets three keys in
  `~/.automata/worker-box.env`, keeping every other line: `WORKER_BATTERIES_IMAGE`,
  `WORKER_CONTAINER_DOCKER_SOCKET` and `WORKER_CONTAINER_RUN_GID` (`automata-runner`'s primary gid).
  A new env file is created `0600` with only those keys: add the box's secrets and the slot tuple by
  hand. Where the #367 loopback fence is provisioned (`/etc/automata/loopback-nft.conf` and its
  loader), the rendered unit keeps its `ExecStartPre=+…nft-loopback-load.sh`; where it is not, the
  line is left out of the render (it would fail every start, and a container has its own loopback).
- **Never, in any mode:** nothing host-path is removed (accounts, sudoers, nft tables, drop-ins,
  battery trees: that is P4). The one host-fence change is `/proc` hidepid, full mode only (see Full mode).
- **No `gh` on the box:** the attestation step prints `skip` and a `WARNING` block on stderr saying
  provenance was **not** verified. Install `gh` and re-run before the first run uses the digest.
  `gh attestation verify` needs a token (`GH_TOKEN`; any read-only one).

### Security probes: `linux/container-security-probes.sh` (ADR-013, seven probes)

The script runs **inside** a run container as `agent` and prints one `PASS|FAIL|SKIP <n> <name>
<detail>` line per probe; it exits non-zero if any probe fails. A probe that cannot gather its
evidence fails rather than passes:

| n   | name                 | expected                                                                                                                                                          |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `egress-denied`      | `CONNECT` to `--denied-host` (default `example.org`) through the run's proxy (`127.0.0.1:3128`) refused with 403; no interface but `lo`, no route, no direct dial |
| 2   | `engine-unreachable` | `7077`/`8888` on loopback, `10.0.2.2`, `172.17.0.1`, `169.254.169.254` and every `--host-addr` (×7077/8888/22) refuse or are unreachable                          |
| 3   | `userns-mapping`     | container root maps to `--runner-uid` (`automata-runner`), `agent` to a subordinate uid (≥ 100000)                                                                |
| 4   | `no-capabilities`    | `CapEff`, `CapPrm`, `CapBnd`, `CapAmb` zero; `NoNewPrivs` 1                                                                                                       |
| 5   | `readonly-rootfs`    | rootfs dirs `EROFS`; `/workspace`, `HOME`, `/opt/flutter`, `/tmp`, `/dev/shm` writable                                                                            |
| 6   | `review-no-write`    | review lane: `/run/automata` holds only `daemon.sock` and `egress-proxy.sock`, no GitHub token in any env or file in reach, `git push --dry-run` fails. Else SKIP |
| 7   | `run-isolation`      | pid 1 is the container's init, no host/worker process visible, only the run's own mounts, no `--peer` token visible anywhere in reach                             |

The lane comes from `--lane` or the container's `AUTOMATA_RUN_LANE`. Two checks are host-side by
nature: probe 1's audit row and probe 7's two containers started together.

**Scope choice: there is no probe lane in the worker yet.** ADR-013 says the worker "can launch [the
probes] as a run of a dedicated probe lane"; a real lane touches dispatch, lane resolution and the
run path, which is larger than P2. The host-side driver below gets the same evidence: it runs the
script inside the containers the worker itself built (preferred: real argv, real proxy, real broker
sockets), or in a standalone container that mirrors `src/agent-run/container-argv.ts`.

**Driver A, live runs (all seven).** On any container-path box (every box after the release), start a
review run and a task run at the same time (two slots), then, while both containers are up:

```bash
d() { sudo -u automata docker -H unix:///run/automata-docker/docker.sock "$@"; }
d ps --filter label=automata.box --format '{{.Names}} {{.Label "automata.lane"}} {{.Label "automata.run"}}'
# For each container, with the OTHER run's id as --peer:
d exec -i <name> bash -s -- --runner-uid "$(id -u automata-runner)" --host-addr <box public IP> \
  --peer <other run id> --allow-url https://api.anthropic.com \
  < packages/worker/deploy/linux/container-security-probes.sh
```

`docker exec` inherits the container's user, groups, capabilities and namespaces, so the script
stands exactly where the agent stands. It reads the run's proxy URL (and its proxy credential, never
printed) from the run's own processes, as the agent could. Then the audit half of probe 1, against
the database the www app writes (`start=` is printed on the script's first line):

```sql
select run_id, destination_host, action, mode, created_at from egress_events
 where destination_host = 'example.org' and created_at >= '<start>' order by created_at;
-- expect one action='deny', mode='enforce' row per probed container
```

**Driver B, standalone (probes 2-7, no live run needed).** Mirrors the run argv (labels and
`--log-driver none` left out so `docker run` can print). There is no worker proxy here, so probe 1
is left to driver A (`--only 2,3,4,5,6,7`). Both containers run at once and each names the other as
its peer; `--self` proves each looked at its own workspace:

```bash
img=ghcr.io/be-automata/automata-batteries@sha256:<digest>
gid=$(id -g automata-runner)
sudo install -d -m 0755 -o automata -g automata /var/tmp/automata-probe
probe_run() { # NAME SELF PEER LANE
  local dir=/var/tmp/automata-probe/$1
  sudo -u automata install -d -m 2770 -g "$gid" "$dir" "$dir/sock"
  sudo -u automata git clone -q https://github.com/<test-org>/<test-repo>.git "$dir/repo"
  echo "$2" | sudo -u automata tee "$dir/repo/.automata-probe-token" >/dev/null
  sudo -u automata chgrp -R "$gid" "$dir/repo" && sudo -u automata chmod -R g+rwX "$dir/repo"
  sudo -u automata docker -H unix:///run/automata-docker/docker.sock run --rm -i \
    --name "automata-probe-$1" --pull never --init --network none --cap-drop ALL \
    --security-opt no-new-privileges --read-only --user 10001:10001 --workdir /workspace \
    --memory 1500m --memory-swap 1500m --pids-limit 4096 --cpus 2 \
    --tmpfs /tmp:rw,nosuid,nodev,size=536870912,mode=1777 --shm-size 268435456b \
    --mount "type=bind,src=$dir/repo,dst=/workspace" \
    --mount "type=bind,src=$dir/sock,dst=/run/automata" \
    --mount type=bind,src=/opt/automata-platform/packages/daemon/dist/index.js,dst=/opt/automata-daemon/index.js,readonly \
    --mount type=volume,dst=/home/agent --mount type=volume,dst=/opt/flutter \
    --mount type=volume,dst=/opt/somnio-ai-tools/agent-rules/adapters \
    --group-add 0 --env AUTOMATA_RUN_LANE="$4" --entrypoint /bin/bash "$img" \
    -s -- --only 2,3,4,5,6,7 --runner-uid "$(id -u automata-runner)" --host-addr <box public IP> \
    --self "$2" --peer "$3" < packages/worker/deploy/linux/container-security-probes.sh
}
probe_run a probe-run-aaaa1111 probe-run-bbbb2222 review >a.out 2>&1 &
probe_run b probe-run-bbbb2222 probe-run-aaaa1111 review >b.out 2>&1 &
wait; cat a.out b.out; sudo rm -rf /var/tmp/automata-probe
```

A green P2 (and the post-release check) is driver A with every line `PASS` (probe 6 `SKIP` on the
task container), plus the `deny` rows.

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
dead sibling worker's orphaned daemons. The #215 engine-liveness watchdog restarts a
wedged worker that stops heartbeating (`WORKER_LIVENESS_STALE_S`). The #373 growth
triggers below alert on capacity signals, but they run inside the worker process and
need days of data, so they cannot page on a dead worker. Gap #7 (alerting on a silently
dead unit before queued runs hit their `scheduleTimeout`) stays open.

### Growth triggers (#373)

An in-process evaluator that checks five signals every interval and POSTs a webhook
when one crosses its threshold. Each trigger authorizes exactly one move:

- `queue_wait_p90` — daily queue-wait p90 > 600 s on each of the last 7 complete UTC
  days → raise the cap, then resize CX43 (cap 6) / CX53 (cap 8). It measures the ENGINE
  queue only: a run that ended before it started (cancelled, timed out) counts its whole life as wait, but a run
  deferred by the #371 headroom check or parked on a #205 box slot is already running on
  the engine, so that wait is not seen (and counts as run time). A quiet trigger is not
  proof the box keeps up; read the `box.headroom_*` journal lines alongside it.
  POLICY WAITS ARE INCLUDED: the engine rows do not say why a run waited, so a wait
  behind the per-org cap (`WORKER_PER_ORG_MAX_RUNS`) or a PR's per-PR maxRuns key counts
  the same as a wait for box capacity. On a single-tenant box, or one busy PR, the p90
  can therefore rise from policy rather than capacity. Check the per-org caps before
  acting on "raise the cap": when `WORKER_PER_ORG_MAX_RUNS` is below
  `WORKER_GLOBAL_MAX_RUNS` and one org holds the queue, raising the global cap moves
  nothing.
- `ram_swap` — RAM above the fraction, or continuous swap-in, sustained for the sustain
  window → add a second shared box on the same tenant. Swap-in counts only at a real
  rate: `pswpin` must rise on every sample of the window AND average at least
  `SWAP_IN_MIN_PAGES_PER_S` = 10 pages/s (Δpswpin ÷ Δt over the sustained window, ~40 KiB/s
  at 4 KiB pages). A trickle of a page or two per sample is cold pages coming back, not a
  box short of RAM.
- `client_share` — one client > 40 % of attributed run time (needs ≥ 3 orgs holding run
  time: on a two-org box one org is always ≥ 50 %, so it never fires) → split that client
  to its own box. Reads `unknown` while more than 5 % of run time is
  unattributed (see below). The 24 h hold is per org: each org over the threshold is
  announced once per 24 h, so a different org is announced as its own split, and two
  orgs trading the top spot are announced once each, not on every swap. An exact tie
  goes to the lower orgId. Its `cleared` text names the orgs announced in the last 24 h
  (`no longer over for org-a, org-b`), not just whichever org is on top at the clear.
- `scale_composite` — any two of: > 5 clients, > 100 PRs/day, the enterprise
  questionnaire → start the per-run sandbox path.
- `supersede_waste` — cancelled run time > 20 % of all run time → revisit the default
  supersede policy. Only review-lane cancels count (`lane=review`): task, pr and self-heal
  cancels and laneless pre-#373 rows are excluded from the numerator. A review-lane cancel
  counts whatever caused it, so a user Stop of a review run counts too. Like `queue_wait_p90` it reads engine timestamps, so a run superseded
  while deferred by #371 or parked on a #205 box slot counts that wait as waste although
  no agent compute ran. On a busy box, check `queue_wait_p90` and the `box.headroom_*`
  lines before reading a high ratio as a policy problem (follow-up #409).

**A saturated box can keep `ram_swap` and `queue_wait_p90` both quiet.** Agent runs have
`memory.swap.max=0`, so they never page, and the #371 headroom check defers a new run
before RAM fills, so utilisation plateaus under the fraction. The deferred run is already
running on the engine, so its wait is not engine queue wait either. The pressure shows
up only as deferrals: read the `box.headroom_rejected` / `box.headroom_deferred_wait`
journal lines alongside both triggers before concluding the box has room.

| Knob                                   | Default | Notes                                                 |
| :------------------------------------- | :------ | :---------------------------------------------------- |
| `WORKER_ALERT_WEBHOOK_URL`             | unset   | Unset = OFF, silent, nothing else is read. See below. |
| `WORKER_GROWTH_TRIGGER_INTERVAL_S`     | 300     | Floor 30, ceiling 43200 (half the sustain ceiling).   |
| `WORKER_GROWTH_TRIGGER_SUSTAIN_S`      | 900     | Floor 60, ceiling 86400; must be ≥ 2 × interval.      |
| `WORKER_GROWTH_TRIGGER_RAM_FRACTION`   | 0.70    | 0 < x < 1.                                            |
| `WORKER_ENTERPRISE_QUESTIONNAIRE`      | unset   | `1` turns on the composite's manual arm.              |
| `WORKER_GROWTH_TRIGGER_TENANT_SIGNALS` | `on`    | `on` or `off`; anything else refuses boot. See below. |

The sustain ceiling is the 24 h dedupe window: a window longer than a day could not be
announced inside the window that holds its re-fire. The interval ceiling is derived from
it: sustain must be ≥ 2 × the interval and is capped at 86400, so 43200 is the largest
interval that can boot, and a larger one is refused with that reason.

`WORKER_ALERT_WEBHOOK_URL` must be `https:`. Plain `http:` is accepted only when the
host is a loopback literal (`127.0.0.0/8`, `::1`) or a private IPv4 literal
(`10/8`, `172.16/12`, `192.168/16`) — the URL is a credential and must not cross a
network in cleartext. Any hostname, `localhost` included, is refused over `http:`: a name
goes through the resolver. Use https, or the IP literal. A URL with credentials before the
host (`https://user:pass@host/…`, or just `user@`) is refused too: fetch rejects such a URL,
so every alert would fail. Put the sink's token in the path or query instead. The refusal
names the knob and the rule, never the URL.

A bad knob refuses boot (`FATAL: growth triggers are configured but cannot be armed`).
Under `Restart=always` that is a crash loop which stops every run lane on the box, not
just the alerts, so validate the knobs before restarting — from `packages/worker`, with
the new env exported:
`pnpm exec tsx -e 'import("./src/agent-run/growth-trigger-config.ts").then((m) => { m.loadGrowthTriggerConfig(process.env); console.log("growth knobs ok"); })'`
throws on exactly the value boot would refuse (it prints no knob values: the URL is a
credential).
The webhook body is `{text, trigger, value, threshold, authorizedMove, boxId, firedAt,
state}` with `state` `fired` or `cleared`; `text` is a one-line summary, so the same URL
works for a Slack incoming webhook or ntfy. A trigger that stays over re-fires at most
once per 24 h (per org for `client_share`; sooner only when a recorded fire time lies in
the future — a clock that stepped back never extends the hold), and one `cleared` notice
is sent when it drops back under. The 24 h hold still applies after a `cleared`: an over
again within the day is not re-announced, and the snapshot carries the live verdict. A
failed POST is not recorded and is retried next tick; `growth.webhook_failed` is logged
once per (trigger, state, reason) streak — a tick with no transition for that trigger
ends the streak — and `growth.webhook_recovered` on the next delivery.
A POST that TIMES OUT is backed off, since a sink that accepts late may already have
posted it: after the k-th consecutive timeout of the same transition the next attempt
waits 2^(k−1) ticks (attempts 1, 2, 4, 8, … ticks apart), capped at 1 h (12 ticks at the
default 300 s interval; every tick when the interval is ≥ 1 h). The alert is never
dropped: it stays pending until delivered. The backoff resets on delivery, on a failure
that is not a timeout, when no transition is pending any more, and when the pending
state flips (a pending `fired` becomes a pending `cleared`, or back). A tick that runs
out of its budget before POSTing keeps the backoff as it was. Other failures (non-2xx,
unreachable, redirect) retry every tick.

The engine read covers exactly the window: `since` = 00:00 UTC seven days ago and
`until` = 00:00 UTC today, so today's partial day is never paged in. Because the window
only moves at 00:00 UTC, the engine is re-read at most hourly: a tick reads it when the
window changed (the first tick of a new UTC day) or the last successful read is ≥ 3600 s
old, and otherwise re-evaluates the cached rows. RAM/swap is still sampled every tick. A
failed read leaves the cache's age as it was, so the next tick retries (and that tick's
run triggers read `unknown`). A malformed read is `unknown` too, never `under`: a run row
(`actionId` ending `:run`) the reader cannot place in time, or a non-empty page none of
whose rows has the engine's row shape, makes the whole read unreadable (`engine read:
malformed run row` / `engine read: no recognizable row on a page`) instead of silently
dropping rows — a window with rows missing would read low and could clear a firing
trigger. Non-run rows (`:on-failure-task`) are still skipped.

State lives in `<WORKER_RUN_NAMESPACE_ROOT>/growth-triggers.json` (mode 0640, written
atomically every tick, and again right after each delivered alert so a worker that dies
mid-tick does not resend it on restart). With the default root (`/tmp/automata-agent-run`)
the file does not survive a reboot, since `/tmp` is cleared, so a trigger may re-fire once
after a reboot, and a pending `cleared` is lost. Non-review runs dispatched before the
#373 www deploy carry no org tag and count as `unattributed` (review runs have carried
`orgId` and `lane=review` since #127); the client signals are meaningful only once the window holds 7 complete
UTC days of tagged runs — up to 8 calendar days after the www deploy. The attribution gate enforces that: while more than 5 % of the window's run
time is unattributed, `client_share` and the scale composite's clients arm read
`unknown` (the share and the unattributed figures are still in the snapshot). The
composite then fires only if the other two arms hold, and reads `unknown` when the
clients arm could decide it.

**One box per tenant sends tenant alerts.** The four run-based triggers
(`queue_wait_p90`, `client_share`, `scale_composite`, `supersede_waste`) read the whole
engine TENANT, not this box's runs. With more than one box on a tenant, every box
evaluates the same rows and would send identical alerts. Set
`WORKER_GROWTH_TRIGGER_TENANT_SIGNALS=off` on every box but one per tenant, and keep
`WORKER_ALERT_WEBHOOK_URL` set on all of them, so each box keeps its own `ram_swap` alert
(which is per box). With `off` the box neither resolves nor reads the engine; the four
run-based triggers read `unknown` with reason `tenant signals off on this box` (no fire,
no clear — a trigger restored as firing stays firing) and the snapshot is still written
every tick. The webhook URL is a secret: it is never logged — keep it in
`worker-box.env`, never in the unit file or the repo.

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

### Run containers instead of `box-budget.json`

The uid-scan reaper and its `box-budget.json` were deleted with the host-uid path (ADR-013 P3):
every process of a run lives in its container's pid namespace, so `docker rm -f` kills all of it,
`setsid` escapees included. What replaces the scan's lines: `container.predecessor_removed` (a
redelivered run removed the container still holding its slot's name), `container.removed` /
`container.remove_retry` / `container.teardown_failed` at teardown, and the boot line's
`orphan container(s) removed` count. To list what is on the box:
`docker -H unix:///run/automata-docker/docker.sock ps -a --filter label=automata.box=<box id>`.

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

## Provisioning a tenant (#374)

A dedicated tenant on this box's engine for one org (or one repo), so its runs never share
the default tenant. `provision:tenant` creates the tenant on an admin session and mints an
API token scoped to it with the image's own `hatchet-admin`; `deploy/bind-hatchet-tenant.ts`
then points www at it.

**Loopback + ssh only.** The tool dials the engine on a loopback literal (anything else is
refused before the credential file is opened), reads the admin password from
`/root/.automata/hatchet-admin.pass` (refused unless a regular file, owned by the running
uid, mode 0600/0400, not a symlink), and adds no listener. Never route it through the
tunnel. The admin must already be renamed into the domain (above); until then pass
`HATCHET_ADMIN_EMAIL=admin@example.com`.

```bash
# as root, on the box
cd /opt/automata-platform
OUT="$(pnpm -s --filter @terragon/worker provision:tenant --name 'Client A' --slug client-a \
  --token-name www --expires-in 8760h)"            # stdout: {"tenantId","token","expiresAt"}
TENANT="$(printf '%s' "$OUT" | jq -r .tenantId)"
# mint-only, into an existing tenant (e.g. a worker token for #375):
pnpm -s --filter @terragon/worker provision:tenant --tenant-id "$TENANT" --token-name box-2
```

`-s` matters: without it pnpm prints its script header on stdout ahead of the JSON. The
token is printed once and never logged; keep it in a shell variable, never a file in the
repo. Tokens expire (`expiresAt`, default one year; `hatchet-admin`'s own default is 90
days): re-mint and re-bind before then.

Scope check, with the new token (`T`): the tenant's own windowed collection answers 200
with zero rows; the default tenant answers 403.

```bash
SINCE="$(date -u -d '-1 hour' +%FT%TZ)"
for t in "$TENANT" 707d0855-80ab-4e1f-a156-f1c4546cbf52; do
  curl -s -o /dev/null -w "$t %{http_code}\n" -H "Authorization: Bearer $T" \
    "http://127.0.0.1:8888/api/v1/stable/tenants/$t/workflow-runs?since=$SINCE&limit=1&only_tasks=true"
done
```

Bind from a machine that holds the prod `DATABASE_URL` and `ENCRYPTION_MASTER_KEY`; the
token travels over ssh into an env var, never through argv or a terminal:

```bash
HATCHET_TENANT_API_TOKEN="$(ssh root@<box> "$PROVISION_COMMAND" | jq -r .token)" \
  pnpm exec tsx deploy/bind-hatchet-tenant.ts <orgSlug> <owner/repo|'*'> "$TENANT"
```

A tenant with no worker enrolled queues its runs until #375 enrolls one. Rollback: delete
the binding row (the org returns to the default tenant); drain the bound tenant first.
