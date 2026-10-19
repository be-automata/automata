import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyRunNamespaceAces,
  applySlotDirAces,
  applySlotLayoutAces,
  type AceExec,
} from "./agent-uid-fs";
import { assertSlotIndex } from "./box-lock";
import { BOX_SLOTS_MAX } from "./slot-limits";
import { agentUserForSlot } from "./spawn-as-user";

/**
 * Per-run resource namespacing for the execution-plane worker (enterprise-hardening
 * Phase 0.2b). Each worker process owns a directory
 *   <root>/<workerId>/
 * holding a boot lock-file `worker.lock` (the worker's own pid) plus, per in-flight
 * run, `<threadId>.sock` (the daemon's unix socket) and `<threadId>.pid` (the
 * daemon's process-group pid). Namespacing by workerId lets ≥2 workers coexist on
 * ONE box: a worker only ever reaps orphans under a SIBLING workerId whose lock pid
 * is dead — never a live worker's daemons (the rogue-daemon guard, preserved).
 *
 * Root default is /tmp (like the daemon's own defaultUnixSocketPath) to keep unix
 * socket paths well under the ~104-char sun_path limit.
 *
 * CROSS-UID RENDEZVOUS (#108). Under WORKER_AGENT_USER these dirs stop being a
 * single-uid scratch space: the DAEMON (agent uid) binds `<threadId>.sock` and
 * writes `<threadId>.pid` here, while the WORKER (operator uid) connects to that
 * socket and reads that pid, and the agent's `gh` connects to the worker-created
 * `<threadId>-gh.sock`. Darwin enforces unix-socket permissions, so
 * ensureRunNamespace() puts an inheritable ACE for BOTH accounts on
 * `<root>/<workerId>/` and a traverse-only ACE on `<root>` itself. Neither the
 * daemon's bind nor the gh broker needs to know: bind(2)-created sockets inherit
 * — PROVIDED the ACE predates the bind, which is why it must run before the gh
 * broker binds (it binds before DaemonProcess.start() does).
 *
 * THE GRANT IS RE-ASSERTED PER RUN, NOT ONLY AT BOOT. It used to run once, at
 * boot, on the reasoning above — correct about ordering, and silently wrong about
 * lifetime. The default root is under /tmp, and macOS's periodic cleaner reaps
 * /tmp entries untouched for three days. Observed in production 2026-09-28: a
 * worker up since Sep 6 served a run whose namespace dir was BORN Sep 28,
 * recreated bare by the run itself long after the boot-time grant was applied to
 * a directory that no longer existed. The daemon then could not write its pidfile
 * —
 *
 *   automata-daemon: /tmp/.../<threadId>.pid: Permission denied
 *
 * — resolvePgid() threw, and the run died about a second after starting. It
 * surfaces to the user as "Review intent could not be parsed", because the agent
 * never produced any output to parse. Every review on an idle box was failing
 * this way, silently, with the cause three layers from the symptom.
 *
 * Re-asserting costs two `chmod +a` calls per run and closes the whole class:
 * a reaped /tmp, a manual rm, anything that removes the dir under a live worker.
 * `chmod +a` is idempotent (verified on macOS 15: re-adding an identical ACE
 * exits 0 and leaves one entry), so the steady-state cost is the two calls and
 * nothing else.
 */

export const DEFAULT_RUN_NAMESPACE_ROOT = "/tmp/automata-agent-run";

export const WORKER_LOCK_FILENAME = "worker.lock";

let cachedWorkerId: string | undefined;

/**
 * A stable id for THIS worker process, memoised for the process lifetime. Both the
 * boot code (worker.ts, which writes the lock + runs reclaim) and every DaemonProcess
 * in this process resolve the same id, so all of a worker's runs land under one dir.
 * Includes the pid for human-readability; the uuid suffix guarantees uniqueness even
 * if a pid is recycled across worker restarts.
 */
export function getProcessWorkerId(): string {
  if (!cachedWorkerId) {
    cachedWorkerId = `w-${process.pid}-${randomUUID().slice(0, 8)}`;
  }
  return cachedWorkerId;
}

