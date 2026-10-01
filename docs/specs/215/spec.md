# Spec — #215: in-process engine-liveness watchdog for the execution-plane worker

- Ticket: #215 (child of #192) — "The worker wedges alive"
- Base revision: `main` = `dec1664` (`fix(worker): one network blip ended a run at the credential pull (#212) (#216)`), verified with `git -C /Users/senior/.superset/projects/automata-platform/.claude/worktrees/215 log --oneline -3`
- Worktree: `/Users/senior/.superset/projects/automata-platform/.claude/worktrees/215`
- Language: English (matches the existing corpus — `docs/specs/152/refinement-report.md`)

---

## 1. Objetivo / Goal

Build an **in-process liveness watchdog** for `@terragon/worker` that exits the process
non-zero when the worker stops being able to take work, so systemd's already-present
`Restart=always` / `RestartSec=15` actually fires.

**The outcome it enables.** On 2026-09-29 the worker wedged *alive*: the gRPC connection
to the Hatchet engine broke, the SDK never reconnected and never threw, and the process
stayed up. systemd saw a healthy unit for 41 minutes. Every cheap signal was green — the
TCP socket to `127.0.0.1:7077` stayed `ESTABLISHED` on a dead connection, `systemctl
is-active` said `active`, and the engine's `/api/ready` returned `200` — while no run could
be dispatched. The journal's last line was at 19:19:05
(`[ERROR/Dispatcher] Error: /Dispatcher/SendStepAc...`) and the next line was the
operator's SIGTERM at 20:00:30. 60 minutes of production outage, ended by a human.

After this ticket, a box that has opted in detects that state **from the engine's own
view of it** — the engine `Worker` row's `lastHeartbeatAt`, which went 40m47s stale while
everything else looked green — and kills itself loudly so the supervisor recovers it.

**What this is NOT.** It is not a reconnect. The SDK owns the gRPC loop and exposes no
connection-lost hook; the recovery mechanism is process death plus `Restart=always`. This
ticket builds only the detector and the exit.

---

## 2. Alcance / Scope

### Incluido en esta fase

1. A new module `packages/worker/src/agent-run/engine-liveness.ts`:
   - a defensive REST probe of the engine's tenant worker collection,
   - a pure evaluator mapping (probe result, clock) → `"healthy" | "unreadable" | "wedged"`,
   - a driver (`start` / `tick` / `stop`) with **both the clock and the exit injected**.
