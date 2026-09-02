import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  WORKER_LOCK_FILENAME,
  sanitizeThreadId,
  workerRunDir,
} from "./run-namespace";
import { buildKillInvocation, type Invocation } from "./spawn-as-user";

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
  /**
   * #108: the unix account daemons run as. Empty (the default) = today's exact
   * behaviour, `process.kill(-pgid)`. Non-empty ⇒ the group kill shells out as
   * that account, because process.kill across a uid boundary is EPERM.
   */
  agentUser?: string;
  /** Injectable for tests (default: spawn the invocation and unref it). */
  spawnKill?: (invocation: Invocation) => void;
}

/**
 * True iff `pid` is confirmed dead (kill(pid,0) throws ESRCH).
 *
 * This deliberately stays on `process.kill` even in agent-uid mode: it targets
 * the sibling **worker.lock** pid, which is another worker process and so
 * always the OPERATOR's own uid, never the agent's. The EPERM →"treat as ALIVE"
 * rule below already fails safe if that ever stops being true. Do not "fix"
 * this into a sudo call — it would shell out once per sibling dir at every boot.
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
  const spawnKill =
    opts.spawnKill ??
    ((invocation: Invocation) => {
      // `sudo -n` never prompts, so a missing NOPASSWD exits immediately rather
      // than hanging boot. Orphans then survive — exactly today's pre-#108
      // failure mode — and boot is not blocked.
      spawn(invocation.file, invocation.args, { stdio: "ignore" }).unref();
    });
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
      daemonFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".pid")); // *.pid = per-run daemon group pids
    } catch {
      daemonFiles = [];
    }
    for (const file of daemonFiles) {
      const daemonPid = readPid(path.join(dir, file));
      if (daemonPid === null) {
        continue; // malformed pid file — tolerate
      }
      try {
        // Inside the try: reclaim never throws (boot must not be blocked by a
        // stray file), and the builders validate their inputs.
        const killInvocation = buildKillInvocation({
          agentUser: opts.agentUser ?? "",
          pgid: daemonPid,
        });
        if (killInvocation) {
          spawnKill(killInvocation);
          log(
            `reclaim: sudo-SIGKILLed orphan daemon group ${daemonPid} (${entry.name})`,
          );
        } else {
          kill(-daemonPid, "SIGKILL"); // negative pid → the whole process group
          log(
            `reclaim: SIGKILLed orphan daemon group ${daemonPid} (${entry.name})`,
          );
        }
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

/**
 * Admission-time reap of PREVIOUS ATTEMPTS of one run (#152 Stage A).
 *
 * The zombie window this closes: a worker dies (SIGKILL, panic, reboot race)
 * mid-run, the engine's session lapses and it REDELIVERS the task — possibly
 * to the OTHER worker process on the box — while the dead attempt's daemon
 * process group still holds the box's memory and credentials. Boot-reclaim
 * only runs at worker starts, so a redelivery landing on the surviving worker
 * used to start a second agent beside the orphan.
 *
 * Called at run admission (workflow.ts, before the box-slot acquire): scans
 * EVERY workerId dir — own and siblings, live or dead — for `<threadId>.pid`
 * and SIGKILLs that process group, then removes ONLY the pid file (a live
 * sibling's dir is never deleted; dead siblings are reclaimDeadWorkerRuns'
 * job, which admission also invokes).
 *
 * WHY killing by threadId is safe with no engine read (fail-closed by
 * construction, not by status polling):
 *  - Hatchet never runs one workflow-run concurrently with itself: a
 *    redelivery is issued only after the prior assignment's session lapsed.
 *  - www's per-thread daemon-token dedup guard prevents two DISPATCHES for
 *    one thread being in flight, so a same-threadId pid can only be a prior
 *    attempt of THIS run — never someone else's live work.
 *  - `slots: 1` means this worker itself has no other task mid-flight.
 * Never throws; every op is best-effort (a stray file must not fail a run).
 */
export function reapOwnThreadAttempts(
  opts: Omit<ReclaimOpts, "selfWorkerId"> & { threadId: string },
): number {
  const { root, threadId } = opts;
  const kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal));
  const spawnKill =
    opts.spawnKill ??
    ((invocation: Invocation) => {
      spawn(invocation.file, invocation.args, { stdio: "ignore" }).unref();
    });
  const log = opts.log ?? (() => {});
  const pidFileName = `${sanitizeThreadId(threadId)}.pid`;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let reaped = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pidFile = path.join(workerRunDir(root, entry.name), pidFileName);
    const daemonPid = readPid(pidFile);
    if (daemonPid === null) continue;
    try {
      const killInvocation = buildKillInvocation({
        agentUser: opts.agentUser ?? "",
        pgid: daemonPid,
      });
      if (killInvocation) {
        spawnKill(killInvocation);
      } else {
        kill(-daemonPid, "SIGKILL");
      }
      log(
        `admission-reap: SIGKILLed prior attempt group ${daemonPid} of ${threadId} (${entry.name})`,
      );
    } catch {
      // already gone
    }
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {
      // best-effort
    }
    reaped += 1;
  }
  return reaped;
}
