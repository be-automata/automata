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

export function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const pollIntervalMs = Number(env.WORKER_POLL_INTERVAL_MS ?? "7000");
  // #108: validate the agent-uid opt-in HERE, not in a separate boot assert —
  // worker.ts calls loadWorkerConfig at boot AND the workflow calls it per run,
  // so a misconfigured box can neither start nor execute.
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
  return {
    agentUser,
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
