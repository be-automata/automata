import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hatchet } from "../hatchet-client";
import { assertAuthEnabledFromEnv } from "../agent-run/assert-auth";
import { loadWorkerConfig } from "../agent-run/config";
import { assertNodeBinSupportsEnvProxy } from "../agent-run/node-floor";
import { reclaimDeadWorkerRuns } from "../agent-run/reclaim";
import {
  bootTimeSlotReclaim,
  startMaintenanceLoop,
} from "../agent-run/scheduling-maintenance";
import {
  claimRunNamespace,
  getProcessWorkerId,
} from "../agent-run/run-namespace";
import { workflows } from "../registry";

const execFileAsync = promisify(execFile);

/**
 * Claim this worker process's namespaced run dir and reap orphans left by DEAD
 * sibling workers (Phase 0.2b). Order matters: write our OWN worker.lock FIRST so a
 * concurrently-booting sibling never mistakes our fresh dir for an orphan, THEN scan
 * siblings. Reclaim only ever group-SIGKILLs daemons under a dir whose worker pid is
 * confirmed dead — a live worker's daemons are never touched (safe for ≥2 workers).
 */
async function claimNamespaceAndReclaim(): Promise<void> {
  const root = loadWorkerConfig().runNamespaceRoot;
  const workerId = getProcessWorkerId();
  try {
    // #108 F2: this ALSO applies the cross-uid ACEs, on the empty dir, before
    // anything is created inside it. macOS applies ACE inheritance at create
    // time, so a grant added later (per-run, inside DaemonProcess.start())
    // never reaches the gh-broker socket workflow.ts already bound.
    await claimRunNamespace({
      root,
      workerId,
      agentUser: loadWorkerConfig().agentUser,
    });
  } catch (err) {
    // A worker that can't claim its dir would leak every run's resources — fail loud.
    console.error("worker: failed to claim run namespace", err);
    throw err;
  }
  reclaimDeadWorkerRuns({
    root,
    selfWorkerId: workerId,
    // #108: empty (the default) ⇒ process.kill(-pgid), exactly as before.
    agentUser: loadWorkerConfig().agentUser,
    log: (message) => console.log(`[worker-boot] ${message}`),
  });
}

/**
 * Starts a worker that registers every workflow in the registry and long-polls the
 * engine over outbound gRPC for work. On a real customer box this is the process the
 * installer runs and keeps alive. Run locally with `pnpm --filter @terragon/worker worker`.
 */
async function main() {
  // #5 fail-closed gate: refuse to boot against an auth-DISABLED engine (a
  // -dev/auth-off hatchet-lite embeds a public signing key → tenancy void). Runs
  // BEFORE anything else so a misconfigured box never registers a worker.
  try {
    await assertAuthEnabledFromEnv();
    console.log("[worker-boot] auth-enabled probe OK");
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: auth-enabled probe failed — refusing to start",
      err,
    );
    process.exit(1);
  }

  // #108 A5: agent-uid mode leans on node's built-in env-proxy support for the
  // agent CLI child. Node 20 has none, and a box on it would turn every fenced
  // run into a silent 90s stall with zero output rather than an error. Probe the
  // configured node ONCE at boot and refuse to start below the floor.
  try {
    const cfg = loadWorkerConfig();
    if (cfg.agentUser) {
      await assertNodeBinSupportsEnvProxy({
        nodeBin: cfg.nodeBin,
        exec: (file, args) => execFileAsync(file, args),
      });
      console.log(
        `[worker-boot] agent-uid mode: ${cfg.agentUser}; node env-proxy floor OK`,
      );
    }
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: agent-uid configuration is unusable — refusing to start",
      err,
    );
    process.exit(1);
  }

  await claimNamespaceAndReclaim();

  // #69 §3.2.4 item 2 — boot-time (secondary) engine-DB slot reclaim, BEFORE
  // registration so this registration's own fresh strategy rows are never
  // scanned as if they were the leak. Master-gated on
  // HATCHET_ENGINE_DATABASE_URL and fully try/catch-guarded internally: an
  // unconfigured or unreachable engine DB must never block boot.
  await bootTimeSlotReclaim(loadWorkerConfig());

  const worker = await hatchet.worker("automata-worker", {
    workflows,
    // #125 C4: ONE slot per worker process. The engine's global concurrency key is
    // per workflow (docs/uat/hatchet-lite-v0.94.10-observed.md §5), so admission
    // is bounded here: with two processes on the box at most one run executes
    // (box-slot.ts) and at most one waits; everything else stays QUEUED on the
    // engine, where a cancel/supersede is free and no timeout clock is running.
    slots: 1,
  });

  // #69 §3.2.4 item 1 (PRIMARY path) + §3.1 rot repair + §3.3 stuck-QUEUED
  // detection. Runs AFTER registration so it observes the strategy rows THIS
  // registration just minted (§3.1.4 ordering note). Master-gated the same
  // way; starts nothing when HATCHET_ENGINE_DATABASE_URL is unset.
  startMaintenanceLoop(loadWorkerConfig(), getProcessWorkerId());

  // Graceful-drain semantics (Phase 3.1 / plan amendment 8). We deliberately install
  // NO custom SIGTERM/SIGINT handler: the Hatchet SDK already registers
  // `process.on('SIGTERM'|'SIGINT') → exitGracefully()`, which PAUSES task assignment
  // on the engine (stops picking up new runs) and then awaits the in-flight run to
  // completion before the process exits. A second handler of ours would RACE the
  // SDK's and risk tearing the daemon down mid-run — the exact drop we're preventing.
  // The operator restart procedure MUST therefore be SIGTERM + wait (never
  // `launchctl kickstart -k`, which is SIGKILL) — see packages/worker/deploy/README.md.
  // This log line lets an operator confirm the drain contract from worker.log.
  console.log(
    "[worker-boot] SIGTERM/SIGINT → SDK graceful drain (in-flight agent-run completes before exit; no custom handler by design)",
  );

  await worker.start();
}

main().catch((err) => {
  console.error("worker failed to start", err);
  process.exit(1);
});
