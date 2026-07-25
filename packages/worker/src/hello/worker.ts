import fs from "node:fs";
import { hatchet } from "../hatchet-client";
import { assertAuthEnabledFromEnv } from "../agent-run/assert-auth";
import { loadWorkerConfig } from "../agent-run/config";
import { reclaimDeadWorkerRuns } from "../agent-run/reclaim";
import {
  getProcessWorkerId,
  workerLockPath,
  workerRunDir,
} from "../agent-run/run-namespace";
import { workflows } from "../registry";

/**
 * Claim this worker process's namespaced run dir and reap orphans left by DEAD
 * sibling workers (Phase 0.2b). Order matters: write our OWN worker.lock FIRST so a
 * concurrently-booting sibling never mistakes our fresh dir for an orphan, THEN scan
 * siblings. Reclaim only ever group-SIGKILLs daemons under a dir whose worker pid is
 * confirmed dead — a live worker's daemons are never touched (safe for ≥2 workers).
 */
function claimNamespaceAndReclaim(): void {
  const root = loadWorkerConfig().runNamespaceRoot;
  const workerId = getProcessWorkerId();
  const dir = workerRunDir(root, workerId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(workerLockPath(root, workerId), String(process.pid));
  } catch (err) {
    // A worker that can't claim its dir would leak every run's resources — fail loud.
    console.error("worker: failed to claim run namespace", err);
    throw err;
  }
  reclaimDeadWorkerRuns({
    root,
    selfWorkerId: workerId,
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

  claimNamespaceAndReclaim();
  const worker = await hatchet.worker("automata-worker", {
    workflows,
    slots: 5,
  });
  await worker.start();
}

main().catch((err) => {
  console.error("worker failed to start", err);
  process.exit(1);
});
