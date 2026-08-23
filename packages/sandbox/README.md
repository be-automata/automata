# @terragon/sandbox — provider abstraction & lifecycle

Multi-provider sandbox layer. A **sandbox** is the remote dev environment a coding
agent runs inside: it clones the repo, installs the daemon, runs the agent, and
puts up commits/PRs. This package hides the provider differences behind one
interface so the control plane drives every provider the same way.

Four providers are implemented here (`src/providers/`): **E2B**, **Daytona**,
**Docker**, **Mock**. A fifth `SandboxProvider` value — `hatchet-remote` — is
_not_ a provider in this package; it is a routing sentinel for the separate
worker/Hatchet execution plane (see [Two execution planes](#two-execution-planes)).

---

## 1. How providers are wired into the workflow

### The abstraction

Two interfaces in [`src/types.ts`](src/types.ts):

- **`ISandboxProvider`** (`types.ts:82`) — the provider factory/lifecycle:
  `getSandboxOrNull`, `getOrCreateSandbox`, `hibernateById`, `extendLife`.
- **`ISandboxSession`** (`types.ts:98`) — a live sandbox handle: `runCommand`,
  `runBackgroundCommand`, `readTextFile`/`writeTextFile`/`writeFile`,
  `hibernate`, `shutdown`, plus `sandboxId` / `sandboxProvider` / `homeDir` /
  `repoDir`. Every provider implements both; nothing above this layer knows which
  provider it is talking to.

`CreateSandboxOptions` (`types.ts:37`) is the single struct the control plane
fills in — repo, branch, agent + credentials, GitHub token, env vars, MCP config,
sandbox size, `egressPolicy` shape (see §3), feature flags, and an
`onStatusUpdate` callback used to stream boot substatus.

### Provider selection

Selection happens in **two stages**:

1. **Which provider value** a thread gets is decided once, at thread creation, by
   `getSandboxProvider(...)` in `apps/www/src/agent/sandbox.ts:405` (called from
   `apps/www/src/server-lib/new-thread-shared.ts:205`) and persisted on the thread
   row. Resolution order:
   - `NODE_ENV === "test"` → `"mock"` (`sandbox.ts:409`).
   - `featureFlags.forceDaytonaSandbox` → `"daytona"`, overriding the user setting
     (`sandbox.ts:414`).
   - user setting `"default"` → `env.E2B_API_KEY ? "e2b" : "docker"`
     (`sandbox.ts:421`).
   - otherwise the explicit value (`e2b` / `daytona` / `docker` / `mock` /
     `hatchet-remote`) passes through.
   - DB column default is `"e2b"` (`packages/shared/src/db/schema.ts:367`).
2. **Which class** implements that value is resolved at boot by
   `getSandboxProvider(provider)` in [`src/provider.ts:8`](src/provider.ts) — a
   `switch` mapping `"e2b" → E2BProvider`, `"docker" → DockerProvider`,
   `"daytona" → DaytonaProvider`, `"mock" → MockProvider` (test-only; throws
   otherwise). `"hatchet-remote"` **throws here on purpose** (`provider.ts:25`):
   a hatchet-remote thread must never reach the local boot path.

`SandboxProvider` and `SandboxSize` (`"small" | "large"`) are defined in
[`packages/types/src/sandbox.ts`](../types/src/sandbox.ts). Both are
DB-persisted — values are never removed from the unions.

### Lifecycle

The orchestration entry points live in [`src/sandbox.ts`](src/sandbox.ts):

- **`getOrCreateSandbox(sandboxId, options)`** (`sandbox.ts:6`) — resumes when
  `sandboxId` is set, otherwise creates. It calls `provider.getOrCreateSandbox`,
  then always runs `setupSandboxEveryTime`, and on **create** also
  `setupSandboxOneTime`. Status is streamed via `onStatusUpdate`
  (`provisioning → booting → running`, with `BootingSubstatus` steps).
- **`hibernateSandbox` / `extendSandboxLife` / `getSandboxOrNull`**
  (`sandbox.ts:57`, `:68`, `:79`) — thin dispatchers to the provider.

Setup, in [`src/setup.ts`](src/setup.ts):

- **`setupSandboxEveryTime`** (`setup.ts:204`, runs on create _and_ resume):
  `setupGitCredentials` (always), then unless `fastResume`: rewrite agent config
  files (`updateAgentFiles` — Claude/Codex/Amp/opencode/Gemini), update the daemon
  if outdated, restart the daemon if not running.
- **`setupSandboxOneTime`** (`setup.ts:74`, create only): clone repo
  (`gitCloneRepo`, blobless `--filter=blob:none`), set git identity, create/checkout
  branch, `git clean -fxd`, `installDaemon` (writes daemon + MCP server, starts and
  pings it — `daemon.ts:69`), then run `terragon-setup.sh` unless skipped.
- **`setupGitCredentials`** (`setup.ts:166`): `credential.helper store` +
  `~/.git-credentials` holding the GitHub token. See §3 — this is the resident
  token the sandbox plane still carries.

### Control plane drives it

`apps/www/src/agent/sandbox.ts` wraps these calls with timing/error telemetry
(`getOrCreateSandboxForThread` at `sandbox.ts:108`, boot timeout race at `:42`,
`maybeHibernateSandboxInternal` at `:359`). The thread's persisted
`sandboxProvider` is simply read back and passed into `getOrCreateSandbox`
(`sandbox.ts:256`).

### Two execution planes

There are **two** places an agent run can execute; this package is only the first:

| Plane                                                            | What runs                                                       | Decided by                       | Code                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------- | --------------------------------------------------- |
| **Sandbox providers** (this package)                             | E2B / Daytona / Docker / Mock booted in-process from `apps/www` | default path                     | `packages/sandbox`, `apps/www/src/agent/sandbox.ts` |
| **Worker / Hatchet** ([`@terragon/worker`](../worker/README.md)) | agent run dispatched to a customer-supplied box                 | `hatchetDispatchEnabled(thread)` | `apps/www/src/agent/hatchet/dispatch.ts`            |

The fork is in `apps/www/src/agent/msg/startAgentMessage.ts:269`: if
`hatchetDispatchEnabled(thread)` (`dispatch.ts:228` — true when
`env.HATCHET_ENABLED` is set **or** `thread.sandboxProvider === "hatchet-remote"`)
it calls `dispatchAgentRun` and returns _before_ any in-process sandbox boot;
otherwise it falls through to the sandbox path above. `dispatchAgentRun`
(`dispatch.ts:240`) mints short-lived tokens and POSTs a reference-only
`AgentRunInput` to Hatchet's REST trigger — no long-lived secret and no prompt
travel with it (the worker pulls the prompt from `/api/daemon/next-message`). This
seam is ADR-003 (`docs/adr/ADR-003-execution-plane-www-dispatch-seam.md`); ADR-002
covers the worker substrate.

---

## 2. The four providers

### E2B — [`src/providers/e2b-provider.ts`](src/providers/e2b-provider.ts)

- **What:** managed micro-VM provider (`@e2b/code-interpreter` `^2.7.1`, the v2
  SDK). Default remote provider in prod when `E2B_API_KEY` is set.
- **Create:** `Sandbox.create(templateId, { lifecycle: { onTimeout: "pause" }, … })`
  (`e2b-provider.ts:53`). Template chosen by `getTemplateIdForSize({ provider: "e2b", size })`.
- **Resume:** `Sandbox.connect(sandboxId)` auto-resumes a paused sandbox
  (`e2b-provider.ts:24`) — v2 dropped the old `Sandbox.resume`. Wrapped in
  `resumeWithRetry` (3 attempts) with an `echo` liveness probe.
- **Hibernate / teardown:** `sandbox.pause()` (`hibernate`, `:101`;
  `hibernateById`, `:237`), `sandbox.kill()` (`shutdown`, `:176`). `extendLife`
  bumps `setTimeout(SLEEP_MS)` (15 min).
- **Network:** native firewall. With a policy, create passes
  `network: { denyOut: ["0.0.0.0/0"], allowOut: [...] }` (`toE2bNetwork`). Enforced
  below the process — env-unset cannot bypass it. No per-connection audit feed.

### Daytona — [`src/providers/daytona-provider.ts`](src/providers/daytona-provider.ts)

- **What:** managed sandbox provider (`@daytonaio/sdk` `0.205.1`). Optional prod
  provider, gated by the `daytonaOptionsForSandboxProvider` UI flag and/or the
  `forceDaytonaSandbox` override; needs `DAYTONA_API_KEY` (`daytona-provider.ts:94`).
- **Create:** `daytona.create({ snapshot: templateId, autoStopInterval: 15,
autoArchiveInterval: 5, autoDeleteInterval: 30d, … })` (`daytona-provider.ts:70`),
  then `setupDaytonaOneTime` seeds a login-shell prompt. Commands run through
  per-command Daytona **sessions** (`runCommandWithSession`, `:123`).
- **Resume:** `daytona.get(id)` then state-machine wait
  (`waitUntilStopped`/`waitUntilStarted`/`start`) — `resumeWithRetry`, `:21`.
- **Hibernate / teardown:** `sandbox.stop()` (relies on auto-archive) for
  hibernate (`:403`); `shutdown` does `stop()` + `delete()` (`:304`).
- **Network:** create-time `domainAllowList` only (`toDaytonaNetwork`). `ip_port`
  and `none` policy levels are **create-time errors** here (see §3). Native
  enforcement, no audit feed.

### Docker — [`src/providers/docker-provider.ts`](src/providers/docker-provider.ts)

- **What:** local containers (`ghcr.io/terragon-labs/containers-test`), shelling out
  to the `docker` CLI. Used for **local dev and testing** — it is the `"default"`
  fallback when no `E2B_API_KEY` is present, and the provider for
  `NODE_ENV !== "test"` local runs.
- **Create:** `docker run -d --name … tail -f /dev/null` (`docker-provider.ts:346`);
  `runCommand` is `docker exec` (`:116`), files via `docker cp` (`:240`).
- **Resume:** `docker inspect` then `docker unpause`/`docker start`
  (`getSandboxOrNull`, `:288`).
- **Hibernate / teardown:** hibernate is a no-op on demand; an internal
  `SLEEP_MS` (1 h) timer force-`docker pause`es (`:77`). `shutdown` is
  `docker rm -f` plus egress sidecar/network teardown (`:178`). Static
  `cleanupTestContainers` / `cleanupAllContainers` sweep leaked containers and
  `automata-egress-*` networks.
- **Network:** no native primitive — enforcement is the **filtering-proxy sidecar**
  on an `--internal` network (see §3). This is the only plane with a
  per-connection audit trail today.

### Mock — [`src/providers/mock-provider.ts`](src/providers/mock-provider.ts)

- **What:** in-memory stub for **tests only**. `getSandboxProvider("mock")` throws
  outside `NODE_ENV === "test"` (`provider.ts:15`).
- **Behavior:** `getOrCreateSandbox` returns a `MockSession` with a `nanoid`
  id; all lifecycle methods (`hibernate`/`shutdown`/`extendLife`) are no-ops and
  every I/O method throws `Not implemented`. No network, no process.

---

## 3. Comparison — security/audit, speed, cost

> Grounded in the code plus [`docs/egress-enforcement.md`](../../docs/egress-enforcement.md)
> and [`docs/compliance/soc2-egress-alignment.md`](../../docs/compliance/soc2-egress-alignment.md).
> Where the docs and code disagree, the code wins and it is flagged inline.

|                         | **E2B**                              | **Daytona**                       | **Docker**                            | **Mock**        |
| ----------------------- | ------------------------------------ | --------------------------------- | ------------------------------------- | --------------- |
| Runs where              | managed micro-VM (remote)            | managed sandbox (remote)          | local container                       | in-process stub |
| SDK / lib               | `@e2b/code-interpreter ^2.7.1` (v2)  | `@daytonaio/sdk 0.205.1`          | `docker` CLI                          | none            |
| Egress mechanism        | native firewall `allowOut`/`denyOut` | create-time `domainAllowList`     | `--internal` net + proxy sidecar      | none            |
| Policy levels supported | `none` / `ip_port`\* / `domain`      | `domain` **only**                 | `none` / `ip_port` / `domain`         | n/a             |
| Env-unset bypass?       | no (below process)                   | no (below process)                | no (no route but the proxy)           | n/a             |
| Per-connection audit    | **no feed**                          | **no feed**                       | **yes** — sidecar stdout JSON         | n/a             |
| Resident GitHub token   | yes (`~/.git-credentials`)           | yes                               | brokered-optional (#114 Docker, flag) | n/a             |
| Boot                    | new VM + template pull               | new sandbox + snapshot            | local `docker run` (fastest)          | instant         |
| Resume                  | `connect` auto-resume from pause     | state-machine restore/start       | unpause/start                         | n/a             |
| Cost                    | metered VM (managed billing)         | metered sandbox (managed billing) | local compute only                    | free            |

\* E2B `ip_port`: the level is accepted, but a `host:port` allowlist entry maps to
its bare host — E2B selectors carry no port syntax, so the port pin is dropped at
this plane (`egress.ts:82`, `toE2bNetwork`).

### Recent library work

- **E2B v2 (#105):** SDK moved `1.2.0-beta.4 → ^2.7.1`; templates rebuilt with the
  v2 CLI (`@e2b/cli ^2.17.1`) and **envd ≥ 0.2.0**. The old `autoPause` patch is
  gone in favor of `lifecycle: { onTimeout: "pause" }`, and `Sandbox.resume` was
  replaced by auto-resuming `Sandbox.connect`. **Ops gate:** v2's secure-by-default
  requires templates rebuilt on the new toolchain _before_ the SDK bump reaches
  prod — un-verifiable in CI, a manual pre-deploy step
  ([`docs/egress-enforcement.md`](../../docs/egress-enforcement.md) §E2B).
- **Daytona snapshots (#106):** small + large snapshots rebuilt, plus an org
  disk-cap knob. SDK moved to `0.205.1` (the `@daytona/sdk` dual-publish; import
  name kept as `@daytonaio/sdk`).

### Egress enforcement (#66)

The control plane resolves a per-repo policy into a **shape** —
`{ level, allowlist }` with system hosts (daemon callback, `github.com`,
`api.github.com`, `api.anthropic.com`) already merged — and ships it on
`CreateSandboxOptions.egressPolicy` (`types.ts:68`). Pure mappers in
[`src/egress.ts`](src/egress.ts) translate the shape per provider. **No policy on
the repo ⇒ every provider's create path is exactly today's behavior** (rollback =
clear the columns).

- **Docker** (`docker-egress.ts`, `docker-provider.ts:372`): sandbox pinned to an
  `--internal` network (no route out); a sidecar `<name>-egress` runs the
  standalone filtering proxy (`egress-proxy-standalone.cjs`) on both the internal
  net and the bridge; the sandbox's `HTTP(S)_PROXY` points at it. **Audited** — the
  sidecar logs every allow/deny as JSON to stdout (`docker logs <name>-egress`).
  _Limitation:_ it does not yet POST `egress_events` to the control plane.
- **E2B** (`toE2bNetwork`, `e2b-provider.ts:64`): native `denyOut: ["0.0.0.0/0"]` +
  resolved `allowOut`. Enforced, un-bypassable, but **no per-connection audit feed**
  (documented AC deviation on #66). Domain filtering matches ports 80/443 only;
  blocked TCP connects can _appear_ to succeed — verify by application-level failure.
- **Daytona** (`toDaytonaNetwork`, `egress.ts:130`): `domain` level →
  `domainAllowList` (comma-separated, `*.` wildcards, max 20). `ip_port` and `none`
  **throw at create time** — Daytona's CIDR `networkAllowList` and `domainAllowList`
  are mutually exclusive at creation, so a CIDR list cannot also carry the required
  system hostnames, and `networkBlockAll` alone would sever the daemon callback.
  Repos needing `ip_port`/`none` must use another provider. Enforced, **no audit feed**.

Matcher parity: the Docker proxy mirrors `packages/worker/src/agent-run/egress-proxy.ts`;
`pnpm -C packages/sandbox build-egress-proxy` regenerates both the dist script and
the embedded `src/egress-proxy-standalone.generated.ts` (a vitest test fails on drift).

### Credential hardening (#81 / #114 / #89) — accurate state

Two planes, two very different states:

- **Worker plane — DONE.** `@terragon/worker` brokers _both_ git and the GitHub
  API for non-review lanes: a loopback git-smart-HTTP proxy
  (`packages/worker/src/agent-run/git-broker.ts`) and a unix-socket `api.github.com`
  proxy (`gh-broker.ts`). The installation token stays in the **worker process
  heap** — never in child env, argv, or on disk; the agent gets a non-reusable
  per-run bearer. Brokering is the fail-safe default (`credentialBroker: "on"`
  unless the exact string `legacy-direct` is set). Merged as **PR #113 /
  commit `e264815`** (builds on #65/#79/#80).
- **Sandbox plane — Docker brokered behind a flag (#114, git half); E2B/Daytona
  not yet.** By default every provider still writes a **resident** GitHub token to
  disk on boot: `setupGitCredentials` (`setup.ts:166`) runs
  `git config --global credential.helper store` and writes `~/.git-credentials`
  with the real `GITHUB_ACCESS_TOKEN` from `setupSandboxEveryTime` (`setup.ts:213`).
  With **`SANDBOX_CREDENTIAL_BROKER=on` on the Docker plane** (merged as **PR #117 /
  commit `b0f4fa7`**), a per-run credential-broker **sidecar** holds the
  installation token in a `0o400 :ro` file (never argv/`-e`/`docker inspect`); the
  guest gets only a per-run, repo-fenced bearer — git via `insteadOf`+`Bearer`,
  token injected server-side in the sidecar
  (`providers/docker-cred-broker.ts`, `cred-broker-standalone.cjs`), and **no
  `~/.git-credentials`** on the brokered path. Brokered sandboxes are **not resumed
  in place** — a resume fails closed and recreates fresh under a DB CAS lease
  (`thread.credentialBrokerMode` provenance). Default off = today's exact behavior.
  **Git only:** the `gh`-API half (a CA-terminating CONNECT proxy) is deferred — a
  brokered guest's `gh` API calls fail closed (401) rather than leak. **E2B/Daytona
  stay unbrokered** (managed runtimes, no host-reachable per-run peer). #114 remains
  open for those two + the gh half.
- **#89 (review-lane on-disk credential) — OPEN for E2B/Daytona; closed on the
  brokered Docker path.** The review env-strip removes env keys only, so the
  `~/.git-credentials` channel (`setup.ts:213`) survives it on the unbrokered
  providers; a brokered Docker sandbox writes no such file. Still open for E2B and
  Daytona (and unbrokered/default Docker).

> Note: `docs/compliance/soc2-egress-alignment.md:22` credits only the git broker
> and is worker-plane-scoped; it predates the gh-API broker from PR #113. The
> umbrella issue #81 remains open pending #89/#114.

### Speed & cost, in prose

- **Docker** is the fastest to boot (local `docker run`, no VM provisioning, no
  template pull) and the cheapest (local compute, no managed billing) — but it is
  single-host, unaudited beyond the egress sidecar, and meant for dev/testing.
- **E2B** and **Daytona** carry managed-provider boot cost (VM/sandbox provision +
  template/snapshot pull) and metered billing, in exchange for real remote
  isolation and hibernation (pause/resume, so warm resume is much cheaper than a
  cold create). E2B resume is a single auto-resuming `connect`; Daytona resume walks
  a start/restore state machine.
- **Mock** is instant and free — it does nothing.

### Choosing a provider — honest pros/cons

- **E2B** — _pro:_ default prod provider, fast pause/resume, native
  un-bypassable firewall, full policy-level coverage. _con:_ no per-connection audit
  feed; `ip_port` port pins are dropped; v2 requires the envd-≥0.2.0 template
  rebuild before deploy; still holds a resident token.
- **Daytona** — _pro:_ managed remote isolation, generous auto-stop/archive/delete
  lifecycle, native enforcement. _con:_ **`domain`-level egress only** (`ip_port`
  and `none` are hard errors); tier 1/2 orgs cannot override network settings (verify
  on the real org first); no audit feed; resident token.
- **Docker** — _pro:_ fastest, free, the **only** plane with per-connection egress
  audit, and the only sandbox plane that can broker credentials
  (#114 Docker, `SANDBOX_CREDENTIAL_BROKER=on` → no resident token in the guest); great for local iteration. _con:_ local single-host, not
  remote isolation; hibernate is timer-based; still writes a resident token like
  every sandbox provider today; not a production isolation boundary.
- **Mock** — _pro:_ zero-cost deterministic tests. _con:_ test-only; every I/O
  method throws.

---

## Development

```bash
pnpm -C packages/sandbox test                 # unit tests
# opt-in Docker egress integration test (needs a docker daemon):
SANDBOX_PROVIDER=docker pnpm -C packages/sandbox vitest run docker-egress.integration
pnpm -C packages/sandbox build-egress-proxy   # regenerate the standalone egress proxy
```

Sandbox template images (E2B, Daytona) are built from
[`@terragon/sandbox-image`](../sandbox-image/README.md).
