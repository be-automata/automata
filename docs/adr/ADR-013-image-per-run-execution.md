# ADR-013: Image-per-run execution — every agent run is a fresh container from one pinned batteries image

- **Status:** Proposed (2026-10-21). The direction is decided by the operator; this record fixes
  _how_. Not implemented: no runtime behaviour changes until P1 ships behind a per-repo flag.
  Stays Proposed until P0's measurements (cold start, RAM, disk, rootless Docker) are recorded
  here; acceptance follows P1 on the canary repo.
- **Date:** 2026-10-21
- **Context source:** anchors are against `main` @ `59a57af5`. The per-phase evidence list (every
  host-model file and function the migration touches, with `file:line`) is in
  [`docs/plans/image-per-run-execution.md`](../plans/image-per-run-execution.md#evidence). The
  load-bearing anchors:
  `packages/worker/src/agent-run/workflow.ts:1391-1409` (lane, review shape and battery seed are
  resolved per run), `:1425-1455` (admission uid reap, then credential + per-run HOME + battery
  seed), `:1517-1580` (egress proxy, git broker, gh broker), `:1606` (the daemon),
  `:1744`/`:1789` (teardown uid reaps), `:470` (`guardRunTerminal`);
  `packages/worker/src/agent-run/daemon-process.ts:380-410` (cgroup, env, `sudo` spawn as the agent
  uid); `packages/worker/src/agent-run/spawn-as-user.ts:166` (`buildSpawnInvocation`);
  `packages/worker/src/agent-run/agent-credentials.ts:51-130,165-222` (trust seed, per-run HOME,
  `seedBatteries`); `packages/worker/src/agent-run/batteries-seed.ts:754`,
  `packages/worker/src/agent-run/harness-seed.ts:462,583,636,662` (link-only packs);
  `packages/worker/src/agent-run/uid-reaper.ts:441,683`; `packages/worker/src/agent-run/run-cgroup.ts:385,479,547`;
  `packages/worker/src/agent-run/egress-proxy.ts:764` and `git-broker.ts:237` (TCP listeners on
  `127.0.0.1`), `gh-broker.ts:263` (unix socket); `packages/worker/deploy/linux/egress-nft.conf`,
  `loopback-nft.conf` (`meta skuid` fences); `packages/worker/deploy/AGENT-UID-PROVISIONING.md`;
  `packages/worker/deploy/{batteries,harness}.json`; `packages/daemon/src/claude.ts:204`
  (`reviewPolicyArgs`).
- **Deciders:** operator (direction); this ADR proposes the mechanism.
- **Relates to:** ADR-002 (per-org execution plane), ADR-004 (review lane emit-only fence), ADR-005
  (monotone floors), ADR-006 (shape not kind), ADR-007 (box budget, slots, uid-wide kill), ADR-011
  (credential broker), #66 (egress), #81/#113 (broker), #85 (host batteries RFC), #108 (agent uid),
  #152/#184/#186 (uid reaper), #204/#205 (ceiling, slots), #367 (loopback fence), #371 (headroom),
  #386 (run-terminal ledger).
- **Supersedes (on acceptance of P4):** the host-uid execution model of #108 and the link-only
  battery packs of #85 for the Linux execution box. ADR-007's I4 (uid-wide kill) is rewritten, not
  dropped (see "What each host mechanism becomes").

## Context

Today an agent run on the execution box is **a host Unix uid on a shared host**:

- The worker (one systemd unit) clones into `<runDir>/repo`, builds a fresh per-run HOME, writes the
  model credential and a trust seed into it, and **symlinks** the pinned battery packs (gstack,
  GSD, ruflo, Somnio skills, CLIs) into that HOME (`seedBatteries`, `resolveHarnessPacks`). The
  packs are built once per box by `install-batteries.sh` (3,000+ lines) from `batteries.json` and
  `harness.json`, then linked read-only, some of them file by file (`forbiddenHelperTokens`,
  `allowedHelperRefs`, `dropped`).
- The daemon is spawned through `sudo` as a dedicated slot account (`automata-agent`, then
  `automata-agent-<i>` with uids from 2000, #205). Everything that keeps one run away from the
  worker, the engine and other runs is a **host-level fence keyed to that uid**: per-uid nftables
  (`meta skuid … tcp dport {80,443} reject`), a second per-uid loopback table that decides by the
  listener's cgroup (#367), POSIX ACLs on the run namespace (with the ACL-mask trap), `/proc`
  `hidepid`, a delegated cgroup subtree for the memory ceiling (which needs `Delegate=memory pids`
  and drops `ProtectControlGroups`), and a uid-wide reaper that finds `setsid` escapees by scanning
  `ps` for the uid.
- Each of these has needed a live incident to get right (the uid 999 collision with the engine's
  Postgres #210, the ACL mask zeroed by `chmod 600`, `sun_path` truncation, the `ProtectControlGroups`
  remount, the cgroup a socket carries from its creator #367). Adding a slot is a seven-step manual
  procedure (`AGENT-UID-PROVISIONING.md` §6). Adding a battery is a manifest entry plus a link
  layout plus install-script support for its install kind.

The operator's reference works the other way: a Vercel Sandbox image with Dart and the Somnio CLI
installed globally, and the run simply happens inside it. Isolation comes from the sandbox
boundary, and every tool is installed the normal way, as on a developer laptop.

## Decision

**Every agent run on the execution box is a fresh container (`docker create` → copy-in →
`docker start`, removed at teardown) started from ONE pinned "batteries image",
`deploy/images/batteries/Dockerfile`, referenced by digest.**

1. **The image holds every battery, installed normally.** Node 24, the Claude Code CLI, the ruflo
   CLI and its MCP server, `@opengsd/gsd-core`, the full gstack suite with its Playwright Chromium
   builds, the Somnio CLI with every catalog skill installed globally for Claude, the Dart and
   Flutter SDKs on `PATH`, `gh`, `pnpm`, actionlint, gitleaks and shellcheck. Every version is
   pinned by version + sha256, commit sha, committed lockfile, base-image digest or Ubuntu
   snapshot id. linux/amd64. Non-root runtime user (`agent`, uid 10001). No secrets.
2. **Isolation is the container boundary.** Separate mount, pid, network, ipc and uts namespaces;
   its own cgroup with Docker's resource flags; `--cap-drop ALL`, `--security-opt
no-new-privileges`, Docker's default seccomp profile, `--init` as pid 1; never `--privileged`,
   never the Docker socket, never a host path except the run's own directory.
3. **Network is `--network none`.** The run's only ways out are the unix sockets the worker binds in
   the run directory and bind-mounts into the container: the egress proxy, the git broker, the gh
   broker, the daemon socket, and (task runs of opted-in repos) the test Postgres socket. A small
   in-container forwarder (`socat`, in the image) exposes the TCP ones on the loopback ports the
   tools already expect, so `HTTPS_PROXY`, `git` remotes and `TEST_DATABASE_ADMIN_URL` keep their
   shapes.
4. **Policy is per-run and copied in; the image carries none.** The worker writes the run's Claude
   settings, trust seed, MCP registration and model credential into the run directory and copies
   them into the created container's HOME before `docker start` (`docker cp` lands them in the
   container's writable layer, never in `docker inspect`, never on argv or env). The daemon bundle
   is bind-mounted read-only from the worker's own deploy, so worker deploys never need an image
   rebuild.
5. **The worker stays the orchestrator.** Admission, slot locks (ADR-007 I1-I3), headroom (#371),
   brokers, egress proxy, terminal ledger and teardown ordering are unchanged in shape; only the
   _spawn_ and the _fences_ change. We do **not** adopt `@terragon/sandbox`'s `DockerProvider` for
   this: it models a long-lived, resumable sandbox (`tail -f /dev/null` + `exec`, hibernate,
   sidecar containers on per-sandbox `--internal` networks, shell-string commands), while a worker
   run is one-shot with its brokers in the worker heap. Its pure builders and lessons are reused
   (the `:ro` secret-file rule from `docker-cred-broker.ts`, the `--internal` network as a fallback
   egress shape from `docker-egress.ts`).
6. **Rollout is per repo.** A per-repo `execution: host | container` setting, resolved by the control
   plane onto the run input exactly like `egressPolicy` (`apps/www/src/agent/hatchet/dispatch.ts:959-983`),
   switches one repo at a time (P1-P3). The host path is deleted only in P4.

## What each existing host mechanism becomes

| Host mechanism today                                                                                                                                                               | Container model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Egress fence**: per-uid nftables (`egress-nft.conf`) rejects 80/443 for the agent uid; the worker's in-process proxy (`startEgressProxy`, TCP `127.0.0.1:0`) enforces the policy | `--network none` gives the container no route at all, so the fence is structural rather than a uid rule. The **same proxy** keeps deciding (allowlist, audit events, observe vs enforce); it listens on a unix socket in the run dir instead of a TCP port (a small worker change: `server.listen(path)`), bind-mounted into the container and bridged to `127.0.0.1:3128` inside by `socat`. Fallback if a tool cannot use a proxy: a per-run `--internal` network with the proxy reachable on it (the `docker-egress.ts` shape).                              |
| **Loopback fence** (#367): `loopback-nft.conf`, `meta skuid` + listener cgroup, reloaded at every worker start                                                                     | Not needed for container runs: the container's loopback is its own, so the engine (`:7077`, `:8888`), its Postgres and every host listener are simply unreachable. Retired in P4.                                                                                                                                                                                                                                                                                                                                                                               |
| **Credential broker** (#81): git broker on TCP loopback, gh broker on a unix socket, real token in the worker heap                                                                 | Unchanged custody: the token never enters the container. The gh broker socket is bind-mounted as-is; the git broker moves to a unix socket and is bridged like the proxy. A run whose lane gets no broker gets **no socket mounted** (absence, not denial).                                                                                                                                                                                                                                                                                                     |
| **Cgroup slot ceiling** (#204): delegated subtree, `memory.max`/`pids.max` per run, `10-ceiling.conf` drops `ProtectControlGroups`                                                 | Docker's own flags on each container: `--memory=$WORKER_RUN_MEMORY_MAX --memory-swap=$WORKER_RUN_MEMORY_MAX` (no swap), `--pids-limit=$WORKER_RUN_TASKS_MAX`, `--cpus`. OOM attribution from `docker inspect .State.OOMKilled` and the container scope's `memory.events`. The worker unit no longer needs `Delegate=` nor the `ProtectControlGroups` relaxation. A `systemd-run --scope` was measured unusable in #204 (polkit, no user bus) and is not revisited. The box budget (ADR-007, #371 headroom) still applies: the sum of container limits must fit. |
| **Uid reaper** (#152/#184/#186): `ps` scan for the slot uid at boot, admission and teardown; `kill -1` as the slot account                                                         | Container lifecycle. Every process of a run lives in the container's pid namespace under `--init`; `docker rm -f` (SIGKILL to the namespace) kills all of it, `setsid` escapees included — the escapee class closes by construction. Boot scan = remove every container labelled with this worker's id (all are orphans at boot). Admission = remove any container already holding this slot's name. ADR-007 I2 ordering stays: the slot is released only after the container is gone.                                                                          |
| **Daemon socket**: `runSocketPath` under the run namespace, ACL'd to the slot uid                                                                                                  | A per-run `sock/` directory bind-mounted at `/run/automata`; the daemon creates its socket there. Permission model (gid shared via `--group-add`, or a mode-0770 dir owned by a dedicated group) is a P0 measurement — it must also survive userns-remap/rootless uid mapping.                                                                                                                                                                                                                                                                                  |
| **Run HOME**: fresh per-run dir under `<runDir>`, credential + trust + settings written, packs symlinked in                                                                        | The container's own `/home/agent` from the image (batteries already installed there), made fresh per run by the container's writable layer. Run-specific files (credential, `.claude.json`, `settings.json` with deny rules and the foreground-only hook) are copied in before start and vanish with the container.                                                                                                                                                                                                                                             |
| **Workspace trust**: `.claude.json` `projects[<workdir>].hasTrustDialogAccepted`, seeded for the raw and the realpath'd path                                                       | Same seed, one fixed path: the clone is bind-mounted at `/workspace`, so the realpath trap is gone. Still written per run (it is policy, and it is what makes review mode honour `.claude/settings.json` in `-p`).                                                                                                                                                                                                                                                                                                                                              |
| **Run-terminal ledger** (#386): worker-side, keyed by workflow run id                                                                                                              | Unchanged. It sits before admission, so a redelivered run is refused before any container exists. Container names derive from `(workerId, slot)` so a crash-redelivered run removes its predecessor's container on admission.                                                                                                                                                                                                                                                                                                                                   |
| **Review-lane fence** (ADR-004): no GitHub credential in the review spawn env, `reviewPolicyArgs` permission mode, plus link-only packs and dropped batteries (install hiding)     | **Run-time policy, not install hiding.** The image installs everything for every lane. The review lane gets (1) no git/gh broker socket and no write token in the container, (2) `--permission-mode default` with the existing `reviewPolicyArgs` allow/deny lists, (3) the settings, deny rules and MCP tool allowlist the worker copies in (for example a `Skill(cso)` deny replaces the dropped `gstack-cso` battery), and (4) its egress policy. ADR-004's invariant is unchanged: a review container holds no credential that can write to GitHub.         |
| **`/proc` hidepid** (`20-hidepid.conf`), slot accounts outside `staff`, workdir traverse ACLs                                                                                      | Not needed: the pid namespace hides other runs and the worker; the mount namespace exposes only the run's own directory.                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Persistent per-repo ruflo memory (optional)

ruflo's memory is useful across runs of the same repo. It becomes an **optional, off-by-default
named volume** per repo (`automata-ruflo-<repo-id>`), mounted only when the repo opts in. Where
ruflo writes its store (cwd-relative directory or a configurable path) is confirmed in P0 before
the mount point is fixed.

**Poisoning risk, called out:** a run on an untrusted PR can write memories that a later run (on
`main`, or a self-heal fix) reads back as context — a persistent prompt injection that outlives the
PR. Therefore: the review lane and every run on a fork or untrusted branch never mount it (or mount
it read-only); only trusted task runs may write; volumes are per repo, never shared; each write run
snapshots the volume first so a poisoned state can be rolled back; and the store is never treated as
instructions by our own prompts.

## Image build, pinning, provenance and rollout

- **Source:** `deploy/images/batteries/Dockerfile`, context `packages/worker/deploy` (it reuses the
  committed GSD/ruflo lockfiles and the Somnio `pubspec.lock` overlay). Pins are copied from
  `batteries.json`, `harness.json` and `cloud-init.yaml`, so host and container run the same builds
  during the migration. One deliberate difference: the operator's reference pins the Somnio CLI at
  `aa91cefe…`, which is 5 commits behind the `aa53f071…` the repo already pins; the image keeps the
  repo's pin.
- **Build:** CI (a workflow on changes under `deploy/images/batteries/**`) with `docker buildx
--platform linux/amd64`, BuildKit SBOM and max-mode provenance attestations, then `verify.sh`
  against the built image, then push to the registry tagged with the commit sha.
- **Reference by digest only.** The worker takes `WORKER_BATTERIES_IMAGE=<repo>@sha256:<digest>` and
  refuses a tag reference at boot. The box verifies the attestation (`gh attestation verify` or
  cosign) before first use of a digest.
- **Rollout:** pre-pull the new digest on the box (`docker pull …@sha256:…`), run `verify.sh`
  against it, then change the worker env and restart at an idle moment. The previous digest stays
  pulled until the next bump, so rolling back is an env change. A bump that changes a battery
  version is a normal reviewed PR, like a manifest bump today.

## Risks

- **The Docker daemon is a root surface.** Whoever can talk to `dockerd` is root on the box. The
  worker must not simply join the `docker` group. In order of preference, measured in P0:
  1. **Rootless Docker** for agent runs: a second, rootless daemon owned by a dedicated user. It
     also separates agent containers from the engine's rootful daemon and networks. Needs cgroup v2
     delegation to that user's systemd instance for `--memory`/`--pids-limit` to work.
  2. **userns-remap** on a dedicated daemon (not on the engine's daemon: remapping would change
     ownership semantics of the engine's Postgres volume).
  3. **gVisor (`runsc`)** as the runtime for agent containers: strongest kernel isolation; cost on
     file-heavy work (pub, npm, Flutter builds) and Chromium compatibility must be measured.
  4. Whatever the daemon, the worker reaches it only through a **narrow root-owned helper** (one
     sudoers line, the way `spawn-as-user.ts` reaches `sudo` today) that accepts a fixed argv shape:
     image digest from config, run-dir-only mounts, `--network none`, `--cap-drop ALL`, never
     `--privileged`, never a socket outside the run dir.
- **Chromium in an unprivileged container** cannot use its own user-namespace sandbox under
  Docker's default seccomp profile; gstack's browse must run with `--no-sandbox` (the container is
  the sandbox) or with a seccomp profile that allows it. Measured in P0.
- **Image size.** Estimated 5-7 GB uncompressed (Flutter ~1.5 GB, Dart ~0.5 GB, two Chromium builds
  ~0.7 GB, the ruflo closure with ONNX runtime and model ~0.5 GB, the rest ~1 GB). Two digests are
  kept during a rollout. P0 records the real `docker image inspect` size and `df` headroom.
- **Cold start.** `create` + copy-in + `start` from a local image should be about a second; a
  first pull of a new digest is minutes and must never happen on the run path (pre-pull is part of
  rollout; the worker refuses a digest that is not present locally).
- **Memory on a CPX42-class box.** Task runs have peaked around 5 GB. The container itself adds
  little (pid 1 + shim, tens of MB), and image pages are shared page cache across containers, but
  the per-run `--memory` must be set from the box's slot tuple (#372) so that slots × ceiling +
  engine + worker fits the box, exactly as `WORKER_RUN_MEMORY_MAX` must today. The #371 headroom
  check stays the admission guard.
- **Writable root filesystem.** Flutter writes its own `bin/cache` and `pub get` writes
  `PUB_CACHE`, so the first version runs with a writable (ephemeral) container layer, not
  `--read-only`. Redirecting those caches to a tmpfs and going read-only is a later hardening.
- **Same uid in every container.** Without a userns mapping every run's `agent` is host uid 10001.
  Containers cannot signal or see each other (pid/mount namespaces), and bind mounts are per run,
  so this is acceptable; it is one more reason to prefer rootless or remapped daemons.
- **Docker as a new dependency of the run path.** A wedged `dockerd` stops every run. The worker
  probes the daemon at boot and at admission and fails the run non-retryably with a clear line, the
  way a missing box-lock helper does today.

## Rollback

- **P1-P3:** set the repo's `execution` back to `host`; it takes effect on the next run, with no
  worker restart. A global `WORKER_EXECUTION_CONTAINER=off` forces every run to the host path (needs
  a restart). The host machinery is untouched until P4.
- **A bad image:** point `WORKER_BATTERIES_IMAGE` back at the previous, still-pulled digest.
- **After P4:** rollback means redeploying the last pre-P4 worker revision (tagged `pre-image-p4`)
  and re-running `install-batteries.sh` and the agent-uid provisioning. That is expensive, which is
  why P4 has the strictest gate.

## What becomes obsolete, and when it can be deleted

Deleted in **P4**, only after every lane has run on containers for 14 consecutive days with zero
host-path runs and no open container-path incident:

- **Battery linking:** `batteries-seed.ts`, `harness-seed.ts`, `batteries-manifest.ts`,
  `harness-manifest.ts`, `harness-layout.ts`, `foreground-only-hook.ts`'s HOME-merge path (the hook
  itself moves into the copied-in settings), `deploy/batteries.json`, `deploy/harness.json`,
  `linux/install-batteries.sh`, `linux/automata-batteries`, `linux/batteries-dry-run.sh`,
  `linux/harness-mcp-probe.mjs`, and the host acceptance scripts' battery sections. The lockfiles
  under `deploy/batteries/{gsd,ruflo,somnio-cli}` move next to the Dockerfile; `harness-mcp-filter.mjs`
  survives if the MCP allowlist still needs it inside the container.
- **Agent-uid provisioning:** `AGENT-UID-PROVISIONING.md`, `spawn-as-user.ts` (the `sudo -u` path),
  `agent-uid-fs.ts`, `uid-reaper.ts`, `box-slots-boot.ts`'s account/sudoers/hidepid/fence checks,
  `run-cgroup.ts`, `sudoers.d-automata` (reduced to the container helper line),
  `linux/egress-nft.conf` + `automata-egress.service` + `nft-preflight.sh` + `nft-verify.sh`,
  `linux/loopback-nft.conf` + `nft-loopback-load.sh` (and the worker unit's `ExecStartPre=+` that
  loads it), `automata-worker.service.d/10-ceiling.conf` and `20-hidepid.conf`, and the slot-account
  steps of `cloud-init.yaml`.
- **Kept:** box locks and slots (ADR-007 I1-I3), headroom (#371), the run-terminal ledger (#386),
  the egress proxy, both brokers, the payload seal (#380), the daemon and its adapters.

## Anti-deviation invariants

- **I1** The image contains no secret and no per-run policy. Credentials, trust, settings and MCP
  registration are copied in per run; a build arg is never a credential.
- **I2** An agent container never gets the Docker socket, `--privileged`, a host network, or a
  bind mount outside its own run directory (plus the read-only daemon bundle).
- **I3** A container's network is `none` (or a per-run `--internal` network in the documented
  fallback). Its only egress is the worker's proxy; there is no path to host loopback.
- **I4** A review-lane container holds no credential that can write to GitHub: no broker socket,
  no token in env or files (ADR-004 unchanged).
- **I5** The worker runs images by digest only and never pulls on the run path.
- **I6** A box slot is released only after its container is gone (ADR-007 I2, restated).

## Options considered

1. **Keep the host-uid model and keep hardening it.** Rejected by the operator: every fence is a
   host-global, uid-keyed mechanism with its own incident history, and every battery needs bespoke
   link support.
2. **`@terragon/sandbox` `DockerProvider` as the run path.** Rejected for the worker (see Decision
   5); its builders are reused.
3. **One long-lived container per slot, runs `exec`'d into it.** Rejected: state would leak between
   runs, which is exactly what per-run HOMEs exist to prevent.
4. **microVMs (Firecracker / Kata).** Stronger isolation, but a much larger operational change on a
   single box. Revisit if gVisor's cost is unacceptable and the rootless measurements disappoint.

## Testing

P0 is measured on the box (see the plan); P1 adds unit tests for the container argv builder (pure,
like `docker-egress.ts`), an integration test that starts a real container with `--network none` and
proves the proxy socket is the only way out, and a review-lane test asserting no broker socket and
no token reach the container. The plan lists acceptance criteria and kill switches per phase.

## Open questions (need the operator)

1. **Docker trust model.** Rootless dedicated daemon (preferred), userns-remap on a dedicated
   daemon, or gVisor — and is a narrow sudo helper the acceptable (only) path from the worker to
   Docker? P0 measures; the operator picks.
2. **One Dart or two.** Flutter 3.47.7 bundles Dart 3.13.5, the same version as the standalone SDK
   the reference installs. Dropping `/opt/dart-sdk` saves about 0.5 GB.
3. **Somnio agent rules.** The CLI installs rules for Claude per project only. Install them into
   each run's checkout (git-excluded, chosen stacks) or not at all?
4. **Registry and visibility** for the image (it holds no secrets, but redistributes third-party
   tools).
5. **Persistent ruflo memory**: enable at all, and which lanes may write.
6. **P1 flag storage**: a per-repo column (migration first) as specified, or a worker-side
   allowlist for the canary only.
7. **Canary repo** for P1.
