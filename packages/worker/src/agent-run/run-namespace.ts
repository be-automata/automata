import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertSlotIndex } from "./box-lock";
import { BOX_SLOTS_MAX } from "./slot-limits";

/**
 * Per-run resource namespacing for the execution-plane worker (enterprise-hardening
 * Phase 0.2b). Each worker process owns a directory
 *   <root>/<workerId>/
 * holding a boot lock-file `worker.lock` (the worker's own pid) plus, per in-flight
 * run, the gh credential broker's `<threadId>-gh.sock` (#81), which the run's
 * container reaches through a forwarded socket in its own run dir (ADR-013).
 * Namespacing by workerId lets ≥2 workers coexist on ONE box: a worker only
 * ever removes the dir of a SIBLING workerId whose lock pid is dead — never a
 * live worker's.
 *
 * Root default is /tmp to keep unix socket paths well under the ~104-char
 * sun_path limit.
 *
 * THE DIR IS RE-CREATED PER RUN, NOT ONLY AT BOOT. The default root is under
 * /tmp, and a periodic tmp cleaner can reap entries untouched for days; a run
 * that found its namespace dir gone would fail to bind its gh broker socket.
 * ensureRunNamespace is idempotent and runs at every admission.
 */

export const DEFAULT_RUN_NAMESPACE_ROOT = "/tmp/automata-agent-run";

export const WORKER_LOCK_FILENAME = "worker.lock";

let cachedWorkerId: string | undefined;

/**
 * A stable id for THIS worker process, memoised for the process lifetime. Both the
 * boot code (worker.ts, which writes the lock + runs reclaim) and every run in this
 * process resolve the same id, so all of a worker's runs land under one dir (and
 * every run container is labelled with it, ADR-013 Run path 7).
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
 * A subdir per slot keeps two concurrent runs' per-run artefacts apart by
 * construction; no run container mounts this tree (each gets only its own
 * forwarded sockets, ADR-013 I2).
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
 * BOX_SLOTS_MAX. The ONE parser for slot dir names: a name like `s` + 400
 * digits or `s99` reads as "not a slot", never reaches assertSlotIndex, and
 * never fails a boot.
 */
export function slotIndexOfDir(name: string): number | null {
  const m = SLOT_DIR_RE.exec(name);
  if (!m) return null;
  const slot = Number(m[1]);
  return slot < BOX_SLOTS_MAX ? slot : null;
}

/**
 * The gh credential broker's unix socket (#81), under the worker's namespaced
 * dir — root defaults to /tmp precisely so it stays under the sun_path limit
 * (the broker asserts the length; macOS bind silently truncates over-long
 * paths rather than erroring). The run's container reaches it through a
 * forwarded socket in its own run dir, never by this path.
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
 * Make this worker's namespaced run dir exist. Idempotent, and called before
 * every run — see the module header for why boot alone is not enough.
 */
export async function ensureRunNamespace(opts: {
  root: string;
  workerId: string;
}): Promise<string> {
  const dir = workerRunDir(opts.root, opts.workerId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * #205: make one slot's subdir exist (0750: worker-private). Idempotent;
 * called at every admission of a run on that slot, before the slot's gh broker
 * socket binds there. Returns the subdir.
 */
export async function ensureSlotNamespace(opts: {
  root: string;
  workerId: string;
  slot: number;
}): Promise<string> {
  const dir = slotRunDir(opts.root, opts.workerId, opts.slot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  return dir;
}

/**
 * Boot-time claim: ensure the namespace, then stake this worker's lock in it.
 *
 * The lock write is what makes the dir a CLAIM — a sibling worker removes the
 * dir of a workerId whose lock pid is dead, so it must exist before any run
 * does. Only boot calls this; every run re-creates the dir alone via
 * ensureRunNamespace().
 */
export async function claimRunNamespace(opts: {
  root: string;
  workerId: string;
}): Promise<string> {
  const dir = await ensureRunNamespace(opts);
  fs.writeFileSync(
    workerLockPath(opts.root, opts.workerId),
    String(process.pid),
  );
  return dir;
}
