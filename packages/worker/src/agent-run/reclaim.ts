import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  WORKER_LOCK_FILENAME,
  accountForPidFile,
  runPidPath,
  slotIndexOfDir,
  workerRunDir,
} from "./run-namespace";
import { LEDGER_DIRNAME } from "./reexecution-guard";
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

/** `*.pid` files directly in `dir`, [] when it cannot be read. */
function pidFilesIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".pid"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * The slot subdirs (`s<i>`, #205) under a worker dir that the WORKER created:
 * a valid slot name (slotIndexOfDir) AND owned by this uid. At N = 1 the agent
 * account can create dirs in the shared worker dir; whatever it drops there is
 * not a slot and is never scanned. [] when the dir cannot be read.
 */
function listSlotDirs(dir: string): Array<{ name: string; slot: number }> {
  const self = process.getuid?.();
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (!e.isDirectory()) return [];
      const slot = slotIndexOfDir(e.name);
      if (slot === null) return [];
      if (self !== undefined) {
        try {
          if (fs.lstatSync(path.join(dir, e.name)).uid !== self) return [];
        } catch {
          return [];
        }
      }
      return [{ name: e.name, slot }];
    });
  } catch {
    return [];
  }
}

/** Every `*.pid` under a worker dir: the flat layout's plus each slot subdir's (#205). */
function listPidFiles(dir: string): string[] {
  return [dir, ...listSlotDirs(dir).map((d) => path.join(dir, d.name))].flatMap(
    pidFilesIn,
  );
}

/** readdir the namespace root, [] when it does not exist — shared by both reapers. */
function listWorkerDirs(root: string): fs.Dirent[] {
  try {
    return (
      fs
        .readdirSync(root, { withFileTypes: true })
        // The root also holds the #371 deferral ledger dir, which is nobody's
        // run and must not be "reclaimed" or logged as skipped.
        .filter((e) => e.isDirectory() && e.name !== LEDGER_DIRNAME)
    );
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
 * #205: the account to signal a recorded group as — the slot's, read off the
 * pidfile's own path (`accountForPidFile`), so a dead slot-1 run is never
 * killed as slot 0 (an EPERM no-op and a leaked agent). Agent-uid mode off ⇒
 * unchanged `process.kill(-pgid)`. null when no account can be derived (a slot
 * whose name would exceed the login limit): the caller skips that file — a
 * reclaim never throws, and never kills as the wrong account.
 */
function killOptsFor<T extends { agentUser?: string }>(
  pidFile: string,
  opts: T,
): T | null {
  if (!opts.agentUser) return opts;
  try {
    return { ...opts, agentUser: accountForPidFile(pidFile, opts.agentUser) };
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

    // Dead worker: SIGKILL every recorded daemon process group, then remove the dir.
    for (const pidFile of listPidFiles(dir)) {
      const daemonPid = readPid(pidFile);
      if (daemonPid === null) {
        continue; // malformed pid file — tolerate
      }
      const killOpts = killOptsFor(pidFile, opts);
      if (killOpts === null) continue;
      const how = killDaemonGroup(daemonPid, killOpts);
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
 *  - the box's N slot locks (box-lock.ts, `slots: N` on the single worker
 *    unit) bound the box's concurrency and cover the crash-relaunch overlap;
 *    a threadId names one run whatever slot it holds, so the same-threadId
 *    kill stays exact at every N (#205). The prior attempt's slot dir names
 *    the account the kill must run as.
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
      ...listSlotDirs(dir).map((d) =>
        runPidPath(root, entry.name, threadId, d.slot),
      ),
    ];
    for (const pidFile of candidates) {
      const daemonPid = readPid(pidFile);
      if (daemonPid === null) continue;
      // The prior attempt ran as the account its slot dir names.
      const killOpts = killOptsFor(pidFile, opts);
      if (killOpts === null) continue;
      const how = killDaemonGroup(daemonPid, killOpts);
      if (how !== "gone") {
        log(
          `admission-reap: ${how === "sudo" ? "sudo-" : ""}SIGKILLed prior attempt group ${daemonPid} of ${threadId} (${entry.name})`,
        );
      }
      try {
        fs.rmSync(pidFile, { force: true });
      } catch {
        // best-effort
      }
      reaped += 1;
    }
  }
  return reaped;
}
