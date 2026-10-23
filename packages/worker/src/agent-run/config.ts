import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PAYLOAD_SEAL_KEY_FILE } from "./payload-seal-keys";
import { BOX_SLOTS_MAX } from "./slot-limits";
import { DEFAULT_RUN_NAMESPACE_ROOT } from "./run-namespace";
import {
  parseContainerRunsConfig,
  type ContainerRunsConfig,
} from "./container-config";
import {
  ADMISSION_BACKOFF,
  ADMISSION_DEFERRAL_BUDGET_S,
  sumBackoffSeconds,
} from "./admission-retry";

/**
 * Execution-plane worker box configuration (ADR-003). Unlike the control plane
 * (apps/www) this runs as an ordinary long-lived Node process on a customer-
 * supplied box, so it reads process.env directly rather than the validated
 * Workers env — there is no workerd/getCloudflareContext here.
 *
 * None of these are secrets that belong to the control plane: ANTHROPIC_API_KEY
 * is the org's own agent key; the GitHub installation token and daemon token
 * arrive per-run as workflow input, never from here (ADR-002 §3).
 */
export interface WorkerConfig {
  /**
   * Absolute path to the built daemon bundle (packages/daemon/dist/index.js),
   * bind-mounted read-only into every run container (ADR-013 Decision 4).
   */
  daemonDist: string;
  /** ANTHROPIC_API_KEY passed to the daemon when the box has no Claude creds file. */
  anthropicApiKey: string;
  /**
   * Who this box belongs to, which decides how a run authenticates to the model
   * provider (D1).
   *
   * "owner"  — the box belongs to the tenant whose runs it executes (the pilot
   *            case: the operator's own Mac). The worker may pull the run's
   *            agent credential from the control plane and materialise it in a
   *            per-run HOME, so the run spends the USER's subscription or API
   *            key, exactly like an in-sandbox run.
   * "shared" — the box executes runs for tenants who do not own it. A provider
   *            credential must never land on disk here, so runs are forced
   *            through the control-plane proxy (useCredits) and bill credits.
   *
   * "box-key" — the box's OWN ANTHROPIC_API_KEY is the intended credential for
   *            every run on it. This is the self-host / pilot posture: the
   *            operator put a funded key here on purpose so agents work, and no
   *            user credential or platform credit is involved.
   *
   * Defaults to "shared": the safe answer for an unconfigured box. An operator
   * opts a single-tenant box in with WORKER_BOX_TRUST=owner (use the run user's
   * own credential) or WORKER_BOX_TRUST=box-key (use this box's key).
   *
   * "box-key" exists because collapsing it into "shared" broke production: a box
   * with a working key and a platform with NO credits was forced onto the credits
   * proxy, and every review run died instantly. Silently falling back to the box
   * key is wrong (that was the original bug); making the operator SAY so is right.
   */
  boxTrust: "owner" | "shared" | "box-key";
  /**
   * #205: how many agent runs this box admits at once — the counting box
   * budget. 1 (the DEFAULT) is an exclusive lock on `box.lock`; N > 1 takes
   * slot files `box.lock.<i>`. Slot i's run is the container named
   * `automata-run-<workerId>-<i>` (ADR-013): its own pid, mount and network
   * namespaces fence it from its siblings, and its `--memory` (the required
   * per-run ceiling) bounds its blast radius. Must equal the worker's engine
   * `slots` and the engine global cap (#372).
   */
  boxSlots: number;
  /**
   * #372: the engine's "global" concurrency cap (`'agent-run-global-memory-budget'`
   * key, PER WORKFLOW VARIANT) as registered by this worker. Must EQUAL
   * `boxSlots`: the engine's cross-workflow cap is the worker's `slots`
   * (= boxSlots) and the host cap is the counting box lock, so the three
   * numbers are one setting — `WORKER_GLOBAL_MAX_RUNS`. Default 1.
   */
  globalMaxRuns: number;
  /**
   * #372: the per-org fairness cap (`input.orgId` GROUP_ROUND_ROBIN key). Must
   * stay ≤ `globalMaxRuns`; equal is allowed (a single-org box must be able to
   * use every slot). `WORKER_PER_ORG_MAX_RUNS`, default 1.
   */
  perOrgMaxRuns: number;
  /**
   * #205: WHICH slot the current run holds — a per-run override the workflow
   * sets on its copy of the config after the slot acquire. Never read from env and undefined at boot. With
   * `boxSlots > 1` every per-run namespace path (daemon socket, pidfile,
   * gh-broker socket) lives under the slot's own subdir, so a run can reach
   * only its own sockets; with `boxSlots === 1` the flat layout is unchanged.
   */
  boxSlot?: number;
  /**
   * #204: per-run memory ceiling in bytes (`WORKER_RUN_MEMORY_MAX`). REQUIRED
   * since ADR-013 P3: every run container gets it as `--memory` (no swap), so
   * the loader refuses a box without it (container-config.ts).
   */
  memoryMaxBytes: number;
  /** #204: per-run `--pids-limit` (`WORKER_RUN_TASKS_MAX`, default 4096). */
  tasksMax: number;
  /**
   * #371: memory-headroom admission check (ADR-007 Decision 5). `MemAvailable`
   * must stay at or above `headroomFloorBytes` and `Committed_AS` plus the
   * expected commit of every admitted run must stay at or below
   * `headroomCommitFraction × CommitLimit`, or admission is DEFERRED (the run
   * gives its slot back and waits IN PROCESS with backoff). Defaults 1G / 0.9 —
   * ON wherever `/proc/meminfo` exists; `0` and `1.0` are the documented
   * rollback that makes the check inert without a deploy. One run's expected
   * commit is its own ceiling when the ceiling is on, else `1300M`.
   */
  headroomFloorBytes: number;
  headroomCommitFraction: number;
  headroomRunCommitBytes: number;
  /**
   * #371: how many times one run may be deferred (waited out in process) before
   * it fails final. Backoff is 2^n s capped at 120 s, so the
   * default 8 bounds total deferral at 366 s (≈ 6 minutes) — deliberately under
   * the control plane's 75-minute stalled-thread cutoff once the 30 m schedule
   * and 30 m execution windows are added (`apps/www/src/server-lib/cron.ts`).
   */
  admissionMaxDeferrals: number;
  /**
   * #215: engine-liveness watchdog. Seconds of observed staleness in THIS
   * worker's engine `Worker.lastHeartbeatAt` after which the process exits
   * non-zero so systemd's Restart=always relaunches it.
   *
   * 0 (the DEFAULT) = OFF: no timer, no probe, no exit — byte-for-byte today's
   * boot.
   *
   * Deliberately generous. An idle worker is not a wedged worker, and a watchdog
   * that restart-loops a healthy box is worse than the bug it covers, so the
   * loader REFUSES anything below LIVENESS_STALE_FLOOR_S rather than accepting a
   * hair-trigger.
   */
  livenessStaleAfterS: number;
  /** #215: watchdog tick period, seconds. Only read when the watchdog is on. */
  livenessPollS: number;
  /**
   * Stable identity for this box, used in the engine worker name so two boxes
   * are distinguishable. See resolveBoxId.
   */
  boxId: string;
  /** Root under which each run gets an isolated clone directory. */
  workdirRoot: string;
  /** thread-status poll interval, ms (5-10s; runs are minutes-long — ADR-003). */
  pollIntervalMs: number;
  /** GitHub App bot login the run's git commits are authored as (never the operator). */
  botLogin: string;
  /**
   * Root dir for per-run daemon resources (socket + pidfile) namespaced by workerId
   * (Phase 0.2b). Each worker owns `<root>/<workerId>/`; boot-reclaim only reaps
   * SIBLING dirs whose worker pid is dead. Default /tmp keeps socket paths short.
   */
  runNamespaceRoot: string;
  /**
   * #386: where the run-terminal ledger lives (`<root>/run-terminals/`).
   * Defaults to runNamespaceRoot. A box whose /tmp is wiped at boot points it
   * at a durable, worker-only dir so a reboot mid-drain keeps the ledger.
   */
  runTerminalRoot: string;
  /**
   * Per-run GitHub credential brokering (#81). "on" (default): the workflow
   * starts the git + gh brokers and the agent child never sees the
   * installation token — only a per-run bearer, in EVERY lane. "legacy-direct"
   * is the one-env-var rollback: no brokers, today's exact raw-token env.
   * Fail-closed within a run: with "on", a broker start failure throws
   * pre-daemon — a run configured for brokering must never silently fall back
   * to a raw-token env.
   */
  credentialBroker: "on" | "legacy-direct";
  /**
   * #437 Part B: a task run cancelled at its execution limit commits and
   * pushes its unfinished work to its work branch before the checkout is
   * deleted. "on" (default); only the exact string "off" disables it — the
   * one-env-var rollback for the salvage alone.
   */
  timeoutSalvage: "on" | "off";
  /**
   * #380: the plane's seal key ring (`{"keys":[…]}`, see
   * payload-seal-keys.ts). Every run unseals its `sealedSecrets` with it.
   * Default /etc/automata/payload-seal.key. MANDATORY (strict, rollout step
   * 4): a missing or unusable file refuses boot, and a run that cannot read
   * it is refused — there is no plain-text fallback.
   */
  payloadSealKeyFile: string;

