import { randomUUID } from "node:crypto";
import path from "node:path";

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
 * DaemonProcess.start() puts an inheritable ACE for BOTH accounts on
 * `<root>/<workerId>/` and a traverse-only ACE on `<root>` itself. Neither the
 * daemon's bind nor the gh broker needs to know: bind(2)-created sockets inherit.
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
