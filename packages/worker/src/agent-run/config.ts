import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RUN_NAMESPACE_ROOT } from "./run-namespace";
import { assertAgentUser } from "./spawn-as-user";

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
  /** Absolute path to node used to spawn the daemon (defaults to this runtime). */
  nodeBin: string;
  /** Absolute path to the built daemon bundle (packages/daemon/dist/index.js). */
  daemonDist: string;
  /**
   * Directory holding the `claude` binary. Prepended to the spawned daemon's
   * PATH so its `bash -lc "... | claude ..."` resolves the agent CLI without the
   * daemon bundle hardcoding an absolute path (team-lead: PATH-resolved override).
   * Empty → rely on the daemon's login-shell PATH.
   */
  claudeBinDir: string;
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
   * Dedicated unprivileged unix account the agent child runs as (#108).
   *
   * Empty (the DEFAULT) = EXACTLY today's behaviour: no sudo wrapper, no ACLs,
   * no group-kill shell-out, no observe-mode proxy. Non-empty additionally
   * REQUIRES an explicit WORKER_WORKDIR_ROOT (see the loader) — the default
   * root is os.tmpdir(), which on macOS is a 0700 dir owned by the worker's own
   * uid and untraversable by any other, so every run would die at clone.
   *
   * macOS-only mechanism; nothing here is platform-gated at config level so the
   * package still typechecks and tests on any platform.
   */
  agentUser: string;
  /**
   * #204: per-run memory ceiling in bytes. 0 (the DEFAULT) = off, and the spawn
   * is byte-for-byte what it is today. Requires agent-uid mode and a delegated
   * cgroup subtree; see run-cgroup.ts.
   */
  memoryMaxBytes: number;
  /** #204: per-run `pids.max`. Only read when the ceiling is on. */
  tasksMax: number;
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
   * Per-run GitHub credential brokering (#81). "on" (default): the workflow
   * starts the git + gh brokers and the agent child never sees the
   * installation token — only a per-run bearer, in EVERY lane. "legacy-direct"
   * is the one-env-var rollback: no brokers, today's exact raw-token env.
   * Fail-closed within a run: with "on", a broker start failure throws
   * pre-daemon — a run configured for brokering must never silently fall back
   * to a raw-token env.
   */
  credentialBroker: "on" | "legacy-direct";

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
}

function defaultDaemonDist(): string {
  // Locate the sibling @terragon/daemon package's built bundle. The daemon must be
  // built (`pnpm --filter @terragon/daemon build`) as a worker-box setup step;
  // provisioning documents this. We can't require.resolve the dist path — the
  // daemon package's "." export is the TS source and its exports map blocks
  // package.json — so we derive it from this file's monorepo location. On a bundled
  // deploy set WORKER_DAEMON_DIST explicitly to override this.
  // this file: packages/worker/src/agent-run/config.ts → up 3 = packages/worker.
  const workerPkgRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  return path.join(workerPkgRoot, "..", "daemon", "dist", "index.js");
}

function resolveClaudeBinDir(explicit: string | undefined): string {
  if (explicit && explicit.trim()) {
    // Accept either the binary path or its directory.
    return explicit.endsWith("/claude") ? path.dirname(explicit) : explicit;
  }
  return "";
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
  const v = (raw ?? "").trim();
  if (!v) {
    return 0;
  }
  const m = /^(\d+)([KMG]?)$/i.exec(v);
  if (!m?.[1]) {
    throw new Error(
      `WORKER_RUN_MEMORY_MAX must be bytes with an optional K/M/G suffix, got ${JSON.stringify(v)}`,
    );
  }
  const suffix = (m[2] ?? "").toUpperCase();
  const scale = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[suffix] ?? 1;
  const bytes = Number(m[1]) * scale;
  // A TYPO MUST NOT BECOME A NONSENSE CEILING. The regex accepts any run of
  // digits, so `99999999999999999999G` parses — and `Number(...) * scale` then
  // exceeds 2^53 or overflows to Infinity, which is written verbatim into
  // `memory.max`. The kernel's answer to that is not something to find out in
  // production, and this file's whole posture is to refuse a typo at boot rather
  // than carry it into a run.
  if (!Number.isSafeInteger(bytes)) {
    throw new Error(
      `WORKER_RUN_MEMORY_MAX=${v} does not fit an exact integer number of bytes ` +
        `(got ${bytes}); use a realistic value such as 1500M`,
    );
  }
  // A ceiling below one session's measured ~1.1 GB would OOM-kill every run.
  // Refusing is kinder than a box where nothing completes.
  if (bytes > 0 && bytes < 256 * 1024 ** 2) {
    throw new Error(
      `WORKER_RUN_MEMORY_MAX=${v} is below 256M; a ceiling that low kills every run (one session measures ~1.1 GB)`,
    );
  }
  return bytes;
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
  // #108: validate the agent-uid opt-in HERE, not in a separate boot assert —
  // worker.ts calls loadWorkerConfig at boot AND the workflow calls it per run,
  // so a misconfigured box can neither start nor execute.
  // #204. Parsed before the agentUser gate below so a nonsense value is refused
  // at boot rather than at the first run — the whole-tuple validation ADR-002's
  // capacity model needs (global cap, worker slots, per-run ceiling, swap) starts
  // with this one not being a typo.
  const memoryMaxBytes = parseMemoryMax(env.WORKER_RUN_MEMORY_MAX);
  // ONLY VALIDATED WHEN THE CEILING IS ON. `parseTasksMax` throws on a set-but-
  // invalid value, and running it unconditionally meant a box that never enabled
  // the ceiling could be stopped from booting by a stray `WORKER_RUN_TASKS_MAX` —
  // breaking the default-off promise this feature makes twice over. With the
  // ceiling off the value is unused, so it is not this feature's business to
  // reject it.
  const tasksMax =
    memoryMaxBytes > 0 ? parseTasksMax(env.WORKER_RUN_TASKS_MAX) : 0;

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
    // guarded by nothing. Refuse, the same way WORKER_RUN_MEMORY_MAX without
    // WORKER_AGENT_USER is refused.
    if (livenessPollS >= livenessStaleAfterS) {
      throw new Error(
        `WORKER_LIVENESS_POLL_S=${livenessPollS} must be well below ` +
          `WORKER_LIVENESS_STALE_S=${livenessStaleAfterS}: a watchdog that ticks no more ` +
          `often than its own threshold cannot observe staleness, and a box told to guard ` +
          `itself must not run unguarded.`,
      );
    }
  }

  const agentUser = env.WORKER_AGENT_USER?.trim() || "";
  if (agentUser) {
    assertAgentUser(agentUser);
    if (!env.WORKER_WORKDIR_ROOT?.trim()) {
      throw new Error(
        "WORKER_AGENT_USER is set but WORKER_WORKDIR_ROOT is not: the default " +
          "workdir root is os.tmpdir(), which on macOS is mode 0700 and owned by " +
          "the worker's own uid — the agent uid cannot traverse it and every run " +
          "would die at clone. Set WORKER_WORKDIR_ROOT (e.g. /usr/local/automata/runs).",
      );
    }
  }
  // THE CEILING NEEDS THE UID DROP, so asking for one without the other is a
  // misconfiguration, not a degraded mode. Without the drop the agent is this
  // process's own child in this process's own cgroup, and capping it would cap
  // the WORKER — so the per-run path declines. It used to decline with a log
  // line and run on, which is the fail-open this whole feature argues against:
  // the operator asked for a ceiling, the box booted happily, and every run went
  // uncapped with one 'skipped' line to show for it. Rejecting here fails at
  // boot AND at every run, because every caller loads this config.
  if (memoryMaxBytes > 0 && !agentUser) {
    throw new Error(
      "WORKER_RUN_MEMORY_MAX is set but WORKER_AGENT_USER is empty: the per-run " +
        "memory ceiling caps the AGENT, which only exists as a separate process " +
        "under the uid drop. Without it the ceiling would cap this worker, so it " +
        "is declined — and a box told to cap its runs must not run them uncapped. " +
        "Set WORKER_AGENT_USER, or unset WORKER_RUN_MEMORY_MAX.",
    );
  }
  return {
    agentUser,
    boxId: resolveBoxId(env.WORKER_BOX_ID),
    memoryMaxBytes,
    tasksMax,
    livenessStaleAfterS,
    livenessPollS,
    nodeBin: env.WORKER_NODE_BIN?.trim() || process.execPath,
    daemonDist: env.WORKER_DAEMON_DIST?.trim() || defaultDaemonDist(),
    claudeBinDir: resolveClaudeBinDir(env.CLAUDE_BIN),
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
    runNamespaceRoot:
      env.WORKER_RUN_NAMESPACE_ROOT?.trim() || DEFAULT_RUN_NAMESPACE_ROOT,
    // Only the exact rollback string opts OUT — anything else (unset, typo)
    // stays brokered, so a misconfigured box degrades to the mode that keeps
    // the installation token out of agent env.
    credentialBroker:
      env.WORKER_CREDENTIAL_BROKER?.trim() === "legacy-direct"
        ? "legacy-direct"
        : "on",

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
    healthPort: (() => {
      const n = Number(env.WORKER_HEALTH_PORT);
      return env.WORKER_HEALTH_PORT?.trim() && Number.isFinite(n) && n > 0
        ? n
        : null;
    })(),
  };
}

/** Resolves a per-mechanism mode: an explicit off/dry-run/on wins; "inherit" defers to the global mode. */
export function resolveMechanismMode(
  mechanismMode: "off" | "dry-run" | "on" | "inherit",
  globalMode: "off" | "dry-run" | "on",
): "off" | "dry-run" | "on" {
  return mechanismMode === "inherit" ? globalMode : mechanismMode;
}
