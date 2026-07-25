import fs from "node:fs";
import path from "node:path";
import { WORKER_LOCK_FILENAME, workerRunDir } from "./run-namespace";

/**
 * Boot-time reclaim of orphaned daemons (enterprise-hardening Phase 0.2b, BINDING
 * amendment 2). Called ONCE at worker startup, AFTER this worker has written its own
 * `worker.lock`. It scans SIBLING `<workerId>/` dirs under the namespace root and,
 * for any whose recorded worker pid is DEAD, SIGKILLs every daemon process-group pid
 * recorded in that dir (negative-pid group kill) and removes the dir.
 *
 * Safety invariants:
 *  - A dir whose worker pid is ALIVE is NEVER touched → ≥2 workers coexist safely
 *    (this replaces the old fixed-pidfile reclaim that could SIGKILL another live
 *    worker's daemon).
 *  - A dead worker's orphans are ALWAYS reaped → the rogue-daemon guard is preserved
 *    (a crashed worker never ran teardown, so its daemon is still holding the agent).
 *  - Conservative on ambiguity: a dir with a MISSING or MALFORMED lock is SKIPPED
 *    (it may belong to a sibling still mid-boot between mkdir and lock-write). We only
 *    reap when we can positively confirm the owning worker pid is dead.
 *  - Never throws: every fs/kill op is best-effort so a boot can't be blocked by a
 *    stray file (malformed files tolerated).
 */

export interface ReclaimOpts {
  root: string;
  /** This worker's id — its own dir is skipped. */
  selfWorkerId: string;
  log?: (message: string) => void;
  /** Injectable for tests (default process.kill). */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

/** True iff `pid` is confirmed dead (kill(pid,0) throws ESRCH). */
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

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // root doesn't exist yet → nothing to reclaim
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === selfWorkerId) {
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

    // Dead worker: SIGKILL every recorded daemon process group, then remove the dir.
    let daemonFiles: string[] = [];
    try {
      daemonFiles = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".pid")); // *.pid = per-run daemon group pids
    } catch {
      daemonFiles = [];
    }
    for (const file of daemonFiles) {
      const daemonPid = readPid(path.join(dir, file));
      if (daemonPid === null) {
        continue; // malformed pid file — tolerate
      }
      try {
        kill(-daemonPid, "SIGKILL"); // negative pid → the whole process group
        log(`reclaim: SIGKILLed orphan daemon group ${daemonPid} (${entry.name})`);
      } catch {
        // already gone
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`reclaim: removed dead worker dir ${entry.name} (pid ${lockPid})`);
    } catch {
      // best-effort
    }
  }
}