2. Configuration knobs in `packages/worker/src/agent-run/config.ts`, gated exactly like
   `WORKER_RUN_MEMORY_MAX` (#204) and `WORKER_AGENT_USER` (#108): validated, off by
   default, and refusing to boot rather than running half-configured.
3. Wiring in `packages/worker/src/hello/worker.ts` — the watchdog starts immediately
   before `await worker.start()`.
4. Unit tests (`packages/worker/src/agent-run/engine-liveness.test.ts`, plus config cases
   appended to `packages/worker/src/agent-run/config.test.ts`) covering every DoD
   scenario, including the namespaced-worker case.
5. A `## Engine-liveness watchdog (#215)` subsection in
   `packages/worker/deploy/README.md`, shaped after `## Agent-uid mode (#108)` at
   `README.md:58-72`, and the one-line `WORKER_RUN_MEMORY_MAX` ceiling knob that section
   is missing (see §6, FACT 4).

### Fuera de scope

- **Any systemd change.** `Restart=always` + `RestartSec=15` already exist at
  `packages/worker/deploy/linux/automata-worker.service:72-73` (confirmed in-tree). The
  recovery half is done; this ticket adds nothing to the unit, no drop-in, no new
  `ExecStartPre`.
- **`TimeoutStopSec=2100`** (`automata-worker.service:67`). It turns a restart of an
  already-wedged worker into a ~35-minute outage, because the SDK's drain awaits a
  connection that is already dead. The value is *correct* for a real in-flight run;
  whether the drain should bail early when nothing is in flight is a separate decision.
  **State this in the PR body; do not fix it here.**
- **Reconnecting the SDK**, patching `@hatchet-dev/typescript-sdk`, or adding a custom
  `SIGTERM`/`SIGINT` handler. `hello/worker.ts` deliberately installs none (the SDK's own
  handler drains); a second one would race it.
- **Log scraping.** The SDK emitted no heartbeat-failure line, no reconnect line, nothing,
  for the whole 41 minutes; the 7 `Failed to send heartbeat` lines that day all fall
  outside the wedge window. A grep-based watchdog would never have fired. Do not build one.
- **Keying on the TCP socket, `systemctl is-active`, or the engine's `/api/ready`.** All
  three were green for the entire outage. A code comment must say so (§10 D-7).
- **Restarting or health-checking the engine**, the compose stack, or the daemon.
- **Alerting, metrics export, Datadog, `/healthz` surface changes.** The existing optional
  `WORKER_HEALTH_PORT` listener (#69) is untouched.
- **Cancelling or reclaiming the in-flight run** on exit. The exit is a `process.exit(1)`;
  existing boot-time reclaim (`reclaimDeadWorkerRuns`, `bootUidScan`) covers the relaunch.
- **Any change to `assert-auth.ts`.** It is not in this ticket's ownership map. This ticket
  **imports** its exported `loadAuthProbeConfig` and does not edit the file.
- **Multi-box / multi-worker semantics.** One worker process per box (`slots: 1` + the
  kernel box lock). The probe matches this process's own registered name only.
- **Any control-plane (`apps/www`) change.**

---

## 3. Tecnologías y convenciones / Technologies & conventions

| Thing | Value | Evidence |
|---|---|---|
| Package | `@terragon/worker` v1.0.0, `"type": "module"` | `packages/worker/package.json` |
| SDK | `@hatchet-dev/typescript-sdk` `^1.26.0` (resolved 1.26.0) | `packages/worker/package.json` deps; `node_modules/.pnpm/@hatchet-dev+typescript-sdk@1.26.0.../package.json` |
| TypeScript | `^5.8.3`, `strict: true`, `noUncheckedIndexedAccess: true`, `noUnusedLocals`, `noUnusedParameters`, `moduleResolution: "bundler"`, `module: ESNext`, `target: ES2022` | `packages/worker/tsconfig.json` |
| Tests | `vitest` `^3.1.4`, co-located `*.test.ts`, run with `--no-file-parallelism` | `packages/worker/package.json` `"test"`; there is **no** `packages/worker/vitest.config.ts` |
| Runner | `tsx` `^4.20.3` (`"worker": "… tsx src/hello/worker.ts"`) | `packages/worker/package.json` |
| HTTP | global `fetch`, injected as `fetchImpl: typeof fetch = fetch` | `src/agent-run/assert-auth.ts:92` |
| Logging | plain `console.log` / `console.error` with a bracketed prefix (`[worker-boot] …`) | `src/hello/worker.ts` throughout |
| Lint | **`@terragon/worker` has NO `lint` script.** A `turbo lint --filter=@terragon/worker` resolves to zero tasks; green there is not evidence, which is why it is absent from the verification command. | `packages/worker/package.json` scripts |

### Existing patterns this must respect

- **Config gating doctrine** (`src/agent-run/config.ts`): a feature is opted into by an
  exact, validated env value; unset/typo/garbage degrades to the safe default; a
  *half-configured* opt-in **throws** at `loadWorkerConfig()`, which both blocks boot and
  blocks every run (every caller loads the config). Exemplars: `parseMemoryMax` (throws on
  a typo and on a ceiling below 256M), and the `memoryMaxBytes > 0 && !agentUser` throw.
- **Boot wiring doctrine** (`src/hello/worker.ts`): each boot gate is a `try { … } catch {
  console.error("[worker-boot] FATAL: …"); process.exit(1); }` block with a one-line
  success log.
- **Background-loop doctrine** (`src/agent-run/scheduling-maintenance.ts:282-309`):
  master-gate returns a no-op handle when the feature is off; otherwise
  `setInterval(...)`, `timer.unref?.()`, one immediate best-effort tick, and the tick
  never throws.
- **TypeScript rules** (`.claude/rules/typescript/best-practices.md`): ES `import` only;
  `interface` for object shapes, `type` for unions; `unknown` + type guards at external
  boundaries; `??` not `||` for defaults; catch `unknown` and narrow with `instanceof
  Error`; never log secrets; files `kebab-case.ts`.

---

## 4. Dependencias previas / Prerequisites

Everything below was **personally confirmed in this worktree at `dec1664`** unless the row
says otherwise.

- [x] `packages/worker/src/agent-run/config.ts` exists and exports `WorkerConfig` +
      `loadWorkerConfig(env)`. Confirmed.
- [x] `packages/worker/src/hello/worker.ts` exists and ends in `await worker.start()`
      inside `main()`, with `main().catch(...)`. Confirmed.
- [x] `packages/worker/deploy/README.md` exists; `## Agent-uid mode (#108)` is at line 58,
      and its "hard boot failure" bullet at line 68. Confirmed by `grep -n '^##'`.
- [x] `packages/worker/deploy/linux/automata-worker.service` contains `Restart=always`
      (line 72) and `RestartSec=15` (line 73). Confirmed by reading the file in-tree, per DoD.
- [x] `WorkerList` is declared verbatim as
      `export interface WorkerList { pagination?: PaginationResponse; rows?: Worker[]; }`
      at `data-contracts.d.ts:2112-2115`. Confirmed.
- [x] `Worker` (`data-contracts.d.ts:2064-2111`) has `name: string` (required, `:2067`) and
      `lastHeartbeatAt?: string` (**optional**, ISO-8601, `:2070-2074`). Confirmed.
- [x] The REST route is `GET /api/v1/tenants/{tenant}/worker` — a **collection** route, not
      a by-id route. Confirmed at `clients/rest/generated/Api.js:1271`. (This matters:
      by-id worker GETs return 403 for API tokens on this engine; the collection route is
      the one that works.)
- [x] `applyNamespace(name, namespace?)` is
      `namespace && !name.startsWith(namespace) ? `${namespace}${name}` : name`, at
      `@hatchet-dev/typescript-sdk/util/apply-namespace.js:4-9`, `.d.ts:1`. Confirmed.
- [x] The SDK registers `this.name = applyNamespace(options.name, this.client.config.namespace)`
      at `v1/client/worker/worker-internal.js:91`. Confirmed.
- [x] The namespace is read from `HATCHET_CLIENT_NAMESPACE` and **normalised to end in an
      underscore** (`if (namespace && !namespace.endsWith('_')) namespace = `${namespace}_``)
      at `util/config-loader/config-loader.js:82-85`. Confirmed. This is why the watchdog
      must read `hatchet.config.namespace` (already normalised) rather than the raw env var.
- [x] `HATCHET_CLIENT_NAMESPACE` / `HATCHET_NAMESPACE` are set **nowhere** in this worktree
      (`grep -rn HATCHET_CLIENT_NAMESPACE`, excluding `node_modules`/`.git` → 0 hits), so
      today the registered name is the unprefixed `automata-worker-${boxId}` — which the
      live journal corroborates (`[INFO/Worker/automata-worker-automata-exec-1]`).
- [x] `HatchetClient` exposes `get config(): ClientConfig` and `ClientConfig` has
      `namespace?: string`. Confirmed at `v1/client/client.d.ts` and
      `clients/hatchet-client/client-config.d.ts:49`.
- [x] `src/agent-run/assert-auth.ts` exports `loadAuthProbeConfig(env)` returning
      `{ apiUrl, tenantId, realToken }`, resolving from `HATCHET_API_URL` /
      `HATCHET_TENANT_ID` or the `HATCHET_CLIENT_TOKEN` JWT claims (`server_url`, `sub`),
      and **throwing** when unresolvable. Confirmed at `assert-auth.ts:47-76`.
- [x] `assertAuthEnabledFromEnv()` already runs first in `main()` and exits 1 on failure,
      so by the time the watchdog starts, the same probe config is known to be resolvable.
      Confirmed.
- [ ] **`pnpm install` has NOT been run in this worktree.** `node_modules/` is absent at
      both the worktree root and `packages/worker/`, so no verification command has been
      executed here yet. Phase 1's preamble must run
      `pnpm install --frozen-lockfile --prefer-offline` from the worktree root first.
      This is the one prerequisite that is **not** satisfied today.

---

## 5. Arquitectura / Architecture

**Pattern:** a self-contained, dependency-injected polling watchdog module, plus a thin
boot-time wiring call. It follows the same shape as the #69 maintenance loop: a master
gate in config, a no-op handle when off, an unref'd interval when on, and a tick that can
never throw.

### Affected layers

| Layer | Affected | Description |
|---|---|---|
| Config (`src/agent-run/config.ts`) | **Yes** | Two new validated env knobs + the half-configured throw. |
| Worker boot (`src/hello/worker.ts`) | **Yes** | One `startEngineLivenessWatchdog(...)` call before `await worker.start()`. |
| New domain module (`src/agent-run/engine-liveness.ts`) | **Yes (NEW)** | Probe + evaluator + driver. |
| Workflow / run execution (`src/agent-run/workflow.ts`, `daemon-process.ts`) | No | The watchdog never touches a run. |
| Engine DB (`src/agent-run/engine-db.ts`, `scheduling-*.ts`) | No | This probe is REST, not SQL, and is gated independently of `HATCHET_ENGINE_DATABASE_URL`. |
| systemd / launchd units | No | `Restart=always` already exists; nothing is added (§2). |
| Deploy docs (`deploy/README.md`) | **Yes** | New subsection + the missing ceiling line. |
| Control plane (`apps/www`), DB schema, daemon | No | — |

### Numbered flow

1. `main()` in `hello/worker.ts` runs the existing boot gates (auth probe, node floor, box
   lock, namespace claim, uid scan, slot reclaim, cgroup ceiling) unchanged.
2. `const worker = await hatchet.worker(`automata-worker-${boxId}`, { workflows, slots: 1 })`
   registers the worker under `applyNamespace("automata-worker-<boxId>", hatchet.config.namespace)`.
3. **New:** a gated block in `hello/worker.ts` does the resolving, and the driver
   (`startEngineLivenessWatchdog`) receives only already-resolved values. **The boot site,
   not the driver, owns config, namespace resolution and both boot log lines** (see §6 for
   the exact interface, which is authoritative):
   - If `cfg.livenessStaleAfterS === 0` (the default) `hello/worker.ts` logs the single
     "off" note and **never calls the driver**: no timer, no fetch, no listener, nothing
     else.
   - Otherwise `hello/worker.ts` resolves the probe config once via `loadAuthProbeConfig()`,
     computes `probeWorkerName = resolveProbeWorkerName(`automata-worker-${boxId}`,
     hatchet.config.namespace)`, calls
     `startEngineLivenessWatchdog({ staleAfterMs, pollIntervalMs, probeWorkerName, probe,
     now: () => Date.now(), onWedged, log })`, and logs the one armed line. The driver
     itself starts an unref'd `setInterval` at `pollIntervalMs` and fires one immediate tick.
   - The driver's own `staleAfterMs: 0` case still returns a no-op handle (it is what the
     "inert when unconfigured" test drives), but on the production path that case is
     unreachable because the boot site does not call it when the feature is off.
4. `await worker.start()` — the SDK owns the loop from here and never returns.
5. Each tick: `probe()` → `GET {apiUrl}/api/v1/tenants/{tenantId}/worker` with
   `Authorization: Bearer <token>`.
6. The response body is narrowed by a type guard to `WorkerList`. **Any** deviation —
   network throw, non-2xx status, non-JSON body, `rows` absent or not an array, no row
   whose `name === probeName`, the matching row's `lastHeartbeatAt` absent or unparseable —
   yields `"unreadable"`.
7. On `"unreadable"`: record it, log at most one throttled line, **never exit**, whatever
   the duration. Unreadable means unknown, and this watchdog's whole reason to exist is
   that it must not become the thing that takes the box down.
8. On a readable heartbeat: `stalenessMs = now() - Date.parse(lastHeartbeatAt)`.
   - `stalenessMs <= thresholdMs` → `"healthy"`; the tick returns.
   - `stalenessMs > thresholdMs` → `"wedged"`: log **one** line naming the observed
     staleness and the threshold, then call `onWedged(line)`, whose production
     implementation is `console.error(line); process.exit(1);`.
9. systemd sees a non-zero exit, waits `RestartSec=15`, relaunches; the fresh process runs
   its boot gates and the boot-time reclaim paths, and re-registers.

A negative staleness (engine clock ahead of the box) clamps to 0 and is treated as
`"healthy"`; it can never be `> thresholdMs`.

### File layout

```
packages/worker/
├── src/
│   ├── agent-run/
│   │   ├── config.ts                    MODIFY  two knobs + half-config throw
│   │   ├── config.test.ts               MODIFY  knob parsing / gating cases
│   │   ├── engine-liveness.ts           NEW     probe + evaluator + driver
│   │   └── engine-liveness.test.ts      NEW     all DoD scenarios
│   └── hello/
│       └── worker.ts                    MODIFY  one start call before worker.start()
└── deploy/
    └── README.md                        MODIFY  "## Engine-liveness watchdog (#215)"
```

---

## 6. Archivos a crear o modificar / Files to create or modify

| Ruta (relative to `/Users/senior/.superset/projects/automata-platform/.claude/worktrees/215`) | Acción | Propósito | Ejemplo del proyecto a seguir |
|---|---|---|---|
| `packages/worker/src/agent-run/config.ts` | MODIFICAR | `livenessStaleAfterS`, `livenessPollS`; validated, off-by-default, throw when half-configured | `parseMemoryMax` + the `memoryMaxBytes > 0 && !agentUser` throw in the same file |
| `packages/worker/src/agent-run/config.test.ts` | MODIFICAR | Parsing + gating cases for the two knobs | the existing `WORKER_RUN_MEMORY_MAX` cases in the same file |
| `packages/worker/src/agent-run/engine-liveness.ts` | NUEVO | Probe, type guard, evaluator, injected-clock/exit driver | `scheduling-maintenance.ts:282-309` (loop) + `assert-auth.ts` (injected `fetchImpl`) |
| `packages/worker/src/agent-run/engine-liveness.test.ts` | NUEVO | Every DoD scenario incl. namespaced match and inert-when-unconfigured | `assert-auth.test.ts` (fake `fetch`), `scheduling-health.test.ts` |
| `packages/worker/src/hello/worker.ts` | MODIFICAR | Start the watchdog before `await worker.start()` | the `prepareCeilingSubtreeAtBoot()` wiring in the same file |
| `packages/worker/deploy/README.md` | MODIFICAR | `## Engine-liveness watchdog (#215)` + the missing ceiling knob line | `## Agent-uid mode (#108)` at `README.md:58-72` |

> **Ownership.** The ownership map for this loop run assigns `config.ts`, `hello/worker.ts`
> and `deploy/README.md` to #215; the two `engine-liveness.*` files are net-new and owned by
> this ticket by creation. `config.test.ts` is the co-located test of an owned file and is
> edited additively (append cases; change nothing existing). **No other file may be touched.**
> In particular `assert-auth.ts` is imported, never edited.
> `docs/specs/152/refinement-report.md:96-98` carries a *different, historical* #152 map that
> also names `hello/worker.ts`; that is finished work and does not constrain this run.

### Per-file detail

#### `packages/worker/src/agent-run/config.ts` — MODIFICAR

Add to the `WorkerConfig` interface, after the `#204` ceiling fields, with a comment block
in the house style:

```ts
  /**
   * #215: engine-liveness watchdog. Seconds of observed staleness in THIS worker's
   * engine `Worker.lastHeartbeatAt` after which the process exits non-zero so
   * systemd's Restart=always relaunches it.
   *
   * 0 (the DEFAULT) = OFF: no timer, no probe, no exit — byte-for-byte today's boot.
   *
   * Deliberately generous. An idle worker is not a wedged worker, and a watchdog that
   * restart-loops a healthy box is worse than the bug it covers, so the loader REFUSES
   * anything below LIVENESS_STALE_FLOOR_S rather than accepting a hair-trigger.
   */
  livenessStaleAfterS: number;
  /** #215: watchdog tick period, seconds. Only read when the watchdog is on. */
  livenessPollS: number;
```

Add two module-level constants and two exported parsers, mirroring `parseMemoryMax` /
`parseTasksMax`:

```ts
/** Minimum accepted WORKER_LIVENESS_STALE_S. See parseLivenessStaleAfterS. */
const LIVENESS_STALE_FLOOR_S = 300;
/** Default tick period when the watchdog is on. */
const LIVENESS_POLL_DEFAULT_S = 60;
```

- `export function parseLivenessStaleAfterS(raw: string | undefined): number`
  - unset / empty / whitespace → `0` (OFF).
  - not an integer, or `<= 0` → **throw**, naming the variable and the value.
  - `> 0` but `< LIVENESS_STALE_FLOOR_S` → **throw**: `WORKER_LIVENESS_STALE_S=<v> is
    below <floor>s; a threshold that short restart-loops an idle box (an idle worker is
    not a wedged worker)`.
  - otherwise the integer.
- `export function parseLivenessPollS(raw: string | undefined): number`
  - unset / empty → `LIVENESS_POLL_DEFAULT_S`.
  - not an integer, or `< 5` → **throw**.

In `loadWorkerConfig`, parse **before** the return (alongside the `#204` block, so a typo
is refused at boot rather than at the first tick), and add the half-configured guard:

```ts
const livenessStaleAfterS = parseLivenessStaleAfterS(env.WORKER_LIVENESS_STALE_S);
// Only validated when the watchdog is ON — same reasoning as parseTasksMax: with the
// feature off the value is unused, and a stray env var must not stop an unrelated box
// from booting.
const livenessPollS =
  livenessStaleAfterS > 0 ? parseLivenessPollS(env.WORKER_LIVENESS_POLL_S) : 0;
// A POLL PERIOD AT OR ABOVE THE THRESHOLD CANNOT DETECT ANYTHING. The first tick after
// the wedge would already be past the deadline in the best case and could be a whole
// period late, so the box would look guarded and be guarded by nothing. Refuse, the same
// way WORKER_RUN_MEMORY_MAX without WORKER_AGENT_USER is refused.
if (livenessStaleAfterS > 0 && livenessPollS >= livenessStaleAfterS) {
  throw new Error(
    `WORKER_LIVENESS_POLL_S=${livenessPollS} must be well below ` +
      `WORKER_LIVENESS_STALE_S=${livenessStaleAfterS}: a watchdog that ticks no more ` +
      `often than its own threshold cannot observe staleness, and a box told to guard ` +
      `itself must not run unguarded.`,
  );
}
```

and return both fields. **Change nothing else in this file.**

#### `packages/worker/src/agent-run/engine-liveness.ts` — NUEVO

Top-of-file doc comment, which must contain — verbatim in substance — the
do-not-simplify note required by the acceptance criteria:

```ts
/**
 * #215: in-process engine-liveness watchdog.
 *
 * WHY THIS SIGNAL AND NOT A CHEAPER ONE. On 2026-09-29 the worker wedged alive for 41
 * minutes: the SDK's gRPC connection to the engine broke, it never reconnected, never
 * threw, and the process stayed up, so systemd's Restart=always never fired. During that
 * whole window THREE obvious signals were GREEN and all three lied:
 *   - the TCP socket to 127.0.0.1:7077 stayed ESTABLISHED on a dead connection;
 *   - `systemctl is-active automata-worker` said `active`;
 *   - the engine's /api/ready returned 200, while every engine reconciliation loop failed.
 * A fourth tempting signal, grepping the journal, is just as dead: the SDK emitted no
 * heartbeat-failure line, no reconnect line, NOTHING, between 19:19:05 and the operator's
 * SIGTERM at 20:00:30.
 *
 * DO NOT "simplify" this watchdog into any of those. The only honest signal is the
 * ABSENCE of a successful engine interaction read from the ENGINE's own view of this
 * worker: the `Worker` row's `lastHeartbeatAt`, which went 40m47s stale while everything
 * above looked healthy.
 *
 * FAILS TO UNKNOWN, NEVER TO WEDGED. An unreadable probe — network error, non-2xx, a body
 * that does not match the declared envelope, no row for this worker — is "unreadable" for
 * as long as it lasts and never exits. Only a genuinely stale-but-READABLE heartbeat does.
 */
```

One module-level constant, named in the same style as `config.ts`'s
`LIVENESS_STALE_FLOOR_S` / `LIVENESS_POLL_DEFAULT_S`, exported because the wiring site
derives the probe's `timeoutMs` from it:

```ts
/**
 * Upper bound on the probe's abort budget, milliseconds. The effective timeout is
 * `Math.min(LIVENESS_PROBE_TIMEOUT_CAP_MS, Math.floor(livenessPollS * 1000 / 2))`, so it
 * is always at most half a tick period (§17: a hung request must not stack ticks) and
 * never more than 10s even at a long poll period.
 */
export const LIVENESS_PROBE_TIMEOUT_CAP_MS = 10_000;
```

Exported surface:

```ts
export type LivenessReading =
  | { kind: "reading"; lastHeartbeatAtMs: number }
  | { kind: "unreadable"; reason: string };

export type LivenessVerdict =
  | { kind: "healthy"; stalenessMs: number }
  | { kind: "unreadable"; reason: string }
  | { kind: "wedged"; stalenessMs: number };

export interface EngineLivenessProbeConfig {
  apiUrl: string;
  tenantId: string;
  token: string;
  /** The NAMESPACED name the engine knows this worker by. See resolveProbeWorkerName. */
  probeWorkerName: string;
  /**
   * Abort budget for the one GET, milliseconds. Passed in rather than guessed, because
   * §17 requires it to sit well below the watchdog's tick period and the probe cannot
   * see that period. The wiring site derives it as
   * `Math.min(LIVENESS_PROBE_TIMEOUT_CAP_MS, Math.floor(livenessPollS * 1000 / 2))`.
   */
  timeoutMs: number;
}

export interface EngineLivenessWatchdogOptions {
  staleAfterMs: number;
  pollIntervalMs: number;
  /**
   * The NAMESPACED name, for the FATAL line only. The driver never probes on its own —
   * the name lives inside the injected `probe` closure — but formatWedgedLine names the
   * worker, so the driver must be told it explicitly.
   */
  probeWorkerName: string;
  probe: () => Promise<LivenessReading>;
  /** Injected clock. Tests pass a fake; production passes () => Date.now(). */
  now: () => number;
  /** Injected exit. Tests capture; production logs + process.exit(1). */
  onWedged: (message: string) => void;
  log?: (message: string) => void;
}

export interface EngineLivenessWatchdogHandle {
  /** One evaluation. Exported for tests: no real timers anywhere in the suite. */
  tick: () => Promise<LivenessVerdict>;
  stop: () => void;
}
```

Functions:

- `export function resolveProbeWorkerName(rawName: string, namespace: string | undefined): string`
  — a one-line wrapper over the SDK's own `applyNamespace`, imported as
  `import { applyNamespace } from "@hatchet-dev/typescript-sdk/util/apply-namespace";`.
  Its doc comment states the precondition (FACT 2):

  > The engine knows this worker by `applyNamespace(options.name, client.config.namespace)`
  > (`v1/client/worker/worker-internal.js:91`), so a probe that matched the RAW
  > `automata-worker-${boxId}` would find no row the moment a namespace is configured,
  > read "unreadable" forever, and never exit — a box that LOOKS guarded while running
  > unguarded. `HATCHET_CLIENT_NAMESPACE` is unset everywhere on `main` today, so the two
  > names are identical on the live box; that is a fact about today's config, not an
  > invariant, which is exactly why this goes through the same transform. The namespace
  > must come from `hatchet.config.namespace` (the SDK normalises it to a trailing `_` at
  > `config-loader.js:82-85`), never from the raw env var, and never from
  > `worker._internal.name`.

- `export function isWorkerList(value: unknown): value is { rows?: Array<{ name?: unknown; lastHeartbeatAt?: unknown }> }`
  — the defensive guard. Cites the contract:
  `@hatchet-dev/typescript-sdk/clients/rest/generated/data-contracts.d.ts:2112` declares
  `export interface WorkerList { pagination?: PaginationResponse; rows?: Worker[]; }`,
  and `Worker.lastHeartbeatAt?: string` is **optional** (`:2070-2074`). The guard accepts
  an object whose `rows`, when present, is an array; every field is re-checked per row.
  Anything else → the caller reports `"unreadable"`.

- `export async function probeEngineLiveness(cfg, fetchImpl: typeof fetch = fetch): Promise<LivenessReading>`
  — `GET ${apiUrl.replace(/\/+$/, "")}/api/v1/tenants/${tenantId}/worker` with
  `Authorization: Bearer ${cfg.token}` and `signal: AbortSignal.timeout(cfg.timeoutMs)`.
  Wrapped in try/catch; `res.ok` checked; body parsed
  with `await res.json()` inside its own try. Picks the row whose `name === probeWorkerName`
  with the **greatest** parseable `lastHeartbeatAt` (a relaunched worker can leave a stale
  same-named row behind — see §11). Returns `{ kind: "unreadable", reason }` on every
  failure path, with a short, secret-free reason.
  **Never log or embed the token, the Authorization header, or the response body.**

- `export function evaluateLiveness(reading: LivenessReading, nowMs: number, staleAfterMs: number): LivenessVerdict`
  — pure. `unreadable` passes through. Otherwise
  `stalenessMs = Math.max(0, nowMs - reading.lastHeartbeatAtMs)`; `> staleAfterMs` →
  `wedged`, else `healthy`.

- `export function formatWedgedLine(stalenessMs: number, staleAfterMs: number, probeWorkerName: string): string`
  — the single loud line, exported so the test asserts the exact text:

  ```
  [worker-liveness] FATAL: no successful engine interaction for <N>s (threshold <T>s) — worker "<name>" is wedged alive; exiting non-zero so the supervisor restarts it
  ```

  where `<N>` is `Math.round(stalenessMs / 1000)` and `<T>` is `staleAfterMs / 1000`.

- `export function startEngineLivenessWatchdog(opts: EngineLivenessWatchdogOptions): EngineLivenessWatchdogHandle`
  — `tick()` = `probe()` → `evaluateLiveness(...)`; on `wedged`, call
  `onWedged(formatWedgedLine(verdict.stalenessMs, opts.staleAfterMs, opts.probeWorkerName))`
  **once** (a `fired` latch, so a synchronous `onWedged` in a test cannot be re-entered and
  a real `process.exit` in flight is not raced); on `unreadable`, log at most one line per
  contiguous unreadable streak. `tick` never throws — a rejected `probe()` is caught and
  becomes `unreadable`. `setInterval(..., pollIntervalMs)`, `timer.unref?.()`, one
  immediate fire-and-forget tick, `stop()` clears the timer.

#### `packages/worker/src/hello/worker.ts` — MODIFICAR

Immediately after the `const worker = await hatchet.worker(...)` block and before
`startMaintenanceLoop(...)` / `await worker.start()`, add one gated block in the existing
boot-gate style:

```ts
// #215: in-process engine-liveness watchdog. OFF unless WORKER_LIVENESS_STALE_S is set,
// in which case this is the only thing that turns a wedged-but-alive worker back into a
// running one — the unit's Restart=always cannot fire on a process that never exits.
// Started AFTER registration (there is no engine row before it) and BEFORE
// `worker.start()`, which never returns.
{
  const cfg = loadWorkerConfig();
  if (cfg.livenessStaleAfterS <= 0) {
    console.log("[worker-boot] engine-liveness watchdog: OFF (WORKER_LIVENESS_STALE_S unset)");
  } else {
    const probeConfig = loadAuthProbeConfig();          // from assert-auth.ts; throws if unresolvable
    const probeWorkerName = resolveProbeWorkerName(
      `automata-worker-${boxId}`,
      hatchet.config.namespace,
    );
    const pollIntervalMs = cfg.livenessPollS * 1000;
    // §17: the abort budget must sit well below the tick period so a hung request cannot
    // stack ticks. Half a period, capped at LIVENESS_PROBE_TIMEOUT_CAP_MS.
    const timeoutMs = Math.min(LIVENESS_PROBE_TIMEOUT_CAP_MS, Math.floor(pollIntervalMs / 2));
    startEngineLivenessWatchdog({
      staleAfterMs: cfg.livenessStaleAfterS * 1000,
      pollIntervalMs,
      probeWorkerName,
      probe: () =>
        probeEngineLiveness({
          apiUrl: probeConfig.apiUrl,
          tenantId: probeConfig.tenantId,
          token: probeConfig.realToken,
          probeWorkerName,
          timeoutMs,
        }),
      now: () => Date.now(),
      onWedged: (message) => {
        console.error(message);
        process.exit(1);
      },
      log: (m) => console.log(`[worker-liveness] ${m}`),
    });
    console.log(
      `[worker-liveness] armed: worker "${probeWorkerName}", stale after ${cfg.livenessStaleAfterS}s, poll ${cfg.livenessPollS}s`,
    );
  }
}
```

The whole block is wrapped in the file's standard `try { … } catch (err) { console.error(
"[worker-boot] FATAL: the engine-liveness watchdog is configured but cannot be armed —
refusing to start", err); process.exit(1); }`. **Change nothing else in this file** — no
signal handler, no reordering of existing gates.

#### `packages/worker/deploy/README.md` — MODIFICAR

Insert a new `## Engine-liveness watchdog (#215)` section immediately after the
`## Agent-uid mode (#108)` section (i.e. before `## Install` at the current line 74),
shaped exactly like it: one paragraph of what and why, one sentence of "OFF by default",
then a short "two things that will otherwise bite" list including the **hard boot failure**
note in the same voice as `README.md:68`.

Required content:

- `WORKER_LIVENESS_STALE_S` — seconds of engine-observed heartbeat staleness before the
  worker exits non-zero. **Unset (the default) = OFF**, byte-for-byte the behaviour above.
  Suggested starting value `900`.
- `WORKER_LIVENESS_POLL_S` — tick period, default `60`; only read when the watchdog is on.
- The bite list:
  - `WORKER_LIVENESS_POLL_S` at or above `WORKER_LIVENESS_STALE_S` is a **hard boot
    failure** — a watchdog that ticks no more often than its own threshold cannot observe
    staleness.
  - `WORKER_LIVENESS_STALE_S` below `300` is refused: an idle worker is not a wedged
    worker, and a hair-trigger restart-loops a healthy box.
- One sentence that recovery is the unit's existing `Restart=always` / `RestartSec=15` and
  that **nothing** needs adding on the systemd side.
- One sentence that an unreadable probe is never a restart.

Separately, and within this file's ownership (FACT 4: no markdown file in the repo mentions
`WORKER_RUN_MEMORY_MAX` — #204's ceiling shipped undocumented), add **one line** to the
`## Agent-uid mode (#108)` bite list:

- `WORKER_RUN_MEMORY_MAX` (#204) is the per-run memory ceiling and **requires**
  `WORKER_AGENT_USER` plus the `automata-worker.service.d/10-ceiling.conf` drop-in; set
  without either, the worker refuses to boot.

That is the entire README change. Do not restructure or reformat the rest of the file.

---

### Implementation phases

Each phase lists exactly the files it touches and is verified with the project's canonical
command, run from the worktree ROOT
(`/Users/senior/.superset/projects/automata-platform/.claude/worktrees/215`):

```bash
pnpm turbo tsc-check --force --filter=@terragon/worker && \
pnpm turbo format-check --force --filter=@terragon/worker && \
pnpm --filter @terragon/worker exec vitest run --no-file-parallelism
```

> **Sandbox note, not a regression:** the worker suite binds local ports, and under the
> Bash sandbox ~50 tests fail with `listen EPERM`. On `EPERM` at bind, re-run the
> verification with `dangerouslyDisableSandbox: true`. `turbo lint --filter=@terragon/worker`
> is deliberately absent — the package has no `lint` script, so it resolves to zero tasks
> and green there proves nothing.

**Phase 1 — configuration (2 files).**
*Preamble, run before touching any file:* from the worktree root, `pnpm install
--frozen-lockfile --prefer-offline` (this worktree has **no** `node_modules` yet — see §4 —
so nothing compiles or tests until this succeeds).
Files: `packages/worker/src/agent-run/config.ts`,
`packages/worker/src/agent-run/config.test.ts`.
Proves: the knobs parse, default to OFF, and a half-configured box throws.

**Phase 2 — the watchdog module (2 files).**
Files: `packages/worker/src/agent-run/engine-liveness.ts`,
`packages/worker/src/agent-run/engine-liveness.test.ts`.
Proves: every DoD scenario — stale→exit with the asserted line, fresh→no exit over a
simulated window longer than the threshold, idle-but-healthy→no exit, unreadable for longer
than the threshold→no exit, namespaced probe still matches, clock and exit both injected.

**Phase 3 — wiring and docs (2 files).**
Files: `packages/worker/src/hello/worker.ts`, `packages/worker/deploy/README.md`.
Proves: the worker type-checks with the watchdog wired, the unconfigured path is inert, and
the runbook documents the knobs.

---

## 7. API Contract

**Sin API surface propia — no aplica.** This ticket exposes no endpoint, adds no route, and
changes no request/response schema. It is a **consumer** of one pre-existing, third-party
engine endpoint, so no sibling `api-contract.md` is written.

The one endpoint consumed, verified against the SDK's generated client in this worktree:

| Method | URL | Auth | Response | Verified at |
|---|---|---|---|---|
| `GET` | `{HATCHET_API_URL}/api/v1/tenants/{tenantId}/worker` | `Authorization: Bearer {HATCHET_API_TOKEN \| HATCHET_CLIENT_TOKEN}` | `WorkerList` = `{ pagination?: PaginationResponse; rows?: Worker[] }` | `Api.js:1271`; `data-contracts.d.ts:2112` |

Fields read, with their real nullability:

| Field | Type | Required? | Evidence |
|---|---|---|---|
| `rows` | `Worker[]` | **optional** | `data-contracts.d.ts:2114` |
| `rows[].name` | `string` | required *in the contract* — re-checked anyway | `:2067` |
| `rows[].lastHeartbeatAt` | `string` (ISO-8601) | **optional** | `:2070-2074` |

Status-code handling is in §11. A live `curl` against the box's engine is a
**post-implementation verification step** (§8, step V), not an entry gate for any phase.

---

## 8. Criterios de éxito / Success criteria

### Verifiable checkboxes

- [ ] With no new env vars set, `loadWorkerConfig()` returns `livenessStaleAfterS === 0`
      and `livenessPollS === 0`, and `hello/worker.ts` starts no timer and issues no fetch.
- [ ] `WORKER_LIVENESS_STALE_S=900` yields `{ livenessStaleAfterS: 900, livenessPollS: 60 }`.
- [ ] `WORKER_LIVENESS_STALE_S=60` throws, naming the 300s floor.
- [ ] `WORKER_LIVENESS_STALE_S=abc` / `0` / `-1` throws.
- [ ] `WORKER_LIVENESS_STALE_S=900 WORKER_LIVENESS_POLL_S=900` throws.
- [ ] A stray `WORKER_LIVENESS_POLL_S` with the watchdog OFF does **not** throw.
- [ ] `resolveProbeWorkerName("automata-worker-box", undefined) === "automata-worker-box"`.
- [ ] `resolveProbeWorkerName("automata-worker-box", "ns_") === "ns_automata-worker-box"`,
      and the probe matches a row named `ns_automata-worker-box`.
- [ ] A heartbeat `> staleAfterMs` old calls `onWedged` exactly once, with the exact line.
- [ ] A fresh heartbeat over a simulated window longer than the threshold never calls `onWedged`.
- [ ] An idle-but-healthy worker (no work dispatched, engine reachable, heartbeat fresh)
      never calls `onWedged`.
- [ ] Every unreadable shape — fetch reject, 500, 401, non-JSON, `rows` missing, `rows` not
      an array, no matching name, `lastHeartbeatAt` absent, `lastHeartbeatAt` unparseable —
      returns `unreadable` and never calls `onWedged`, across more simulated time than the
      threshold.
- [ ] No test uses a real timer, `vi.useFakeTimers` aside, and no test calls `process.exit`.
- [ ] `packages/worker/deploy/linux/automata-worker.service` is **byte-identical** to
      `dec1664` (`git -C <worktree> diff --stat -- packages/worker/deploy/linux/` is empty).
- [ ] `git -C <worktree> status --porcelain` lists only the six files in §6.

### Required tests

| File | Scenario |
|---|---|
| `packages/worker/src/agent-run/config.test.ts` | unset → OFF; `900` → on with default poll; `60` → throws (floor); non-integer/`0`/negative → throws; `poll >= stale` → throws; stray poll while OFF → no throw |
| `packages/worker/src/agent-run/engine-liveness.test.ts` | **stale → exit**: heartbeat `now - 2400s`, threshold 900s → `onWedged` called once, message asserted to contain `no successful engine interaction for 2400s (threshold 900s)` and `exiting non-zero` |
| ″ | **fresh → no exit**: 40 ticks, fake clock advanced 60s each (2400s > 900s threshold), heartbeat advanced with it → `onWedged` never called |
| ″ | **idle but healthy → no exit**: a row with `slots` unused / no `recentStepRuns` and a fresh `lastHeartbeatAt`, over a window > threshold → `onWedged` never called |
| ″ | **unreadable → no exit**: parametrised over fetch-reject, 500, 401, non-JSON body, `{}`, `{rows: "nope"}`, `{rows: []}`, wrong name, missing `lastHeartbeatAt`, `lastHeartbeatAt: "not-a-date"` — each for 40 ticks across 2400s → `onWedged` never called, verdict `unreadable` every time |
| ″ | **namespaced probe matches** (FACT 2): client namespace `"ns_"`, engine rows `[{name:"ns_automata-worker-b1", lastHeartbeatAt: <stale>}]`, raw name `automata-worker-b1` → verdict `wedged`. Negative control: a probe built from the RAW name against the same rows yields `unreadable`, i.e. the silent-inert bug, and the test asserts the difference |
| ″ | **injected clock and exit**: the whole suite passes a `now` closure and an `onWedged` spy; a test asserts `startEngineLivenessWatchdog` never references `Date.now` or `process.exit` by driving `tick()` directly with a frozen clock |
| ″ | **inert when unconfigured**: `staleAfterMs: 0` → handle is a no-op, `probe` spy never called, `onWedged` never called, `stop()` safe to call |

### Exact verification commands

From `/Users/senior/.superset/projects/automata-platform/.claude/worktrees/215`:

```bash
pnpm turbo tsc-check --force --filter=@terragon/worker && \
pnpm turbo format-check --force --filter=@terragon/worker && \
pnpm --filter @terragon/worker exec vitest run --no-file-parallelism
```

`--force` is mandatory: turbo's cache replays other worktrees, so an unforced `tsc-check`
is not evidence about this tree.

**Step V — post-implementation, on the box only** (never an entry gate for a phase): with
the watchdog armed, confirm the engine returns a row for this worker's namespaced name and
a fresh `lastHeartbeatAt`:

```bash
curl -fsS -H "Authorization: Bearer $HATCHET_API_TOKEN" \
  "$HATCHET_API_URL/api/v1/tenants/$HATCHET_TENANT_ID/worker" \
  | jq '.rows[] | select(.name|startswith("automata-worker")) | {name, lastHeartbeatAt}'
```

---

## 9. Criterios de UX / UX criteria

**Not applicable — this ticket has no user interface.** `@terragon/worker` is a headless
long-lived Node process on an operator-supplied box; its only human surface is the
journal and `deploy/README.md`. The operator-facing equivalents live in §15
(observability) and §16.

- **Loading** — Not applicable (no UI).
- **Formularios** — Not applicable (no forms; configuration is env vars, §13).
- **Passwords** — Not applicable (no credential entry; see §14 for token handling).
- **Errores** — Operator-facing error text is the boot-refusal messages (§6) and the single
  wedged line (§15). Both name the variable or the number that caused them.
- **Navegación** — Not applicable.
- **Accesibilidad** — Not applicable (no rendered output). The log lines are plain ASCII,
  single-line, and greppable by a fixed prefix (`[worker-liveness]`).

---

## 10. Decisiones tomadas / Decisions made (locked)

The implementer must not change these.

- **D-1. The signal is the engine's `Worker.lastHeartbeatAt`, read over REST.** Decided by
  the outage evidence: the journal went silent for 41 minutes and the engine row went
  40m47s stale. *Why not the alternatives:* log scraping has nothing to scrape (no
  heartbeat-failure line, no reconnect line, inside the window; the 7 `Failed to send
  heartbeat` lines that day are all outside it); the socket, `systemctl is-active` and
  `/api/ready` were all green throughout.
- **D-2. Recovery is `process.exit(1)` + the unit's existing `Restart=always`.** The SDK
  exposes no connection-lost hook and `worker.start()` never returns, so the watchdog
  observes liveness independently and the only lever it has is its own exit code. Nothing
  is added to the systemd unit.
- **D-3. Off by default, opt-in by one validated env var.** `WORKER_LIVENESS_STALE_S` unset
  → no timer, no probe, no behaviour change, matching how #204's ceiling and #108's uid
  fence are gated.
- **D-4. Half-configured refuses to boot.** `poll >= stale` throws at
  `loadWorkerConfig()`, which blocks both boot and every run. A box told to guard itself
  must never run unguarded — the same lesson #204 wrote into this file.
- **D-5. A 300s floor on the threshold, and a generous 900s recommended value.** An idle
  worker is not a wedged worker; a restart loop on a healthy box would be worse than the
  bug.
- **D-6. Unreadable ≠ wedged, for any duration.** Network error, non-2xx, bad shape, no
  matching row → `unreadable`, no exit, forever. A watchdog that exits because it could not
  reach the engine would turn a transient engine blip into a restart storm.
- **D-7. A code comment in `engine-liveness.ts` names the three signals that lied** (TCP
  socket, `systemctl is-active`, `/api/ready`) and forbids simplifying into them. This is a
  required deliverable, not a nicety.
- **D-8. The probe name goes through the SDK's own `applyNamespace`**, with the namespace
  read from `hatchet.config.namespace`. Not the raw env var (the SDK normalises it to a
  trailing `_` at `config-loader.js:82-85`), and explicitly **not** `worker._internal.name`.
- **D-9. Both the clock and the exit are injected.** No real timers and no `process.exit`
  in any test; production supplies `() => Date.now()` and the exiting `onWedged` at the one
  wiring site.
- **D-10. The probe is REST, independent of `HATCHET_ENGINE_DATABASE_URL`.** The #69
  maintenance path needs a Postgres port the box does not publish by default; the watchdog
  must work on a plain box, so it reuses the REST credentials `assert-auth.ts` already
  resolves.
- **D-11. `TimeoutStopSec=2100` is out of scope and called out in the PR**, not fixed here.
- **D-12. The wedged line's text is produced by an exported `formatWedgedLine`**, so the
  test asserts the operator-visible string rather than a paraphrase.

---

## 11. Edge cases

- **Datos inválidos (response shape).** `rows` absent, `rows` not an array, a row that is
  not an object, `name` not a string, `lastHeartbeatAt` absent (it is optional in the
  contract, `data-contracts.d.ts:2070-2074`), or `lastHeartbeatAt` present but
  `Date.parse` → `NaN`. **All → `unreadable`. None → `wedged`.**
- **API errors, per status code.**
  - `200` with a body that fails the guard → `unreadable`.
  - `401` / `403` — token rotated, expired, or the by-id-vs-collection route trap →
    `unreadable`, log once. Never an exit: an auth problem is not a wedge, and boot already
    fails closed on auth via `assertAuthEnabledFromEnv`.
  - `404` — wrong tenant path → `unreadable`.
  - `429` — throttled → `unreadable`; the fixed tick period is the only backoff (§17).
  - `5xx` — engine down or restarting → `unreadable`. This is precisely the case where
    exiting would be wrong: the engine will come back and the SDK will reconnect.
- **Sin conexión.** `fetch` rejects (`ECONNREFUSED`, DNS, TLS) → `unreadable`. Indefinitely
  unreadable is an accepted, deliberate state (D-6).
- **Timeout.** The probe passes `AbortSignal.timeout(cfg.timeoutMs)`, where `timeoutMs` is
  an explicit field of `EngineLivenessProbeConfig` computed at the wiring site as
  `Math.min(LIVENESS_PROBE_TIMEOUT_CAP_MS, Math.floor(pollIntervalMs / 2))` — bounded well
  below `pollIntervalMs` so a hung request cannot stack ticks; a timeout → `unreadable`.
- **Respuesta vacía / inesperada.** `{}`, `{"rows": []}`, or rows for other workers only →
  no matching row → `unreadable`. This is also the **registration window**: between
  `hatchet.worker(...)` and the engine's first heartbeat write there may be no row, and
  `unreadable` is exactly the right reading for it — no boot grace period is needed.
- **Stale duplicate row after a restart.** A relaunched worker registers under the same
  name, and the engine can briefly hold the dead registration's row too. The probe takes
  the **greatest** parseable `lastHeartbeatAt` among matching rows, so an old row can never
  manufacture a false wedge.
- **Clock skew.** Engine clock ahead of the box → negative staleness, clamped to `0` →
  `healthy`. Box clock ahead of the engine → an inflated staleness; the 300s floor and the
  recommended 900s threshold absorb ordinary NTP drift.
- **Doble submit / re-entrancy.** A `fired` latch means `onWedged` is called at most once
  per process; a tick that starts while the previous one is still in flight is harmless
  because ticks are stateless apart from that latch, and the abort timeout bounds overlap.
- **`stop()` after firing, or `stop()` twice.** Idempotent no-ops.

---

## 12. Estados de UI requeridos / Required UI states

**Not applicable — headless process, no UI.** The equivalent state table is the watchdog's
own state machine and the journal line each state produces:

| Estado | Condición | Efecto observable |
|---|---|---|
| idle (off) | `livenessStaleAfterS === 0` | one boot line from `hello/worker.ts`: `engine-liveness watchdog: OFF (WORKER_LIVENESS_STALE_S unset)`; the driver is never called, so no timer and no probe |
| loading (arming) | opted in, before the first tick | one boot line from `hello/worker.ts`: `[worker-liveness] armed: worker "<name>", stale after <S>s, poll <P>s` |
| success (healthy) | readable heartbeat within threshold | silent — no per-tick logging |
| error (unreadable) | probe failed or shape mismatch | one throttled line per contiguous unreadable streak; no exit |
| empty (no matching row) | `rows` has no row for this name | treated as `unreadable`, same as above |
| disabled | not opted in | identical to idle (off) |
| offline | `fetch` rejects | `unreadable`; no exit, for any duration |
| wedged (terminal) | readable heartbeat older than threshold | exactly one `[worker-liveness] FATAL: …` line, then exit 1 |

---

## 13. Validaciones / Validations

### Validaciones de "cliente" (the env-var loader, `config.ts`)

| Campo | Regla | Mensaje |
|---|---|---|
| `WORKER_LIVENESS_STALE_S` | unset / empty → `0` (OFF) | — (no message; this is the default) |
| `WORKER_LIVENESS_STALE_S` | must be an integer `> 0` when present | `WORKER_LIVENESS_STALE_S must be a positive integer number of seconds, got "<v>"` |
| `WORKER_LIVENESS_STALE_S` | `>= 300` | `WORKER_LIVENESS_STALE_S=<v> is below 300s; a threshold that short restart-loops an idle box (an idle worker is not a wedged worker)` |
| `WORKER_LIVENESS_POLL_S` | only read when the watchdog is on | — |
| `WORKER_LIVENESS_POLL_S` | integer `>= 5` | `WORKER_LIVENESS_POLL_S must be an integer >= 5, got "<v>"` |
| `WORKER_LIVENESS_POLL_S` | `< WORKER_LIVENESS_STALE_S` | `WORKER_LIVENESS_POLL_S=<p> must be well below WORKER_LIVENESS_STALE_S=<s>: a watchdog that ticks no more often than its own threshold cannot observe staleness, and a box told to guard itself must not run unguarded.` |

Every one of these **throws** from `loadWorkerConfig()`, which refuses boot and refuses
every run.

### Validaciones de servidor

The engine's response is validated at the boundary by `isWorkerList` plus per-row checks
(§6). There is no `api-contract.md` for this ticket (§7); the shape's ground truth is
`@hatchet-dev/typescript-sdk/clients/rest/generated/data-contracts.d.ts:2064-2115`, cited
in the guard's comment. **Validation failure is always `unreadable`, never `wedged`.**

---

## 14. Seguridad y permisos / Security & permissions

- **Secret handling.** The probe uses the same bearer this box already holds
  (`HATCHET_API_TOKEN` or `HATCHET_CLIENT_TOKEN`), resolved through the existing
  `loadAuthProbeConfig()`. **No new secret is introduced, stored, or written to disk.**
- **Never logged:** the token, the `Authorization` header, the full URL with any query
  containing credentials, or the response body. The `unreadable` reason string is a short
  fixed phrase plus, at most, an HTTP status code and an `Error.message` — construct it so
  a token can never be interpolated into it. (`redact.ts` exists in this package but is
  scoped to git/argv secrets; do not repurpose it here, and do not edit it.)
- **Sensitive payloads.** The engine `Worker` row carries no user data; the watchdog reads
  only `name` and `lastHeartbeatAt` and discards the rest.
- **Permission checks.** None to add. The endpoint is tenant-scoped and the box's token is
  already tenant-scoped; the fail-closed auth gate (`assertAuthEnabledFromEnv`) has already
  proven at boot that the token is accepted and that a garbage token is rejected.
- **401 / 403 flow.** Treated as `unreadable`: logged once (status only), no exit, no
  retry-with-different-credentials, no token refresh. A rotated token is an operator
  problem, and turning it into a restart loop would be strictly worse.
- **No new network egress destination.** The probe targets the same `HATCHET_API_URL` the
  boot auth gate already calls — on the Linux box, loopback.
- **No privilege change.** Nothing here runs as the agent uid, touches sudo, the PF anchor,
  the cgroup subtree, or the box lock.

---

## 15. Observabilidad y logging

The project's real mechanism is `console.log` / `console.error` to stdout/stderr, captured
by systemd (`StandardOutput=journal`, `SyslogIdentifier=automata-worker`,
`automata-worker.service:75-77`) and read with `journalctl -u automata-worker`. Prefixed,
single-line, greppable.

**What to log**

| When | Stream | Line |
|---|---|---|
| Boot, watchdog off | stdout | `[worker-boot] engine-liveness watchdog: OFF (WORKER_LIVENESS_STALE_S unset)` |
| Boot, watchdog armed | stdout | `[worker-liveness] armed: worker "<probeWorkerName>", stale after <S>s, poll <P>s` |
| Unreadable streak begins | stdout | `[worker-liveness] probe unreadable (<reason>) — treating as UNKNOWN, not wedged` — **once per contiguous streak**, not per tick |
| Wedged (terminal) | **stderr** | `[worker-liveness] FATAL: no successful engine interaction for <N>s (threshold <T>s) — worker "<name>" is wedged alive; exiting non-zero so the supervisor restarts it` |

The FATAL line is the acceptance criterion "the exit is loud": it names the observed
staleness **and** the threshold, so the journal explains the restart that follows 15
seconds later, and it is the last line before the exit.

**Never log:** the bearer token, the `Authorization` header, the raw response body, or any
per-tick healthy line (a healthy tick every 60s for weeks is noise that would bury the one
line that matters).

---

## 16. i18n / textos visibles

**Not applicable — no translation layer in this package and no end-user-visible text.**
`@terragon/worker` is an operator-facing headless process; per the repo's TypeScript rules,
identifiers and log text are English, and there is no i18n catalogue to add keys to.

For completeness, the operator-visible strings this ticket introduces, all English,
hardcoded by design, and each with a single definition site:

| Constant / function | Where | Text |
|---|---|---|
| `formatWedgedLine(...)` | `engine-liveness.ts` | the FATAL line (§15) — exported precisely so the test asserts it rather than duplicating it |
| boot "armed" line | `hello/worker.ts` | `[worker-liveness] armed: …` |
| boot "OFF" line | `hello/worker.ts` | `[worker-boot] engine-liveness watchdog: OFF …` |
| the four throw messages | `config.ts` | §13 |

---

## 17. Performance

- **One HTTP GET per `WORKER_LIVENESS_POLL_S`** (default 60s) against loopback on the
  Linux box. At the recommended settings that is 1440 requests/day — negligible next to the
  engine's own traffic, and far below the #69 maintenance loop's per-tick SQL.
- **No repeated calls per tick.** Exactly one `fetch`; the probe config and the namespaced
  probe name are resolved **once at arm time** and closed over, never re-derived per tick.
- **Cancellation, not debouncing.** Each request carries
  `AbortSignal.timeout(cfg.timeoutMs)` — `Math.min(LIVENESS_PROBE_TIMEOUT_CAP_MS,
  Math.floor(pollIntervalMs / 2))`, i.e. at most half a tick period and never above 10s —
  so a hung request is abandoned rather than allowed to stack
  ticks. There is nothing to debounce: the tick period is fixed and operator-chosen.
- **No caching.** Caching a liveness reading would defeat the feature. The only retained
  state is the `fired` latch and the unreadable-streak flag, both booleans.
- **No re-renders / no allocation pressure.** The tick allocates one request and one small
  parsed object; nothing accumulates. `timer.unref?.()` keeps the watchdog from holding the
  event loop open on its own.
- **Zero cost when off**, which is the default: no timer is created and no module-level
  work is done beyond an import.
- **Detection latency bound:** worst case `staleAfterS + pollIntervalS` (900 + 60 = 960s at
  the recommended settings) from the last successful engine interaction, plus
  `RestartSec=15`. Against a 60-minute human-detected outage that is the whole point; it is
  not a sub-minute detector and is not meant to be.

---

## 18. Restricciones / Restrictions

Hard "do not" rules for the implementer:

1. **Do not touch any file outside the six in §6.** Especially not
   `packages/worker/deploy/linux/automata-worker.service`, `assert-auth.ts`,
   `scheduling-*.ts`, `workflow.ts`, or anything under `apps/`.
2. **Do not add anything to the systemd unit** — no drop-in, no `WatchdogSec=`/`sd_notify`,
   no `ExecStartPre`, no `Restart*` change. `Restart=always` + `RestartSec=15` already exist
   at `:72-73`.
3. **Do not fix `TimeoutStopSec=2100`.** State it in the PR (§2, D-11).
4. **Do not key on the TCP socket, `systemctl is-active`, or `/api/ready`,** and do not
   remove the comment that says why (D-7).
5. **Do not scrape logs.** No `journalctl`, no stdout interception, no SDK log-hook.
6. **Do not reach into SDK internals** — no `worker._internal`, no private field access, no
   monkey-patching, no vendored SDK copy.
7. **Do not treat an unreadable probe as wedged**, and do not add an "unreadable for too
   long → exit" escape hatch. That is the failure mode this design forbids.
8. **Do not use real timers or `process.exit` in any test.** Inject both.
9. **Do not make the watchdog on by default**, and do not pick a default threshold below
   300s.
10. **Do not add a custom `SIGTERM`/`SIGINT` handler** — the SDK owns the drain and a second
    handler would race it (`hello/worker.ts` says so explicitly).
11. **Do not log the token, the `Authorization` header, or the response body.**
12. **Do not introduce a new dependency.** `fetch` is global; `applyNamespace` comes from
    the SDK already in `package.json`. If the deep import
    `@hatchet-dev/typescript-sdk/util/apply-namespace` does not resolve under
    `moduleResolution: "bundler"`, **stop and report it** (§20) rather than silently
    reimplementing the transform.
13. **Do not reformat or restructure** `deploy/README.md` beyond the new section and the one
    added ceiling line, and do not "improve" adjacent code, comments, or formatting in the
    three modified source files.
14. **Do not gate the watchdog on `HATCHET_ENGINE_DATABASE_URL`** or otherwise couple it to
    the #69 maintenance machinery.

---

## 19. Entregables / Deliverables

- [ ] `packages/worker/src/agent-run/engine-liveness.ts` — probe, type guard, pure
      evaluator, `formatWedgedLine`, `resolveProbeWorkerName`, injected-clock/exit driver,
      and the D-7 comment naming the three signals that lied.
- [ ] `packages/worker/src/agent-run/engine-liveness.test.ts` — every scenario in §8.
- [ ] `packages/worker/src/agent-run/config.ts` — `livenessStaleAfterS`, `livenessPollS`,
      their parsers, and the half-configured throw.
- [ ] `packages/worker/src/agent-run/config.test.ts` — the six config cases in §8
      (appended; nothing existing changed).
- [ ] `packages/worker/src/hello/worker.ts` — one gated wiring block before
      `await worker.start()`, in the file's existing boot-gate style.
- [ ] `packages/worker/deploy/README.md` — `## Engine-liveness watchdog (#215)` shaped after
      `## Agent-uid mode (#108)` (`:58-72`), including a "hard boot failure" note in the
      voice of `:68`, plus the one missing `WORKER_RUN_MEMORY_MAX` line in the #108 section.
- [ ] The three-command canonical verification green from the worktree root.
- [ ] A PR body that states the `TimeoutStopSec=2100` limitation as explicitly out of scope,
      and confirms `Restart=always` / `RestartSec=15` were read in-tree and left untouched.

---

## 20. Checklist final para el agente / Final agent checklist

- [ ] `pnpm install --frozen-lockfile --prefer-offline` ran from the worktree root **before**
      phase 1 touched a file (this worktree starts with no `node_modules`).
- [ ] Every path used was absolute and rooted at the worktree; no `cd`-then-relative read.
- [ ] `git -C <worktree> status --porcelain` shows **only** the six files of §6 plus this
      spec.
- [ ] `git -C <worktree> diff -- packages/worker/deploy/linux/` is **empty**.
- [ ] Ran, from `/Users/senior/.superset/projects/automata-platform/.claude/worktrees/215`:
      `pnpm turbo tsc-check --force --filter=@terragon/worker && pnpm turbo format-check
      --force --filter=@terragon/worker && pnpm --filter @terragon/worker exec vitest run
      --no-file-parallelism` — **exit code 0**, checked explicitly, not eyeballed from a pipe.
- [ ] If the suite failed with `listen EPERM`, re-ran it with `dangerouslyDisableSandbox: true`
      and confirmed the failures were the known port-binding ones, not new.
- [ ] Did **not** cite `turbo lint --filter=@terragon/worker` as evidence (no `lint` script).
- [ ] With every new env var unset, `loadWorkerConfig()` returns `livenessStaleAfterS === 0`
      and `livenessPollS === 0` — verified by a `config.test.ts` case, not by reading.
      (That is the whole testable claim: `hello/worker.ts` has **no** test file in-tree and
      Restriction 1 forbids adding one, so "the boot path starts no timer and issues no
      fetch" is established by inspection of the single gated block in §6 — the driver is
      not called at all on that branch — and is deliberately **not** claimed as test-proven.
      The `engine-liveness.test.ts` "inert when unconfigured" case proves the driver's own
      `staleAfterMs: 0` no-op handle, which is a different claim.)
- [ ] The namespaced-probe test exists and its negative control (raw name → `unreadable`)
      demonstrates the silent-inert bug it prevents.
- [ ] No test uses a real timer or `process.exit`.
- [ ] `engine-liveness.ts` contains the comment naming the TCP socket, `systemctl is-active`
      and `/api/ready` as the three signals that were green throughout the outage.
- [ ] No token, header, or response body is logged anywhere.
- [ ] `@hatchet-dev/typescript-sdk/util/apply-namespace` resolved and type-checked; if it
      did not, **stopped and reported** instead of reimplementing the transform.
- [ ] Reported every disagreement found between this spec and the code as-built, rather than
      quietly adapting.

---

## Open questions / surfaced assumptions

Nothing here blocks implementation; each is a decision made in the open, with its evidence.

1. **`import { applyNamespace } from "@hatchet-dev/typescript-sdk/util/apply-namespace"` was
   reasoned from the package layout, not compiled** — this worktree has no `node_modules`,
   so no `tsc` run was possible here. The evidence for it: the SDK's `package.json` has
   **no** `exports` map (checked), so subpath imports are resolved path-wise under
   `moduleResolution: "bundler"`, and both `util/apply-namespace.js` and
   `util/apply-namespace.d.ts` exist. Phase 2's `tsc-check` is the proof. Restriction #12
   says what to do if it fails: stop and report, do not reimplement.
2. **Threshold defaults (`300` floor, `900` recommended, `60` poll) are chosen by me**, from
   the outage shape (40m47s of staleness) and the "idle is not wedged" criterion. The ticket
   says "generous, bounded, configurable" without naming numbers. If the tech lead wants
   different numbers, only the two constants in `config.ts` and the README line change.
3. **The `poll >= stale` boot refusal is my addition**, not spelled out in the ticket. It
   follows D-4 / the #204 doctrine directly: a watchdog that ticks no more often than its
   threshold is a box that looks guarded and is not — the exact failure this repo has paid
   for twice. Flagging it because a reviewer could reasonably call it unrequested
   configurability rather than a fail-closed guard.
4. **Picking the max-heartbeat row among same-named rows** (§11) is my addition. A relaunch
   can briefly leave two rows with the same name; taking the first match could read the dead
   one and manufacture a false wedge. Cheap and strictly safer, but it is a decision made
   silently otherwise.
5. **`AbortSignal.timeout(...)` on the probe** is my addition, for the reason in §17. It
   needs Node ≥17.3; the box is already pinned to Node ≥22.21.0 / ≥24 by the #108 env-proxy
   floor, so it is safe here.
6. **Ticket text vs. real code — disagreements found: none material.** Every contract the
   ticket asserted was verified in this worktree and matched: `WorkerList` at
   `data-contracts.d.ts:2112`, `lastHeartbeatAt` optional at `:2070-2074`,
   `applyNamespace` at `worker-internal.js:91`, `Restart=always`/`RestartSec=15` at
   `automata-worker.service:72-73`, `await worker.start()` ending `hello/worker.ts`,
   `WORKER_RUN_MEMORY_MAX` undocumented in every markdown file, and
   `HATCHET_CLIENT_NAMESPACE` unset repo-wide. Two details the ticket did not mention and
   that matter: the REST route is the **collection** route
   `GET /api/v1/tenants/{tenant}/worker` (`Api.js:1271`) — a by-id worker GET returns 403
   for API tokens on this engine — and the SDK **normalises the namespace to a trailing
   underscore** (`config-loader.js:82-85`), which is why D-8 reads it off
   `hatchet.config.namespace` rather than off `HATCHET_CLIENT_NAMESPACE`.
7. **The one prerequisite not satisfied today** is `pnpm install` in this worktree (§4, last
   row). Folded into phase 1's preamble.
