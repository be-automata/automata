import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  SLOT_DIR_RE,
  WORKER_LOCK_FILENAME,
  runPidPath,
  runUserPath,
  workerRunDir,
} from "./run-namespace";
import {
  assertAgentUser,
  buildKillInvocation,
  type Invocation,
} from "./spawn-as-user";

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

/**
 * Every `*.pid` under a worker dir: the flat layout's own files plus those in
 * its slot subdirs (`s<i>/`, #205). *.pid = per-run daemon group pids.
 */
function listPidFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".pid")) {
      out.push(path.join(dir, entry.name));
    } else if (entry.isDirectory() && SLOT_DIR_RE.test(entry.name)) {
      try {
        for (const f of fs.readdirSync(path.join(dir, entry.name))) {
          if (f.endsWith(".pid")) out.push(path.join(dir, entry.name, f));
        }
      } catch {
        // a vanished subdir is nothing to reap
      }
    }
  }
  return out;
}

/** The slot subdirs present under a worker dir, as slot indexes (#205). */
function listSlotDirs(dir: string): number[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SLOT_DIR_RE.test(e.name))
      .map((e) => Number(e.name.slice(1)));
  } catch {
    return [];
  }
}

/** readdir the namespace root, [] when it does not exist — shared by both reapers. */
function listWorkerDirs(root: string): fs.Dirent[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory());
  } catch {
    return [];
  }
}

/**
 * The ONE group-kill dispatch both reapers share: sudo-shelled as the agent
 * account when configured (cross-uid process.kill is EPERM; `sudo -n` never
 * prompts, so a missing NOPASSWD exits instead of hanging), else
 * process.kill(-pgid). Never throws. Returns the label of the path taken so
 * the caller's log line can say which.
 */
function killDaemonGroup(
  pgid: number,
  opts: Pick<ReclaimOpts, "agentUser" | "kill" | "spawnKill">,
): "sudo" | "direct" | "gone" {
  const kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal));
  const spawnKill =
    opts.spawnKill ??
    ((invocation: Invocation) => {
      spawn(invocation.file, invocation.args, { stdio: "ignore" }).unref();
    });
  try {
    const invocation = buildKillInvocation({
      agentUser: opts.agentUser ?? "",
      pgid,
    });
    if (invocation) {
      spawnKill(invocation);
      return "sudo";
    }
    kill(-pgid, "SIGKILL");
    return "direct";
  } catch {
    return "gone";
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

/**
 * #205: the agent account a pidfile's run executed as, from its `.user`
 * sibling. Null when absent or not a plain login name — then the caller's
 * configured account is used, which is exactly today's behaviour for every
 * pre-#205 pidfile and for agent-uid mode off. A malformed record is never
 * passed to sudo.
 */
function readRunUser(pidFile: string): string | null {
  try {
    const raw = fs.readFileSync(runUserPath(pidFile), "utf8").trim();
    if (!raw) return null;
    assertAgentUser(raw);
    return raw;
  } catch {
    return null;
  }
}

/** The account to kill a recorded group as: the run's own record, else the configured one. */
function killOptsFor(
  pidFile: string,
  opts: ReclaimOpts | Omit<ReclaimOpts, "selfWorkerId">,
) {
  const recorded = opts.agentUser ? readRunUser(pidFile) : null;
  return recorded ? { ...opts, agentUser: recorded } : opts;
}

function removeRunRecord(pidFile: string): void {
  for (const f of [pidFile, runUserPath(pidFile)]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // best-effort
    }
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

    // Dead worker: SIGKILL every recorded daemon process group, then remove the dir.
    for (const pidFile of listPidFiles(dir)) {
      const daemonPid = readPid(pidFile);
      if (daemonPid === null) {
        continue; // malformed pid file — tolerate
      }
      // #205: a dead slot-1 run must be signalled as slot 1's account.
      const how = killDaemonGroup(daemonPid, killOptsFor(pidFile, opts));
      if (how !== "gone") {
        log(
          `reclaim: ${how === "sudo" ? "sudo-" : ""}SIGKILLed orphan daemon group ${daemonPid} (${entry.name})`,
        );
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
 * Called at run admission (workflow.ts, before the box-lock acquire): scans
 * EVERY workerId dir — own and siblings, live or dead — for `<threadId>.pid`
 * and SIGKILLs that process group, then removes ONLY the pid file (a live
 * sibling's dir is never deleted; dead siblings are reclaimDeadWorkerRuns'
 * job, which admission also invokes), and the uid-scan reaper (`uid-reaper.ts`,
 * #184) runs AFTER the lock — it is the only uid-wide kill.
 *
 * WHY killing by threadId is safe with no engine read (fail-closed by
 * construction, not by status polling):
 *  - Hatchet never runs one workflow-run concurrently with itself: a
 *    redelivery is issued only after the prior assignment's session lapsed.
 *  - www's per-thread token dedup bars concurrent double-dispatch, so a
 *    same-threadId pid can only be a prior attempt of THIS run — never
 *    someone else's live work.
 *  - `slots: 1` on the box's single worker unit makes the box single-flight;
 *    the kernel lock (box-lock.ts) covers the crash-relaunch overlap.
 * Never throws; every op is best-effort (a stray file must not fail a run).
 */
export function reapOwnThreadAttempts(
  opts: Omit<ReclaimOpts, "selfWorkerId"> & { threadId: string },
): number {
  const { root, threadId } = opts;
  const log = opts.log ?? (() => {});

  let reaped = 0;
  for (const entry of listWorkerDirs(root)) {
    // The producer's own path builder (daemon-process.ts writes these files
    // via runPidPath) — the filename contract has exactly one owner. The flat
    // layout first, then every slot subdir (#205): a prior attempt of this
    // thread may have run on any slot.
    const dir = workerRunDir(root, entry.name);
    const candidates = [
      runPidPath(root, entry.name, threadId),
      ...listSlotDirs(dir).map((slot) =>
        runPidPath(root, entry.name, threadId, slot),
      ),
    ];
    for (const pidFile of candidates) {
      const daemonPid = readPid(pidFile);
      if (daemonPid === null) continue;
      // The prior attempt's record names the account it ran as.
      const how = killDaemonGroup(daemonPid, killOptsFor(pidFile, opts));
      if (how !== "gone") {
        log(
          `admission-reap: ${how === "sudo" ? "sudo-" : ""}SIGKILLed prior attempt group ${daemonPid} of ${threadId} (${entry.name})`,
        );
      }
      removeRunRecord(pidFile);
      reaped += 1;
    }
  }
  return reaped;
}
