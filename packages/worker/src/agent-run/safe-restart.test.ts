import { describe, expect, it } from "vitest";

import { drainForRestart, type DrainEngine } from "./safe-restart";

const NAME = "automata-worker-box-1";

interface FakeWorker {
  id: string;
  name: string;
  status: string;
  used: number;
  limit: number;
  paused: boolean;
}

/**
 * An engine whose busy slots follow a script: `usedByTick[i]` is what the
 * worker reports on the i-th read after the pause.
 */
function fakeEngine(
  workers: FakeWorker[],
  opts: {
    usedByTick?: number[];
    failListAt?: number;
    failPause?: boolean;
    omitSlots?: boolean;
  } = {},
) {
  let reads = 0;
  const calls: string[] = [];
  const engine: DrainEngine = {
    async listWorkers() {
      if (opts.failListAt === reads) throw new Error("engine down");
      const tick = reads++ - 1;
      if (opts.usedByTick && tick >= 0) {
        const used =
          opts.usedByTick[Math.min(tick, opts.usedByTick.length - 1)];
        for (const w of workers) if (w.paused) w.used = used ?? 0;
      }
      return {
        rows: workers.map((w) => ({
          metadata: { id: w.id },
          name: w.name,
          status: w.paused && w.status === "ACTIVE" ? "PAUSED" : w.status,
          ...(opts.omitSlots
            ? {}
            : {
                slotConfig: {
                  default: { available: w.limit - w.used, limit: w.limit },
                },
              }),
        })),
      };
    },
    async setPaused(id, paused) {
      if (opts.failPause && paused) throw new Error("403");
      calls.push(`${paused ? "pause" : "unpause"} ${id}`);
      const w = workers.find((x) => x.id === id);
      if (w) w.paused = paused;
    },
  };
  return { engine, calls };
}

function run(engine: DrainEngine, timeoutMs = 60_000, signal?: AbortSignal) {
  let t = 0;
  const log: string[] = [];
  return drainForRestart({
    engine,
    workerName: NAME,
    timeoutMs,
    pollMs: 5_000,
    log: (m) => log.push(m),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    signal,
  }).then((result) => ({ result, log }));
}

const worker = (over: Partial<FakeWorker> = {}): FakeWorker => ({
  id: "w-live",
  name: NAME,
  status: "ACTIVE",
  used: 0,
  limit: 3,
  paused: false,
  ...over,
});

describe("drainForRestart", () => {
  it("pauses the live worker and reports drained once every slot is free, leaving it paused for the restart", async () => {
    const w = worker({ used: 2 });
    const { engine, calls } = fakeEngine(
      [w, worker({ id: "w-old", status: "INACTIVE" })],
      { usedByTick: [2, 1, 0] },
    );
    const { result } = await run(engine);
    expect(result).toEqual({
      kind: "drained",
      workerIds: ["w-live"],
      waitedMs: 10_000,
    });
    expect(calls).toEqual(["pause w-live"]);
    expect(w.paused).toBe(true);
  });

  it("counts a run waiting on memory headroom: a held slot is busy, whatever the run is doing", async () => {
    const { engine } = fakeEngine([worker({ used: 1 })], {
      usedByTick: [1, 1, 1, 0],
    });
    const { result } = await run(engine);
    expect(result.kind).toBe("drained");
    expect(result.kind === "drained" && result.waitedMs).toBe(15_000);
  });

  it("never reports drained for a worker that still holds a run at the deadline: it is unpaused and left running", async () => {
    const w = worker({ used: 1 });
    const { engine, calls } = fakeEngine([w], { usedByTick: [1] });
    const { result } = await run(engine, 20_000);
    expect(result).toEqual({
      kind: "timeout",
      workerIds: ["w-live"],
      busySlots: 1,
    });
    expect(calls).toEqual(["pause w-live", "unpause w-live"]);
    expect(w.paused).toBe(false);
  });

  it("an abort (Ctrl-C) unpauses the worker", async () => {
    const w = worker({ used: 1 });
    const { engine, calls } = fakeEngine([w], { usedByTick: [1] });
    const ac = new AbortController();
    ac.abort();
    const { result } = await run(engine, 60_000, ac.signal);
    expect(result.kind).toBe("timeout");
    expect(calls).toEqual(["pause w-live", "unpause w-live"]);
  });

  it("no active worker under this name: nothing to interrupt, nothing paused", async () => {
    const { engine, calls } = fakeEngine([
      worker({ status: "INACTIVE" }),
      worker({ id: "w-other", name: "automata-worker-box-2" }),
    ]);
    const { result } = await run(engine);
    expect(result).toEqual({ kind: "no-worker" });
    expect(calls).toEqual([]);
  });

  it("only this box's worker is paused, never another box's", async () => {
    const other = worker({ id: "w-other", name: "automata-worker-box-2" });
    const { engine, calls } = fakeEngine([worker(), other]);
    const { result } = await run(engine);
    expect(result.kind).toBe("drained");
    expect(calls).toEqual(["pause w-live"]);
    expect(other.paused).toBe(false);
  });

  it("a worker that went INACTIVE mid-drain holds nothing (the engine took its runs back)", async () => {
    const w = worker({ used: 1 });
    const { engine } = fakeEngine([w], { usedByTick: [1] });
    const list = engine.listWorkers.bind(engine);
    let n = 0;
    engine.listWorkers = async () => {
      const v = (await list()) as { rows: Array<{ status: string }> };
      if (++n > 2) for (const r of v.rows) r.status = "INACTIVE";
      return v;
    };
    const { result } = await run(engine);
    expect(result.kind).toBe("drained");
  });

  it("fails CLOSED when the engine stops answering mid-drain: unreadable, worker unpaused", async () => {
    const w = worker({ used: 1 });
    const { engine, calls } = fakeEngine([w], {
      usedByTick: [1],
      failListAt: 2,
    });
    const { result } = await run(engine);
    expect(result.kind).toBe("unreadable");
    expect(calls).toEqual(["pause w-live", "unpause w-live"]);
  });

  it("fails CLOSED when the engine reports no slot usage: never assumes idle", async () => {
    const { engine, calls } = fakeEngine([worker()], { omitSlots: true });
    const { result } = await run(engine);
    expect(result.kind).toBe("unreadable");
    expect(calls).toEqual(["pause w-live", "unpause w-live"]);
  });

  it("a refused pause is unreadable and pauses nothing", async () => {
    const { engine, calls } = fakeEngine([worker()], { failPause: true });
    const { result } = await run(engine);
    expect(result.kind).toBe("unreadable");
    expect(calls).toEqual([]);
  });
});
