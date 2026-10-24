/**
 * Pause this box's worker in the engine and wait until it runs nothing, so the
 * restart that follows interrupts no run. Run by `automata-worker-safe-restart`
 * (deploy/linux) as the service account, with worker-box.env loaded; see
 * src/agent-run/safe-restart.ts for why.
 *
 *   node --import tsx scripts/drain-for-restart.ts [--timeout-s N] [--poll-s N]
 *
 * Exit: 0 drained (or no active worker: nothing to interrupt) — restart now;
 * 3 still busy at the deadline, or interrupted (worker unpaused again);
 * 4 the engine could not be read or written (worker unpaused again).
 */
import { Hatchet } from "@hatchet-dev/typescript-sdk";

import { resolveBoxId } from "../src/agent-run/config";
import { resolveProbeWorkerName } from "../src/agent-run/engine-liveness";
import { drainForRestart } from "../src/agent-run/safe-restart";

function flag(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`${name} must be a positive number of seconds`);
    process.exit(2);
  }
  return v;
}

// 50 min: a run's 30 min execution timeout plus its 12 min headroom-deferral
// budget, with room to spare. Anything still running then is stuck.
const timeoutS = flag("--timeout-s", 3000);
const pollS = flag("--poll-s", 5);

const hatchet = Hatchet.init();
const workerName = resolveProbeWorkerName(
  `automata-worker-${resolveBoxId(process.env.WORKER_BOX_ID)}`,
  hatchet.config.namespace,
);
const abort = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => abort.abort());
}

const result = await drainForRestart({
  engine: {
    listWorkers: () => hatchet.workers.list(),
    setPaused: async (id, paused) => {
      await (paused ? hatchet.workers.pause(id) : hatchet.workers.unpause(id));
    },
  },
  workerName,
  timeoutMs: timeoutS * 1000,
  pollMs: pollS * 1000,
  log: (m) => console.log(m),
  signal: abort.signal,
});
console.log(`drain: ${JSON.stringify(result)}`);
process.exit(
  result.kind === "drained" || result.kind === "no-worker"
    ? 0
    : result.kind === "timeout"
      ? 3
      : 4,
);