  // --- Scheduling deadlock recovery (#69, §3.5) -----------------------------
  // Everything below is inert unless engineDatabaseUrl is set — the box's
  // engine Postgres publishes no host port by default (see
  // docker-compose.hatchet.maintenance.yml), so an unconfigured box never
  // attempts a connection, never writes a snapshot, and boot is never blocked
  // on any of this (AC-13).
  /** Master gate. Empty → all three #69 mechanisms are inert no-ops. */
  engineDatabaseUrl: string;
  /** Tenant every maintenance query scopes to. Empty → auto-resolve the single tenant at boot. */
  engineTenantId: string;
  /** Global mode for mechanisms 1 (rot repair) & 2 (slot reclaim). */
  schedulingMaintenanceMode: "off" | "dry-run" | "on";
  /** Per-mechanism override for rot repair. "inherit" defers to schedulingMaintenanceMode. */
  concurrencyRotRepairMode: "off" | "dry-run" | "on" | "inherit";
  /** Per-mechanism override for slot reclaim. "inherit" defers to schedulingMaintenanceMode. */
  slotReclaimMode: "off" | "dry-run" | "on" | "inherit";
  /** Mechanism 3 (stuck-QUEUED detection). Read-only, so on by default. */
  stuckQueuedDetect: "off" | "on";
  /** Stuck-QUEUED threshold, seconds. Default scheduleTimeout/2 (workflow.ts:236). */
  stuckQueuedS: number;
  /** Dead-generation heartbeat threshold, seconds (§3.2.1). Also the no-progress event window. */
  workerDeadAfterS: number;
  /** Age floor for orphan slots only, seconds (§3.2.2 case (a)). */
  slotMinAgeS: number;
  /** Maintenance tick period, seconds. Adds to the §3.2.2 latency bound. */
  maintIntervalS: number;
  /** Per-query LIMIT for every maintenance statement. */
  maintBatch: number;
  /** Optional loopback /healthz port. null → no new listener (default). */
  healthPort: number | null;
  /**
   * ADR-013: the container every agent run executes in — the pinned batteries
   * image, the rootless daemon's socket and the per-container limits
   * (container-config.ts). Always set; an unusable value refuses boot.
   */
  containerRuns: ContainerRunsConfig;
}

