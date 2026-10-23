import { readFileSync } from "node:fs";

import { parseMeminfo, readProcMeminfo } from "./headroom";

/**
 * #205/#372 boot-time checks of the counting box budget against THIS box,
 * kept out of hello/worker.ts so they are unit-testable (that module runs
 * main() on import). Since ADR-013 each slot's run is a container bounded by
 * its own `--memory` (no swap), so the budget is N × that ceiling plus the
 * box's base load.
 */

/**
 * #205: a loud line when N × per-run ceiling exceeds the box's RAM. Not a
 * refusal — #371's headroom check bounds the SUM at admission and #372's tuple
 * validation decides what to refuse — but an operator who set N = 3 with a
 * 5000M ceiling on a 7.6 GB box should read it at boot, not after the ENOMEM.
 */
export function warnIfSlotsExceedMemory(
  cfg: { boxSlots: number; memoryMaxBytes: number },
  readMeminfo: () => string = () => readFileSync("/proc/meminfo", "utf8"),
  log: (line: string) => void = (l) => console.warn(l),
): void {
  if (cfg.boxSlots <= 1 || cfg.memoryMaxBytes <= 0) {
    return;
  }
  const memTotalBytes = readMemTotalBytes(readMeminfo);
  if (memTotalBytes === null) {
    return;
  }
  const need = cfg.boxSlots * cfg.memoryMaxBytes;
  if (need > memTotalBytes) {
    log(
      `[worker-boot] WARNING: WORKER_BOX_SLOTS=${cfg.boxSlots} × WORKER_RUN_MEMORY_MAX=${cfg.memoryMaxBytes} = ${need} bytes exceeds MemTotal ${memTotalBytes}; runs cannot swap (--memory-swap = --memory). With the memory-headroom check armed (#371) a second concurrent run is DEFERRED — expect box.headroom_rejected / box.headroom_deferred_wait lines and, past the budget, budget-exhausted failures; with the check OFF (inert rollback) concurrent runs can hit ENOMEM under load`,
    );
  }
}

/**
 * #372: the base load every box carries beside its runs (worker, engine
 * container, Postgres, sshd — measured 2.4–3.5 GB idle on the pilot). The
 * FLOOR of that range, deliberately: this is the operator's typo guard for the
 * tuple, not the admission decision — #371's boot-load WARNING reports the
 * Committed_AS actually observed, and its admission uses the live figure.
 */
export const BOX_BASE_COMMIT_BYTES = 2 * 1024 ** 3;

/**
 * #372: the operator's typo guard for the memory side of the tuple, in the
 * SAME terms the #371 headroom check admits by: N runs' expected commit
 * (`WORKER_HEADROOM_RUN_COMMIT`, = the ceiling by default) plus the box's base
 * load must fit `WORKER_HEADROOM_COMMIT_FRACTION × CommitLimit` (swap +
 * overcommit_ratio × RAM), or N full runs could never be admitted together —
 * the headroom check would defer every run past the first until it failed
 * (observed: #371's drill on the cx33 deferred every second 5000M run). With
 * the commit arm inert (fraction ≥ 1 — the documented rollback, or the arm
 * alone) the guard is skipped under the SAME condition evaluateHeadroom skips
 * the arm: nothing would defer, and the kernel does not enforce CommitLimit. Refuses
 * (throws, naming the knobs) on Linux with the ceiling on; a box without the
 * ceiling or /proc/meminfo is not this check's business (N > 1 already
 * requires both). `warnIfSlotsExceedMemory` stays the softer RAM warning
 * beside it: swap can absorb N × ceiling > MemTotal, nothing absorbs the
 * commit budget.
 */
export function assertSlotsFitCommitLimit(
  cfg: {
    boxSlots: number;
    memoryMaxBytes: number;
    headroomRunCommitBytes: number;
    headroomCommitFraction: number;
  },
  opts: {
    platform?: NodeJS.Platform;
    readMeminfo?: () => string;
    baseBytes?: number;
  } = {},
): void {
  const {
    platform = process.platform,
    readMeminfo = readProcMeminfo,
    baseBytes = BOX_BASE_COMMIT_BYTES,
  } = opts;
  // N = 1 is #371's business (assessHeadroomSupport refuses a run commit the
  // box can never admit); this guard is the N-run SUM the ticket's AC names.
  if (platform !== "linux" || cfg.memoryMaxBytes <= 0 || cfg.boxSlots <= 1) {
    return;
  }
  // With the commit arm inert (fraction ≥ 1 — evaluateHeadroom skips it, and
  // the documented rollback sets it so) nothing defers on commit and the
  // kernel does not enforce CommitLimit either (vm.overcommit_memory 0): this
  // guard has nothing to guard. Same condition as the runtime arm, exactly.
  if (cfg.headroomCommitFraction >= 1) return;
  let commitLimit: number;
  try {
    ({ commitLimit } = parseMeminfo(readMeminfo()));
  } catch (e) {
    // The boot label for this guard says "slots do not fit"; an unreadable
    // kernel file is a different problem and must read as one.
    throw new Error(
      `/proc/meminfo could not be read, so the WORKER_BOX_SLOTS × run-commit tuple cannot be checked against this box (${e instanceof Error ? e.message : String(e)}) — this is NOT a sizing problem: fix the /proc mount or the file read first`,
    );
  }
  const fraction = cfg.headroomCommitFraction;
  const budget = fraction * commitLimit;
  const need = cfg.boxSlots * cfg.headroomRunCommitBytes + baseBytes;
  if (need > budget) {
    throw new Error(
      `WORKER_BOX_SLOTS=${cfg.boxSlots} × run commit ${cfg.headroomRunCommitBytes} (WORKER_HEADROOM_RUN_COMMIT, = WORKER_RUN_MEMORY_MAX by default) + ${baseBytes} base = ${need} bytes exceeds ${fraction} × CommitLimit ${commitLimit} = ${Math.floor(budget)} (the memory-headroom budget; CommitLimit = swap + overcommit_ratio × RAM): ${cfg.boxSlots} full runs could never be admitted together — the headroom check would defer every run past the first until it failed. Lower WORKER_BOX_SLOTS (and WORKER_GLOBAL_MAX_RUNS with it) or the run commit, raise vm.overcommit_ratio or add swap, or resize the box.`,
    );
  }
}

/** `MemTotal` from /proc/meminfo text in bytes; null when unreadable or absent. */
function readMemTotalBytes(read: () => string): number | null {
  try {
    const m = /^MemTotal:\s+(\d+)\s+kB/m.exec(read());
    return m?.[1] ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}
