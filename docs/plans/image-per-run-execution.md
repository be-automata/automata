# Plan: image-per-run execution (ADR-013)

Decision record: [ADR-013](../adr/ADR-013-image-per-run-execution.md). Image:
[`deploy/images/batteries/`](../../deploy/images/batteries/README.md). Anchors are against `main` @
`59a57af5`.

Every phase has acceptance criteria, the measurements it records, and a kill switch. A phase starts
only when the previous one's criteria hold. Measurements go into the ADR's status line as they land.

## Phases

### P0 — build the image, smoke it on the box

No worker change. Nothing a run does changes.

Steps:

1. Build `deploy/images/batteries/Dockerfile` for linux/amd64 (CI or the box) and run
   `deploy/images/batteries/verify.sh <image>` against it.
2. On the box: pull or load the image by digest; run `verify.sh` there.
3. In-container smoke as a run would see it (manual, as root on the box): a scratch run dir with a
   clone of a canary repo bind-mounted at `/workspace`, `--network none`, `--cap-drop ALL`,
   `--security-opt no-new-privileges`, `--init`, `--memory`/`--pids-limit` from the box's tuple, and
   a `socat` bridge to a throwaway proxy unix socket. Run `claude --version`, `flutter analyze` and
   `dart pub get` (through the proxy), `somnio status`, `ruflo --version`, gstack `browse` against
   a page served through the proxy, `gh --version`.
4. Measure the daemon-socket permission model and rootless Docker (below).

Acceptance:

- `verify.sh` passes on the box against the pinned digest.
- The smoke container cannot reach `127.0.0.1:7077`/`:8888` on the host, cannot resolve or connect
  anywhere without the proxy socket, and reaches an allowed host through it.
- A container killed with `docker rm -f` leaves no process of uid 10001 (or its mapped uid) on the
  host, including a deliberately `setsid`-detached child.
- A rootless-Docker (or userns-remap) daemon either runs the smoke with `--memory`/`--pids-limit`
  enforced, or the ADR records why not and which fallback P1 uses.
- Chromium (gstack browse) works in the container, with the sandbox mode recorded.

Measurements: image size (`docker image inspect --format '{{.Size}}'`), disk headroom (`df -h` on the
Docker root before/after), pull time for a fresh digest, cold start (`create` + `cp` + `start` to
first daemon line, median of 10), idle container RSS, peak RSS of a `flutter analyze` and of a full
`pnpm install` on a large repo, and the box's free memory with 3 smoke containers at their ceiling.

Kill switch: none needed (no run path uses it). Remove with `docker rmi`.

### P1 — the container run path behind a per-repo flag, one canary repo

Worker change: a container spawn path beside the host path, chosen per run.

- Control plane: a per-repo `execution` setting (`host` default, `container`), resolved onto the run
  input like `egressPolicy` (`apps/www/src/agent/hatchet/dispatch.ts:959-983`), carried as
  `AgentRunInput.execution` (`packages/worker/src/agent-run/types.ts:102`). Schema change ships as a
  migration first (AGENTS.md ordering).
- Worker: `WORKER_BATTERIES_IMAGE` (digest only, checked present at boot) and a pure
  container-argv builder (unit-tested like `packages/sandbox/src/providers/docker-egress.ts`); the
  egress proxy and git broker gain a unix-socket listener; teardown and boot scan remove containers
  by label; OOM read from the container.
- Only the **task lane** of the canary repo runs in a container in P1 (smallest blast radius: no PR
  effects).

Acceptance:

- 20 consecutive canary task runs complete in containers with the same outcomes as host runs on the
  same prompts (thread status, commits, egress audit rows present).
- Every run's journal shows `execution=container image=<digest>`; no run in the canary shows a host
  spawn.
- A cancelled run and a run killed at its memory ceiling leave no container and release the slot
  (ADR-013 I6); the OOM is attributed on the thread.
- Egress: a denied host is refused and audited exactly as on the host path; nothing leaves without
  the proxy.
- Non-canary repos are byte-identical on the host path (their run journal is unchanged).

Measurements: run wall time and setup time vs host runs on the canary (median, p95), peak memory per
run, disk growth per run (container layer size before removal).

Kill switch: set the canary repo's `execution` to `host` (next run, no restart).
`WORKER_EXECUTION_CONTAINER=off` forces the host path for every run (restart).

### P2 — task and PR lanes

- Extend `container` to the `pr` lane (mentions on PRs) and to all task runs of opted-in repos; then
  opt in repos in batches.
- Brokers: git and gh broker sockets are mounted for lanes that get them today; self-heal fix runs
  keep their ref fence.
- Test services: task runs of `TEST_SERVICES_REPOS` repos get the test Postgres unix socket mounted
  and bridged to `127.0.0.1:25432`.

Acceptance: all task/PR runs of opted-in repos for 7 days without a container-specific failure;
push, PR creation and mention replies work through the brokers; the test-Postgres repos pass their
suites in containers.

Measurements: per-lane setup overhead, concurrent slot behaviour at the full tuple (3 slots at
ceiling), box free memory and disk at peak.

Kill switch: per-repo flag; global env switch.

### P3 — review lane

- Reviews of opted-in repos run in containers with: no broker socket, no write token, the existing
  `reviewPolicyArgs` (`packages/daemon/src/claude.ts:204`), and the review settings/MCP allowlist
  copied in. The deny list gains entries for skills that were "dropped" from the host batteries
  (for example `gstack-cso`).
- Persistent ruflo memory is never mounted on reviews (read-only at most, decided per the ADR).

