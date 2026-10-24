import fs from "node:fs";
import path from "node:path";
import { WORKER_LOCK_FILENAME, workerRunDir } from "./run-namespace";
import { RUN_TERMINAL_LEDGER_DIR } from "./run-terminal-ledger";

/**
 * Boot-time reclaim of a DEAD sibling worker's namespace dir (enterprise-hardening
 * Phase 0.2b). Called ONCE at worker startup, AFTER this worker has written its own
 * `worker.lock`. It scans SIBLING `<workerId>/` dirs under the namespace root and
 * removes any whose recorded worker pid is DEAD.
 *
 * Since ADR-013 a run's processes live in its container, so there is no host
 * process group to kill here: a dead worker's run containers are removed by label
 * at boot (container-boot.ts) and a redelivered run's predecessor by slot name
 * (ContainerDaemonProcess.start). What a dead worker leaves in this tree is its
 * dir and the gh broker sockets in it.
 *
 * Safety invariants:
 *  - A dir whose worker pid is ALIVE is NEVER touched → ≥2 workers coexist safely.
 *  - Conservative on ambiguity: a dir with a MISSING or MALFORMED lock is SKIPPED
 *    (it may belong to a sibling still mid-boot between mkdir and lock-write). We only
 *    remove when we can positively confirm the owning worker pid is dead.
 *  - Never throws: every fs/kill op is best-effort so a boot can't be blocked by a
 *    stray file.
 */

export interface ReclaimOpts {
  root: string;
  /** This worker's id — its own dir is skipped. */
  selfWorkerId: string;
  log?: (message: string) => void;
  /** Injectable for tests (default process.kill); only ever probes with signal 0. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

/**
 * True iff `pid` is confirmed dead (kill(pid,0) throws ESRCH). The probed pid is
 * a sibling worker's, always this worker's own uid; EPERM is treated as ALIVE.
 */
function isPidDead(
  pid: number,
  kill: (pid: number, signal: NodeJS.Signals | 0) => void,
): boolean {
  try {
    kill(pid, 0);
    return false; // signal delivered → alive
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = exists but not ours (treat as ALIVE,
    // never reap). Anything else → be conservative and treat as alive.
    return (err as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

/**
 * readdir the namespace root, [] when it does not exist. The run-terminal ledger
 * (#386) lives beside the worker dirs and is not one: it has no worker.lock.
 */
function listWorkerDirs(root: string): fs.Dirent[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== RUN_TERMINAL_LEDGER_DIR);
  } catch {
    return [];
  }
}

function readPid(file: string): number | null {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function reclaimDeadWorkerRuns(opts: ReclaimOpts): void {
  const { root, selfWorkerId } = opts;
  const kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal));
  const log = opts.log ?? (() => {});

  for (const entry of listWorkerDirs(root)) {
    if (entry.name === selfWorkerId) {
      continue;
    }
    const dir = workerRunDir(root, entry.name);
    const lockPid = readPid(path.join(dir, WORKER_LOCK_FILENAME));

    // Ambiguous (no/malformed lock) → skip; only reap a POSITIVELY-dead worker.
    if (lockPid === null) {
      log(`reclaim: skip ${entry.name} — no readable worker.lock`);
      continue;
    }
    if (!isPidDead(lockPid, kill)) {
      continue; // live worker — never touch
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`reclaim: removed dead worker dir ${entry.name} (pid ${lockPid})`);
    } catch {
      // best-effort
    }
  }
}
