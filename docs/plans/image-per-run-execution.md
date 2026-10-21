# Plan: image-per-run execution (ADR-013)

Decision record: [ADR-013](../adr/ADR-013-image-per-run-execution.md), including the operator's
locked decisions of 2026-10-21. Image: [`deploy/images/batteries/`](../../deploy/images/batteries/README.md).
Anchors are against `main` @ `1a13f49a`.

Shape: a **hard switch**. The container path is built dark on `main`, proven on a throwaway box,
then made the only path by one release PR that also deletes the host-uid machinery. There is no
per-repo execution setting at any point. Each phase has acceptance criteria and the measurements it
records; a phase starts only when the previous one's criteria hold. Measurements go into the ADR's
status line as they land.

## Phases

### P0 — image in GHCR, rootless daemon on a throwaway box, measurements

No worker change. Nothing a production run does changes.

Steps:

1. Merge this PR: `.github/workflows/batteries-image.yml` builds the image, runs `verify.sh` and
   pushes `ghcr.io/be-automata/automata-batteries:sha-<commit>`; make the package public (README).
2. On a fresh throwaway box (same size class as production): a dedicated rootless Docker daemon
   under `automata-runner` (no sudo, lingering on), with cgroup v2 delegation for its
   `user@<uid>.service` (`Delegate=cpu cpuset io memory pids`). Pull the image by digest, run
   `verify.sh` and `gh attestation verify` there.
3. Smoke a container by hand with the full hardening baseline (ADR-013 Decision 3), a clone of a
   test repo at `/workspace`, and a `socat` bridge to a throwaway proxy unix socket. Run
   `claude --version`, `flutter analyze` and `flutter pub get` (through the proxy), `somnio status`,
   the per-run rules install, `ruflo --version`, gstack `browse` against a page served on the
   container's own loopback, `gh --version`.

Acceptance (all required; the first is a **blocker** for the whole migration):

- Under the rootless daemon, `--memory` is enforced (a container allocating past it is OOM-killed
  and `.State.OOMKilled` is true), `--pids-limit` is enforced (a fork loop stops at the limit) and
  `--cpus` is enforced (a CPU burner is throttled to the quota, read from `cpu.stat`).
- `verify.sh` passes on the box against the pinned digest.
- The smoke container cannot reach the host's `7077`/`8888`, cannot connect anywhere without the
  proxy socket, and reaches an allowed host through it.
- `docker rm -f` leaves no process of the container's mapped uids on the host, including a
  deliberately `setsid`-detached child.
- The run-dir hand-over works: the container (uid 10001, `--group-add 0`) can write `/workspace`
  and the socket dir, which the worker created setgid and group-owned by `automata-runner`'s group.
- gstack `browse` works in the container, with the Chromium sandbox mode recorded.

Measurements: image size and pull time for a fresh digest; Docker root `df` before/after; cold start
(`create` with the HOME and Flutter volumes + `cp` + `start` to first daemon line, median of 10);
idle container RSS; peak RSS of `flutter analyze` and of a full `pnpm install` on a large repo; the
box's free memory with 3 containers at their ceiling. If the Flutter volume copy dominates cold
start, record the cut chosen (ADR-013 Risks).

### P1 — the container run path, dark, every lane

Worker change, merged to `main` in small PRs, **unused in production**: the path runs only when
`WORKER_DEV_CONTAINER_RUNS=1`, which is set only on the throwaway box (ADR-013 Decision 6). This
dev-only switch is the one exception to "no flag", exists only until the release PR, and has no
per-repo or per-lane form.

