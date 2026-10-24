# Phase 2 ticket 5 (#373) — growth triggers: production UAT

- **Box:** `automata-exec-1`, Hetzner cpx42 (8 vCPU, `MemTotal` 15 987 540 kB, 8 GB swap). It runs tuple 3/3/2 (#372).
- **Code:** main `297fed92` carries PR #497 (merge `ef3893df`, 2026-10-23 23:07 UTC) and #496, which is dev-only.
- **Deploys, 2026-10-23:**
  - www version `e7fe7bc1-9a32-46f1-bd1b-2c8197f339f5`, BUILD_ID `toeB6hA5jydMA4s6mTf9r`, created 23:19:43 UTC. The rollback target is `d8701ca1`.
  - The worker was fast-forwarded to `297fed9` and restarted at 23:26:59 UTC.
- **Order and idle gate:** www went first, then the worker. Every worker restart in this record passed the same gate first: no `run-*` cgroup under the unit, no daemon process, no pending systemd job, and every `Task run starting` in the last 30 min matched by a terminal line.

## UAT 1 / AC 8: every dispatch lane is tagged (OD-0)

Source: `GET /api/v1/stable/tenants/<t>/workflow-runs?since=…&only_tasks=true` on the box, `:run` rows only. Each org value was reduced to `org` or `u:<user>` before printing.

| createdAt (UTC) | workflow           | lane     | orgId | repo | prNumber |
| :-------------- | :----------------- | :------- | :---- | :--- | :------- |
| 23:19:40.76     | `agent-run-newest` | `review` | org   | yes  | 868      |
| 23:19:40.82     | `agent-run`        | —        | —     | —    | —        |
| 23:19:41.01     | `agent-run`        | —        | —     | —    | —        |
| 23:20:47.38     | `agent-run-newest` | `review` | org   | yes  | 866      |
| 23:20:55.20     | `agent-run`        | **`pr`** | org   | yes  | 866      |

- **Before the deploy:** every `agent-run` (non-review) row is untagged. That is the gap OD-0 closes.
- **After the deploy:** the first non-review run (23:20:55) carries `lane=pr`, `orgId`, `repoFullName` and `prNumber`.
- **Review runs** are tagged both before and after the deploy, as they have been since #127.
- **Not yet seen:** a task, self-heal or mention run after the deploy. They share the same `buildRunMetadata` path, and the 7-day re-query below covers them.

**Pass.**

## UAT 3 / AC 1 and AC 7: unset is silent, a bad knob refuses

- **Unset is silent.** The webhook stayed unset (`worker-box.env` has no `WORKER_ALERT_WEBHOOK_URL`) at both the deploy restart (23:26:59) and the restore restart (23:40:06). After each one the journal shows `listening for actions`, the liveness watchdog armed, and **0** `growth.*` lines.
- **A bad knob refuses.** Each value below was checked on the box with the README's knob check (`loadGrowthTriggerConfig(process.env)`, run as `automata`). Every URL was the placeholder `https://hooks.example.test/uat-secret-path`.

| Case                                                         | Outcome                                                                          | URL in output |
| :----------------------------------------------------------- | :------------------------------------------------------------------------------- | :------------ |
| unset                                                        | `growth knobs ok`                                                                | 0             |
| valid https URL                                              | `growth knobs ok`                                                                | 0             |
| `http:` to a public host                                     | refused: must use https (loopback or private IPv4 literal only)                  | 0             |
| `https://user:pw@…`                                          | refused: must not carry credentials in the URL                                   | 0             |
| `INTERVAL_S=60 SUSTAIN_S=90`                                 | refused: sustain must be ≥ 2 × interval (120)                                    | 0             |
| `INTERVAL_S=43201`                                           | refused: above the 43 200 s ceiling (sustain ≥ 2 × interval, capped at 86 400 s) | 0             |
| `RAM_FRACTION=1.5`                                           | refused: must be 0 < x < 1                                                       | 0             |
| `TENANT_SIGNALS=maybe`                                       | refused: must be `on` or `off`                                                   | 0             |
| UAT 2 knobs (`RAM_FRACTION=0.10 SUSTAIN_S=60 INTERVAL_S=30`) | `growth knobs ok`                                                                | 0             |

- **Boot path not run live.** A refused knob is never booted on production: under `Restart=always` it would crash-loop every run lane. Boot runs the same loader, and its FATAL wiring is pinned by `growth-triggers-boot.test.ts`.

**Pass.**

## UAT 2 / AC 2–5: one alert fires, survives a restart, and clears once

- **Sink:** a private ntfy.sh topic made for this test (`https://ntfy.sh/automata-uat-<32 hex>`). The topic name was never written to the repo or this record, and it was deleted after the test.
- **Knobs:** added temporarily to `worker-box.env`, which kept `automata:automata` and mode 600. The backup is `/root/worker-box.env.pre-uat373`.

| Time (UTC) | Step                                                             | Evidence                                                                                                                                                                                                                                                  |
| :--------- | :--------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 23:32:41   | restart with `RAM_FRACTION=0.10`, sustain 60 s, interval 30 s    | `growth.armed {"intervalS":30,"sustainS":60,"ramFraction":0.1,"tenantSignals":true}`; `ram_swap` "warming up"; `client_share` unknown, "attribution incomplete (more than 5% of run time unattributed)", as expected right after the www deploy           |
| 23:33:48   | fire                                                             | `growth.trigger_fired {"trigger":"ram_swap","value":0.119,"threshold":0.1}`; **one** ntfy message: `[growth] ram_swap FIRED on automata-exec-1: box RAM 11.9% used (threshold > 10% sustained ≥ 60s: true; …)`                                            |
| 23:35      | secrecy check                                                    | the topic name appears 0 times in the journal and in the snapshot, and `ntfy.sh` appears 0 times in the journal; snapshot `/tmp/automata-agent-run/growth-triggers.json` is mode 640, owner `automata`, `ram_swap.firing: true`                           |
| 23:36:11   | restart with `RAM_FRACTION` back to 0.70 (default), webhook kept | the restored firing state is **not** re-announced: no second FIRED                                                                                                                                                                                        |
| 23:38:38   | clear                                                            | `growth.trigger_cleared {"trigger":"ram_swap","value":0.125,"threshold":0.7}`; **one** ntfy message: `[growth] ram_swap cleared on automata-exec-1: box RAM 12.5% used (threshold > 70% …)`; snapshot `verdict: under, firing: false`, `lastFiredAt` kept |
| 23:40:06   | restore and restart                                              | `worker-box.env` restored byte for byte (`cmp` identical, `automata:automata` 600, 0 growth knobs); 0 `growth.*` lines since boot; test snapshot removed, so a later enable does not start from it                                                        |

The ntfy topic held exactly two messages: one FIRED and one cleared.

**Pass.**

## Still open

- **OD-0 7-day window.** `client_share` and the scale composite's clients arm mean something only once the window holds 7 complete UTC days of tagged runs. The first full window ends **2026-11-01 00:00 UTC**. On or after that date, re-query the engine:
  - confirm the unattributed share is ≤ 5 %;
  - confirm task, self-heal and mention runs carry `orgId` and `lane`.
- **Alerts in production.** The production box does not send growth alerts yet: the webhook is unset. Setting `WORKER_ALERT_WEBHOOK_URL` to the operator's real sink is a separate operator action. Run the README knob check before the restart.
- **Follow-ups:** #485 (review findings filed by the owner), #409 (worker-recorded admission time) and #408 (www paging).
