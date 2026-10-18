---
spike: 016
name: long-lived-agent-short-lived-token
type: integration
validates: "Given a days-lived box and a minutes-lived per-run push token, when the agent wakes (incl. after a pause longer than the TTL) and pushes, then a fresh wake-bound token is minted per wake, stale ones are refused at the edge, and none is persisted in $HOME"
verdict: VALIDATED
related: [003-push-time-policy-gate, 013-long-lived-agent-wake, 015-template-boots-persistent-box]
tags: [credentials, long-lived-agents, policy, tokens, wake, integration]
---

# Spike 016: A long-lived agent with short-lived push tokens

## What This Validates
Two invariants pulled against each other:
- **Spike 003:** push credentials are scoped to one run, short-lived and revocable.
- **Spike 013:** agents live for days and sleep in between.

Should a persistent agent hold a token for its whole lifetime? No. The fix is to redefine the unit: **the credential lives for one wake, not for the box**.
- Each wake (start, unpause, or a turn after a long idle) mints a token bound to `{boxId, wakeId}`.
- The edge accepts only the box's *current* wake.
- Sleeping revokes the token.

## Research
| Option | Stale-token window | Survives orchestrator crash? | Cost | Verdict |
|---|---|---|---|---|
| One token per box lifetime (long TTL) | days | n/a | none | **Rejected.** Contradicts 003; an exfiltrated token is good for days |
| Per-run TTL token, refreshed by the agent itself (refresh token in the box) | refresh-token lifetime | yes | the agent holds a refresh secret | Rejected. Moves the long-lived secret, doesn't remove it |
| Per-wake mint, TTL only | ≤ TTL | yes | 1 mint per wake | Partial. A TTL long enough for a work session is still a window |
| Per-wake mint + revoke-on-sleep | 0 if revoke runs | **no** (a missed revoke leaves ≤ TTL) | + 1 revoke | Better |
| **Per-wake mint + revoke-on-sleep + edge wake binding** | **0 after the next wake, even if revoke was missed** | **yes** | + 1 registry lookup per push | **Chosen** |

**Delivery** reuses spike 015's mechanism:
- A tmpfs file at `/run/secrets/FORGE_TOKEN`, written over `docker exec -i` stdin.
- The turn process reads it into the git child's env-scoped config (`GIT_CONFIG_COUNT/KEY_0/VALUE_0` → `http.extraHeader`).
- It is never put in argv, the repo's `.git/config` or `$HOME`.

## How to Run
```bash
cd .planning/spikes/016-long-lived-agent-short-lived-token
node run.mjs   # needs Docker + ports 3316/3317 (outside the Claude sandbox) and ../002-forge-substrate/work/seed.git
```

The setup:
- spike 003's unchanged `gate-server.mjs` + `pre-receive.mjs` run on :3317;
- the wake-binding edge runs on :3316, in-process with the orchestrator's wake registry;
- the box reaches the edge at `host.docker.internal`.

## What to Expect
- **Output:** 11 PASS lines, then `11/11 passed` with latency stats.
- **Cleanup:** the container, the volume and `work/` are removed.

## Observability
- **`events.jsonl`:** wake events (wakeId, TTL, mint and deliver ms), sleep events, edge refusals with reasons, and checks.
- **Gate audit:** the gate's own audit (accepted, rejected or refused) is counted in `results.json`.

## Investigation Trail
1. **Before any wake hook, the box can't push.** No token exists in the tmpfs, so git fails with no credential. A box is inert until the control plane runs the hook.
2. **Pause keeps the tmpfs, and so keeps the stale token.**
   - 015 showed that *stop* clears tmpfs secrets. *Pause* does not: the frozen process and its RAM-backed files are kept.
   - After a pause longer than the TTL (4.5 s against a 3 s TTL), the old token is still in `/run/secrets` and the agent pushes with it. The gate refuses it as `token expired at …`.
   - So **unpause is a wake too**: it must run the mint hook. A fresh token then pushes fine.
3. **A missed revoke is covered by the wake binding.**
   - The scenario: wake 2's token is exfiltrated, the orchestrator crashes before revoking it, and wake 3 happens.
   - The stolen token is unexpired and unrevoked, yet the edge refuses it: `token bound to box-7 wake w2; box is on wake w3`.
   - TTL alone would have left a 60 s window.
4. **Revoke-on-sleep works by itself.** A copy of the live token, taken before `docker stop`, is refused by the gate as `token revoked (run box-7:w3 ended)` well inside its 60 s TTL. For this check the edge's binding was set to that wake on purpose, to isolate the gate's revocation path.
5. **Stop clears the token.** After restart the tmpfs is empty, the agent can't push, and the wake hook restores the ability to push.
6. **Leak scan.**
   - What was searched: the `$HOME` volume, including the repo's `.git/config`, for every issued token's signature plus `Authorization` and `extraHeader`. Also `docker inspect` and PID 1's environ.
   - The scan found nothing.
   - The first run passed with nothing to show the detector *could* see a leak. A **positive-control canary** (a token file in a side mount) was added and is found every time.

## Results
**VALIDATED, 11/11.**

| Measure (10 wakes, OrbStack) | p50 | p90 |
|---|---|---|
| mint + deliver over exec stdin | 39–43 ms | 44–53 ms |
| push (box → edge → gate → pre-receive) | 91–98 ms | 96–106 ms |
| **wake hook → pushed** | **129–143 ms** | 138–154 ms |

Minting itself (HMAC) is about 0.1 ms. Delivery is dominated by `docker exec`.

**Signal for the build:**
- **Credential unit is the wake, not the box.** The worker's wake path (start *and* unpause) calls the broker (#81). It mints `{boxId, wakeId, refPrefix, paths, exp, jti}` and writes it to the box's tmpfs. The sleep path revokes.
- **Edge wake binding:**
  - The forge edge or broker keeps `currentWake[boxId]` in Redis or Postgres and refuses any token whose wake isn't current.
  - That makes a missed revoke harmless after the next wake, and costs one keyed lookup per push.
- **TTL:** set the token TTL to the *expected turn length*, not the box lifetime. A turn that outlives its TTL calls the wake hook again, which re-mints and supersedes the old token.
- **Pause is a wake.** It keeps tmpfs, so it keeps stale credentials. The pause tier from 013 must re-mint on unpause.
