import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The box's ONE agent-run slot, enforced on the worker plane (#125 C4).
 *
 * WHY: the engine-side "global" concurrency key
 * (`'agent-run-global-memory-budget'`, definition.ts) is scoped PER WORKFLOW in
 * Hatchet v1 — proven by #128's E2E against hatchet-lite v0.94.10: a run on
 * `agent-run-strict` started 193ms into a live `agent-run-newest` run. With the
 * four variants registered, the engine alone would let up to four agent-runs
 * execute at once on a box budgeted for one (the ENOMEM wall the cap exists
 * for). This lock is the box-level belt to the engine's per-workflow
 * suspenders: every run acquires it before provisioning and releases it in
 * its finally, across BOTH worker processes on the box (shared directory).
 *
 * Mechanism: an atomic `mkdir` of `<dir>/slot` is the lock; `owner.json`
 * inside carries the holder's pid + a heartbeat. A waiter reclaims a slot
 * whose owner pid is dead or whose heartbeat is older than `staleMs` (a
 * SIGKILLed worker never releases). Waiting honours the run's AbortSignal so
 * an engine cancel while queued here still tears down promptly.
 */

export type BoxSlot = { release: () => Promise<void> };

type Owner = { pid: number; holder: string; heartbeatAt: number };

const HEARTBEAT_MS = 10_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(slotDir: string): Promise<Owner | null> {
  try {
    return JSON.parse(
      await readFile(path.join(slotDir, "owner.json"), "utf8"),
    ) as Owner;
  } catch {
    return null;
  }
}

export async function acquireBoxSlot({
  dir,
  holder,
  signal,
  pollMs = 1000,
  staleMs = 45_000,
  now = () => Date.now(),
}: {
  dir: string;
  holder: string;
  signal?: AbortSignal;
  pollMs?: number;
  staleMs?: number;
  now?: () => number;
}): Promise<BoxSlot> {
  await mkdir(dir, { recursive: true });
  const slotDir = path.join(dir, "slot");
  for (;;) {
    if (signal?.aborted) {
      const err = new Error("box slot wait aborted");
      err.name = "AbortError";
      throw err;
    }
    try {
      await mkdir(slotDir);
      // Acquired — but a cancel can land in the same instant the previous
      // holder released. Never run a cancelled run's body: give it back.
      if (signal?.aborted) {
        await rm(slotDir, { recursive: true, force: true });
        const err = new Error("box slot wait aborted");
        err.name = "AbortError";
        throw err;
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    // Held by someone: reclaim only a dead or silent owner.
    const owner = await readOwner(slotDir);
    const stale =
      owner === null ||
      !pidAlive(owner.pid) ||
      now() - owner.heartbeatAt > staleMs;
    if (stale) {
      await rm(slotDir, { recursive: true, force: true });
      continue;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const ownerFile = path.join(slotDir, "owner.json");
  const beat = () =>
    writeFile(
      ownerFile,
      JSON.stringify({
        pid: process.pid,
        holder,
        heartbeatAt: now(),
      } satisfies Owner),
      "utf8",
    );
  await beat();
  const timer = setInterval(() => void beat().catch(() => {}), HEARTBEAT_MS);
  timer.unref?.();
  return {
    async release() {
      clearInterval(timer);
      await rm(slotDir, { recursive: true, force: true });
    },
  };
}

/** Run `fn` holding the box slot; releases on return, throw, or abort. */
export async function withBoxSlot<T>(
  opts: Parameters<typeof acquireBoxSlot>[0],
  fn: () => Promise<T>,
): Promise<T> {
  const slot = await acquireBoxSlot(opts);
  try {
    return await fn();
  } finally {
    await slot.release();
  }
}
