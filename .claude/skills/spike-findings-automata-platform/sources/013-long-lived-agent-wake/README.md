---
spike: 013
name: long-lived-agent-wake
type: standard
validates: "Given a persistent per-scope agent box with a volume, when it sleeps and a cron/webhook event wakes it, then durable state survives, wake latency is measured per mode, and concurrent triggers wake it once"
verdict: VALIDATED
related: [012-box-template-manifest]
tags: [long-lived-agents, lifecycle, sleep-wake, docker, persistence, artifacts]
---

# Spike 013: Long-lived agent with sleep/wake

## What This Validates
Every Automata run is ephemeral today: only E2B/Daytona hibernate (`apps/www/src/agent/sandbox.ts:617`), and Hatchet worker runs are per-run. Prospects want agents that *live*: a per-team or per-channel agent with memory, files and a session that wakes on schedules and events. Agent37 sells exactly this, and qm calls it "one durable sandbox per scope". This spike measures what each sleep mode keeps and what each costs, using plain Docker as on the worker box.

## Research
| Mode | Who uses it | Keeps | Loses | Idle cost |
|---|---|---|---|---|
| stop/start (same container) | Agent37 stop/start; Docker | volume + container rootfs | process memory | disk only |
| pause/unpause (cgroup freezer) | (none advertise it) | **everything, same process** | nothing | **RAM stays allocated** |
| recreate (new container, same volume) | Agent37 `update` (OS layer reset, `/home/node` kept) | volume (`$HOME`) | rootfs and process | disk only |
| CRIU checkpoint/restore | Agent37 auto-sleep ("memory usually survives") | memory too, without holding RAM | — | disk only |

The agent in this spike is PID 1 and writes heartbeats. Durable state lives in `$HOME` (`memory.jsonl`, `session.json`, `artifacts/`); its "working set" is in memory only. Turns arrive via `docker exec`, which mirrors Agent37's exec API, so the box needs **no inbound port**. The orchestrator wakes the box single-flight and then delivers the turn.

## How to Run
```bash
cd .planning/spikes/013-long-lived-agent-wake
node lifecycle.mjs          # needs Docker (OrbStack); N=10 by default; cleans up its container and volume
```

## What to Expect
- PASS lines for 7 checks, then a JSON block with p50/p90 per mode.
- `results.json` and `events.jsonl` are written.

## Observability
`events.jsonl` holds every lifecycle event and check with ISO timestamps. `results.json` holds latency stats per mode.

## Investigation Trail
1. **Stop/start (N=10).** Memory (2 facts), `session.json` and `artifacts/report.md` survive every cycle, and the boot id changes each time.
   - Surprise: the **container rootfs also survives** stop/start (`/tmp` scratch kept). Only *recreate* gives the "OS layer reset" Agent37 describes.
   - So "durable" must be defined as `$HOME` only, or state leaks across template revisions that should have reset it.
2. **Pause/unpause.** The same process resumes (same boot id), and the in-memory counter keeps going (1 → 15). This is the only mode that keeps a live harness process, e.g. an open Claude session with warm context. The cost is that RAM stays reserved.
3. **Recreate** (simulating a template rev N+1 rollout from spike 012). The volume state survives, and the old rootfs scratch is gone; the new boot's scratch replaces it.
4. **Concurrent cron and webhook while asleep.** `Promise.all` of two deliveries started the box **once** (boots 17 → 18), because `wake()` is single-flight per box. Without that, both triggers would race `docker start`.
5. **CRIU.** `docker checkpoint create` failed on OrbStack (`criu failed: type DUMP`). Memory-preserving sleep without holding RAM is **not available** on this stack. It needs a Linux host with CRIU, Firecracker snapshots, or a provider (E2B/Agent37).
6. **PID-1 signal trap.** This was followed up because `stop` looked suspiciously fast. A harness that doesn't handle SIGTERM (the common case) made `docker stop` take **10,250 ms** and end in SIGKILL (exit 137). That would kill the agent mid-write to memory. With `--init` it took **184 ms** and exit 143. → Templates must default to `init: true`.

## Results
**VALIDATED** (7/7 checks). On OrbStack/macOS with the `node:24` image already local:

| Mode | p50 | p90 | Keeps process memory | Idle cost |
|---|---|---|---|---|
| warm turn (box running) | 45 ms | 47 ms | yes | full |
| pause → event → turn | 133 ms | 154 ms | **yes** | RAM |
| stop → event → start → healthy → turn | 189 ms | 206 ms | no | disk |
| recreate (template update) → healthy | 296 ms | 315 ms | no | disk |
| first provision (create + boot) | 662 ms | — | — | — |

**Signal for the build:**
- The **box lifecycle is cheap** (< 0.3 s, excluding image pulls). Real wake cost will be dominated by harness startup and session resume (`claude --resume` reloading its JSONL), not by Docker. That wasn't measured here because no credentials are mounted into the box. Next step is to measure it on the Hetzner worker.
- **Tiering policy:**
  - running while active;
  - **pause** for short idle (minutes; keeps the session live);
  - **stop** for long idle (disk-only billing);
  - **recreate** only on a template revision update.
- **Durable = `$HOME` volume only:** memory, session JSONL and artifacts. Artifacts should also sync to R2 on sleep, so they survive box loss and can be served without waking the box. Today's R2 client (`packages/r2`) is user-scoped; it needs a `scope/agent/artifacts/` prefix.
- **Must-haves:**
  - `--init` (or a `SIGTERM` trap) in every template;
  - single-flight wake per box;
  - a health definition of "heartbeat from *this* boot", not "container running". Agent37 reports `running` before the box is actually healthy.
