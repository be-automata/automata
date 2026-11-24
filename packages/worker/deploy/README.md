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

## Run telemetry and the stuck-agent stop (spike 032, #546)

Both are box settings, OFF by default. The agent never chooses where its telemetry goes.

**Telemetry.** `sudo deploy/linux/install-run-telemetry.sh` installs two hardened services bound to
loopback. The collector runs as a `DynamicUser`. Maple runs as the static `automata-telemetry` user,
because `DynamicUser` symlinks the state dir and Maple refuses a symlinked data dir. Both releases are
pinned and verified by sha256 before extraction:

- `automata-otel-collector` (otelcol-contrib 0.162.0) listens on `127.0.0.1:4320`. It **deletes
  `user.email`, `user.id`, `user.account_id` and `user.account_uuid`** before storing anything:
  Claude Code exports the credential owner's identity on every record, even with prompts off.
- `automata-maple` (Maple local v0.3.2, FSL-1.1, internal use only) stores the telemetry on
  `127.0.0.1:4318`. For the UI, run `ssh -L 4318:127.0.0.1:4318 <box>`.

Then set `WORKER_RUN_OTLP_URL=http://127.0.0.1:4320` and restart with `automata-worker-safe-restart`.
Every run container, review lane included, gets `otel-collector.sock` bridged to its loopback `:4318`.
The OTel export is set in the run's **user settings `env`**, because a settings `env` block beats
the process env, so env-only config is silently overridden.

| What leaves a run                                                                       | What never does                                       |
| :-------------------------------------------------------------------------------------- | :---------------------------------------------------- |
| Tokens, cost, TTFT and model per request                                                | Prompt text (`OTEL_LOG_USER_PROMPTS=0`, pinned)       |
| Tool name, success/failure and duration per call                                        | File contents                                         |
| A `claude_code.interaction` trace per turn; a failed call is `Error: ShellError`        | Command arguments (`OTEL_LOG_TOOL_DETAILS=0`, pinned) |
| `automata.run_id` (threadChatId), `automata.thread_id`, `automata.lane`, `automata.org` | Account identity (deleted by the collector)           |

`WORKER_RUN_OTLP_URL` must be `http://<loopback>:<port>` with no credentials or path. Anything else
refuses boot.