function defaultDaemonDist(): string {
  // Locate the sibling @terragon/daemon package's built bundle. The daemon must be
  // built (`pnpm --filter @terragon/daemon build`) as a worker-box setup step;
  // provisioning documents this. We can't require.resolve the dist path — the
  // daemon package's "." export is the TS source and its exports map blocks
  // package.json — so we derive it from this file's monorepo location. On a bundled
  // deploy set WORKER_DAEMON_DIST explicitly to override this; the box launcher
  // (deploy/linux/run-worker.sh.template) exports it to the copy it stages under
  // /usr/local/automata/daemon.
  // this file: packages/worker/src/agent-run/config.ts → up 3 = packages/worker.
  const workerPkgRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  return path.join(workerPkgRoot, "..", "daemon", "dist", "index.js");
}

/** Parses a positive-int env value, falling back to `fallback` on anything non-finite or ≤0. */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Exact-string mode parser shared by the three #69 mode knobs
 * (`config.ts:134-140` doctrine): only `off`/`dry-run`/`on` opt in; anything
 * else — unset, typo, garbage — degrades to `safeDefault` so a misconfigured
 * box never silently starts mutating engine state.
 */
function parseMode(
  raw: string | undefined,
  safeDefault: "off" | "dry-run" | "on",
): "off" | "dry-run" | "on" {
  const trimmed = raw?.trim();
  return trimmed === "off" || trimmed === "dry-run" || trimmed === "on"
    ? trimmed
    : safeDefault;
}

