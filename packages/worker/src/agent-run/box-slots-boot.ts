import { readFileSync } from "node:fs";

/**
 * #205 boot-time helpers for the counting box budget, kept out of
 * hello/worker.ts so they are unit-testable (that module runs main() on import).
 */

/**
 * #205: every slot account must resolve to a uid. `id -u <name>` exits non-zero
 * for an unknown account; the names were validated as plain logins by
 * loadWorkerConfig, so nothing here reaches `id` unvalidated.
 */
export async function assertSlotAccountsExist(
  users: string[],
  exec: (file: string, args: string[]) => Promise<unknown>,
): Promise<void> {
  for (const user of users) {
    try {
      await exec("/usr/bin/id", ["-u", user]);
    } catch (e) {
      throw new Error(
        `slot account ${JSON.stringify(user)} does not exist on this box (id -u failed: ${
          e instanceof Error ? e.message : String(e)
        }); provision it (deploy/AGENT-UID-PROVISIONING.md) or lower WORKER_BOX_SLOTS`,
      );
    }
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
  let memTotalBytes: number | null = null;
  try {
    const m = /^MemTotal:\s+(\d+)\s+kB/m.exec(readMeminfo());
    memTotalBytes = m?.[1] ? Number(m[1]) * 1024 : null;
  } catch {
    memTotalBytes = null;
  }
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
