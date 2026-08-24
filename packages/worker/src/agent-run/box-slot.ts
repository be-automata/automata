import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
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
 * suspenders: every run acquires it before its credentials touch disk and
 * releases it in its finally, across BOTH worker processes on the box (shared
 * directory). Worker `slots: 1` bounds how many runs can wait here.
 *
 * Mechanism: the holder writes `owner.json` {pid, holder, heartbeatAt} into a
 * private temp dir and atomically RENAMES it to `<dir>/slot` — the slot never
 * exists without its owner file, so a waiter can never mistake a fresh holder
 * for a stale one. A waiter reclaims a slot whose owner pid is dead or whose
 * heartbeat is older than `staleMs` (a SIGKILLed worker never releases).
 * `release()` removes the slot ONLY if the owner file is still ours, so a
 * holder that was reclaimed (heartbeat stalled) can never free someone else's
 * lock. Waiting honours the run's AbortSignal, including in the instant after
 * a successful claim, so an engine cancel while queued here never runs a body.
 */

export type BoxSlot = { release: () => Promise<void> };

type Owner = {
  pid: number;
  holder: string;
  nonce: string;
  heartbeatAt: number;
};

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

function abortError(): Error {
  const err = new Error("box slot wait aborted");
  err.name = "AbortError";
  return err;
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
  const nonce = randomBytes(8).toString("hex");
  const owner = (): Owner => ({
    pid: process.pid,
    holder,
    nonce,
    heartbeatAt: now(),
  });
  for (;;) {
    if (signal?.aborted) throw abortError();
    // Build the claim privately, then publish it atomically.
    const claim = path.join(dir, `.claim-${process.pid}-${nonce}`);
    await mkdir(claim, { recursive: true });
    await writeFile(path.join(claim, "owner.json"), JSON.stringify(owner()));
    try {
      await rename(claim, slotDir);
      if (signal?.aborted) {
        // A cancel can land in the instant the previous holder released:
        // never run a cancelled run's body — give the slot straight back.
        await rm(slotDir, { recursive: true, force: true });
        throw abortError();
      }
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EISDIR") {
        await rm(claim, { recursive: true, force: true });
        throw e;
      }
      await rm(claim, { recursive: true, force: true });
    }
    // Held by someone: reclaim only a dead or silent owner. A slot without
    // an owner file cannot be a fresh holder (claims are published whole),
    // so it is debris from a crash mid-release — reclaim it too.
    const current = await readOwner(slotDir);
    const stale =
      current === null ||
      !pidAlive(current.pid) ||
      now() - current.heartbeatAt > staleMs;
    if (stale) {
      await rm(slotDir, { recursive: true, force: true });
      continue;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const ownerFile = path.join(slotDir, "owner.json");
  const beat = () => writeFile(ownerFile, JSON.stringify(owner()), "utf8");
  const timer = setInterval(() => void beat().catch(() => {}), HEARTBEAT_MS);
  timer.unref?.();
  return {
    async release() {
      clearInterval(timer);
      // Only free a slot that is still OURS: a holder reclaimed after a
      // heartbeat stall must not remove the new holder's lock.
      const current = await readOwner(slotDir);
      if (current && current.nonce !== nonce) return;
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