/** Filename-safe threadId (threadIds are already `thr_<nanoid>`; defensive only). */
function sanitizeThreadId(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function workerRunDir(root: string, workerId: string): string {
  return path.join(root, workerId);
}

export function workerLockPath(root: string, workerId: string): string {
  return path.join(workerRunDir(root, workerId), WORKER_LOCK_FILENAME);
}

/**
 * #205: the directory one run's artefacts live in. Flat (`<root>/<workerId>`,
 * today's layout) when `slot` is undefined — the N = 1 box; `<root>/<workerId>/s<i>`
 * when the box runs several slots.
 *
 * WHY A SUBDIR PER SLOT. The daemon socket accepts a run-starting message from
 * ANY client that can connect (packages/daemon/src/runtime.ts has no caller
 * authentication), and connect(2) on a unix socket is a permission check on the
 * socket file. One shared dir with an inheritable grant per slot account would
 * let slot i's agent open slot j's daemon socket and inject a message into a
 * run holding another org's credentials. So each slot gets its own dir, granted
 * to that slot's account alone (plus the worker), and the shared worker dir
 * hands the slot accounts traverse only.
 */
export function slotRunDir(
  root: string,
  workerId: string,
  slot?: number,
): string {
  const dir = workerRunDir(root, workerId);
  if (slot === undefined) {
    return dir;
  }
  assertSlotIndex(slot, "slotRunDir");
  return path.join(dir, `s${slot}`);
}

/** The slot-subdir name pattern reclaim scans for (`s0`, `s1`, …). */
const SLOT_DIR_RE = /^s(0|[1-9]\d?)$/;

/**
 * #205: the slot index a dir name denotes, or null when the name is not one
 * the worker itself would have created: `s<i>` with i a plain integer below
 * BOX_SLOTS_MAX. The ONE parser for slot dir names. At N = 1 the agent account
 * holds an inheritable grant on the shared worker dir, so an agent CAN drop a
 * dir there; a name like `s` + 400 digits or `s99` must read as "not a slot",
 * never reach assertSlotIndex, and never fail an admission or a boot.
 */
export function slotIndexOfDir(name: string): number | null {
  const m = SLOT_DIR_RE.exec(name);
  if (!m) return null;
  const slot = Number(m[1]);
  return slot < BOX_SLOTS_MAX ? slot : null;
}

/**
 * #205: the agent account that owns a per-run pidfile, from WHERE it lives:
 * `<workerDir>/s<i>/x.pid` ⇒ slot i's account; the flat layout (or any dir
 * that is not a slot dir) ⇒ the base account. The layout IS the record —
 * nothing else has to be written per run, and a reclaim after a crash reads
 * only the path it already found. Throws only for a slot whose account name
 * would exceed the login limit (assertAgentUser); reclaim treats that as
 * "skip this file".
 */
export function accountForPidFile(pidFile: string, baseUser: string): string {
  const slot = slotIndexOfDir(path.basename(path.dirname(pidFile)));
  return slot === null ? baseUser : agentUserForSlot(baseUser, slot);
}

export function runSocketPath(
  root: string,
  workerId: string,
  threadId: string,
  slot?: number,
): string {
  return path.join(
    slotRunDir(root, workerId, slot),
    `${sanitizeThreadId(threadId)}.sock`,
  );
}

/**
 * The gh credential broker's unix socket (#81). Lives beside the daemon socket
 * under the worker's namespaced dir — root defaults to /tmp precisely so these
 * stay under the sun_path limit (the broker asserts the length; macOS bind
 * silently truncates over-long paths rather than erroring).
 *
 * Any unix socket bound in this dir for another uid must be chmod 0660 right
 * after listen, or the Linux ACL mask voids the grant (gh-broker.ts, runtime.ts).
 */
export function runGhSocketPath(
  root: string,
  workerId: string,
  threadId: string,
  slot?: number,
): string {
  return path.join(
    slotRunDir(root, workerId, slot),
    `${sanitizeThreadId(threadId)}-gh.sock`,
  );
}

export function runPidPath(
  root: string,
  workerId: string,
  threadId: string,
  slot?: number,
): string {
  return path.join(
    slotRunDir(root, workerId, slot),
    `${sanitizeThreadId(threadId)}.pid`,
  );
}

/**
 * #205: which slot subdir (if any) a run's artefacts use, from the run's config.
 * `undefined` = the flat layout — always at N = 1. At N > 1 a config without the
 * per-run `boxSlot` override is a programming error: writing into the shared dir
 * would silently re-open the cross-slot socket reach the subdir exists to close.
 */
export function slotFor(config: {
  boxSlots: number;
  boxSlot?: number;
}): number | undefined {
  if (config.boxSlots <= 1) {
    return undefined;
  }
  if (config.boxSlot === undefined) {
    throw new Error(
      `invariant violated: WORKER_BOX_SLOTS=${config.boxSlots} but this run's config carries no boxSlot — the slot acquire must set it before any per-run path is built`,
    );
  }
  return config.boxSlot;
}

/**
 * Make this worker's namespaced run dir exist and carry the #108 cross-uid
 * grants. Idempotent, and safe to call before every run — see the module header
 * for why calling it only at boot was a production failure.
 *
 * ORDER IS LOAD-BEARING. The ACEs must be on the dir BEFORE anything is created
 * inside it, because macOS applies inheritance at create time. Every later
 * artefact — the worker lock, each run's daemon socket, each run's gh-broker
 * socket, each run's pidfile — inherits from that point on. Applying the grant
 * inside DaemonProcess.start() is too late: workflow.ts binds the gh-broker
 * socket first, so call this at admission, before any broker comes up.
 *
 * Returns the dir. Throws if the dir cannot be created or an ACE cannot be
 * applied — a run whose namespace is ungranted will stall on an unreachable
 * socket or die on an unwritable pidfile, and failing here names the cause.
 */
export async function ensureRunNamespace(opts: {
  root: string;
  workerId: string;
  /** Empty (the default) ⇒ no ACL is touched at all. */
  agentUser: string;
  /**
   * #205: every slot's account, when the box runs more than one slot. The
   * worker dir is then SHARED by all slots and hands each slot account
   * TRAVERSE only; the inheritable grant goes on each slot's own `s<i>/`
   * subdir (ensureSlotNamespace), where that slot's socket, pidfile and
   * gh-broker socket live. Omitted ⇒ `[agentUser]`, exactly as before.
   */
  agentUsers?: string[];
  workerLogin?: string;
  exec?: AceExec;
  platform?: NodeJS.Platform;
}): Promise<string> {
  const { root, workerId, agentUser } = opts;
  const dir = workerRunDir(root, workerId);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.agentUsers && opts.agentUsers.length > 1) {
    // N > 1: the shared worker dir hands every slot account TRAVERSE only. The
    // inheritable grant goes on each slot's own subdir (ensureSlotNamespace), so
    // a slot's daemon socket is never connectable by a sibling slot.
    await applySlotLayoutAces({
      root,
      runDir: dir,
      agentUsers: opts.agentUsers,
      exec: opts.exec,
      platform: opts.platform,
    });
    return dir;
  }
  await applyRunNamespaceAces({
    root,
    runDir: dir,
    agentUser,
    workerLogin: opts.workerLogin ?? os.userInfo().username,
    exec: opts.exec,
    platform: opts.platform,
  });
  return dir;
}