/** Same doctrine, but "inherit" is also a valid explicit value (the per-mechanism override knobs). */
function parseModeOrInherit(
  raw: string | undefined,
): "off" | "dry-run" | "on" | "inherit" {
  const trimmed = raw?.trim();
  return trimmed === "off" || trimmed === "dry-run" || trimmed === "on"
    ? trimmed
    : "inherit";
}

/**
 * Stable identity for THIS box (#192 P5).
 *
 * Every worker registered with the engine under the same name is
 * indistinguishable from every other, which was fine while one laptop was the
 * whole execution plane and stops being fine the moment a second box exists:
 * the engine's worker list, the dashboard and any per-box question ("which box
 * ran this?", "is the Frankfurt box alive?") all collapse into one row.
 *
 * Defaults to the hostname, which is already unique per box and needs no
 * provisioning step. `WORKER_BOX_ID` overrides it for boxes whose hostname is
 * an opaque cloud id, or when two boxes must be told apart by role rather than
 * by host.
 *
 * Sanitised, not trusted: the value reaches the engine as part of a worker name,
 * so it is reduced to a conservative charset and bounded. An empty or
 * all-invalid value falls back rather than producing a nameless worker.
 */
export function resolveBoxId(raw: string | undefined): string {
  const candidate = (raw ?? "").trim() || os.hostname();
  const cleaned = candidate
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "unknown-box";
}

/**
 * Parse `WORKER_RUN_MEMORY_MAX` — bytes, or a `K`/`M`/`G` suffix because a
 * ceiling written in bytes is unreadable and an unreadable knob gets mistyped.
 *
 * Unset or empty = 0 = OFF. Anything present but unparseable THROWS: a typo that
 * silently disabled a memory ceiling would leave the box exposed while the
 * config claims it is protected, which is the failure #192's cloud-init lesson
 * was about.
 */
export function parseMemoryMax(raw: string | undefined): number {
  // The byte grammar (and the "a typo must not become a nonsense ceiling"
  // safe-integer refusal) is parseBytesEnv's; this knob adds only its floor.
  const bytes = parseBytesEnv("WORKER_RUN_MEMORY_MAX", raw, 0);
  const v = (raw ?? "").trim();
  // A ceiling below one session's measured ~1.1 GB would OOM-kill every run.
  // Refusing is kinder than a box where nothing completes.
  if (bytes > 0 && bytes < 256 * 1024 ** 2) {
    throw new Error(
      `WORKER_RUN_MEMORY_MAX=${v} is below 256M; a ceiling that low kills every run (one session measures ~1.1 GB)`,
    );
  }
  return bytes;
}

/**
 * #386: the ledger root. Unset ⇒ the namespace root. A relative path is
 * refused at boot: it would resolve against the worker's cwd (the repo
 * checkout) and silently change with it.
 */
export function parseRunTerminalRoot(
  raw: string | undefined,
  runNamespaceRoot: string,
): string {
  const v = raw?.trim() ?? "";
  if (!v) return runNamespaceRoot;
  if (!path.isAbsolute(v)) {
    throw new Error(
      `WORKER_RUN_TERMINAL_ROOT must be an absolute path (got ${JSON.stringify(v)})`,
    );
  }
  return v;
}

/** Upper bound on `WORKER_BOX_SLOTS`; a typo like `30` must not mint 30 accounts' worth of lock files. */
export { BOX_SLOTS_MAX };

/**
 * Parse a slot-count knob — `WORKER_BOX_SLOTS` (#205), `WORKER_GLOBAL_MAX_RUNS`
 * and `WORKER_PER_ORG_MAX_RUNS` (#372). Unset or empty = 1 = today's exclusive
 * lock and compile-time caps. Anything present but not an integer in
 * [1, BOX_SLOTS_MAX] THROWS, naming the knob: a box told to run N must never
 * quietly run a different N (the engine caps are bounded by the slot bound
 * because the tuple must agree).
 */
