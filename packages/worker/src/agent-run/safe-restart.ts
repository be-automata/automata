/**
 * Drain this box's worker BEFORE a restart, so a planned restart never
 * interrupts a run (#386 follow-up).
 *
 * `systemctl restart` SIGTERMs the worker and the SDK drains in-flight runs —
 * but it stops the engine heartbeat first, so a drain that outlasts the
 * engine's heartbeat window gets the run REASSIGNED and handed to another
 * worker (measured: 29 s into a drain on the live box, 2026-10-22). On one box
 * the run-terminal ledger catches the redelivery, because the relaunched
 * process only starts after the drain ended. On two boxes the other box gets
 * the run WHILE this one is still running it, and nothing recorded at the end
 * of a run can stop that.
 *
 * So the restart never SIGTERMs a busy worker: pause it in the engine (the same
 * flag the SDK's own exit sets, minus the signal — no new assignments, runs in
 * flight keep going and keep heartbeating), wait until every slot is free
 * (a run waiting on memory headroom still holds its slot), and only then
 * restart. The relaunched process registers a NEW worker row, unpaused. A drain
 * that does not finish in time unpauses the worker again and leaves it running.
 */

/** What the drain reads and writes on the engine. */
export interface DrainEngine {
  /** The tenant's worker collection (`GET /api/v1/tenants/{tenant}/worker`). */
  listWorkers(): Promise<unknown>;
  setPaused(workerId: string, paused: boolean): Promise<void>;
}

export type DrainResult =
  /** Every target worker is paused with all slots free: restart now. */
  | { kind: "drained"; workerIds: string[]; waitedMs: number }
  /**
   * No ACTIVE worker under this name. NOT proof the box is idle: a name that
   * does not match the running process (namespace, WORKER_BOX_ID) or a worker
   * still registering after a restart reads the same, so callers fail closed.
   */
  | { kind: "no-worker" }
  /** Still busy at the deadline; the workers were unpaused again. */
  | { kind: "timeout"; workerIds: string[]; busySlots: number }
  /** The engine could not be read; any paused worker was unpaused again. */
  | { kind: "unreadable"; reason: string };

interface WorkerRow {
  id: string;
  name: string;
  status: string;
  slotConfig: Record<string, { available: number; limit: number }> | null;
}

function toWorkerRows(value: unknown): WorkerRow[] | null {
  if (typeof value !== "object" || value === null) return null;
  const rows = (value as { rows?: unknown }).rows ?? [];
  if (!Array.isArray(rows)) return null;
  const out: WorkerRow[] = [];
  for (const r of rows as unknown[]) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const id = (o.metadata as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || typeof o.name !== "string") continue;
    let slotConfig: WorkerRow["slotConfig"] = null;
    if (typeof o.slotConfig === "object" && o.slotConfig !== null) {
      slotConfig = {};
      for (const [k, v] of Object.entries(o.slotConfig)) {
        const s = v as { available?: unknown; limit?: unknown };
        if (typeof s?.available !== "number" || typeof s?.limit !== "number") {
          slotConfig = null;
          break;
        }
        slotConfig[k] = { available: s.available, limit: s.limit };
      }
    }
    out.push({
      id,
      name: o.name,
      status: typeof o.status === "string" ? o.status : "",
      slotConfig,
    });
  }
  return out;
}

/**
 * Slots still held by `row`'s runs, or null when the engine did not say. A row
 * that went INACTIVE holds nothing: the engine has already taken its runs back.
 */
function busySlots(row: WorkerRow | undefined): number | null {
  if (!row || row.status === "INACTIVE") return 0;
  if (!row.slotConfig) return null;
  return Object.values(row.slotConfig).reduce(
    (n, s) => n + Math.max(0, s.limit - s.available),
    0,
  );
}

export async function drainForRestart(opts: {
  engine: DrainEngine;
  /** The name the engine knows this box's worker by (namespace applied). */
  workerName: string;
  timeoutMs: number;
  pollMs: number;
  log: (msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Aborts the wait (SIGINT): the workers are unpaused and the result is `timeout`. */
  signal?: AbortSignal;
}): Promise<DrainResult> {
  const { engine, workerName, timeoutMs, pollMs, log, signal } = opts;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const read = async (): Promise<WorkerRow[] | null> => {
    try {
      return toWorkerRows(await engine.listWorkers());
    } catch (err) {
      log(
        `drain: worker list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };
  const unpause = async (ids: string[]): Promise<void> => {
    for (const id of ids) {
      try {
        await engine.setPaused(id, false);
        log(`drain: unpaused worker ${id}`);
      } catch (err) {
        log(
          `drain: could not unpause worker ${id}: ${err instanceof Error ? err.message : String(err)} — restart the worker to recover`,
        );
      }
    }
  };

  const initial = await read();
  if (!initial) return { kind: "unreadable", reason: "worker list unreadable" };
  const targets = initial
    .filter((w) => w.name === workerName && w.status !== "INACTIVE")
    .map((w) => w.id);
  if (targets.length === 0) {
    log(`drain: no active worker named ${workerName} — nothing to drain`);
    return { kind: "no-worker" };
  }

  const paused: string[] = [];
  for (const id of targets) {
    try {
      await engine.setPaused(id, true);
      paused.push(id);
      log(`drain: paused worker ${id} (no new assignments)`);
    } catch (err) {
      await unpause(paused);
      return {
        kind: "unreadable",
        reason: `pause ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const startedAt = now();
  let lastBusy = -1;
  for (;;) {
    const rows = await read();
    if (!rows) {
      await unpause(paused);
      return { kind: "unreadable", reason: "worker list unreadable mid-drain" };
    }
    let busy = 0;
    for (const id of paused) {
      const n = busySlots(rows.find((r) => r.id === id));
      if (n === null) {
        await unpause(paused);
        return {
          kind: "unreadable",
          reason: `worker ${id} reports no slot usage`,
        };
      }
      busy += n;
    }
    if (busy === 0) {
      return {
        kind: "drained",
        workerIds: paused,
        waitedMs: now() - startedAt,
      };
    }
    if (busy !== lastBusy) {
      log(`drain: waiting for ${busy} run(s) to finish`);
      lastBusy = busy;
    }
    if (signal?.aborted || now() - startedAt >= timeoutMs) {
      await unpause(paused);
      return { kind: "timeout", workerIds: paused, busySlots: busy };
    }
    await sleep(pollMs);
  }
}

/**
 * The drain script's exit code: 0 restart now; 3 still busy (or interrupted),
 * worker unpaused; 4 not proven idle — engine unreadable, or no worker under
 * this name while the unit runs (unless the operator allows it explicitly).
 */
export function drainExitCode(
  result: DrainResult,
  allowNoWorker: boolean,
): number {
  switch (result.kind) {
    case "drained":
      return 0;
    case "no-worker":
      return allowNoWorker ? 0 : 4;
    case "timeout":
      return 3;
    case "unreadable":
      return 4;
  }
}
