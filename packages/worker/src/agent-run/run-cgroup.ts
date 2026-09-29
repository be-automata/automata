import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Per-run memory ceiling via a DELEGATED cgroup v2 subtree (#204).
 *
 * WHY A DELEGATED SUBTREE AND NOT `systemd-run --scope`. #193 specified a
 * transient scope. Measured on the live box, the worker's own service account
 * cannot create one: `systemd-run --scope --uid=…` is refused by polkit
 * ("Interactive authentication required"), `--user` has no bus (the account is
 * not logged in and does not linger), and sudoers grants nothing as root. The
 * two ways to make a scope possible are both worse than the problem — a sudoers
 * entry for `systemd-run` is arbitrary root, because sudoers(5) permits any
 * arguments for a bare command path and `--uid=0` is one of them; a polkit rule
 * for `manage-units` is "start any transient unit as any uid".
 *
 * cgroup v2 delegation instead gives the worker write access to its OWN subtree,
 * so it creates and caps a per-run cgroup with no privilege at all. The uid drop
 * stays exactly where it was (`sudo -u <agent> /usr/bin/sh`) and the sudoers file
 * does not change.
 *
 * WHY THE SUPERVISOR CGROUP EXISTS. cgroup v2 forbids enabling controllers for a
 * cgroup's children while that cgroup itself holds processes ("no internal
 * process" constraint). The worker's own process sits in the delegated root, so
 * enabling `+memory` there fails EBUSY — `Device or resource busy`, which is how
 * this was found. Moving the worker into a leaf (`supervisor/`) vacates the root
 * and the enable then succeeds.
 *
 * WHY THE WORKER MOVES THE CHILD, AND THE CHILD WAITS. The agent cannot join the
 * cgroup itself: writing `cgroup.procs` requires write access to the common
 * ANCESTOR of source and destination, which the agent uid does not have, and
 * handing it over is not possible either — chowning `cgroup.procs` to the agent
 * is EPERM, since an unprivileged user cannot give a file away. So the worker
 * performs the move, and the wrapper blocks on a ready marker until it has, then
 * `exec`s. The agent therefore never runs outside its ceiling, and every file in
 * the per-run cgroup stays worker-owned — which is also what stops the agent
 * raising its own `memory.max`.
 *
 * DEFAULT-OFF AND LINUX-ONLY. Every function here is a no-op when the ceiling is
 * unset or the subtree is not delegated, so the pilot Mac, CI and any
 * non-delegated box keep today's behaviour byte-for-byte.
 */

/** Leaf the worker moves itself into so the delegated root can delegate. */
export const SUPERVISOR_CGROUP = "supervisor";

/** Controllers this feature needs. `Delegate=memory pids` on the unit grants them. */
export const REQUIRED_CONTROLLERS = ["memory", "pids"] as const;

/**
 * Read this process's cgroup v2 path from `/proc/self/cgroup`.
 *
 * The v2 line is the one with an empty controller field: `0::/path`. A v1-only
 * or hybrid host has no such line, and that is a supported "feature off" state,
 * not an error.
 */
export function parseCgroupPath(procSelfCgroup: string): string | null {
  for (const line of procSelfCgroup.split("\n")) {
    const parts = line.split(":");
    // `0::<path>` — hierarchy id 0, no controller name.
    if (parts.length >= 3 && parts[0] === "0" && parts[1] === "") {
      const p = parts.slice(2).join(":").trim();
      return p.startsWith("/") ? p : null;
    }
  }
  return null;
}

/**
 * Which controllers a cgroup can hand to its children, from its
 * `cgroup.controllers`. Enabling one that is absent fails, so this is what
 * decides whether the feature can run at all.
 */
export function parseControllers(cgroupControllers: string): string[] {
  return cgroupControllers.trim().split(/\s+/).filter(Boolean);
}

/**
 * Is the ceiling usable here? Requires cgroup v2, a delegated root the worker can
 * write, and both controllers available.
 *
 * Deliberately returns a REASON rather than a boolean: a box where the operator
 * meant to enable this and mistyped `Delegate=` should say which precondition
 * failed, not fall back to silence. The whole point of #192's cloud-init lesson
 * is that a silently-absent mechanism is worse than a loud one.
 */
export type CgroupSupport =
  | { supported: true; root: string; controllers: string[] }
  | { supported: false; reason: string };

export function assessCgroupSupport(opts: {
  platform?: NodeJS.Platform;
  /** Contents of /proc/self/cgroup. */
  procSelfCgroup: string;
  /** cgroup v2 mount point; the only place it ever is in practice. */
  mountPoint?: string;
  /**
   * Must the controllers already be ENABLED in `cgroup.subtree_control`?
   *
   * True at RUN time: by then boot has enabled them, and if it has not, creating a
   * run cgroup would fail writing `memory.max`. False at BOOT time, where this is
   * called immediately BEFORE `prepareDelegatedRoot` does the enabling — requiring
   * it there is circular and refuses every boot, which is how this was found.
   */
  requireEnabled?: boolean;
  /** Injected for tests. */
  readFile?: (p: string) => string;
  access?: (p: string) => boolean;
}): CgroupSupport {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") {
    return { supported: false, reason: `platform ${platform} has no cgroups` };
  }
  const mount = opts.mountPoint ?? "/sys/fs/cgroup";
  const readFile = opts.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const canWrite =
    opts.access ??
    ((p: string) => {
      try {
        fs.accessSync(p, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });

  const rel = parseCgroupPath(opts.procSelfCgroup);
  if (!rel) {
    return {
      supported: false,
      reason: "no cgroup v2 path in /proc/self/cgroup",
    };
  }
  // Climb out of the supervisor leaf.
  //
  // This is read at RUN time as well as at boot, and by run time the worker has
  // already moved itself into `<root>/supervisor` — so /proc/self/cgroup reports
  // the LEAF, not the delegated root. Taking it at face value creates every run
  // cgroup under the supervisor, where `memory` is not in subtree_control, so
  // `memory.max` does not exist and the create fails EACCES.
  //
  // Production traffic found this on the first real run. The drill could not:
  // it was handed the root explicitly, a convenience that bypassed the exact
  // line being exercised here.
  const delegatedRel =
    path.basename(rel) === SUPERVISOR_CGROUP ? path.dirname(rel) : rel;
  const root = path.join(mount, delegatedRel);

  // `cgroup.subtree_control` is the file delegation chowns to the unit's User=.
  // If it is not writable, the unit has no `Delegate=` and nothing below works.
  if (!canWrite(path.join(root, "cgroup.subtree_control"))) {
    return {
      supported: false,
      reason: `${root}/cgroup.subtree_control is not writable — the unit needs Delegate=memory pids`,
    };
  }

  let controllers: string[];
  try {
    controllers = parseControllers(
      readFile(path.join(root, "cgroup.controllers")),
    );
  } catch (e) {
    return {
      supported: false,
      reason: `cannot read ${root}/cgroup.controllers: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const missing = REQUIRED_CONTROLLERS.filter((c) => !controllers.includes(c));
  if (missing.length > 0) {
    return {
      supported: false,
      reason: `delegated cgroup lacks controller(s) ${missing.join(", ")} (have: ${controllers.join(", ") || "none"})`,
    };
  }

  if (opts.requireEnabled === false) {
    return { supported: true, root, controllers };
  }

  // AVAILABLE IS NOT THE SAME AS ENABLED, and the difference is a whole class of
  // failure. `cgroup.controllers` lists what the parent GRANTED; children only get
  // `memory.max` once `+memory` has actually been written to this cgroup's
  // `cgroup.subtree_control`. Checking only the former means a box whose boot-time
  // preparation FAILED still reports `supported` at run time, so every run creates
  // a cgroup and then dies writing `memory.max` — while the boot log says the
  // ceiling is off. Check what is enabled, not what is merely on offer.
  let enabled: string[];
  try {
    enabled = parseControllers(
      readFile(path.join(root, "cgroup.subtree_control")),
    );
  } catch (e) {
    return {
      supported: false,
      reason: `cannot read ${root}/cgroup.subtree_control: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const notEnabled = REQUIRED_CONTROLLERS.filter((c) => !enabled.includes(c));
  if (notEnabled.length > 0) {
    return {
      supported: false,
      reason: `delegated cgroup has controller(s) ${notEnabled.join(", ")} available but not enabled in subtree_control (enabled: ${enabled.join(", ") || "none"}) — boot-time preparation did not run or failed`,
    };
  }
  return { supported: true, root, controllers };
}

/**
 * The per-run cgroup's absolute path. Named by threadId so a stray directory is
 * traceable to a run, and sanitised because it becomes a filesystem path.
 */
export function runCgroupPath(root: string, threadId: string): string {
  // SANITISING ALONE CAN COLLIDE, and a collision here is not cosmetic: two runs
  // would share one cgroup, so they would share one memory ceiling and either
  // one's teardown would `cgroup.kill` the other's agent. Today's threadIds are
  // uuids and cannot collide, but this function does not get to assume that about
  // every future caller, so the short digest of the RAW id keeps distinct ids
  // distinct whatever the sanitiser folds together.
  const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const digest = createHash("sha256")
    .update(threadId)
    .digest("hex")
    .slice(0, 8);
  return path.join(root, `run-${safe}-${digest}`);
}

/** Injectable filesystem surface, so every function below is unit-testable. */
export interface CgroupFs {
  mkdir: (dir: string) => void;
  write: (file: string, value: string) => void;
  read: (file: string) => string;
  rmdir: (dir: string) => void;
  /**
   * Entry names in a directory; [] when it cannot be read. Optional: an injected
   * surface that omits it simply gets no boot sweep, rather than a type error.
   */
  readdir?: (dir: string) => string[];
  /** Injectable so the retry loop below costs a test nothing. */
  sleep?: (ms: number) => void;
}

const defaultFs: CgroupFs = {
  readdir: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
  mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
  write: (file, value) => fs.writeFileSync(file, value),
  read: (file) => fs.readFileSync(file, "utf8"),
  rmdir: (dir) => fs.rmdirSync(dir),
  // Busy-wait rather than async: teardown() is synchronous by contract, and 50ms
  // at a time bounded to ten tries is half a second in the worst case.
  sleep: (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin */
    }
  },
};

/**
 * BOOT: vacate the delegated root and delegate the controllers downward.
 *
 * Order is a kernel constraint, not a preference. `cgroup.subtree_control`
 * rejects `+memory` with EBUSY while the cgroup holds processes, so the worker
 * must move itself into `supervisor/` FIRST. Getting this backwards produces
 * `Device or resource busy` with nothing naming the cause.
 *
 * Idempotent: re-running on an already-prepared subtree is a no-op, so a worker
 * restart does not need the box reset.
 */
export function prepareDelegatedRoot(opts: {
  root: string;
  /** The worker's own pid. */
  pid: number;
  fsi?: CgroupFs;
}): void {
  const { root, pid } = opts;
  const io = opts.fsi ?? defaultFs;
  const supervisor = path.join(root, SUPERVISOR_CGROUP);

  io.mkdir(supervisor);

  // Vacate the root COMPLETELY, not just this process.
  //
  // The "no internal process" rule counts every member, and the worker is not
  // alone in its cgroup: `run-worker.sh` rebuilds the daemon bundle on each
  // start, and esbuild leaves a service process behind. Moving only `process.pid`
  // therefore works or fails depending on whether that child happens to have
  // exited yet — it passed in a drill and then failed on a real deploy with
  // `EBUSY: resource busy or locked`, which is the kernel refusing the enable
  // below while a sibling is still in the root.
  //
  // `cgroup.procs` is read fresh and each pid migrated; the kernel accepts a pid
  // that is already there, so this is safe to repeat and safe if one exits
  // mid-loop.
  let members: string[] = [];
  try {
    members = io
      .read(path.join(root, "cgroup.procs"))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    // Unreadable root ⇒ fall back to moving just ourselves, which is strictly
    // better than moving nothing.
  }
  if (!members.includes(String(pid))) {
    members.push(String(pid));
  }
  for (const member of members) {
    try {
      io.write(path.join(supervisor, "cgroup.procs"), member);
    } catch {
      // A pid that exited between the read and the write is gone, which is the
      // outcome we wanted anyway. Anything still there will surface as the EBUSY
      // below, named.
    }
  }

  // THE SWEEP THE TEARDOWN COMMENT PROMISES. `killAndRemoveRunCgroup` gives up
  // after its bounded retries rather than failing a finished run, so a run whose
  // members outlived the kill leaves its directory behind. Without a sweep those
  // accumulate for the life of the box — one empty directory per such run, each
  // still holding its `memory.max`. Boot is the right moment: no run of ours is
  // in flight, and the previous worker's processes are already gone.
  //
  // `rmdir` only — a directory that still holds processes fails EBUSY and is
  // LEFT, which is the correct outcome: that would mean a live agent, and a boot
  // sweep has no business killing one it cannot account for.
  for (const entry of io.readdir?.(root) ?? []) {
    if (!entry.startsWith("run-")) {
      continue;
    }
    try {
      io.rmdir(path.join(root, entry));
    } catch {
      // Still occupied, or already gone. Both are fine.
    }
  }

  const current = io.read(path.join(root, "cgroup.subtree_control"));
  const enabled = parseControllers(current);
  const toEnable = REQUIRED_CONTROLLERS.filter((c) => !enabled.includes(c));
  if (toEnable.length === 0) {
    return;
  }
  io.write(
    path.join(root, "cgroup.subtree_control"),
    toEnable.map((c) => `+${c}`).join(" "),
  );
}

/**
 * Create one run's cgroup and apply its ceiling.
 *
 * `memory.swap.max = 0` is deliberate and load-bearing: swap is the box-wide
 * `CommitLimit` cushion (ADR-002 §6 — 6 concurrent sessions on 7.6 GB works ONLY
 * because swap lifted CommitLimit to ~13.8 GB), not per-run headroom. A run that
 * would swap should die inside its ceiling instead of dragging the whole box
 * toward the fork/posix_spawn ENOMEM that takes worker, engine and Postgres
 * together.
 *
 * NOTHING here is handed to the agent. An earlier shape chowned `cgroup.procs`
 * to the agent uid so the wrapper could join the cgroup itself; that is both
 * impossible (an unprivileged user cannot give a file away to another uid —
 * EPERM) and unnecessary. Measured on the box from the worker's OWN delegated
 * subtree, which is production's shape:
 *
 *   worker moves its own same-uid child ................. OK
 *   worker moves an AGENT-uid child (spawned via sudo) .. OK
 *   agent moves ITSELF in, even with cgroup.procs 0666 .. refused
 *
 * cgroup v2 delegation requires write on the destination's `cgroup.procs` AND on
 * the common ancestor's, and the agent owns neither. The worker owns both. So the
 * worker performs the move, and every file in the cgroup stays worker-owned —
 * which is also why the agent cannot raise its own limit.
 */
export function createRunCgroup(opts: {
  root: string;
  threadId: string;
  memoryMaxBytes: number;
  tasksMax: number;
  fsi?: CgroupFs;
}): string {
  const { root, threadId, memoryMaxBytes, tasksMax } = opts;
  const io = opts.fsi ?? defaultFs;
  const dir = runCgroupPath(root, threadId);

  io.mkdir(dir);
  io.write(path.join(dir, "memory.max"), String(memoryMaxBytes));
  io.write(path.join(dir, "memory.swap.max"), "0");
  io.write(path.join(dir, "pids.max"), String(tasksMax));

  return dir;
}

/**
 * Put one process into this run's cgroup. Performed by the WORKER, which is the
 * only party permitted to — see createRunCgroup's note for the measurements.
 *
 * Called with the wrapper's own pid (the one it recorded for the pgid contract),
 * AFTER it has been recorded and BEFORE the wrapper execs the agent. The pid
 * survives `exec`, so the agent runs inside the ceiling from its first
 * instruction rather than being moved mid-flight.
 *
 * Throws on failure. A run whose cgroup membership did not land would execute
 * with NO ceiling while every log line says one was applied, and that silent
 * downgrade is the failure this whole ticket exists to prevent.
 */
export function moveIntoCgroup(opts: {
  cgroupDir: string;
  pid: number;
  fsi?: CgroupFs;
}): void {
  const io = opts.fsi ?? defaultFs;
  io.write(path.join(opts.cgroupDir, "cgroup.procs"), String(opts.pid));
}

/**
 * Did the kernel OOM-kill anything in this cgroup?
 *
 * This is why `memory.events` is read instead of inferring from exit 137: every
 * SIGKILL looks like 137, INCLUDING our own teardown kill. Without the counter a
 * superseded run would be mislabelled `resource-limit`, which is exactly the kind
 * of wrong-cause report #204 exists to remove.
 *
 * Returns 0 when the file is unreadable — the cgroup may already be gone, and a
 * missing counter must never be read as "yes, OOM".
 */
export function readOomKillCount(opts: {
  cgroupDir: string;
  fsi?: CgroupFs;
}): number {
  const io = opts.fsi ?? defaultFs;
  let raw: string;
  try {
    raw = io.read(path.join(opts.cgroupDir, "memory.events"));
  } catch {
    return 0;
  }
  for (const line of raw.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === "oom_kill") {
      const n = Number(value);
      return Number.isInteger(n) && n >= 0 ? n : 0;
    }
  }
  return 0;
}

/**
 * Kill everything in this run's cgroup, then remove it.
 *
 * `cgroup.kill` is a single kernel-side write that kills every member with no
 * pid races and no reachability into any sibling — which is what #205 needs when
 * the uid-wide `kill -9 -- -1` stops being safe at N > 1.
 *
 * Best-effort throughout: a teardown that throws would fail a run whose work is
 * already done. `rmdir` fails while members remain, so the kill precedes it.
 */
export function killAndRemoveRunCgroup(opts: {
  cgroupDir: string;
  fsi?: CgroupFs;
  log?: (message: string) => void;
}): void {
  const io = opts.fsi ?? defaultFs;
  const log = opts.log ?? (() => {});
  try {
    io.write(path.join(opts.cgroupDir, "cgroup.kill"), "1");
  } catch (e) {
    log(
      `cgroup.kill failed for ${opts.cgroupDir}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // `cgroup.kill` returns as soon as the signals are queued; the kernel still has
  // to reap them, and `rmdir` fails EBUSY while any member remains. Observed on
  // the first production run — the kill worked, the rmdir lost the race, and the
  // directory stayed behind. A few short retries turn a guaranteed leak into a
  // rare one, without blocking teardown on a process that refuses to die.
  let removed = false;
  for (let attempt = 0; attempt < 10 && !removed; attempt++) {
    try {
      io.rmdir(opts.cgroupDir);
      removed = true;
    } catch {
      io.sleep?.(50);
    }
  }
  if (removed) {
    return;
  }
  try {
    io.rmdir(opts.cgroupDir);
  } catch (e) {
    // A surviving member or a slow kill leaves the directory. Residue is cheap,
    // a failed teardown is not — and the leftover is not permanent: the boot
    // sweep in prepareDelegatedRoot rmdirs stale `run-*` dirs on the next start.
    log(
      `rmdir failed for ${opts.cgroupDir}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