export function parseSlotCount(name: string, raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (!v) {
    return 1;
  }
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isInteger(n) || n < 1 || n > BOX_SLOTS_MAX) {
    throw new Error(
      `${name} must be an integer between 1 and ${BOX_SLOTS_MAX}, got ${JSON.stringify(v)}`,
    );
  }
  return n;
}

/** `WORKER_BOX_SLOTS` (#205); see parseSlotCount. */
export function parseBoxSlots(raw: string | undefined): number {
  return parseSlotCount("WORKER_BOX_SLOTS", raw);
}

/** Parse `WORKER_RUN_TASKS_MAX`; unset ⇒ a generous default, since it is a runaway guard, not a budget. */
export function parseTasksMax(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (!v) {
    return 4096;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 64) {
    throw new Error(
      `WORKER_RUN_TASKS_MAX must be an integer >= 64, got ${JSON.stringify(v)}`,
    );
  }
  return n;
}

/**
 * Parse a byte size with an optional K/M/G suffix for `name` (#371). Unset ⇒
 * `fallback`. `0` is allowed (it is how an arm is made inert). Anything else
 * unparseable THROWS — a typo that silently disabled a guard would leave the
 * box looking guarded.
 */
export function parseBytesEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  const v = (raw ?? "").trim();
  if (!v) {
    return fallback;
  }
  const m = /^(\d+)([KMG]?)$/i.exec(v);
  if (!m?.[1]) {
    throw new Error(
      `${name} must be bytes with an optional K/M/G suffix, got ${JSON.stringify(v)}`,
    );
  }
  const suffix = (m[2] ?? "").toUpperCase();
  const scale = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[suffix] ?? 1;
  const bytes = Number(m[1]) * scale;
  // A TYPO MUST NOT BECOME A NONSENSE VALUE. The regex accepts any run of
  // digits, so `99999999999999999999G` parses — and `Number(...) * scale` then
  // exceeds 2^53 or overflows to Infinity, which would be written verbatim into
  // `memory.max` or compared against the kernel's numbers. Refuse at boot.
  if (!Number.isSafeInteger(bytes)) {
    throw new Error(
      `${name}=${v} does not fit an exact integer number of bytes (got ${bytes}); use a realistic value such as 1500M`,
    );
  }
  return bytes;
}

/** Parse `WORKER_HEADROOM_COMMIT_FRACTION` (#371): unset ⇒ 0.9; must be in (0, 1]. */
export function parseCommitFraction(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (!v) {
    return 0.9;
  }
  // Plain decimal only: `Number()` would also take "0x1" (→ 1, silently inert)
  // or "1e-1", and a typo must not quietly change the guard.
  const n = /^\d*\.?\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(
      `WORKER_HEADROOM_COMMIT_FRACTION must be a decimal in (0, 1], got ${JSON.stringify(v)} (1.0 makes that arm inert)`,
    );
  }
  return n;
}

/**
 * Parse `WORKER_ADMISSION_MAX_DEFERRALS` (#371): unset ⇒ 8 (366 s of backoff;
 * the budget check in loadWorkerConfig accepts up to 10 = 606 s under the 720 s
 * budget); a non-negative integer. That budget check is the ONE upper bound — a
 * second numeric cap here could only disagree with it.
 */
export function parseMaxDeferrals(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (!v) {
    return 8;
  }
  if (!/^\d+$/.test(v)) {
    throw new Error(
      `WORKER_ADMISSION_MAX_DEFERRALS must be a non-negative integer, got ${JSON.stringify(v)}`,
    );
  }
  return Number(v);
}

/** Minimum accepted WORKER_LIVENESS_STALE_S. See parseLivenessStaleAfterS. */
const LIVENESS_STALE_FLOOR_S = 300;
/** Default tick period when the watchdog is on. */
const LIVENESS_POLL_DEFAULT_S = 60;

/**
 * Parse `WORKER_LIVENESS_STALE_S` (#215) — the engine-observed heartbeat
 * staleness, in seconds, past which the worker exits non-zero.
 *
 * Unset or empty = 0 = OFF, exactly like the #204 ceiling: an unconfigured box
 * gets no timer, no probe and no behaviour change. Anything present but
 * unparseable THROWS, because a typo that silently disabled the watchdog would
 * leave a box LOOKING guarded while running unguarded — the same failure mode
 * the whole ticket exists to remove.
 */
