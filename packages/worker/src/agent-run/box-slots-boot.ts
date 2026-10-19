import { readFileSync } from "node:fs";

import { resolveUidViaId } from "./uid-reaper";

/**
 * #205 boot-time helpers for the counting box budget, kept out of
 * hello/worker.ts so they are unit-testable (that module runs main() on import).
 */

/**
 * #205: every slot account must resolve to a uid — checked in parallel through
 * the reaper's bounded `id -u` (2 s, SIGKILL), so a hung NSS lookup cannot wedge
 * boot. The names were validated as plain logins by loadWorkerConfig.
 */
export async function assertSlotAccountsExist(
  users: string[],
  resolveUid: (user: string) => Promise<number> = resolveUidViaId,
): Promise<void> {
  const results = await Promise.allSettled(users.map((u) => resolveUid(u)));
  const missing = results.flatMap((r, i) =>
    r.status === "rejected"
      ? [
          `${JSON.stringify(users[i])} (${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          })`,
        ]
      : [],
  );
  if (missing.length > 0) {
    throw new Error(
      `slot account(s) ${missing.join(", ")} do not exist on this box; provision them (deploy/AGENT-UID-PROVISIONING.md §6) or lower WORKER_BOX_SLOTS`,
    );
  }
}

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
      `[worker-boot] WARNING: WORKER_BOX_SLOTS=${cfg.boxSlots} × WORKER_RUN_MEMORY_MAX=${cfg.memoryMaxBytes} = ${need} bytes exceeds MemTotal ${memTotalBytes}; runs cannot swap (memory.swap.max=0), so the headroom check (#371) will defer admissions under load`,
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