Acceptance: an automated check per review run that the container has no gh broker socket,
no git broker socket, and no GitHub token in env or files; 50 consecutive reviews on opted-in repos with
the same verdict rate (approve / request changes / non-verdict notice) as the host path for the same
repos over the prior two weeks; orchestrated reviews' fan-out works inside the container.

Measurements: review wall time vs host, model-call count per review (to catch a silent tool
breakage), memory peak.

Kill switch: per-repo flag (reviews return to the host path on the next push).

### P4 — delete the host-uid machinery

Gate: every lane on containers for 14 consecutive days, zero host-path runs, no open container-path
incident, and the last pre-P4 worker revision tagged `pre-image-p4`.

Work: delete what the ADR lists under "What becomes obsolete"; move the GSD/ruflo/Somnio lockfiles
next to the Dockerfile; drop the `execution` flag's `host` value (or keep the column and refuse
`host`); simplify `cloud-init.yaml` to Docker + worker + engine.

Acceptance: CI green; the box rebuilt from the simplified cloud-init runs all lanes; no
`meta skuid` table, no slot accounts, no delegated cgroup on the box.

Kill switch: redeploy `pre-image-p4` and re-run battery install and agent-uid provisioning (slow;
hence the gate).

## Evidence

Current host-model code each phase touches (`main` @ `59a57af5`).

**P0** (reads only; nothing changes)

- Pins reused by the Dockerfile: `packages/worker/deploy/batteries.json` (Dart SDK, Somnio CLI
  `aa53f071…`, shellcheck/actionlint/gitleaks, pnpm), `packages/worker/deploy/harness.json` (gstack
  `df89475b…`, bun, Chromium, GSD 1.16.0, ruflo 3.56.7 and its prebuild/model prefetch),
  `packages/worker/deploy/linux/cloud-init.yaml:87-93` (Node, pnpm, Claude Code 2.1.284),
  `:101-105` (Chromium runtime packages).
- Box sizing rules the measurements must respect: `packages/worker/src/agent-run/config.ts:530`
  (`WORKER_RUN_MEMORY_MAX`), `:601` (`WORKER_BOX_SLOTS`), `box-slots-boot.ts:451,497`
  (`warnIfSlotsExceedMemory`, `assertSlotsFitCommitLimit`), `headroom.ts:121` (`evaluateHeadroom`).

**P1** (container spawn beside the host spawn)

- Spawn: `packages/worker/src/agent-run/daemon-process.ts:380-410` (`prepareRunCgroup`,
  `ensureEnv`, `buildSpawnInvocation`, `spawn`), `spawn-as-user.ts:166` (`buildSpawnInvocation`),
  `:219,251` (kill invocations), `agent-command.ts:55` (`runAsAgent`), `provision.ts:430`
  (`runAsAgentViaSudo`).
- Run setup: `workflow.ts:1295` (`provisionWorkdir`), `:1425` (admission reap), `:1447`
  (`materialiseAgentCredentials`), `agent-credentials.ts:51-130` (trust seed), `:165-222` (per-run
  HOME, `seedBatteries` call at `:211`).
- Egress: `workflow.ts:1517-1550` (proxy start, enforce vs observe), `egress-proxy.ts:497`
  (`startEgressProxy`), `:764` (TCP `listen(0, "127.0.0.1")`), `daemon-env.ts:324`
  (`buildRunProxyEnv`), `:410` (`buildDaemonEnv`).
- Brokers: `workflow.ts:1563-1580`, `git-broker.ts:88,237` (TCP listener), `gh-broker.ts:128,263`
  (unix socket), `run-namespace.ts:154,175` (`runSocketPath`, `runGhSocketPath`).
- Ceiling and OOM: `run-cgroup.ts:385` (`createRunCgroup`), `:479` (`readMemoryEvents`), `:547`
  (`killAndRemoveRunCgroup`), `daemon-process.ts:709` (`prepareRunCgroup`), `:817`.
- Reaper and teardown: `workflow.ts:1744,1789`, `uid-reaper.ts:441` (`reapAgentUidEscapees`), `:683`
  (`bootUidScan`).
- Flag plumbing: `apps/www/src/agent/hatchet/dispatch.ts:959-983`, `packages/worker/src/agent-run/types.ts:102,164`.
- Unchanged but on the path: `workflow.ts:470` (`guardRunTerminal`), `run-terminal-ledger.ts:108,151`;
  `run-lane.ts:15` (`resolveRunLane`).

**P2** (task/PR lanes)

- `task-agent.ts:66,97,118,148` (`taskAgentForRun`, `batterySeedForRun`, `foregroundOnlyForRun`,
  `readTokenForRun`), `foreground-only-hook.ts:79` (`mergeForegroundOnlySettings`),
  `harness-seed.ts:462` (`resolveHarnessPacks`), `:583` (`writeHarnessHomeFiles`), `:636`
  (`harnessMcpServers`), `:673` (`harnessRunEnv`), `batteries-seed.ts:672` (`seedForegroundOnly`),
  `:754` (`seedBatteries`).
- Test services: `packages/worker/deploy/linux/install-test-postgres.sh` (loopback 25432), the
  `TEST_SERVICES_REPOS` injection described in `AGENTS.md`.

**P3** (review lane)

- `review-agent-wire.ts:57` (`reviewAgentForRun`), `workflow.ts:1391-1396`, `harness-seed.ts:662`
  (`harnessDenyRules`), `packages/daemon/src/claude.ts:204` (`reviewPolicyArgs`),
  `packages/daemon/src/daemon.ts:774` (`withholdGitCredentialsInReviewMode`),
  `packages/worker/deploy/linux/harness-mcp-filter.mjs`, `packages/worker/deploy/batteries.json`
  (`forbiddenHelperTokens`, `dropped`).

**P4** (deletions)

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