/**
 * #205: make one slot's subdir exist and carry its grant — the slot account and
 * the worker login, inheritable, after any inherited extended ACL has been
 * stripped (`setfacl -b`), so the subdir carries exactly those two entries
 * whatever the parent dir accumulated. Idempotent; called at every admission of
 * a run on that slot, before the slot's gh-broker socket binds there. Returns
 * the subdir.
 */
export async function ensureSlotNamespace(opts: {
  root: string;
  workerId: string;
  slot: number;
  /** The slot's own account. */
  agentUser: string;
  workerLogin?: string;
  exec?: AceExec;
  platform?: NodeJS.Platform;
}): Promise<string> {
  const dir = slotRunDir(opts.root, opts.workerId, opts.slot);
  // 0750: a sibling slot (another account) may not even LIST this slot's
  // pidfiles and records; the grant below opens it to exactly two accounts.
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  await applySlotDirAces({
    dir,
    agentUser: opts.agentUser,
    workerLogin: opts.workerLogin ?? os.userInfo().username,
    exec: opts.exec,
    platform: opts.platform,
  });
  return dir;
}

/**
 * Boot-time claim: ensure the namespace, then stake this worker's lock in it.
 *
 * The lock write is what makes the dir a CLAIM rather than just a grant — a
 * sibling worker reaps orphans under a workerId whose lock pid is dead, so it
 * must exist before any run does. Only boot calls this; every run re-asserts
 * the grant alone via ensureRunNamespace().
 */
export async function claimRunNamespace(opts: {
  root: string;
  workerId: string;
  /** Empty (the default) ⇒ no ACL is touched at all. */
  agentUser: string;
  /** #205: every slot's account (see ensureRunNamespace). */
  agentUsers?: string[];
  workerLogin?: string;
  exec?: AceExec;
  platform?: NodeJS.Platform;
}): Promise<string> {
  const dir = await ensureRunNamespace(opts);
  fs.writeFileSync(
    workerLockPath(opts.root, opts.workerId),
    String(process.pid),
  );
  return dir;
}