export function parseLivenessStaleAfterS(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (!v) {
    return 0;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `WORKER_LIVENESS_STALE_S must be a positive integer number of seconds, got ${JSON.stringify(v)}`,
    );
  }
  // AN IDLE WORKER IS NOT A WEDGED WORKER. A short threshold turns ordinary
  // quiet — or a slow engine heartbeat write — into a restart, and a box that
  // restart-loops while healthy is strictly worse than the bug this guards.
  if (n < LIVENESS_STALE_FLOOR_S) {
    throw new Error(
      `WORKER_LIVENESS_STALE_S=${v} is below ${LIVENESS_STALE_FLOOR_S}s; a threshold ` +
        `that short restart-loops an idle box (an idle worker is not a wedged worker)`,
    );
  }
  return n;
}

/** Parse `WORKER_LIVENESS_POLL_S` (#215); unset ⇒ LIVENESS_POLL_DEFAULT_S. */
export function parseLivenessPollS(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (!v) {
    return LIVENESS_POLL_DEFAULT_S;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 5) {
    throw new Error(
      `WORKER_LIVENESS_POLL_S must be an integer >= 5, got ${JSON.stringify(v)}`,
    );
  }
  return n;
}

export function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const pollIntervalMs = Number(env.WORKER_POLL_INTERVAL_MS ?? "7000");
  // Every refusal below fires at boot AND per run: worker.ts calls
  // loadWorkerConfig at boot and the workflow calls it for every run, so a
  // misconfigured box can neither start nor execute.
  // #204. The whole-tuple validation ADR-002's capacity model needs (global
  // cap, worker slots, per-run ceiling, swap) starts with this one not being a
  // typo.
  const memoryMaxBytes = parseMemoryMax(env.WORKER_RUN_MEMORY_MAX);
  const runNamespaceRoot =
    env.WORKER_RUN_NAMESPACE_ROOT?.trim() || DEFAULT_RUN_NAMESPACE_ROOT;
  const runTerminalRoot = parseRunTerminalRoot(
    env.WORKER_RUN_TERMINAL_ROOT,
    runNamespaceRoot,
  );
  // `--pids-limit` for every run container.
  const tasksMax = parseTasksMax(env.WORKER_RUN_TASKS_MAX);

  // #215. Parsed here, alongside the #204 block, so a typo is refused at boot
  // rather than at the first tick.
  const livenessStaleAfterS = parseLivenessStaleAfterS(
    env.WORKER_LIVENESS_STALE_S,
  );
  // The poll period is read and checked ONLY when the watchdog is on — same
  // reasoning as parseTasksMax: with the feature off the value is unused, and a
  // stray env var must not stop an unrelated box from booting.
  let livenessPollS = 0;
  if (livenessStaleAfterS > 0) {
    livenessPollS = parseLivenessPollS(env.WORKER_LIVENESS_POLL_S);
    // A POLL PERIOD AT OR ABOVE THE THRESHOLD CANNOT DETECT ANYTHING. The first
    // tick after the wedge would already be past the deadline in the best case
    // and could be a whole period late, so the box would look guarded and be
    // guarded by nothing. Refuse rather than boot unguarded.
    if (livenessPollS >= livenessStaleAfterS) {
      throw new Error(
        `WORKER_LIVENESS_POLL_S=${livenessPollS} must be well below ` +
          `WORKER_LIVENESS_STALE_S=${livenessStaleAfterS}: a watchdog that ticks no more ` +
          `often than its own threshold cannot observe staleness, and a box told to guard ` +
          `itself must not run unguarded.`,
      );
    }
  }

  // ADR-013: every run is a container from the pinned image, so the image,
  // the rootless daemon's socket and the per-run ceiling (`--memory`) are
  // required: a box without them refuses to boot (container-config.ts).
  const containerRuns = parseContainerRunsConfig(
    env,
    memoryMaxBytes,
    parseBytesEnv,
  );
  // #205. Each slot's run is its own container (pid, mount and network
  // namespaces) bounded by its own `--memory`, so N > 1 needs nothing beyond
  // the ceiling containerRuns already required above.
  const boxSlots = parseBoxSlots(env.WORKER_BOX_SLOTS);
  // Container runs: each run is its own container (pid, mount and network
  // namespaces), so the slot accounts are not the fence between them.
  // #372. THE TUPLE MOVES TOGETHER. The engine's "global" key is per workflow
  // variant, the worker's `slots` is the engine-native cross-workflow cap and the
  // counting box lock is the host cap: `WORKER_GLOBAL_MAX_RUNS` must EQUAL
  // `WORKER_BOX_SLOTS` (worker.ts registers `slots: boxSlots`), or the engine
  // would either dispatch runs the box cannot admit (global > slots: they park
  // on the box lock with their 30-minute clocks running) or starve slots the
  // box paid for (global < slots). The per-org fairness cap must not exceed the
  // global cap (a cap no run can reach is a lie in the registration). Refused
  // here, at boot AND at every run.
  // Unset = the slots (the only consistent value — a box already running
  // WORKER_BOX_SLOTS=2 keeps booting across this change); an EXPLICIT value
  // that disagrees is still refused below.
  const globalMaxRuns = env.WORKER_GLOBAL_MAX_RUNS?.trim()
    ? parseSlotCount("WORKER_GLOBAL_MAX_RUNS", env.WORKER_GLOBAL_MAX_RUNS)
    : boxSlots;
  const perOrgMaxRuns = parseSlotCount(
    "WORKER_PER_ORG_MAX_RUNS",
    env.WORKER_PER_ORG_MAX_RUNS,
  );
  if (globalMaxRuns !== boxSlots) {
    throw new Error(
      `WORKER_GLOBAL_MAX_RUNS=${globalMaxRuns} but WORKER_BOX_SLOTS=${boxSlots}: the engine ` +
        "global cap, the worker's engine slots and the kernel box slots are ONE setting " +
        "and must agree — set both knobs to the same value (the tuple also needs " +
        "WORKER_RUN_MEMORY_MAX and the swap sized for it; deploy/README.md).",
    );
  }
  if (perOrgMaxRuns > globalMaxRuns) {
    throw new Error(
      `WORKER_PER_ORG_MAX_RUNS=${perOrgMaxRuns} exceeds WORKER_GLOBAL_MAX_RUNS=${globalMaxRuns}: ` +
        "no org can be admitted past the global cap, so a larger per-org cap is a " +
        "misconfiguration — set WORKER_PER_ORG_MAX_RUNS at or below the global cap.",
    );
  }
  // #371. Parsed here so a typo is refused at boot, not at the first admission.
  const headroomFloorBytes = parseBytesEnv(
    "WORKER_HEADROOM_FLOOR",
    env.WORKER_HEADROOM_FLOOR,
    1024 ** 3,
  );
  const headroomCommitFraction = parseCommitFraction(
    env.WORKER_HEADROOM_COMMIT_FRACTION,
  );
  const headroomRunCommitBytes = parseBytesEnv(
    "WORKER_HEADROOM_RUN_COMMIT",
    env.WORKER_HEADROOM_RUN_COMMIT,
    memoryMaxBytes > 0 ? memoryMaxBytes : 1300 * 1024 ** 2,
  );
  if (headroomRunCommitBytes <= 0) {
    throw new Error(
      "WORKER_HEADROOM_RUN_COMMIT must be positive: it is what one admitted run is expected to commit",
    );
  }
  const admissionMaxDeferrals = parseMaxDeferrals(
    env.WORKER_ADMISSION_MAX_DEFERRALS,
  );
  // #371: the deferral wait is spent IN PROCESS inside the run's 30-minute
  // executionTimeout, so the worst case must leave the agent a usable window
  // and keep the run inside www's 75-minute stalled cutoff — the inequality
  // documented on ADMISSION_DEFERRAL_BUDGET_S.
  const worstCaseS = sumBackoffSeconds(admissionMaxDeferrals);
  if (worstCaseS > ADMISSION_DEFERRAL_BUDGET_S) {
    throw new Error(
      `WORKER_ADMISSION_MAX_DEFERRALS=${admissionMaxDeferrals} waits up to ${worstCaseS}s ` +
        `(2^n s capped at ${ADMISSION_BACKOFF.maxSeconds}s), over the ${ADMISSION_DEFERRAL_BUDGET_S}s budget ` +
        `that leaves a deferred run its execution window (and www's 75-minute stalled cutoff)`,
    );
  }
  return {
    boxSlots,
    globalMaxRuns,
    perOrgMaxRuns,
    headroomFloorBytes,
    headroomCommitFraction,
    headroomRunCommitBytes,
    admissionMaxDeferrals,
    boxId: resolveBoxId(env.WORKER_BOX_ID),
    memoryMaxBytes,
    tasksMax,
    livenessStaleAfterS,
    livenessPollS,
    daemonDist: env.WORKER_DAEMON_DIST?.trim() || defaultDaemonDist(),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    // Only the exact string opts in. Anything else (unset, typo, "true") stays
    // "shared", so a misconfigured box degrades to the mode that keeps provider
    // credentials off its disk.
    boxTrust:
      env.WORKER_BOX_TRUST?.trim() === "owner"
        ? "owner"
        : env.WORKER_BOX_TRUST?.trim() === "box-key"
          ? "box-key"
          : "shared",
    workdirRoot:
      env.WORKER_WORKDIR_ROOT?.trim() ||
      path.join(os.tmpdir(), "automata-worker-runs"),
    pollIntervalMs:
      Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
        ? pollIntervalMs
        : 7000,
    botLogin: env.WORKER_BOT_LOGIN?.trim() || "automata-ai-bot[bot]",
    runNamespaceRoot,
    runTerminalRoot,
    // Only the exact rollback string opts OUT — anything else (unset, typo)
    // stays brokered, so a misconfigured box degrades to the mode that keeps
    // the installation token out of agent env.
    credentialBroker:
      env.WORKER_CREDENTIAL_BROKER?.trim() === "legacy-direct"
        ? "legacy-direct"
        : "on",
    timeoutSalvage: env.WORKER_TIMEOUT_SALVAGE?.trim() === "off" ? "off" : "on",
    payloadSealKeyFile:
      env.WORKER_PAYLOAD_SEAL_KEY_FILE?.trim() || DEFAULT_PAYLOAD_SEAL_KEY_FILE,

    // --- #69 scheduling deadlock recovery ---------------------------------
    engineDatabaseUrl: env.HATCHET_ENGINE_DATABASE_URL?.trim() || "",
    engineTenantId: env.HATCHET_ENGINE_TENANT_ID?.trim() || "",
    schedulingMaintenanceMode: parseMode(
      env.WORKER_SCHEDULING_MAINTENANCE,
      "dry-run",
    ),
    concurrencyRotRepairMode: parseModeOrInherit(
      env.WORKER_CONCURRENCY_ROT_REPAIR,
    ),
    slotReclaimMode: parseModeOrInherit(env.WORKER_SLOT_RECLAIM),
    stuckQueuedDetect:
      env.WORKER_STUCK_QUEUED_DETECT?.trim() === "off" ? "off" : "on",
    stuckQueuedS: parsePositiveInt(env.HATCHET_STUCK_QUEUED_S, 900),
    workerDeadAfterS: parsePositiveInt(env.HATCHET_WORKER_DEAD_AFTER_S, 600),
    slotMinAgeS: parsePositiveInt(env.HATCHET_SLOT_MIN_AGE_S, 600),
    maintIntervalS: parsePositiveInt(env.HATCHET_MAINT_INTERVAL_S, 60),
    maintBatch: parsePositiveInt(env.HATCHET_MAINT_BATCH, 100),
    containerRuns,
    healthPort: (() => {
      const n = Number(env.WORKER_HEALTH_PORT);
      return env.WORKER_HEALTH_PORT?.trim() && Number.isFinite(n) && n > 0
        ? n
        : null;
    })(),
  };
}

/**
 * #205: the config one run uses once it holds slot `slot` — the same box config
 * with the slot's index (its container name and per-run namespace subdir).
 */
export function configForSlot(cfg: WorkerConfig, slot: number): WorkerConfig {
  return { ...cfg, boxSlot: slot };
}

/** Resolves a per-mechanism mode: an explicit off/dry-run/on wins; "inherit" defers to the global mode. */
export function resolveMechanismMode(
  mechanismMode: "off" | "dry-run" | "on" | "inherit",
  globalMode: "off" | "dry-run" | "on",
): "off" | "dry-run" | "on" {
  return mechanismMode === "inherit" ? globalMode : mechanismMode;
}
