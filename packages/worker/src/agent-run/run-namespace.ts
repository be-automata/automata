import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyRunNamespaceAces, type AceExec } from "./agent-uid-fs";

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

export function runSocketPath(
  root: string,
  workerId: string,
  threadId: string,
): string {
  return path.join(
    workerRunDir(root, workerId),
    `${sanitizeThreadId(threadId)}.sock`,
  );
}

/**
 * The gh credential broker's unix socket (#81). Lives beside the daemon socket
 * under the worker's namespaced dir — root defaults to /tmp precisely so these
 * stay under the sun_path limit (the broker asserts the length; macOS bind
 * silently truncates over-long paths rather than erroring).
 */
export function runGhSocketPath(
  root: string,
  workerId: string,
  threadId: string,
): string {
  return path.join(
    workerRunDir(root, workerId),
    `${sanitizeThreadId(threadId)}-gh.sock`,
  );
}

export function runPidPath(
  root: string,
  workerId: string,
  threadId: string,
): string {
  return path.join(
    workerRunDir(root, workerId),
    `${sanitizeThreadId(threadId)}.pid`,
  );
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
  workerLogin?: string;
  exec?: AceExec;
  platform?: NodeJS.Platform;
}): Promise<string> {
  const { root, workerId, agentUser } = opts;
  const dir = workerRunDir(root, workerId);
  fs.mkdirSync(dir, { recursive: true });
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
