---
spike: 015
name: template-boots-persistent-box
type: integration
validates: "Given a compiled template (Dockerfile + runtime manifest), when it boots a persistent box and rev N+1 recreates it, then init is on, secrets are resolved at boot and absent from image/inspect, $HOME survives, the old rootfs is gone, and pinned instances don't move until update()"
verdict: VALIDATED
related: [012-box-template-manifest, 013-long-lived-agent-wake, 016-long-lived-agent-short-lived-token]
tags: [templates, long-lived-agents, secrets, tmpfs, init, revisions, integration]
---

# Spike 015: A compiled template boots a persistent box

## What This Validates
Spike 012 compiled `automata.template.yaml` into a Dockerfile plus a runtime manifest, and spike 013 ran a persistent box. Neither had been fed into the other. This spike checks that seam:
- The template's `init` and resources reach `docker run`.
- `secretRefs` become real values inside the box, at boot only.
- A new revision (rev N+1) is rolled out per instance through recreate, while `$HOME` survives.

**Substitution:** the image is `FROM node:24` plus 012's appended template block, verbatim. The production base (`renderBase()`, `Dockerfile.hbs`) takes minutes to build. 012 already proved that base is byte-identical to the repo renderer, so swapping it here doesn't affect what is being tested.

## Research
| Mechanism for secret values at boot | In `docker inspect`? | In image or layers? | On disk? | Survives stop? | Verdict |
|---|---|---|---|---|---|
| `docker run -e NAME=value` | **yes** (Config.Env, readable by anyone with the docker socket, persists across stop/start) | no | container config on host | yes | **Rejected.** The leak is proven in-spike. |
| `--env-file` | yes (expanded into Config.Env) | no | host file | yes | Rejected (same leak) |
| Build `ARG` / `ENV` | yes | **yes**, in history | yes | yes | Rejected (012 already forbids it) |
| Bind-mount a host secret file | no | no | **yes** (on the host disk) | yes | Rejected for the worker box |
| Docker/Swarm secrets | no | no | Raft store | yes | Needs swarm mode; not on our stack |
| **Per-container tmpfs at `/run/secrets`, values piped over `docker exec -i` stdin** | **no** | **no** | **no** (RAM only) | **no**: re-resolved on every wake | **Chosen** |

Exec args *are* visible through `docker inspect <execId>`, so the value never goes in argv. It goes through stdin (`sh -c 'umask 077; cat > /run/secrets/NAME'`).

## How to Run
```bash
cd .planning/spikes/015-template-boots-persistent-box
node --experimental-strip-types --no-warnings run.ts   # needs Docker (OrbStack); run outside the Claude sandbox
```
The runner cleans up `spike015-*` containers, volumes and images.

## What to Expect
- **Output:** 17 PASS lines, then `17/17 passed` with timings. The exit code is 0 or 1.
- **Secret values:** random per run (`FAKESECRET015…`), so no secret-shaped literal ever exists on disk.

## Observability
- **`events.jsonl`:** builds (tag, ms) and every check.
- **`results.json`:** timings plus check details.

## Investigation Trail
1. **012's runtime manifest can't boot a box.**
   - `compile()` emits `secretRefs: [ANTHROPIC_API_KEY, ORG_STAGING_DATABASE_URL]`, but drops *which env var each secret feeds* (`DATABASE_URL ← ORG_STAGING_DATABASE_URL`). The box can't be wired without that.
   - **Fix:** the manifest now carries `secretBindings: {ENV_NAME: SECRET_NAME}`. This is a required change to 012's `Compiled.runtime`.
2. **`init` wasn't a template field.**
   - 012's `TemplateSpec` had no `init`. Here it's read with a default of `true` and included in the digest.
   - **Control:** the same agent (it deliberately has no SIGTERM handler, like most harnesses) booted from an `init: false` template.
     - Stop took **10,213 ms** and ended in SIGKILL (137).
     - With `init: true` it took **128 ms** and exited 143.
3. **`docker run -e` leaks.** I proved it in a throwaway container: the value sits in `docker inspect` Config.Env, so the mechanism a developer reaches for first is wrong.
4. **tmpfs plus exec-stdin is clean.**
   - The value is absent from inspect, from `docker history`, from *every saved image layer* (`docker save | grep`: 0 hits), from the `$HOME` volume, and from PID 1's environment.
   - `docker diff` lists only the mountpoint (`A /run/secrets`), never its files.
   - The first run flagged that mountpoint as a leak. It was a false fail, and the check now looks under `/run/secrets/`.
5. **tmpfs is cleared on stop.**
   - After stop and start, the box has **no** secrets until the control plane re-injects them (68 ms).
   - This is a feature: a sleeping box holds no credentials. It forces "resolve secrets on every wake", the same hook spike 016 uses for per-wake tokens.
6. **Revisions behave as in 012, now with real containers.**
   - Reordering env keys gives the same digest, so the image is not rebuilt.
   - Rev 2 published: both instances stay on rev 1 *and keep running the rev-1 image*.
   - `update(a)` recreates `a` on the rev-2 image with the same volume:
     - memory and session survive;
     - rootfs scratch is reset;
     - the new env applies;
     - `b` is untouched.
   - Rollback `update(a, 1)` returns `a` to the rev-1 image with memory intact.

## Results
**VALIDATED, 17/17.**

| Step | ms |
|---|---|
| build rev 1 (cold, node:24 cached) | 1,296 (299 with build cache) |
| launch → healthy | 256–336 |
| inject 2 secrets (exec stdin) | 67–71 |
| stop with init | 128 |
| stop without init (control) | 10,213 → SIGKILL |
| re-inject on wake | 68 |
| build rev 2 | 244–512 |
| recreate on rev 2 → healthy + secrets | 390 |

**Signal for the build:**
- **Runtime manifest:** it must carry `secretBindings` (env name → secret name), plus `init` (default true, in the digest). Extend 012's `Compiled.runtime`.
- **Secret delivery:** a per-container **tmpfs at `/run/secrets`** (mode 0700), with values piped over exec stdin by the control plane on **every wake**.
  - The harness wrapper reads the files into the *turn* process env. It never puts them in PID 1's env or `docker run -e`.
  - On E2B and Daytona, use their equivalents for in-memory files and the same "inject on resume" hook.
- **Image cache:** key it by template digest (`spike015-<name>:<digest>` here), so an identical body never rebuilds.
- **Rollout:** update or rollback = `rm` + `run` on the pinned image with the same volume, then health (a heartbeat from this boot), then inject secrets.
