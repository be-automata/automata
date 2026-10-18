---
spike: 018
name: real-harness-wake-cost
type: standard
validates: "Given the Hetzner worker (idle window, throwaway container), when a box holding a Claude session is paused/stopped then woken for a turn, then claude --resume time-to-first-request per mode is measured and context recall verified"
verdict: VALIDATED
related: [013-long-lived-agent-wake, 021-agent-memory-context-persistency]
tags: [long-lived-agents, latency, claude, resume, hetzner]
---

# Spike 018: Real Claude Code wake cost

## What This Validates
Spike 013 showed the Docker lifecycle costs under 0.3 s, and predicted that harness startup and session resume would dominate. This spike measures the **real Claude Code CLI** (2.1.302, the same version as the operator's) resuming a real session in each sleep mode, at two session sizes, and checks that the resumed request still carries a fact taught in turn 1.

## Research
| Measure what | How | Why |
|---|---|---|
| Time to first token with the real API | needs a credential in the box | The worker's key is a production secret that bills per token, so it wasn't used. Model TTFT is also independent of the box, so it's left out of this measurement |
| **Harness wake (box → CLI boot → session JSONL load → request)** | `ANTHROPIC_BASE_URL` → a stub inside the box that **replies instantly** and logs each request's size, message count and whether the fact is present | Every millisecond measured is harness or box, and no credential exists anywhere in the box |

Modes:
- **(C) box running:** a cold `claude -p --resume` process per turn. This is how the worker runs today.
- **(A) stop → start → healthy:** then a cold CLI resume.
- **(B) pause → unpause:** a **live** `claude -p --input-format stream-json` process keeps the session open, and the event is one stdin line.

## How to Run
```bash
cd .planning/spikes/018-real-harness-wake-cost
docker build -t spike018-claude .
node wake.mjs --n 10 --label orbstack            # local, outside the sandbox
# Hetzner (idle window; check `journalctl -u automata-worker --since -30min | grep 'run start'` and `pgrep -u automata-agent` first):
#   scp -r Dockerfile app wake.mjs package.json root@<box>:/root/spike018/ && ssh root@<box> 'cd /root/spike018 && docker build -t spike018-claude . && node wake.mjs --n 10 --label hetzner; docker rmi spike018-claude'
```

## What to Expect
- `8/8 passed`.
- `results.<label>.json` holds p50/p90 for each mode and size, plus request bytes and paused memory.

## Observability
- `events.<label>.jsonl` logs each phase and check.
- The stub writes `$HOME/stub.jsonl` inside the box (arrival time, bytes, message count, `hasFact`, model). The volume is deleted at cleanup.

## Investigation Trail
1. **Smoke test.**
   - The real CLI talks to the stub with no other endpoint needed, given `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
   - `--resume <id>` reloads the session: the second request carried 5 messages and the fact.
   - **Every request carries about 63 KB (about 16k tokens) of system prompt and tools before any history.** That's the fixed per-turn cost a resumed agent pays. Prompt caching matters more than resume time.
2. **The first full run passed 8/8, so I checked the numbers.**
   - The "small" session isn't 2 turns. By its last measurement it had 32 messages (180 KB JSONL), because the benchmark turns go into the same session.
   - The large session (20 × 20 KB replies) is 1 MB of JSONL, and its resumed request is 476 KB with 185 messages. Every request in every mode carried the fact.
3. **Resume load scales mildly.** Going from a 180 KB to a 1 MB session added about 34 ms at p50 to a cold-process resume. The native CLI binary boots in well under 200 ms.
4. **Hetzner (2026-10-18 05:18 UTC).** The operator approved the firewall rule update (it was first blocked by the permission classifier and not worked around).
   - Pre-run check: worker active, 0 `run start` in 30 min (the last was 04:11). The 26 "automata-agent" processes were the engine's Postgres, which shows under that uid because of the known uid-999 collision, not agent runs.
   - The image was built on the box. After the run, the container, volume, image and `/root/spike018` were removed. 0 runs started during the spike.
5. **Hetzner is 2–5x slower than the laptop, mostly in the harness.**
   - A cold CLI resume goes from 171 to 850 ms, while stop→healthy only goes from 125 to 380 ms. The CX33's shared vCPUs dominate CLI boot and JSONL parse.
   - The pause tier stays at about 165 ms and doesn't grow with session size.

## Results
**VALIDATED.** 8/8 on both the Hetzner worker (CX33, 4 shared vCPU, 7.6 GB) and OrbStack.

| mode | Hetzner small (180 KB) p50 / p90 | Hetzner large (1 MB) p50 / p90 | OrbStack small / large p50 | keeps process | idle cost |
|---|---|---|---|---|---|
| running, cold `claude -p --resume` | 850 / 913 ms | 947 / 1007 ms | 171 / 205 ms | — | full |
| **pause → unpause, live CLI process** | **162 / 170 ms** | **172 / 210 ms** | 70 / 71 ms | yes | 125–133 MiB RAM (Hetzner) |
| stop → start → healthy | 380 / 547 ms | 407 / 557 ms | 125 / 123 ms | no | disk |
| stop → start → turn | 1322 / 1682 ms | 1449 / 1629 ms | 296 / 311 ms | no | disk |

**Signal for the build:**
- **On the production box, harness wake is about 1.3–1.5 s for stop/start with a cold CLI** (about 0.3 s on a laptop). Model TTFT comes on top, so the wake SLA will be set by model TTFT and the ~16k-token fixed prompt as much as by the box. Keep that prefix stable across turns and wakes so prompt caching hits.
- **The pause tier with a live stream-json process is the fast path:** about 165 ms on Hetzner (70 ms on a laptop) and size-independent, costing about 130 MiB of RAM per paused agent on Hetzner. On the 7.6 GB worker box, after the engine and the 1500M per-run ceiling, that's tens of paused agents, not hundreds. Paused agents need a cap and LRU demotion to stop.
- **Resume preserves context in every mode** (the fact appears in every resumed request). The session JSONL on the `$HOME` volume is the durable unit, which confirms spike 013.
- **Not measured:**
  - MCP servers, hooks and plugins in the box. Each cold process re-spawns them, and a live paused process keeps them, which widens the pause advantage.
  - Auto-compaction on very long sessions (spike 021).
  - The real API TTFT.