**Stuck-agent stop (#546).** The daemon counts consecutive failed tool calls. It runs in two modes:

- **Observe** (`WORKER_TOOL_FAILURE_STREAK_LIMIT` unset or `0`, the default). The streak is logged at
  5, 10, 15, and so on.
- **Stop** (an integer from 3 to 100). At that streak the run ends with an error result naming the
  streak and the last tool, the same way the idle watchdog ends it.

The limit is written to the run env after the repo env, and `TOOL_FAILURE_STREAK_LIMIT` is a reserved
repo-env key, so an owner cannot lift it. A `grep` with no match or a failing test also counts as a failure.

**Production value: 12** (`automata-exec-1`, since 2026-11-02). It was measured, not guessed:

- **Working agents.** Across 894 real Claude Code sessions (≥ 20 tool calls each, 166,500 calls, 6,423
  failed), the longest run of consecutive failed calls in any session was **6**: p50 1, p99 3, none at 10
  or more. 12 is twice that maximum.
- **Drill on the box** (issue #551). The agent was told to run 15–30 failing `ls` calls, one per call:

  | Limit | Result                                    |
  | :---- | :---------------------------------------- |
  | 25    | the agent stopped by itself at 22, no cut |
  | 10    | cut, with 9 failures recorded             |
  | 3     | cut after the first turn, 14 s            |

  A killed run loses its last telemetry batch, so expect limit − 1 recorded failures.

Re-check the value against the telemetry (`claude_code.tool_result` `success` per run, in Maple) when run
types change.

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

## Cell session continuation (#743)

The `cellSessionContinuation` feature flag (default **off**, admin page, per user) gates the whole
feature for a cell task run: the worker copies the Claude session transcript out of the cell after
each turn (redacted in the worker), restores it into the next cell, saves unfinished work to the
work branch on a timeout, and www continues a timed-out run once in a new cell. The flag reaches the
worker in the pulled message (`featureFlags`), so a change applies from the next run with no
restart. Off: no capture, no restore, no continuation. A follow-up in a new cell then starts with
`sessionId: null` and a note instead of the silent `--continue`.

What it needs, once, before the flag goes on anywhere:

1. The migration `2026-11-25-cell-session-checkpoint.sql` is applied (`migrate.yml` on green main).
2. www and the worker are deployed with the flag off (the worker through
   `automata-worker-safe-restart`). This release also raises onFailure's typed-terminal wait to
   150 s and its execution timeout to `"4m"`.
3. **R2 retention (OQ-5).** Checkpoints live in the private bucket (`automata-private`) under the
   `cell-sessions/` prefix and nothing deletes them. Add a lifecycle rule that expires the prefix
   after 30 days, from a machine logged in to the Cloudflare account:

   ```bash
   wrangler r2 bucket lifecycle add automata-private cell-sessions-30d cell-sessions/ --expire-days 30
   wrangler r2 bucket lifecycle list automata-private   # confirm the rule
   ```

   A restore after expiry finds a missing blob, starts fresh and says so.

4. Run `R2_CONFORMANCE=remote` once against a throwaway bucket and record the result on #743.

Turn the flag on for the test org's user first, run the AC-8 UAT from the spec, then widen it.

**Rollback.** Turn the flag off on the admin page: the next run does no capture, restore or
continuation, and checkpoints left behind are inert. To go back further, redeploy the previous
worker (onFailure returns to 120 s / `"3m"`) and the previous www; the tables stay, unused. Remove
the lifecycle rule with `wrangler r2 bucket lifecycle remove automata-private cell-sessions-30d`
only if the prefix should be kept.

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
automata-worker-safe-restart              # default drain budget 75 min
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
shutdown. At its 70-minute deadline (4200 s, under the unit's `TimeoutStopSec=4500`;
raised from 30 minutes with the task lane's 60-minute run budget, #742) it leaves the worker paused, and the
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
select thread_id, destination_host, action, mode, created_at from egress_events
 where destination_host = 'example.org' and created_at >= '<start>' order by created_at;
-- expect one action='deny', mode='enforce' row per probed container;
-- thread_id is the worker's run id (automata.run label); run_id holds the constant 'legacy-thread-chat-id'
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

### Scheduled evidence renewal: `linux/box-evidence-probes.sh` (ADR-014 evidence upkeep)

Box evidence expires 30 days after it is measured (ADR-014 decision 3), and an expired profile is
denied `evidence_expired`. A weekly systemd timer re-runs driver B and lets www renew the
`automata-box/observe` evidence:

- `automata-box-evidence.timer` fires Sundays 04:00 UTC (plus up to 30 min of jitter), and with
  `Persistent=true` a run missed while the box was down fires on the next boot.
- `automata-box-evidence.service` (oneshot, root, no `Restart=`) runs `box-evidence-probes.sh`. It runs
  driver B exactly as above, with the image pinned in `WORKER_BATTERIES_IMAGE`, fresh random
  `--self`/`--peer` tokens and a 600 s bound per container. Then it posts the verdict lines of both
  containers to `POST <www>/api/internal/profile-evidence/box`.
- www decides what the lines prove (`packages/shared/src/model/box-evidence.ts`).
  - A full pass is exactly one `PASS` for each of probes 2 to 7 in both containers, and nothing
    else. It writes the five observe capabilities as new `conformance` rows, `trigger: "schedule"`.
  - Anything else writes nothing and posts an ops alert (`OPS_ALERT_WEBHOOK_URL`). The unit also
    exits non-zero, so it shows in `systemctl --failed`.
  - A report dated more than 2 h in the past or 5 min in the future is refused, because
    `measured_at` sets `expires_at`.
- Driver B does not measure probe 1, so the timer never renews `automata-box/enforce`. That profile
  still needs driver A until probe 1 runs against the enforce proxy on its own.
- Every day at 13:00 UTC, the hourly www cron posts an ops alert listing each profile whose earliest
  current evidence expires within 7 days, or that has none.

Install (once per box, as root). The secret is a new random value, set on both sides. It is
dedicated: never reuse `INTERNAL_SHARED_SECRET` or a worker credential. It lives in a root-only
file, not in `worker-box.env`, so the worker and the agent uid never hold it:

```bash
# 1. www (from a machine logged in to the Cloudflare account; reads the value from stdin)
npx wrangler secret put PROFILE_EVIDENCE_SECRET --name automata-www
# 2. the box, same value, typed or piped; never on a command line
install -d -m 0700 /etc/automata
( umask 077; cat > /etc/automata/profile-evidence.env ) <<'ENV'
AUTOMATA_WWW_URL=https://<www host>
PROFILE_EVIDENCE_SECRET=<value>
ENV
# 3. the units, from the deployed checkout
install -m 0644 /opt/automata-platform/packages/worker/deploy/linux/automata-box-evidence.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now automata-box-evidence.timer
# 4. prove it: a dry run posts nothing; a real run renews and prints the new expiry
/opt/automata-platform/packages/worker/deploy/linux/box-evidence-probes.sh --dry-run
systemctl start automata-box-evidence.service && journalctl -u automata-box-evidence -n 30 --no-pager
```

Run it when the box is idle (no `automata.box` containers): the two probe containers take up to
2 x 1500 MB and 2 CPUs while they run. Rotation: write the new value to the box file first, then
`wrangler secret put`. A run that lands in the gap fails loudly, and the evidence lasts 30 days.

## Image cleanup (automata-image-gc.timer)

Each new image pin leaves the previous image on disk: 12.6 GB per batteries
image, 13-17 GB per cell image. On 2026-11-24 old images, leaked run dirs and
battery backups filled the box disk to 100%, and every run failed with
`No space left on device`. `image-gc.sh` runs daily as root and removes, on
each daemon, only the images of one repository that nothing pins:

| Daemon                                         | Repository           | Kept                                                                                                           |
| ---------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/run/automata-docker/docker.sock` (runner)    | `automata-batteries` | `CURRENT` and `PREVIOUS` from `/etc/automata/batteries-image.state`, and the worker's `WORKER_BATTERIES_IMAGE` |
| `/run/automata-opensandbox-docker/docker.sock` | `automata-cell`      | the worker's `WORKER_OPENSANDBOX_GUEST_IMAGE`                                                                  |

With no pin found for a daemon, that daemon is skipped. `docker rmi` runs
without `--force`, so Docker refuses to remove an image that a container
still uses. Install, or update after a pull:

```bash
sudo install -m 0755 packages/worker/deploy/linux/image-gc.sh /usr/local/sbin/automata-image-gc.sh
sudo install -m 0644 packages/worker/deploy/linux/automata-image-gc.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now automata-image-gc.timer
sudo /usr/local/sbin/automata-image-gc.sh --dry-run   # what it would remove now
journalctl -u automata-image-gc                        # what it removed
```

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

Two engine-side defects were diagnosed as able to wedge the box's single agent-run slot:
**concurrency-group rot** (a broken link between a workflow-level strategy and its
step-level strategies — tasks sit `QUEUED` forever with an idle worker) and **SIGKILL
slot exhaustion** (a worker killed without drain never releases its
`v1_concurrency_slot` row). See `docs/plans/69-scheduling-deadlock-recovery.md` for the
design.

**Rot is detection only (#570).** The #69 rot detectors and the rot repair read the
link columns against the wrong tables, so they flagged healthy workflow-level
strategies and the repair would have broken them. The detectors now resolve links the
way the engine does, and the repair was removed: nothing the worker runs writes to
`v1_step_concurrency` or `v1_workflow_concurrency`. No real rot mechanism has been
shown; a non-empty rot finding is worth an engineer's look, not an automatic fix.

### Everything here is OFF by default

`HATCHET_ENGINE_DATABASE_URL` unset is the master gate: a box that only ever runs
plain `hatchet:up` has no published engine-DB port to point it at, never sets the URL,
and is byte-identical to a box that predates this ticket. Nothing here changes that
default.

### Diagnosis (read-only, works on any box with docker access — no opt-in required)

```bash
# Step-level rot (#570) — a step strategy's parent_strategy_id is a
# v1_workflow_concurrency id (hatchet v1-core.sql). Non-empty rows mean an active
# step strategy whose parent does not exist in its own workflow version.
docker exec automata-hatchet-postgres-1 psql -U hatchet -d hatchet -c "
  SELECT c.id, c.step_id, c.expression, c.parent_strategy_id
    FROM v1_step_concurrency c
   WHERE c.is_active AND c.parent_strategy_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM v1_workflow_concurrency w
                      WHERE w.workflow_id = c.workflow_id
                        AND w.workflow_version_id = c.workflow_version_id
                        AND w.id = c.parent_strategy_id)
   ORDER BY c.id;"

# Workflow-level rot (#570) — child_strategy_ids are v1_step_concurrency ids.
# Non-empty rows mean an active workflow strategy names a child that is not a
# step strategy of the same version pointing back at it.
docker exec automata-hatchet-postgres-1 psql -U hatchet -d hatchet -c "
  SELECT c.id, c.workflow_version_id, c.expression, c.child_strategy_ids, x.child_id
    FROM v1_workflow_concurrency c
    CROSS JOIN LATERAL unnest(COALESCE(c.child_strategy_ids, '{}'::bigint[])) AS x(child_id)
   WHERE c.is_active
     AND NOT EXISTS (SELECT 1 FROM v1_step_concurrency s
                      WHERE s.workflow_id = c.workflow_id
                        AND s.workflow_version_id = c.workflow_version_id
                        AND s.id = x.child_id
                        AND s.parent_strategy_id = c.id)
   ORDER BY c.id;"

# Reverse link (#570) — an active step strategy whose parent does not list it in
# child_strategy_ids. The engine compares that array's size when it releases a
# workflow slot. Neither detector checks this; run it by hand when rot is suspected.
docker exec automata-hatchet-postgres-1 psql -U hatchet -d hatchet -c "
  SELECT c.id, c.parent_strategy_id, w.child_strategy_ids
    FROM v1_step_concurrency c
    JOIN v1_workflow_concurrency w ON w.workflow_id = c.workflow_id
     AND w.workflow_version_id = c.workflow_version_id AND w.id = c.parent_strategy_id
   WHERE c.is_active
     AND NOT (c.id = ANY(COALESCE(w.child_strategy_ids, '{}'::bigint[])))
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
`slots.reclaimable` with `mode: "dry-run"` means the box is leaking slots but nothing
has been written yet — this is expected during the observation window (see Promotion
below). Non-zero `rot.stepLevel`/`rot.workflowLevel` is never repaired automatically;
see the note on rot at the top of this section. A structured log line
(`event: "scheduling.rot_detected"` /
`"scheduling.slots_reclaimed"` / `"scheduling.stuck_queued"` / `"scheduling.tick_error"`
/ `"scheduling.tick_skipped_locked"`) is emitted to `worker.log` on every tick with a
non-empty finding.

`rot.repaired` is always `0` and `rot.mode` is never `on`: rot is detection only (#570).
A box that resolves `WORKER_CONCURRENCY_ROT_REPAIR` to `on` (directly, or by inheriting
`WORKER_SCHEDULING_MAINTENANCE=on`) runs it as `dry-run` and logs
`scheduling.rot_repair_removed` once at boot.

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
mechanism 2 (slot reclaim) detects and logs but never writes. Mechanism 1 (rot) only
ever detects (#570).
Mechanism 3 (stuck-QUEUED detection) is read-only and on by default.

### Promotion procedure (dry-run → on)

1. Observe ≥24h of `scheduling-health.json`. Confirm `slots.reclaimable = 0` on a
   healthy box, and that any reported rot rows match the diagnosis queries above. There
   is no rot step to promote: rot repair was removed (#570).
2. Flip `WORKER_SLOT_RECLAIM=on` **separately, at least a day later**, and only after
   reviewing the partition guard (§3.2.1) against this box's network reliability. A box
   on flaky connectivity should stay at `dry-run` indefinitely for this mechanism —
   detection still works, and the manual reclaim query above covers the rare real case.

### Kill switches (rollback)

Unset any of these and SIGTERM-restart — an untouched box (no `HATCHET_ENGINE_DATABASE_URL`)
is the strongest rollback available, since nothing runs at all:

| Env var                             | Effect when unset/off                                         |
| ----------------------------------- | ------------------------------------------------------------- |
| `HATCHET_ENGINE_DATABASE_URL`       | Master gate. Unset → all three mechanisms inert.              |
| `WORKER_SCHEDULING_MAINTENANCE=off` | Mechanisms 1 & 2 fully disabled (no detect, no write).        |
| `WORKER_CONCURRENCY_ROT_REPAIR=off` | Rot detection disabled (mechanism 1 never writes since #570). |
| `WORKER_SLOT_RECLAIM=off`           | Slot reclaim specifically disabled.                           |
| `WORKER_STUCK_QUEUED_DETECT=off`    | Read-only detection disabled (rarely needed).                 |

A box that ran the removed rot repair with `on` before #570 may hold real breakage it
caused (a step strategy with `parent_strategy_id` set to NULL, or a workflow strategy
with step ids stripped from `child_strategy_ids`). The workflow-level diagnosis query
above shows the first case (the workflow row whose child no longer points back); the
reverse-link query shows the second. Whether a worker restart
re-registers fresh strategies was never tested against this case (#570); treat a box
that ran the repair with `on` as needing an engineer.

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

**Loopback + ssh only.** The tool dials the engine on a loopback IP literal (`127.0.0.1` or
`[::1]`; anything else, `localhost` included, is refused before the credential file is
opened), reads the admin password from `/root/.automata/hatchet-admin.pass` (refused unless
a regular file owned by the running uid, mode 0600/0400, not a symlink), refuses redirects,
and adds no listener. Never route it through the tunnel. The admin must already be renamed
into the domain (above); until then pass `HATCHET_ADMIN_EMAIL=admin@example.com`.

Run it **once**, from the operator's machine, and keep its output in a variable there —
every run of the create form makes a new tenant:

```bash
BOX=root@138.201.174.63
OUT="$(ssh "$BOX" 'cd /opt/automata-platform && pnpm -s --filter @terragon/worker \
  provision:tenant --name "Client A" --slug client-a --token-name www --expires-in 8760h')"
TENANT="$(printf '%s' "$OUT" | jq -r .tenantId)"
printf '%s' "$OUT" | jq -r .expiresAt              # re-mint and re-bind before this
```

`-s` matters: without it pnpm prints its script header on stdout ahead of the JSON line
`{"tenantId","token","expiresAt"}`. Progress (the tenant id as soon as it exists) goes to
stderr; the token is printed once and never logged — keep it in a variable, never a file in
the repo. Expiry defaults to one year (`hatchet-admin`'s own default is 90 days). If the
mint fails after the tenant was created, the error names the tenant and the mint-only
re-run:

```bash
ssh "$BOX" 'cd /opt/automata-platform && pnpm -s --filter @terragon/worker \
  provision:tenant --tenant-id <tenantId> --token-name www'     # also #375's worker tokens
```

Scope check: the token reads its own tenant's windowed collection (200, zero rows) and is
refused on the default tenant (403):

```bash
T="$(printf '%s' "$OUT" | jq -r .token)"
ssh "$BOX" 'read -r T; SINCE=$(date -u -d "-1 hour" +%FT%TZ)
  for t in '"$TENANT"' 707d0855-80ab-4e1f-a156-f1c4546cbf52; do
    curl -s -o /dev/null -w "$t %{http_code}\n" -H "Authorization: Bearer $T" \
      "http://127.0.0.1:8888/api/v1/stable/tenants/$t/workflow-runs?since=$SINCE&limit=1&only_tasks=true"
  done' <<<"$T"
```

Bind from a machine that holds the prod `DATABASE_URL` and `ENCRYPTION_MASTER_KEY` (the
token stays in the environment, never argv):

```bash
HATCHET_TENANT_API_TOKEN="$T" pnpm exec tsx deploy/bind-hatchet-tenant.ts \
  <orgSlug> <owner/repo|'*'> "$TENANT"
```

A tenant with no worker enrolled queues its runs until #375 enrolls one. Rollback: delete
the binding row (the org returns to the default tenant); drain the bound tenant first.

## OpenSandbox cells (ADR-014, #656)

The box hosts the OpenSandbox server that runs remote cells. It listens on `127.0.0.1:8090`
only, drives a **dedicated rootless Docker daemon** (account `automata-opensandbox`, socket
`/run/automata-opensandbox-docker/docker.sock`, mode 0600, no shared group, so the worker
account cannot reach it), and is reached from outside only through a Cloudflare tunnel behind
Access. The P0 probe proved the rootless daemon enforces egress on x86_64 / Ubuntu 24.04
(34/34, `docs/specs/656/gate-log-g.md`). All commands run as root on the box.

The order below secures the hostname **before** it is tunnelled (the rule from "Engine
dashboard hygiene": a tunnelled service with no auth gave the public an owner login). Do not
reorder steps 3 to 6.

### 1. Install on the box

```bash
cd /opt/automata-platform/packages/worker/deploy/linux
./install-rootless-docker.sh --profile opensandbox     # the dedicated rootless daemon
./install-opensandbox.sh                               # images by digest, key file, server unit
./install-opensandbox.sh --check                       # read-only; exit 1 on any FAIL
```

`install-opensandbox.sh` runs the daemon profile itself, so the first line is only for
inspecting that step alone. The API key is generated once into `/etc/automata/opensandbox.env`
(root:root, 0600, one `OPENSANDBOX_API_KEY=<hex>` line) and never printed. The server unit
takes it through `LoadCredential=` and renders its config (the only place the key is written
out, mode 0600) to `/var/lib/automata-opensandbox/run/config.toml` with
`render-opensandbox-config.sh`; the unit removes that file when it stops. The installer also
adds the drop-in `/etc/systemd/system/automata-worker.service.d/opensandbox.conf` (the repo
file `automata-worker-opensandbox.conf`: `LoadCredential=` for the same key file), so the
key is in no other file and in no process environment. It does **not** restart the worker:
the worker takes the credential at its next `automata-worker-safe-restart`. A box without
OpenSandbox has no drop-in and its worker unit is unchanged.

### 2. Pre-pull the cell image (optional, by digest)

```bash
./install-opensandbox.sh --pull-cell-image <registry/name@sha256:...>
```

A tag exits 2. The pull is refused when the store's filesystem has less than 20 GB free
(`CELL_IMAGE_MIN_FREE_GB`). The image is about **12.5 GB on disk** in a third image store
(the runner daemon and the rootful daemon each hold their own; no layers are shared across
daemons). The cell's ready timeout is 60 s, which a cold pull cannot meet, so pre-pull
before the first cell. Decide with the owner before doing this on the production box: the
80 GB disk has already run out once with two copies.

### 3. Access app and service token (first)

In Cloudflare Zero Trust, create a self-hosted Access application on the server hostname with
**exactly one policy: action Service Auth, including one service token.**

- Do **not** add an Allow policy or an identity provider. Either one makes Access answer a
  token-less request with a 302 to the login page instead of a 403.
- Note the application's **AUD** tag, and keep the token's id and secret out of the repo and
  out of command lines (they are PR-C's Worker secrets, step 9).

### 4. Tunnel ingress rule with `access.required`

In `/etc/cloudflared/config.yml`, before the catch-all, path-fenced to the reconciler's
routes (everything else on the hostname, including `/proxy/` and any exec path, gets 404):

```yaml
- hostname: <host>
  path: ^/(health|sandboxes(/[^/]+(/(networkpolicy|credential-vault))?)?)$
  service: http://127.0.0.1:8090
  originRequest:
    access:
      required: true
      teamName: <team>
      audTag: ["<AUD>"]
- hostname: <host>
  service: http_status:404
```

`access.required` makes cloudflared reject, at the origin, any request without a valid
Access JWT, so a deleted or misconfigured Access app does not open the hostname (two locks).
Ingress cannot filter by method, so `POST /sandboxes` passes the fence; Access, the API key
and `access.required` still apply. A method filter would need a Worker or WAF rule.

### 5. Validate, then restart the connector

```bash
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://<host>/sandboxes/x/proxy/44772/ping   # must pick the 404 rule
systemctl restart cloudflared-automata-hatchet.service
```

### 6. DNS route last

```bash
cloudflared tunnel route dns automata-hatchet <host>
```

Until this step the hostname resolves nowhere, so no unauthenticated window opens.

### 7. Checks (AC-12)

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<host>/health
```

Without any token this must print exactly `403` with an empty redirect URL. **A 302 (any
redirect URL) is a FAIL**: step 3 left a login path open; remove it before going on.

With the two `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers (read them from your
secret store into the shell, never type them inline):

- no API key, `GET /sandboxes` returns 401;
- with the API key too, `GET /sandboxes?metadata=automata%3Dcell` returns 200;
- `…/sandboxes/x/proxy/44772/ping` returns 404.

### 8. Conformance evidence (before `OPENSANDBOX_URL`, #709)

`cell-plan` refuses every cell with `egress_not_enforced` until the `opensandbox/runc` profile
has unexpired `conformance` evidence. The evidence comes from the `OPENSANDBOX_IT` live suite
(a throwaway OpenSandbox in a privileged dind on the host's rootful Docker, about 5 minutes),
and `push-evidence.sh` reports it to www. Without this step the first cell run fails, as it did
on 2026-11-19.

**Renewal rule.** The evidence lasts **30 days from the run**: re-run within 30 days of the
last run. Push within **24 h** of the run, because www refuses an older report
(`measured_at_out_of_window`), and run it from a checkout with no local changes, because www
refuses a `-dirty` platform sha. The weekly timer below does both.

Needs `/etc/automata/profile-evidence.env` and the `PROFILE_EVIDENCE_SECRET` www secret, the
same pair as "Scheduled evidence renewal" above (install them first if that section has not
run on this box):

```bash
cd /opt/automata-platform/packages/worker/deploy/linux
# 1. install-opensandbox.sh installs automata-cell-evidence.{service,timer} and enables the
#    timer once profile-evidence.env exists: re-run it after creating that file
./install-opensandbox.sh
./install-opensandbox.sh --check      # cell-evidence-unit and cell-evidence-timer lines: ok
# 2. the plan: read-only checks (config, clean checkout, free disk, idle); runs and pushes nothing
./opensandbox-evidence-renew.sh --dry-run
# 3. the first push, now
systemctl start automata-cell-evidence.service
journalctl -u automata-cell-evidence -n 20 --no-pager   # ends: renewed: rows=9 expiresAt=<instant>
```

Prove it read-only:
`SELECT capability, measured_at, expires_at FROM profile_evidence WHERE profile_id = 'opensandbox/runc' ORDER BY measured_at DESC LIMIT 9;`
shows rows measured minutes ago. Once step 9 sets the URL,
`curl -s https://<www host>/api/health/cell-evidence` answers `{"status":"ok",...}`.

The timer, `automata-cell-evidence.timer`:

- runs on Wednesdays at 04:00 UTC (up to 30 min later), so it never overlaps the Sunday box
  evidence; `Persistent=true` fires a run missed while the box was down at the next boot;
- skips, with one `skip:` line and exit 0, while a cell exists on the OpenSandbox server
  (metadata `automata=cell`), while a hand-run IT is up (an `osbit=1` container, which `up.sh`
  would remove), or while another renewal holds the lock. The check runs once, at the start:
  a cell that starts during the run is unaffected, because the IT uses its own dind;
- fails, and stays `failed` in `systemctl --failed`, on a missing config, a dirty checkout,
  under 10 GB free in the Docker root, an IT failure or a refused push;
- keeps the IT output in `/var/lib/automata-cell-evidence/last-it.log` (root, 0600). The journal
  gets fixed lines, counts, the host, `expiresAt` and enum codes, never a secret.

Alerting. www's hourly cron logs `[cron:cell-evidence]`: an error line while the evidence
expires within 7 days or `cell-plan` would refuse, an `ok` line otherwise, nothing while cells
are off. `GET /api/health/cell-evidence` (public, read-only, no secret) answers the same status,
and the Synthetic workflow's `cell-evidence` job keeps one issue labelled `cell-evidence` open
while it is `expiring` or `refused`, then closes it on the first `ok`. The job fails (red run,
no issue) while the endpoint does not answer 200 with a `status`, so deploy www before the
workflow change reaches `main`, or expect red runs until it is deployed. Count the effect in the
`[daemon cell-plan]` log lines with outcome `egress_not_enforced`.

### 9. www secrets (PR-C's code reads the Access ones)

Every value goes through `wrangler secret put … --name automata-www` on stdin, never on a
command line. `opensandboxConfigured()` turns the cell plane on once both URL and key are
non-empty, so set them in this order:

1. the two Access secrets, `OPENSANDBOX_ACCESS_CLIENT_ID` and `OPENSANDBOX_ACCESS_CLIENT_SECRET` (the service token's id and secret). Both must be set before `OPENSANDBOX_URL`: a half-set pair keeps the reconciler off, with one `[cell] OpenSandbox Access config is incomplete or the URL is not https` warn line;
2. `OPENSANDBOX_GUEST_IMAGE` (the cell image digest);
3. `OPENSANDBOX_API_KEY`, streamed from the box:
   `ssh <box> sudo sed -n 's/^OPENSANDBOX_API_KEY=//p' /etc/automata/opensandbox.env | npx wrangler secret put OPENSANDBOX_API_KEY --name automata-www`;
4. **last**, `OPENSANDBOX_URL=https://<host>`, and only after step 7 passes and step 8
   recorded the evidence.

The per-user flag `opensandboxCells` and the per-org switch (`organization.cells_enabled`, #708) still gate `cell-plan`.

### 10. Worker

The worker reads three names (PR-E): `WORKER_OPENSANDBOX_URL`,
`WORKER_OPENSANDBOX_API_KEY_FILE` and `WORKER_OPENSANDBOX_GUEST_IMAGE`.

- The launcher exports the first two only when `$CREDENTIALS_DIRECTORY/opensandbox.env`
  exists and is non-empty: the file path, and `http://127.0.0.1:8090` unless `worker-box.env`
  overrides it. That credential comes from the drop-in
  `automata-worker.service.d/opensandbox.conf` that `install-opensandbox.sh` installs. On a
  box without OpenSandbox there is no drop-in, so no credential and nothing is exported, and
  the unit boots as before. PR-E fails closed when `WORKER_OPENSANDBOX_API_KEY_FILE` is
  unset; the launcher does not decide it.
- Set `WORKER_OPENSANDBOX_GUEST_IMAGE` (digest-pinned; a tag is refused) in `worker-box.env`.
- Re-render the worker unit and launcher, `systemctl daemon-reload`, then restart with
  `automata-worker-safe-restart`. The worker picks up the drop-in's credential only on that
  restart (the installer never restarts it).

What the worker does with them (#656 PR-E):

- **`cells_unconfigured`.** The cell marker follows www's gate (the `opensandboxCells` flag and the org switch),
  not the worker's box. With the flag on, a marked run on a worker whose three names are unset
  or invalid (a partial set, a key file that is not exactly one `OPENSANDBOX_API_KEY=<hex>`
  line, a non-loopback `http:` URL, a tag-only image) fails closed with `cells_unconfigured`
  before any www or provider call. It **never falls back to the box**. With the flag off there
  is no marker and the run takes the box path unchanged. The key file is read per marked run,
  so a rotated key needs no restart, and the boot line reports only which names are present
  (`cells: off` or `cells: env present (...)`).
- **Rollout (R7), org by org (#708).** A run is marked for a cell only when www has OpenSandbox
  configured, the run owner's `opensandboxCells` flag is on **and** the run's org has cells on
  (`organization.cells_enabled`, default off, set by an admin at `/internal/admin/organizations`).
  One account can own the automations of many orgs, so the flag alone no longer moves every org
  at once: switch on only the orgs whose runs land on a box with the OpenSandbox server installed
  and the three names set. A marked run that lands on any other box fails `cells_unconfigured`.
  The switch is read on every dispatch and every cell-plan call, so it applies on the next run
  without a deploy. Switching an org off does not reroute a run already marked: its cell-plan
  call answers `cells_disabled` and the run fails closed (no box fallback); new runs take the
  box. Rollback: switch the org off, or unset `OPENSANDBOX_URL` for every org.
  **Upgrading to #708:** every org starts off, so the www revision that ships the org gate turns
  cells off for every flagged user until an admin switches their org on, and a run marked by the
  old revision then fails `cells_disabled`. Deploy it while no cell run is in flight (or with
  the flag off), then switch on, at `/internal/admin/organizations`, the orgs that already ran
  cells.
- **One box per deployment.** Cells are supported on one box per deployment only. On one box
  the attempts of a run never overlap (systemd stops the old worker before the new one starts,
  and a redelivery waits in-process). Across two boxes attempt _n_ and _n+1_ can overlap, and
  only www's `superseded` lease fence and the cell TTL (75 min, #742) cover it. Do not run cells on
  two boxes of one deployment.
- **Poll interval.** A marked run refuses with `cell_poll_interval_too_long` when
  `WORKER_POLL_INTERVAL_MS` is over 75 s (a quarter of the 5-min lease window).
- **Deploy order: www first, then the worker.** www's `lease: "superseded"` answer and the
  reconciler's lease rule (`CELL_RECONCILE_STALE_MS` = 5 min) are safe alone: no cell exists
  until a PR-E worker runs one. A worker against a www without `superseded` would read a real
  fence as a revocation and fail loudly. The first cell run is also the first retired token
  (PR-D).

### What a cell may reach (#705)

`cell-plan` compiles every cell's egress from named bundles (ADR-014,
`packages/shared/src/model/cell-egress.ts` and `cell-egress-catalog.ts`). The cell's policy is
default-deny, HTTPS on 443 only (`:80` is denied on every host), exact hosts only (no
wildcards), at most 100 entries.

- **Always:** the platform bundle, which holds the broker (the www public host) and
  `api.anthropic.com`.
- **The repo's allowlist,** when its `egress_policy` is `domain`: every operator entry of
  `repo_review_settings.egress_allowlist` becomes a per-run bundle
  `repo/<owner>__<name>@<hash>`. The entries pass the box's own validator first, so a cell can
  only reach what the box would allow. `none` and no policy give the platform bundle only.
- **`ip_port` repos stay on the box** (OD-1). The cell policy is domain-based, so dispatch never
  marks such a run for a cell, and `cell-plan` refuses one with `409 egress_level_unsupported`.
- **A set the cell cannot express also stays on the box.** That covers a wildcard such as
  `*.example.com`, a port other than 443 and anything over the cap. Dispatch leaves the run
  unmarked (one log line, `[hatchet] cell egress refused`), and `cell-plan` refuses with
  `409 egress_compile_failed` and a `reason` (`egress_wildcard`, `port_not_443`,
  `too_many_entries`, …) before it opens a step.
- **A setting changed after dispatch fails the run.** Dispatch decides box or cell once. If the
  repo moves to `ip_port`, or gains an entry the cell cannot express, while a marked run waits
  for its plan, `cell-plan` refuses it and the run fails: the worker never falls back to the
  box. Re-run the task.
- **Package registries (opt-in, off by default, OD-2):** `cell_egress_registries = true` on the
  repo's row adds `automata/registries@1`. Its hosts are:

  - npm and yarn: `registry.npmjs.org`, `registry.yarnpkg.com`;
  - PyPI: `pypi.org`, `files.pythonhosted.org`;
  - pub: `pub.dev`, `pub.dartlang.org`;
  - Maven Central: `repo.maven.apache.org`, `repo1.maven.org`;
  - Gradle: `plugins.gradle.org`, `plugins-artifacts.gradle.org`, `services.gradle.org`,
    `downloads.gradle.org`;
  - crates.io: `crates.io`, `index.crates.io`, `static.crates.io`;
  - Go: `proxy.golang.org`, `sum.golang.org`.

  It applies with no policy or with `domain`. Under `none` (the operator chose system hosts
  only) it is ignored. It is the one deliberate widening past the box: the box never reads it,
  so under `domain` a cell can reach registry hosts the repo's allowlist does not list.
  **Registries accept uploads.** This layer cannot enforce GET-only,
  so the opt-in widens what a prompt-injected agent can send out. Turn it on only for a repo
  that needs it. Multi-tenant storage hosts (`storage.googleapis.com`, S3) are not in `@1`,
  and a wider list is a new version (`@2`), never an edit of `@1`.

- **Flutter and Dart (#719):** `flutter pub get` should not need any host beyond `@1` for
  dependencies hosted on pub.dev; a git or third-party hosted dependency needs its own host.
  pub.dev serves package archives itself (`/api/archives/<package>-<version>.tar.gz`, no redirect,
  checked 2026-11-20); confirming this in a cell is AC-1 of #719. The Flutter SDK and engine
  artifacts do need `storage.googleapis.com`: `flutter precache`, artifacts fetched on demand,
  and the Android Gradle embedding (`/download.flutter.io`). They come from
  `FLUTTER_STORAGE_BASE_URL`, which defaults to `https://storage.googleapis.com`. No bundle
  carries that host (#719, OD-1). A repo that needs it lists it in its own `domain` allowlist,
  so the risk is a recorded choice per repo. **The host serves every Google Cloud Storage
  bucket, so allowing it lets a prompt-injected agent upload to a bucket an attacker owns,
  with no credential of ours.** The `domain` allowlist governs the box too, so the box opens
  the host as well. A repo with no policy that moves to `domain` also limits its box runs to
  the listed hosts plus the system hosts, so list everything its runs fetch. List the storage
  host only for a repo that builds Flutter artifacts in its runs. An Android build also pulls
  the Android Gradle Plugin and androidx from Google's Maven repository (`google()`, served
  from `dl.google.com`; `maven.google.com` if a build names it), which `@1` does not carry
  either, so an Android repo lists that host as well. Leave the third-party mirrors
  (`storage.flutter-io.cn`, `pub.flutter-io.cn`) out: the Flutter team can't verify their
  reliability or security (docs.flutter.dev/community/china).

To widen a repo, set it through the review-settings API (repo admin), for example:

```bash
curl -X PUT https://<www>/api/review-settings/<owner>/<repo> \
  -H 'content-type: application/json' --cookie "<session>" \
  -d '{"egressPolicy":"domain","egressAllowlist":["example.com"],"cellEgressRegistries":true}'
```

For a Flutter repo, the allowlist adds the storage host (and, for Android, `dl.google.com`) to
the repo's other hosts. The example below shows the shape, not a complete list. The PUT
replaces the whole list, so send every host the repo's runs fetch. The box never reads
`registries@1`, so under `domain` it needs the registry hosts listed too: here `pub.dev`, and
for an Android build on the box also the Gradle and Maven hosts it uses (`services.gradle.org`,
`plugins.gradle.org`, `repo.maven.apache.org`). The exact set for a Flutter Android build is
confirmed by the #719 AC-1 run.

```bash
curl -X PUT https://<www>/api/review-settings/<owner>/<repo> \
  -H 'content-type: application/json' --cookie "<session>" \
  -d '{"egressPolicy":"domain","egressAllowlist":["pub.dev","storage.googleapis.com","dl.google.com"],"cellEgressRegistries":true}'
```

Each planned cell writes one `cell_decision` row (`seam = 'compile'`, `mode = 'shadow'`). Its
`input.egress` holds `level`, `refs`, `bundles` and the `digest` the plan carries as
`egressDigest`, so a `deny` row in `egress_events` can be traced to the set that produced it.
The row records the set (`input.kind = 'cell_egress'`); it is not a policy decision. A replayed
plan request writes another row for the same `(stepKey, attempt)`, so key reads on
`(stepKey, attempt, digest)`.

### Findings every operator must know

- **Metadata values** must match `[A-Za-z0-9._-]`, at most 63 characters, alphanumeric at both
  ends. The server answers 400 `SANDBOX::INVALID_METADATA_LABEL` otherwise (a `:` in a step
  key is enough).
- **Deny-all needs the vault revoked first.** OpenSandbox 1.2.1 refuses a deny-all
  (`credential vault policy validation: binding ... is not allowed by egress policy`) while
  the vault holds a binding. An emergency quarantine is revoke, then deny-all.
- **A cell with no network policy has no egress sidecar**, so its revoke and deny-all
  return **502**, not 404. Delete such a cell directly (`DELETE /sandboxes/{id}`). Production
  cells always carry a policy.
- `docker logs` does not work on the dedicated daemon (its logging driver cannot be read
  back); use `journalctl -u automata-opensandbox.service` for the server's own output.

### Rollback, in this order

1. unset www's `OPENSANDBOX_URL`;
2. let the reconciler clear the cells, or run `teardown` by hand;
3. remove the worker drop-in `/etc/systemd/system/automata-worker.service.d/opensandbox.conf`,
   `systemctl daemon-reload`, then `automata-worker-safe-restart`: the launcher stops
   exporting `WORKER_OPENSANDBOX_*`;
4. `systemctl disable --now automata-opensandbox.service`;
5. remove the DNS route and the ingress rule;
6. `systemctl disable --now automata-cell-evidence.timer` (the evidence already recorded still
   lasts 30 days from its run).

**Never remove or replace `/etc/automata/opensandbox.env` while the drop-in exists.** Its
`LoadCredential=` has no fallback, so the worker cannot restart without the key file. Remove the
drop-in first (step 3), reload, then change the key file. `install-opensandbox.sh` exits 2 rather
than leave the drop-in beside an invalid key file.
