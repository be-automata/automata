/**
 * Pause this box's worker in the engine and wait until it runs nothing, so the
 * restart that follows interrupts no run. Run by `automata-worker-safe-restart`
 * (deploy/linux) as the service account, with worker-box.env loaded; see
 * src/agent-run/safe-restart.ts for why.
 *
 *   node --import tsx scripts/drain-for-restart.ts [--timeout-s N] [--poll-s N]
 *     [--allow-no-worker] [--for-stop]
 *
 * --for-stop: the unit's ExecStop= (every `systemctl stop`/`restart`, and
 * shutdown). Best-effort — systemd SIGTERMs the worker when this returns,
 * whatever it says — so it always exits 0, leaves the worker paused at the
 * deadline, and never fails the unit's stop.
 *
 * Exit: 0 drained — restart now; 3 still busy at the deadline, or interrupted
 * (worker unpaused again); 4 not proven idle: the engine could not be read or
 * written (worker unpaused again), or no active worker carries this box's name
 * — a name mismatch or a worker still registering reads the same, so it is
 * refused unless `--allow-no-worker` says the operator checked.
 */
import { Hatchet } from "@hatchet-dev/typescript-sdk";

import { resolveBoxId } from "../src/agent-run/config";
import { resolveProbeWorkerName } from "../src/agent-run/engine-liveness";
import { drainExitCode, drainForRestart } from "../src/agent-run/safe-restart";

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

const forStop = process.argv.includes("--for-stop");
const abort = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => abort.abort());
}

async function main(): Promise<number> {
  const hatchet = Hatchet.init();
  const workerName = resolveProbeWorkerName(
    `automata-worker-${resolveBoxId(process.env.WORKER_BOX_ID)}`,
    hatchet.config.namespace,
  );
  const result = await drainForRestart({
    engine: {
      listWorkers: () => hatchet.workers.list(),
      setPaused: async (id, paused) => {
        await (paused
          ? hatchet.workers.pause(id)
          : hatchet.workers.unpause(id));
      },
    },
    workerName,
    timeoutMs: timeoutS * 1000,
    pollMs: pollS * 1000,
    log: (m) => console.log(m),
    signal: abort.signal,
    keepPausedOnTimeout: forStop,
  });
  console.log(`drain: ${JSON.stringify(result)}`);
  if (result.kind === "no-worker" && !forStop) {
    console.log(
      `drain: no active worker named ${workerName} while the unit runs — refusing to restart blind; check the name (WORKER_BOX_ID, namespace) or pass --allow-no-worker`,
    );
  }
  return drainExitCode(result, process.argv.includes("--allow-no-worker"));
}

let code: number;
try {
  code = await main();
} catch (err) {
  console.log(
    `drain: failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  code = 4;
}
if (forStop && code !== 0) {
  console.log(
    `drain: not proven idle (exit ${code}); the stop proceeds to SIGTERM — the SDK drain and the run-terminal ledger take over`,
  );
}
process.exit(forStop ? 0 : code);