- `WORKER_BATTERIES_IMAGE` (digest only, present in the rootless daemon's store, checked at boot)
  and the rootless daemon's socket path in the worker config.
- A pure container-argv builder (unit-tested like `packages/sandbox/src/providers/docker-egress.ts`)
  that emits the hardening baseline and refuses anything ADR-013 I2 forbids.
- The egress proxy and the git broker gain a unix-socket listener; the gh broker's socket moves
  under `<runDir>/sock/`.
- The run path of ADR-013 ("Run path", steps 1-7) for **every lane**: review, pr/mention/companion,
  task, self-heal (audit and fix). The review lane mounts no broker socket.
- The entry step: `socat` bridges, the Somnio rules install with stack detection (unit-tested on
  fixture checkouts: tracked `CLAUDE.md` restored, written paths excluded, `git status` clean),
  then the daemon.
- Teardown and boot remove containers by label and slot name; OOM read from the container.
- The per-run settings merge: the worker's deny rules and foreground-only hook plus the lane's share
  of `~/.claude/settings.batteries.json`.

Acceptance (on the throwaway box, against a test org and test repos):

- Every lane completes on containers with the outcome the host path gives for the same input:
  a review posts its verdict, a mention replies, the companion posts its one comment, a task pushes
  and opens its PR through the brokers, a self-heal audit files its findings and a fix run opens its
  PR inside its ref fence, and a test-Postgres repo passes its suite through the bridged socket.
- A cancelled run and a run killed at its memory ceiling leave no container and release the slot
  (ADR-013 I6); the OOM is attributed on the thread.
- 3 concurrent runs at the slot tuple (3 slots, ≤ 2 per org) complete without a headroom refusal
  that the host path would not have given.
- CI green with the switch off; production's behaviour is unchanged (its runs never take the path).

Measurements: run wall time and setup time per lane vs the production host path (median, p95), peak
memory per lane, disk growth per run.

### P2 — provisioning script and the security probes

- `deploy/provision-execution-box.sh` (ADR-013 "Fleet"): rootless daemon, delegation, image pull by
  digest + `verify.sh` + attestation check, worker unit and env. Idempotent.
- The security probe script (ADR-013 "Security probes", seven probes), launched from inside a run
  container.

Acceptance:

- A second fresh throwaway box is provisioned by the script alone and runs every lane; a second run
  of the script on it changes nothing.
- All seven probes pass on that box.
- The script is run on the **production box** in a mode that only adds the rootless daemon and
  pre-pulls the release digest (no worker change): the host path keeps running, and the rootless
  daemon is verified there before the release.

### P3 — release PR: hard switch and host-uid deletion

One PR:

- The container path becomes the only path; `WORKER_DEV_CONTAINER_RUNS` is deleted.
- Everything ADR-013 lists under "What becomes obsolete" for the release PR is deleted.
- ADR-013 moves to Accepted with its measurements; ADR-002 gets the revision note drafted in
  ADR-013.

Deploy: the worker restarts on the new revision at an idle moment, with `WORKER_BATTERIES_IMAGE`
set to the pre-pulled digest. Right after: the seven probes run on the production box, then one run
per lane is watched to completion.

Acceptance: probes green on production; every lane completes on containers in its first 24 hours;
no host-path code remains (`grep` for `sudo -u`, `meta skuid`, `reapAgentUidEscapees` returns
nothing outside history docs).

Rollback: `git revert` the release PR and redeploy. The box still holds the host provisioning
(slot accounts, nft tables, sudoers, drop-ins) until P4, so this is a pure redeploy.

### P4 — box cleanup after the soak

After 14 days on containers with no open container-path incident: the provisioning script removes
the slot accounts, their sudoers lines, the nft tables and loader, the unit drop-ins and the host
battery trees from the production box, and `cloud-init.yaml` is reduced to the script. After this,
a revert also needs the old host provisioning re-run.

Acceptance: the box has no `meta skuid` table, no slot accounts and no delegated worker cgroup, and
every lane still runs.

## Evidence

Current host-model code each phase touches (`main` @ `1a13f49a`).

**Motivating defect**

- `packages/worker/deploy/linux/loopback-nft.conf:84` (the per-uid mark), `:110` (accept only
  listeners in the worker's cgroup), `:133` (reset everything else);
  `packages/worker/deploy/linux/automata-batteries:287` (`browse goto failed as $AGENT_USER`);
  `packages/worker/deploy/linux/install-batteries.sh:3136-3137` (`harness.sha256` invalidated).

**P0** (reads only; nothing changes)

- Pins reused by the Dockerfile: `packages/worker/deploy/batteries.json` (Somnio CLI `aa53f071…`,
  shellcheck/actionlint/gitleaks, pnpm), `packages/worker/deploy/harness.json` (gstack
  `df89475b…`, bun, Chromium, GSD 1.16.0, ruflo 3.56.7 and its prebuild/model prefetch),
  `packages/worker/deploy/linux/cloud-init.yaml:87-93` (Node, pnpm, Claude Code 2.1.284),
  `:101-105` (Chromium runtime packages).
- Box sizing rules the measurements must respect: `packages/worker/src/agent-run/config.ts:530`
  (`WORKER_RUN_MEMORY_MAX`), `:601` (`WORKER_BOX_SLOTS`), `box-slots-boot.ts:451,497`
  (`warnIfSlotsExceedMemory`, `assertSlotsFitCommitLimit`), `headroom.ts:121` (`evaluateHeadroom`).

**P1** (the container path; all paths under `packages/worker/src/agent-run/` unless stated)

- Spawn: `daemon-process.ts:380-410` (`prepareRunCgroup`, `ensureEnv`, `buildSpawnInvocation`,
  `spawn`), `spawn-as-user.ts:166` (`buildSpawnInvocation`), `:219,251` (kill invocations),
  `agent-command.ts:55` (`runAsAgent`), `provision.ts:430` (`runAsAgentViaSudo`).
- Run setup: `workflow.ts:1295` (`provisionWorkdir`), `:1425` (admission reap), `:1447`
  (`materialiseAgentCredentials`), `agent-credentials.ts:51-130` (trust seed), `:165-222` (per-run
  HOME, `seedBatteries` call at `:207`).
- Egress: `workflow.ts:1517-1550` (proxy start, enforce vs observe), `egress-proxy.ts:497`
  (`startEgressProxy`), `:764` (TCP `listen(0, "127.0.0.1")`), `daemon-env.ts:324`
  (`buildRunProxyEnv`), `:410` (`buildDaemonEnv`).
- Brokers: `workflow.ts:1563-1580`, `git-broker.ts:88,237` (TCP listener), `gh-broker.ts:128,263`
  (unix socket), `run-namespace.ts:154,175` (`runSocketPath`, `runGhSocketPath`).
- Ceiling and OOM: `run-cgroup.ts:385` (`createRunCgroup`), `:479` (`readMemoryEvents`), `:547`
  (`killAndRemoveRunCgroup`), `daemon-process.ts:709` (`prepareRunCgroup`), `:817`.
- Reaper and teardown: `workflow.ts:1744,1789`, `uid-reaper.ts:441` (`reapAgentUidEscapees`), `:683`
  (`bootUidScan`).
- Lanes: `run-lane.ts:15` (`resolveRunLane`), `task-agent.ts:66,97,118,148` (`taskAgentForRun`,
  `batterySeedForRun`, `foregroundOnlyForRun`, `readTokenForRun`), `review-agent-wire.ts:57`
  (`reviewAgentForRun`), `workflow.ts:1391-1396`.
- Settings and packs to replace: `foreground-only-hook.ts:79` (`mergeForegroundOnlySettings`),
  `harness-seed.ts:462` (`resolveHarnessPacks`), `:583` (`writeHarnessHomeFiles`), `:636`
  (`harnessMcpServers`), `:662` (`harnessDenyRules`), `:673` (`harnessRunEnv`),
  `batteries-seed.ts:672` (`seedForegroundOnly`), `:754` (`seedBatteries`).
- Review fence: `packages/daemon/src/claude.ts:204` (`reviewPolicyArgs`),
  `packages/daemon/src/daemon.ts:774` (`withholdGitCredentialsInReviewMode`),
  `packages/worker/deploy/linux/harness-mcp-filter.mjs`, `packages/worker/deploy/batteries.json`
  (`forbiddenHelperTokens`, `dropped`).
- Test services: `packages/worker/deploy/linux/install-test-postgres.sh` (loopback 25432), the
  `TEST_SERVICES_REPOS` injection described in `AGENTS.md`.
- Unchanged but on the path: `workflow.ts:470` (`guardRunTerminal`), `run-terminal-ledger.ts:108,151`
  (`recordRunTerminal`, `guardRunTerminal`).

**P3** (deletions)

- `packages/worker/src/agent-run/`: `batteries-seed.ts`, `harness-seed.ts`, `batteries-manifest.ts`,
  `harness-manifest.ts`, `harness-layout.ts`, `spawn-as-user.ts`, `agent-uid-fs.ts:283,315,340,399`,
  `uid-reaper.ts`, `run-cgroup.ts`, `box-slots-boot.ts:27,87,203,268,308,363` (account, sudoers,
  hidepid, group, traverse and fence checks), `config.ts:566-610` (`WORKER_AGENT_USER` gates), and
  their tests (including the battery and nft sections of `deploy-assets.test.ts`).
- `packages/worker/deploy/`: `AGENT-UID-PROVISIONING.md`, `batteries.json`, `harness.json`,
  `sudoers.d-automata`, `linux/install-batteries.sh`, `linux/automata-batteries`,
  `linux/batteries-dry-run.sh`, `linux/egress-nft.conf`, `linux/automata-egress.service`,
  `linux/nft-preflight.sh`, `linux/nft-verify.sh`, `linux/loopback-nft.conf`,
  `linux/nft-loopback-load.sh`, `linux/automata-worker.service:72` (the loopback `ExecStartPre=+`),
  `linux/automata-worker.service.d/10-ceiling.conf`, `linux/automata-worker.service.d/20-hidepid.conf`,
  `linux/sudoers.d-automata`, `linux/cloud-init.yaml:70-81` (slot accounts) and its battery steps.
