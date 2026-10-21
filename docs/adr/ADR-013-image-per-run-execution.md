# ADR-013: Image-per-run execution — every agent run is a fresh container from one pinned batteries image

- **Status:** Proposed (2026-10-21). The operator decided the direction and locked the open points on
  2026-10-21 (see "Locked decisions"); this record fixes _how_. Not implemented: no runtime
  behaviour changes before the release PR (P3). It stays Proposed until P0's measurements (rootless
  cgroup enforcement, cold start, RAM, disk) are recorded here, and is Accepted with the release PR.
- **Date:** 2026-10-21
- **Context source:** anchors are against `main` @ `1a13f49a`. The per-phase evidence list (every
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
  `loopback-nft.conf:84,110,133` (`meta skuid` fences); `packages/worker/deploy/AGENT-UID-PROVISIONING.md`;
  `packages/worker/deploy/{batteries,harness}.json`; `packages/daemon/src/claude.ts:204`
  (`reviewPolicyArgs`).
- **Deciders:** operator (direction and the locked decisions); this ADR specifies the mechanism.
- **Relates to:** ADR-002 (per-org execution plane; revision note below), ADR-004 (review lane
  emit-only fence), ADR-005 (monotone floors), ADR-006 (shape not kind), ADR-007 (box budget, slots,
  uid-wide kill), ADR-011 (credential broker), #66 (egress), #81/#113 (broker), #108 (agent uid),
  #152/#184/#186 (uid reaper), #204/#205 (ceiling, slots), #367 (loopback fence), #371 (headroom),
  #372 (slot tuple), #374/#375 (separate fleet work), #386 (run-terminal ledger).
- **Supersedes:** Cloudflare Sandboxes as the run-isolation direction (#112) and the host-batteries
  RFC (#85), now. On release (P3): the host-uid execution model of #108 and the link-only battery
  packs of #85 for the Linux execution box. ADR-007's I4 (uid-wide kill) is rewritten, not dropped
  (see "What each host mechanism becomes").

## Locked decisions (operator, 2026-10-21)

| Topic               | Decision                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope of "done"     | **All** lanes run in containers (review, pr/mention/companion, task, self-heal) **and** the host-uid machinery is deleted.                                                                                               |
| Rollout             | A **hard switch** in one release PR. No long-lived per-repo `execution: host \| container` flag. Rollback = `git revert` of the release PR + redeploy.                                                                   |
| Registry            | **Public GHCR**, `ghcr.io/be-automata/automata-batteries`, built and pushed by `.github/workflows/batteries-image.yml`. The box pins the **digest**, never a tag.                                                        |
| Docker trust model  | A **dedicated rootless Docker daemon** under an unprivileged user, used only for agent runs, separate from the root daemon that runs the engine stack. The worker reaches its socket without `sudo`; no sudo helper.     |
| Hardening baseline  | `--network none`; unix-socket bridges via `socat`; `--cap-drop ALL`; `no-new-privileges`; read-only rootfs; default seccomp; `--init`; writable workspace/HOME only; limits from the slot tuple. **gVisor is deferred.** |
| Dart                | Flutter's bundled Dart only. The standalone SDK is gone from the image (−0.64 GB).                                                                                                                                       |
| Somnio agent rules  | Installed **per run into the checkout**, for every lane, with the written paths added to `.git/info/exclude` (see "Run path").                                                                                           |
| Fleet               | **In scope**: one idempotent provisioning script (rootless daemon, image pull by digest, worker), proven on a fresh throwaway box. #374/#375 stay separate.                                                              |
| Ruflo memory        | **Out of scope** (poisoning risk). A future option only.                                                                                                                                                                 |
| Concurrency         | Stays **3 slots, ≤ 2 per org** (#372). Resizing the box is allowed if the measurements need it.                                                                                                                          |
| Superseded          | Cloudflare Sandboxes (#112) and the host-batteries RFC (#85).                                                                                                                                                            |
| Security acceptance | The invariants are re-proven by **live probes from inside a run container** (list under "Security probes"), plus a revision note on ADR-002.                                                                             |

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
  remount, the cgroup a socket carries from its creator #367). Adding a slot is a five-step manual
  procedure (`AGENT-UID-PROVISIONING.md` §6). Adding a battery is a manifest entry plus a link
  layout plus install-script support for its install kind.
- **A known defect the host model cannot fix cheaply (observed 2026-10-21):** gstack's `browse`
  starts its own HTTP server on loopback and then connects to it. As an agent uid that connect is
  judged by the #367 loopback fence, which accepts only listeners in the worker's cgroup
  (`packages/worker/deploy/linux/loopback-nft.conf:110`) and resets everything else (`:133`); the
  browse server's socket lives in the run's cgroup, so `browse goto` fails. `install-batteries.sh`'s
  harness acceptance therefore fails at that check (`packages/worker/deploy/linux/automata-batteries:287`)
  and invalidates `harness.sha256` (`install-batteries.sh:3136-3137`). Allowing it means teaching a
  host-global fence about per-run listeners; in a container the run's loopback is its own and the
  problem does not exist.

The operator's reference works the other way: a sandbox image with Flutter and the Somnio CLI
installed globally, and the run simply happens inside it. Isolation comes from the sandbox
boundary, and every tool is installed the normal way, as on a developer laptop.

## Decision

**Every agent run on the execution box, in every lane, is a fresh container (`docker create` →
copy-in → `docker start`, removed at teardown) started from ONE pinned "batteries image",
`deploy/images/batteries/Dockerfile`, referenced by digest, on a dedicated rootless Docker daemon.**

1. **The image holds every battery, installed normally.** Node 24, the Claude Code CLI, the ruflo
   CLI and its MCP server, `@opengsd/gsd-core`, the full gstack suite with its Playwright Chromium
   builds, the Somnio CLI (compiled ahead of time) with every catalog skill installed globally for
   Claude, the Flutter SDK (its bundled Dart is the only Dart), `gh`, `pnpm`, actionlint, gitleaks
   and shellcheck. Every version is pinned by version + sha256, commit sha, committed lockfile,
   base-image digest or Ubuntu snapshot id. linux/amd64. Non-root runtime user (`agent`, uid 10001).
   No secrets, no per-run policy: the hooks gstack and GSD register are kept as
   `~/.claude/settings.batteries.json` for the worker to merge per lane, and Claude's build-time
   `~/.claude.json` (a machine id and user id that would be identical in every container) is
   removed.
2. **A dedicated rootless Docker daemon runs the agent containers.** It runs as an unprivileged
   system user (`automata-runner`, no login, no sudo) under that user's systemd instance, with its
   own data root, separate from the rootful daemon that runs the engine stack. Root inside a
   container is that unprivileged user on the host, and every other container uid (including
   `agent`) is a subordinate uid with no host identity. The worker reaches the daemon's socket
   through a group grant on a socket path outside the run namespaces, **without `sudo`**: being
   able to drive that daemon is being able to act as `automata-runner`, never as host root. The
   worker never joins the `docker` group of the rootful daemon.
3. **Hardening baseline, on every run container:**
   - `--network none`: no interface but the container's own loopback.
   - The run's only ways out are unix sockets the worker binds in the run directory and
     bind-mounts in: the egress proxy, the git broker, the gh broker, the daemon socket and (task
     runs of opted-in repos) the test Postgres socket. `socat` in the image bridges the TCP ones to
     the loopback ports the tools expect (`127.0.0.1:3128` for `HTTPS_PROXY`, the git broker port,
     `127.0.0.1:25432` for `TEST_DATABASE_ADMIN_URL`), so the tools' configuration keeps its shape.
   - `--cap-drop ALL`, `--security-opt no-new-privileges`, Docker's default seccomp profile,
     `--init` as pid 1. Never `--privileged`, never a Docker socket, never a host path except the
     run's own directory and the read-only daemon bundle.
   - `--read-only` root filesystem. Writable: `/workspace` (bind mount of the run's clone), `HOME`
     and `/opt/flutter` (per-run anonymous volumes, populated from the image at create and removed
     with the container; Flutter writes stamps and a lock under `bin/cache` on every invocation),
     `/tmp` (`--tmpfs`) and `/dev/shm` (`--shm-size`, for Chromium). Nothing else.
   - Limits from the slot tuple (#372): `--memory=$WORKER_RUN_MEMORY_MAX
--memory-swap=$WORKER_RUN_MEMORY_MAX` (no swap), `--pids-limit=$WORKER_RUN_TASKS_MAX`,
     `--cpus`. Under rootless these need cgroup v2 delegation to the daemon user's systemd
     instance (`Delegate=cpu cpuset io memory pids` on `user@<uid>.service`); **P0 must prove all
     three are enforced, or the migration stops** (see Risks).
   - gVisor (`runsc`) is deferred: revisit only if a probe shows a gap the baseline cannot close.
4. **Policy is per run and copied in; the image carries none.** The worker writes the run's Claude
   settings (its deny rules, the foreground-only hook and the lane's share of
   `settings.batteries.json`), trust seed, MCP registration and model credential into the run
   directory and copies them into the created container's HOME volume before `docker start`
   (`docker cp`: never in `docker inspect`, never on argv or env). The daemon bundle is
   bind-mounted read-only from the worker's own deploy, so a worker deploy never needs an image
   rebuild.
5. **The worker stays the orchestrator.** Admission, slot locks (ADR-007 I1-I3), headroom (#371),
   brokers, egress proxy, terminal ledger and teardown ordering are unchanged in shape; only the
   _spawn_ and the _fences_ change. We do **not** adopt `@terragon/sandbox`'s `DockerProvider` for
   this: it models a long-lived, resumable sandbox (`tail -f /dev/null` + `exec`, hibernate,
   sidecar containers on per-sandbox `--internal` networks, shell-string commands), while a worker
   run is one-shot with its brokers in the worker heap. Its pure builders and lessons are reused
   (the `:ro` secret-file rule from `docker-cred-broker.ts`, the argv-builder style of
   `docker-egress.ts`).
6. **Hard switch.** The container path is built dark on `main` (P1), proven on a throwaway box
   (P1-P2), then made the only path in one release PR that also deletes the host-uid machinery
   (P3). There is no per-repo or per-lane execution setting at any point. **One internal, dev-only
   switch exists before the release PR**: `WORKER_DEV_CONTAINER_RUNS=1` (off when unset; the
   worker logs a boot warning when it is on). It exists so the dark path can merge in small
   reviewed PRs and run real lanes on the throwaway box without a long-lived branch. It is never
   set on the production box (the provisioning script never writes it; only the throwaway box's
   env sets it by hand), and the release PR deletes it along with the host path.

## Run path (what a run does, in order)

1. **Admission** (unchanged): run-terminal ledger (#386), slot lock, headroom. Then remove any
   container still holding this slot's name (`automata-run-<workerId>-<slot>`), so a crash-redelivered
   run never meets its predecessor.
2. **Workdir**: clone into `<runDir>/repo` as today; bind the brokers, proxy and daemon sockets in
   `<runDir>/sock/`.
3. **Create**: `docker create` with the hardening baseline, the image digest from
   `WORKER_BATTERIES_IMAGE`, labels `automata.worker=<workerId>`, `automata.run=<runId>`,
   `automata.lane=<lane>`, `<runDir>/repo` → `/workspace`, `<runDir>/sock` → `/run/automata`, the
   daemon bundle read-only. The review lane gets no git/gh broker socket at all (absence, not
   denial).
4. **Copy in** the per-run policy files (Decision 4).
5. **Start**. The container's entry step, before the daemon starts:
   1. starts the `socat` bridges for the sockets that are present;
   2. **installs the Somnio agent rules into the checkout, for every lane**:
      `somnio -q rules install --agent claude --project --stacks <stacks>` in `/workspace`, where
      `<stacks>` comes from the checkout's marker files (`pubspec.yaml` → `dart` and, if it
      depends on the Flutter SDK, `flutter`; `tsconfig.json` → `typescript`; a `react` dependency →
      `react`; `@nestjs/core` → `nestjs`; `pyproject.toml`/`requirements*.txt` → `python`, plus
      `django`/`fastapi`/`flask` by dependency; `*.csproj` → `dotnet`; Firebase `functions/` →
      `functions`), and nothing is installed when no stack matches. The installer rewrites
      `CLAUDE.md` and any same-named rule file even when the repo tracks them (measured
      2026-10-21), so the step then restores every tracked path it changed
      (`git diff --name-only -z | xargs -0r git checkout --`; the repo's own files win) and appends
      every path it added (`git ls-files --others --exclude-standard`, anchored with a leading `/`)
      to `.git/info/exclude`. The checkout's `git status` is clean afterwards, so nothing the
      installer wrote can be committed or reviewed as part of the change. `verify.sh` exercises
      exactly this sequence. (The `somnio skills install --agent claude --project` form installs
      the 25 catalog skills per project; the image already has them globally, so the run installs
      rules only.)
   3. execs the daemon.
6. **Run** (unchanged daemon protocol over `/run/automata`).
7. **Teardown**: `docker rm -f -v` (SIGKILL to the whole pid namespace, anonymous volumes
   removed), read `.State.OOMKilled` first; the slot is released only after the container is gone
   (ADR-007 I2). **Boot**: remove every container labelled `automata.worker=<workerId>` (all are
   orphans at boot).

## What each existing host mechanism becomes

| Host mechanism today                                                                                                                                                               | Container model                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Egress fence**: per-uid nftables (`egress-nft.conf`) rejects 80/443 for the agent uid; the worker's in-process proxy (`startEgressProxy`, TCP `127.0.0.1:0`) enforces the policy | `--network none` gives the container no route at all, so the fence is structural rather than a uid rule. The **same proxy** keeps deciding (allowlist, audit events, observe vs enforce); it listens on a unix socket in the run dir instead of a TCP port (a small worker change: `server.listen(path)`), bind-mounted in and bridged to `127.0.0.1:3128` by `socat`.                                                               |
| **Loopback fence** (#367): `loopback-nft.conf`, `meta skuid` + listener cgroup, reloaded at every worker start                                                                     | Not needed: the container's loopback is its own, so the engine (`:7077`, `:8888`), its Postgres and every host listener are unreachable, and a tool's own loopback server (gstack `browse`) just works. Deleted in the release PR.                                                                                                                                                                                                   |
| **Credential broker** (#81): git broker on TCP loopback, gh broker on a unix socket, real token in the worker heap                                                                 | Unchanged custody: the token never enters the container. The gh broker socket is bind-mounted as-is; the git broker moves to a unix socket and is bridged like the proxy. A lane that gets no broker gets **no socket mounted**.                                                                                                                                                                                                     |
| **Cgroup slot ceiling** (#204): delegated subtree, `memory.max`/`pids.max` per run, `10-ceiling.conf` drops `ProtectControlGroups`                                                 | Docker's flags on each container (Decision 3), enforced through the rootless daemon's delegated cgroup v2 subtree. OOM attribution from `.State.OOMKilled` and the container's `memory.events`. The worker unit no longer needs `Delegate=` nor the `ProtectControlGroups` relaxation. The box budget (ADR-007, #371 headroom) still applies: the sum of container limits must fit.                                                  |
| **Uid reaper** (#152/#184/#186): `ps` scan for the slot uid at boot, admission and teardown; `kill -1` as the slot account                                                         | Container lifecycle. Every process of a run lives in the container's pid namespace under `--init`; `docker rm -f` kills all of it, `setsid` escapees included — the escapee class closes by construction. Boot and admission remove by label and by slot name (Run path 1, 7).                                                                                                                                                       |
| **Daemon socket**: `runSocketPath` under the run namespace, ACL'd to the slot uid                                                                                                  | `<runDir>/sock/` bind-mounted at `/run/automata`. Under rootless, container uid 10001 is a subordinate host uid, so the directory is handed over by group, not by ACL: `<runDir>` is setgid and group-owned by `automata-runner`'s primary group (container gid 0), the worker is a member, and the container runs with `--group-add 0`. P0 measures this; it also covers the writable `/workspace` bind mount.                      |
| **Run HOME**: fresh per-run dir under `<runDir>`, credential + trust + settings written, packs symlinked in                                                                        | The image's `/home/agent` (batteries already installed there), as a per-run anonymous volume populated at create and removed with the container. Run-specific files are copied in before start.                                                                                                                                                                                                                                      |
| **Workspace trust**: `.claude.json` `projects[<workdir>].hasTrustDialogAccepted`, seeded for the raw and the realpath'd path                                                       | Same seed, one fixed path: the clone is always `/workspace`, so the realpath trap is gone. Still written per run (it is policy, and it is what makes review mode honour `.claude/settings.json` in `-p`).                                                                                                                                                                                                                            |
| **Run-terminal ledger** (#386): worker-side, keyed by workflow run id                                                                                                              | Unchanged. It sits before admission, so a redelivered run is refused before any container exists.                                                                                                                                                                                                                                                                                                                                    |
| **Review-lane fence** (ADR-004): no GitHub credential in the review spawn env, `reviewPolicyArgs` permission mode, plus link-only packs and dropped batteries (install hiding)     | **Run-time policy, not install hiding.** The image installs everything for every lane. The review lane gets (1) no git/gh broker socket and no write token in the container, (2) `--permission-mode default` with the existing `reviewPolicyArgs` allow/deny lists, (3) the settings, deny rules and MCP tool allowlist the worker copies in (a `Skill(cso)` deny replaces the dropped `gstack-cso` battery), (4) its egress policy. |
| **`/proc` hidepid** (`20-hidepid.conf`), slot accounts outside `staff`, workdir traverse ACLs                                                                                      | Not needed: the pid namespace hides other runs and the worker; the mount namespace exposes only the run's own directory.                                                                                                                                                                                                                                                                                                             |

## Image build, pinning, provenance and rollout

- **Source:** `deploy/images/batteries/Dockerfile`, context `packages/worker/deploy` (it reuses the
  committed GSD/ruflo lockfiles and the Somnio `pubspec.lock` overlay). Pins are copied from
  `batteries.json`, `harness.json` and `cloud-init.yaml`. One deliberate difference: the operator's
  reference pins the Somnio CLI at `aa91cefe…`, 5 commits behind the `aa53f071…` the repo already
  pins; the image keeps the repo's pin.
- **Build and publish:** `.github/workflows/batteries-image.yml`, on changes to
  `deploy/images/batteries/**`, the three lockfile dirs it copies, or the workflow itself.
  `docker buildx build --platform linux/amd64` on a GitHub-hosted runner (disk freed first), then
  `verify.sh` against the built image. Pull requests build and verify only. On `main` it also
  pushes `ghcr.io/be-automata/automata-batteries:sha-<commit>`, attests build provenance for the
  pushed digest, and writes the digest to the job summary. It uses `GITHUB_TOKEN` with
  `packages: write`; no other credential.
- **Public package.** The org is on GitHub Free, where private packages are capped at 500 MB of
  storage; the image is several GB and holds no secrets, so the package is public. Making it public
  is a one-time manual step after the first push (procedure in
  [`deploy/images/batteries/README.md`](../../deploy/images/batteries/README.md#publish)).
- **Reference by digest only.** The worker takes
  `WORKER_BATTERIES_IMAGE=ghcr.io/be-automata/automata-batteries@sha256:<digest>`, refuses a tag
  reference at boot, and refuses a digest that is not present in the rootless daemon's store. The
  box verifies the attestation (`gh attestation verify oci://…@sha256:… --repo be-automata/automata`)
  before first use of a digest.
- **Rollout of a new digest:** the provisioning script pulls it by digest and runs `verify.sh`
  against it; then the worker env changes and the worker restarts at an idle moment. The previous
  digest stays pulled until the next bump, so rolling an image back is an env change. A bump that
  changes a battery version is a normal reviewed PR.

## Fleet: one provisioning script

`deploy/provision-execution-box.sh` (P2) brings a fresh Ubuntu 24.04 box, or an existing one, to
the container model, idempotently: packages (`docker-ce`, `docker-ce-rootless-extras`, `uidmap`,
`dbus-user-session`, `socat`); the `automata-runner` user with its subuid/subgid range and
lingering enabled; cgroup v2 delegation for `user@<uid>.service`; the rootless daemon with its data
root, socket path and group grant; the image pulled **by digest** and checked with `verify.sh` and
`gh attestation verify`; the worker unit and its env. Every step checks before it changes, so a
second run is a no-op. It is proven on a fresh throwaway box (twice in a row: the second run
changes nothing) before it touches the production box. Multi-box scheduling and box registration
(#374/#375) stay separate.

## Security probes (acceptance for P2 and the release)

Run from **inside a run container** on the throwaway box (P2) and on the production box right after
the release deploy, by a probe script the worker can launch as a run of a dedicated probe lane. Each
probe has an expected result; any other result fails the release:

1. **Egress to a non-allowlisted host is denied and logged**: `curl https://example.org` through the
   proxy is refused and an egress audit row is written; without the proxy there is no route.
2. **Engine ports are unreachable**: connecting to the host's `7077` and `8888` (and every host
   address) fails.
3. **Container root is not host root**: the container's uid map shows root mapped to
   `automata-runner`'s uid and `agent` to a subordinate uid.
4. **No capabilities**: `CapEff`, `CapPrm` and `CapBnd` are zero; `NoNewPrivs` is 1.
5. **Read-only rootfs**: writing outside `/workspace`, `HOME`, `/opt/flutter`, `/tmp`, `/dev/shm`
   fails with `EROFS`.
6. **A review container holds no write credential**: no broker socket under `/run/automata`, no
   GitHub token in env or files, and `git push` from `/workspace` fails.
7. **Concurrent runs cannot see each other**: two probe containers started together see only their
   own processes, files and sockets.

`verify.sh` already asserts 3 (non-root), 4 and 5 against the image at build time.

### ADR-002 revision note (lands with the release PR)

ADR-002 is not edited now: it describes the box as it is. The release PR appends this revision to
its header:

> **Revision 4 (on release of ADR-013):** on the Linux execution box, an agent run no longer
> executes as a host uid. Every run is a fresh container from one pinned image on a dedicated
> rootless Docker daemon, with no network but unix-socket bridges to the worker's egress proxy and
> brokers. The control/execution split and the credential-placement rules (Decision §3, §4, R3.4)
> are unchanged: the GitHub token stays in the worker, and a review container holds no write
> credential. Layer 3 customization packs (R3.1, R3.3) become image contents, bumped by a reviewed
> PR to the image, not packs linked into a HOME.

## Out of scope

- **Persistent per-repo ruflo memory.** Not built. A run on an untrusted PR could write memories
  that a later run on `main` or a self-heal fix reads back as context, a persistent prompt injection
  that outlives the PR. A future option would need per-repo volumes, no mount on review or
  untrusted-branch runs, write access for trusted task runs only, and snapshots for rollback.
- gVisor, microVMs, multi-box scheduling (#374/#375).

## Risks

- **Rootless resource limits (blocker).** If P0 cannot show `--memory`, `--pids-limit` and `--cpus`
  enforced under the rootless daemon (a container at its ceiling is OOM-killed, a fork bomb stops at
  the limit, a CPU burner is throttled), the box budget (ADR-007) cannot hold and the migration
  stops until it can. There is no fallback to the rootful daemon.
- **Chromium in an unprivileged container** cannot use its own user-namespace sandbox under
  Docker's default seccomp profile; gstack's browse runs with `--no-sandbox` (the container is the
  sandbox). Measured in P0.
- **Image size.** The spike build was 9.0 GB unpacked; without the standalone Dart SDK and the
  build-only pub and bun caches it is 8.26 GB (CI build, 2026-10-21). Two digests are kept during a rollout, so budget about
  20 GB of rootless Docker root. P0 records size and `df` headroom on the box.
- **Cold start.** `create` (which populates the HOME and Flutter volumes from the image) + copy-in +
  `start`. Measured on a laptop under amd64 emulation: about 3 s with HOME alone, 13-18 s with
  `/opt/flutter` too. P0 measures it natively on the box; if the Flutter copy stays too slow, P0
  records the cut (for example a per-slot Flutter volume reset from the image between runs).
  A first pull of a new digest is minutes and never happens on the run path.
- **Memory on the box.** Task runs have peaked around 5 GB. The container adds little, and image
  pages are shared page cache, but `--memory` comes from the slot tuple so that slots × ceiling +
  engine + worker fits the box, exactly as `WORKER_RUN_MEMORY_MAX` must today. The #371 headroom
  check stays the admission guard; resizing the box is allowed if the measurements need it.
- **Docker as a new dependency of the run path.** A wedged rootless daemon stops every run. The
  worker probes it at boot and at admission and fails the run non-retryably with a clear line, the
  way a missing box-lock helper does today.

## Rollback

- **Before the release PR:** nothing to roll back; production never takes the container path.
- **After the release PR:** `git revert` the release PR and redeploy. The release PR deletes code
  only; it does not deprovision the box. The slot accounts, nft tables, sudoers lines and unit
  drop-ins stay on the box until the cleanup step (P4), so a revert is a pure redeploy.
- **A bad image:** point `WORKER_BATTERIES_IMAGE` back at the previous, still-pulled digest.
- **After P4 (box cleanup):** a revert also needs the old host provisioning re-run. That is why P4
  waits for the soak.

## What becomes obsolete

Deleted in the **release PR (P3)**:

- **Battery linking:** `batteries-seed.ts`, `harness-seed.ts`, `batteries-manifest.ts`,
  `harness-manifest.ts`, `harness-layout.ts`, `foreground-only-hook.ts`'s HOME-merge path (the hook
  itself moves into the copied-in settings), `deploy/batteries.json`, `deploy/harness.json`,
  `linux/install-batteries.sh`, `linux/automata-batteries`, `linux/batteries-dry-run.sh`,
  `linux/harness-mcp-probe.mjs`, and the host acceptance scripts' battery sections. The lockfiles
  under `deploy/batteries/{gsd,ruflo,somnio-cli}` move next to the Dockerfile;
  `harness-mcp-filter.mjs` survives if the MCP allowlist still needs it inside the container.
- **Agent-uid execution:** `AGENT-UID-PROVISIONING.md`, `spawn-as-user.ts` (the `sudo -u` path),
  `agent-uid-fs.ts`, `uid-reaper.ts`, `box-slots-boot.ts`'s account/sudoers/hidepid/fence checks,
  `run-cgroup.ts`, `sudoers.d-automata`, `linux/egress-nft.conf` + `automata-egress.service` +
  `nft-preflight.sh` + `nft-verify.sh`, `linux/loopback-nft.conf` + `nft-loopback-load.sh` (and the
  worker unit's `ExecStartPre=+` that loads it), `automata-worker.service.d/10-ceiling.conf` and
  `20-hidepid.conf`, the slot-account and battery steps of `cloud-init.yaml`, and the
  `WORKER_DEV_CONTAINER_RUNS` switch.
- **Removed from the box in P4** (by the provisioning script, after the soak): the slot accounts,
  their sudoers lines, the nft tables, the unit drop-ins and the host battery trees.
- **Kept:** box locks and slots (ADR-007 I1-I3), headroom (#371), the run-terminal ledger (#386),
  the egress proxy, both brokers, the payload seal (#380), the daemon and its adapters.

## Anti-deviation invariants

- **I1** The image contains no secret and no per-run policy. Credentials, trust, settings and MCP
  registration are copied in per run; a build arg is never a credential.
- **I2** An agent container never gets a Docker socket, `--privileged`, a capability, a host
  network, a writable root filesystem, or a bind mount outside its own run directory (plus the
  read-only daemon bundle).
- **I3** A container's network is `none`. Its only egress is the worker's proxy over a unix socket;
  there is no path to host loopback.
- **I4** A review-lane container holds no credential that can write to GitHub: no broker socket,
  no token in env or files (ADR-004 unchanged).
- **I5** The worker runs images by digest only, on the rootless daemon only, and never pulls on the
  run path.
- **I6** A box slot is released only after its container is gone (ADR-007 I2, restated).
- **I7** There is one execution path. No setting selects the host path; the dev-only switch never
  exists in a production build after the release PR.

## Options considered

1. **Keep the host-uid model and keep hardening it.** Rejected by the operator: every fence is a
   host-global, uid-keyed mechanism with its own incident history, every battery needs bespoke link
   support, and some tools (gstack browse) cannot work under the fences at all.
2. **A per-repo `execution: host | container` flag with gradual rollout.** Rejected by the operator:
   two execution paths in production for weeks doubles the surface every incident must reason
   about. The throwaway box and the probes carry the proof instead.
3. **The rootful Docker daemon behind a narrow sudo helper.** Rejected: whoever drives a rootful
   daemon is host root, and the helper is one more argv-validating root surface.
4. **Cloudflare Sandboxes (#112).** Superseded: the run stays on the box next to its brokers and
   egress proxy.
5. **`@terragon/sandbox` `DockerProvider` as the run path.** Rejected for the worker (Decision 5);
   its builders are reused.
6. **One long-lived container per slot, runs `exec`'d into it.** Rejected: state would leak between
   runs.
7. **gVisor or microVMs (Firecracker / Kata).** Deferred: stronger kernel isolation at a cost on
   file-heavy work and a larger operational change on a single box.

## Testing

P0 is measured on a throwaway box (see the plan). P1 adds unit tests for the container argv builder
(pure, like `docker-egress.ts`) and the stack detection for the rules install, an integration test
that starts a real container with `--network none` and proves the proxy socket is the only way out,
and a review-lane test asserting no broker socket and no token reach the container. P2 runs the
security probes and every lane on the throwaway box. The plan lists acceptance criteria per phase.
