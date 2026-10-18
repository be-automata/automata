# Long-lived (persistent) agents: sleep and wake

## Requirements
- **Durable state is the `$HOME` volume only:** memory, the session JSONL and artifacts.
  - The container rootfs survives stop/start but is reset on recreate (a template update), so it must never be treated as durable.
- **Every box runs with an init** (`docker run --init`, or a PID-1 SIGTERM trap).
- **Wake is single-flight per box.**
- **Health means "a heartbeat from *this* boot"** (the boot id changed), not "the container is running".
- **Artifacts persist on the volume and sync to R2** under a scope prefix.

## How to Build It

### 1. Box shape
- One container per scope: org, team, channel or repo agent. A named volume is mounted at `/home/agent`.
- **No inbound port.** Turns arrive via `docker exec <box> node /app/turn.mjs …` (mirrors Agent37's exec API).
- The agent writes `$HOME/heartbeat` with `{bootId, at}`. `bootId` is minted per process start.

### 2. Lifecycle tiers (orchestrator policy)
| state | when | keeps | idle cost | wake → turn p50 (OrbStack) |
|---|---|---|---|---|
| running | active | everything | full | 45 ms warm turn |
| **paused** (`docker pause`) | short idle (minutes) | **live process, warm harness session** | RAM | 133 ms |
| **stopped** (`docker stop`) | long idle | volume + rootfs | disk | 189 ms |
| **recreated** (`rm` + `run`, same volume) | template revision update only | volume | disk | 296 ms to healthy |
| first provision | — | — | — | 662 ms |

### 3. Single-flight wake (from `lifecycle.mjs`)
```js
let waking = null;   // production: per-box key; a DB/advisory lock across workers
async function wake() {
  const state = await docker("inspect", "-f", "{{.State.Status}}", NAME);
  if (state === "running") return { woke: false };
  if (state === "paused") { await docker("unpause", NAME); return { woke: true, mode: "unpause" }; }
  if (!waking) waking = (async () => { await docker("start", NAME); await waitHealthy(undefined); return { woke: true, mode: "start" }; })()
    .finally(() => { waking = null; });
  return waking;
}
```
- `waitHealthy(prevBoot)` polls until the heartbeat's `bootId !== prevBoot`.
- Cron and webhook delivered together resulted in exactly one start (boots 17 → 18).

### 4. Wiring into Automata
- **Triggers:** the existing automations (cron and PR/webhook intake) call `deliver(event)`, which runs `wake()` and then the turn.
- **Artifacts:** on sleep, sync `$HOME/artifacts/` to R2 at `<org>/<scope>/<agent>/artifacts/`, so they can be served without waking the box. `packages/r2` is user-scoped today and needs that prefix.
- **Template update:** recreate on the new revision with the same volume. Only rootfs scratch is lost (spike 012 pin semantics).

## What to Avoid
- **Running a box without `--init`.** A harness that ignores SIGTERM made `docker stop` take **10,250 ms** and end in SIGKILL (exit 137), mid-write to memory. With `--init` it took 184 ms (exit 143).
- **Treating rootfs as durable.** It leaks state across template revisions that should have reset it.
- **Reporting healthy on `State.Status == running`.** Agent37 does that, and it reports ready before the agent is.
- **Unguarded concurrent `docker start`.** Two triggers race it.
- **Planning on CRIU.** `docker checkpoint create` fails on OrbStack with `criu failed: type DUMP`.

## Constraints
- Memory-preserving sleep *without* holding RAM is unavailable on this stack. It needs one of: a Linux host with CRIU, Firecracker snapshots, or a provider (E2B or Agent37).
- Docker lifecycle overhead is under 0.3 s excluding image pulls. Real harness wake on Hetzner is now measured (spike 018, below): a cold-CLI stop/start takes 1.3–1.45 s; a paused live process takes about 165 ms.
- The numbers above come from OrbStack on macOS with `node:24` already cached locally.

## Session 3 additions (spikes 015, 016, 018, 021-A)

### Real harness wake cost on the production box (018)
The real Claude Code 2.1.302 runs against an instant local Messages-API stub (`ANTHROPIC_BASE_URL`), so no credential is in the box. Measured on Hetzner CX33, p50:

| mode | 180 KB session | 1 MB session | idle cost |
|---|---|---|---|
| pause → unpause, **live** `claude -p --input-format stream-json` | **162 ms** | **172 ms** | ~130 MiB RAM |
| running, cold `claude -p --resume` | 850 ms | 947 ms | full |
| stop → start → healthy → turn | 1.32 s | 1.45 s | disk |

- Hetzner is 2–5x slower than OrbStack, and the extra time is CLI boot and JSONL parsing, not Docker.
- **Every turn sends about 63 KB (about 16k tokens) of system prompt and tools.** Keep that prefix stable so wakes hit the prompt cache.
- **Tiering:** a paused agent with a live stream-json process is the fast path. Cap paused agents (tens per 7.6 GB box) and LRU-demote them to stopped.
- Resume carried the turn-1 fact in every mode.

### Secret delivery into a persistent box (015)
- `docker run -e` **leaks values into `docker inspect`**; this was confirmed.
- **Use a per-container tmpfs at `/run/secrets`** (mode 0700). Values are piped over `docker exec -i` stdin on **every wake**, because stop clears the tmpfs (re-injection takes 68 ms).
- The harness wrapper loads the files into the *turn* process env, never PID 1.
- Verified clean in inspect, `docker history`, image layers, the volume and PID 1's env.
- **Init:** stop takes 128–143 ms with init, versus 10.2 s ending in SIGKILL without it.
- **Recreate on rev N+1:** 390–447 ms. `$HOME` survives, rootfs is reset, other instances stay pinned.

### Per-wake push credentials (016)
- **The credential unit is the wake, not the box.**
  - Wake (start **and** unpause) → the broker mints `{boxId, wakeId, refPrefix, paths, exp, jti}` into the tmpfs.
  - Sleep → revoke.
  - The edge keeps `currentWake[boxId]` and refuses any token for a non-current wake, so a missed revoke is harmless after the next wake.
- **Pause keeps the tmpfs**, and with it a stale token. Unpause must re-mint.
- **TTL = expected turn length.** A long turn re-calls the wake hook.
- **Latency:** mint plus deliver ~40 ms; wake→pushed p50 ~124–135 ms.
- The canary-file positive control proves the `$HOME` leak scan actually works.

### Memory persistence across sleep, recreate and compaction (021-A)
- **One `$HOME` volume per scope, including `~/.claude`.** `--resume <id>` finds a session from any cwd, so scopes sharing one config dir can read each other's sessions; this was confirmed.
- Harness auth comes per wake via tmpfs. A per-scope `CLAUDE_CONFIG_DIR` starts out "Not logged in".
- **Compaction is lossy.** After `/compact`, recall from the session alone failed in 4 of 6 runs.
- **Structured scope memory is the durable truth.** A `memory_record` carries `rev` CAS, `sensitivity`, `humanEdited` and provenance, and is re-injected *in the turn* at every wake. That restored the fact 3/3. `--append-system-prompt` on `--resume` was flaky.
- **Revision rules:** an agent write after a human edit is refused, even after the agent re-reads. Path-traversal scope ids are rejected.
- **Exclude session JSONL (`~/.claude`) from artifact sync to R2.** It holds full request blobs.

## Origin
Synthesized from spikes: 013, 015, 016, 018, 021
Source files are in `sources/013-long-lived-agent-wake/`: `lifecycle.mjs` and `app/agent.mjs`, `app/turn.mjs`.
