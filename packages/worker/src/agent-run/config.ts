import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RUN_NAMESPACE_ROOT } from "./run-namespace";

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

export function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const pollIntervalMs = Number(env.WORKER_POLL_INTERVAL_MS ?? "7000");
  return {
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
  };
}
