import { describe, expect, it, vi } from "vitest";

import {
  evaluateLiveness,
  formatWedgedLine,
  isWorkerList,
  LIVENESS_PROBE_TIMEOUT_CAP_MS,
  probeEngineLiveness,
  resolveProbeWorkerName,
  startEngineLivenessWatchdog,
  type EngineLivenessProbeConfig,
  type LivenessReading,
} from "./engine-liveness";

const STALE_AFTER_MS = 900_000; // 900s, the recommended threshold
const POLL_MS = 60_000;

const PROBE_CONFIG: EngineLivenessProbeConfig = {
  apiUrl: "https://engine.example.com/",
  tenantId: "tenant-1",
  token: "real-token",
  probeWorkerName: "automata-worker-b1",
  timeoutMs: LIVENESS_PROBE_TIMEOUT_CAP_MS,
};

/** A fetch stub returning one canned JSON body with the given status. */
function fetchJson(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

/**
 * A driver harness with an injected clock and an onWedged spy. No real timers: the
 * interval is created under fake timers and discarded, so only explicit `tick()` calls
 * ever run. The probe is handed the clock so a test can mint a heartbeat relative to it.
 */
function harness(opts: {
  probe: (now: () => number) => Promise<LivenessReading>;
  staleAfterMs?: number;
  nowMs?: number;
}) {
  let clock = opts.nowMs ?? Date.parse("2026-09-29T19:00:00.000Z");
  const now = () => clock;
  const onWedged = vi.fn();
  const log = vi.fn();
  vi.useFakeTimers();
  const handle = startEngineLivenessWatchdog({
    staleAfterMs: opts.staleAfterMs ?? STALE_AFTER_MS,
    pollIntervalMs: POLL_MS,
    probeWorkerName: "automata-worker-b1",
    probe: () => opts.probe(now),
    now,
    onWedged,
    log,
  });
  vi.useRealTimers();
  return {
    handle,
    onWedged,
    log,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("resolveProbeWorkerName", () => {
  it("is the raw name when no namespace is configured", () => {
    expect(resolveProbeWorkerName("automata-worker-box", undefined)).toBe(
      "automata-worker-box",
    );
  });

  it("prefixes the already-normalised namespace", () => {
    expect(resolveProbeWorkerName("automata-worker-box", "ns_")).toBe(
      "ns_automata-worker-box",
    );
  });
});

describe("isWorkerList", () => {
  it("accepts an envelope with no rows (rows is optional in the contract)", () => {
    expect(isWorkerList({})).toBe(true);
    expect(isWorkerList({ pagination: {} })).toBe(true);
  });

  it("accepts rows as an array", () => {
    expect(isWorkerList({ rows: [] })).toBe(true);
  });

  it("rejects non-objects and a non-array rows", () => {
    expect(isWorkerList(null)).toBe(false);
    expect(isWorkerList("nope")).toBe(false);
    expect(isWorkerList({ rows: "nope" })).toBe(false);
  });
});

describe("evaluateLiveness", () => {
  it("passes an unreadable reading straight through", () => {
    expect(
      evaluateLiveness({ kind: "unreadable", reason: "http 500" }, 0, 1000),
    ).toEqual({ kind: "unreadable", reason: "http 500" });
  });

  it("is healthy inside the threshold and at exactly the threshold", () => {
    expect(
      evaluateLiveness(
        { kind: "reading", lastHeartbeatAtMs: 0 },
        900_000,
        900_000,
      ),
    ).toEqual({ kind: "healthy", stalenessMs: 900_000 });
  });

  it("is wedged past the threshold", () => {
    expect(
      evaluateLiveness(
        { kind: "reading", lastHeartbeatAtMs: 0 },
        900_001,
        900_000,
      ),
    ).toEqual({ kind: "wedged", stalenessMs: 900_001 });
  });

  it("clamps a negative staleness (engine clock ahead of the box) to healthy", () => {
    expect(
      evaluateLiveness(
        { kind: "reading", lastHeartbeatAtMs: 5_000 },
        0,
        900_000,
      ),
    ).toEqual({ kind: "healthy", stalenessMs: 0 });
  });
});

describe("probeEngineLiveness", () => {
  it("calls the tenant worker COLLECTION route with a bearer token", async () => {
    const fetchImpl = fetchJson({ rows: [] });
    await probeEngineLiveness(PROBE_CONFIG, fetchImpl);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(call[0]).toBe(
      "https://engine.example.com/api/v1/tenants/tenant-1/worker",
    );
    expect((call[1] as RequestInit).headers).toEqual({
      Authorization: "Bearer real-token",
    });
  });

  it("reads the matching row's lastHeartbeatAt", async () => {
    const hb = "2026-09-29T19:19:05.000Z";
    const reading = await probeEngineLiveness(
      PROBE_CONFIG,
      fetchJson({
        rows: [
          { name: "someone-else", lastHeartbeatAt: "2026-09-29T19:30:00.000Z" },
          { name: "automata-worker-b1", lastHeartbeatAt: hb },
        ],
      }),
    );
    expect(reading).toEqual({
      kind: "reading",
      lastHeartbeatAtMs: Date.parse(hb),
    });
  });

  it("takes the GREATEST heartbeat among same-named rows (stale duplicate after a relaunch)", async () => {
    const fresh = "2026-09-29T19:40:00.000Z";
    const reading = await probeEngineLiveness(
      PROBE_CONFIG,
      fetchJson({
        rows: [
          {
            name: "automata-worker-b1",
            lastHeartbeatAt: "2026-09-29T19:00:00.000Z",
          },
          { name: "automata-worker-b1", lastHeartbeatAt: fresh },
        ],
      }),
    );
    expect(reading).toEqual({
      kind: "reading",
      lastHeartbeatAtMs: Date.parse(fresh),
    });
  });

  it("never puts the token in the unreadable reason", async () => {
    const reading = await probeEngineLiveness(
      PROBE_CONFIG,
      vi.fn(async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:8888");
      }) as unknown as typeof fetch,
    );
    expect(reading.kind).toBe("unreadable");
    expect(JSON.stringify(reading)).not.toContain("real-token");
  });
});

/** Every shape the engine can hand back that must read "unreadable". */
const UNREADABLE_CASES: Array<{ name: string; fetchImpl: typeof fetch }> = [
  {
    name: "fetch rejects",
    fetchImpl: vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
  },
  { name: "http 500", fetchImpl: fetchJson({ rows: [] }, 500) },
  { name: "http 401", fetchImpl: fetchJson({ rows: [] }, 401) },
  {
    name: "non-JSON body",
    fetchImpl: vi.fn(
      async () => new Response("<html>nope</html>", { status: 200 }),
    ) as unknown as typeof fetch,
  },
  { name: "empty envelope {}", fetchImpl: fetchJson({}) },
  { name: "rows is not an array", fetchImpl: fetchJson({ rows: "nope" }) },
  { name: "rows is empty", fetchImpl: fetchJson({ rows: [] }) },
  {
    name: "no row with this worker's name",
    fetchImpl: fetchJson({
      rows: [{ name: "other", lastHeartbeatAt: "2026-09-29T19:00:00.000Z" }],
    }),
  },
  {
    name: "lastHeartbeatAt absent (optional in the contract)",
    fetchImpl: fetchJson({ rows: [{ name: "automata-worker-b1" }] }),
  },
  {
    name: "lastHeartbeatAt unparseable",
    fetchImpl: fetchJson({
      rows: [{ name: "automata-worker-b1", lastHeartbeatAt: "not-a-date" }],
    }),
  },
  {
    name: "a row that is not an object",
    fetchImpl: fetchJson({ rows: [null, 42] }),
  },
];

describe("unreadable → never an exit (D-6)", () => {
  for (const testCase of UNREADABLE_CASES) {
    it(`${testCase.name}: unreadable for 40 ticks across 2400s, no exit`, async () => {
      const probe = () => probeEngineLiveness(PROBE_CONFIG, testCase.fetchImpl);
      const h = harness({ probe });
      for (let i = 0; i < 40; i += 1) {
        const verdict = await h.handle.tick();
        expect(verdict.kind).toBe("unreadable");
        h.advance(POLL_MS);
      }
      expect(h.onWedged).not.toHaveBeenCalled();
      // One line per contiguous streak, not one per tick.
      expect(h.log).toHaveBeenCalledTimes(1);
      h.handle.stop();
    });
  }
});

describe("startEngineLivenessWatchdog", () => {
  it("stale → calls onWedged exactly once with the exact operator-visible line", async () => {
    const nowMs = Date.parse("2026-09-29T20:00:00.000Z");
    const probe = vi.fn(
      async (): Promise<LivenessReading> => ({
        kind: "reading",
        lastHeartbeatAtMs: nowMs - 2_400_000, // 2400s stale
      }),
    );
    const h = harness({ probe, nowMs });
    const verdict = await h.handle.tick();
    expect(verdict).toEqual({ kind: "wedged", stalenessMs: 2_400_000 });
    expect(h.onWedged).toHaveBeenCalledTimes(1);
    const message = h.onWedged.mock.calls[0]![0] as string;
    expect(message).toContain(
      "no successful engine interaction for 2400s (threshold 900s)",
    );
    expect(message).toContain("exiting non-zero");
    expect(message).toBe(
      formatWedgedLine(2_400_000, STALE_AFTER_MS, "automata-worker-b1"),
    );

    // The `fired` latch: more wedged ticks never re-enter onWedged.
    await h.handle.tick();
    await h.handle.tick();
    expect(h.onWedged).toHaveBeenCalledTimes(1);
    h.handle.stop();
  });

  it("fresh heartbeat → no exit across a simulated window longer than the threshold", async () => {
    const h = harness({
      probe: async (now) => ({ kind: "reading", lastHeartbeatAtMs: now() }),
    });
    for (let i = 0; i < 40; i += 1) {
      // 40 × 60s = 2400s > the 900s threshold.
      expect((await h.handle.tick()).kind).toBe("healthy");
      h.advance(POLL_MS);
    }
    expect(h.onWedged).not.toHaveBeenCalled();
    h.handle.stop();
  });

  it("idle but healthy → no exit (an idle worker is not a wedged worker)", async () => {
    // A real engine row for a worker that has taken no work: slots unused, no recent
    // step runs — but the heartbeat is fresh, which is the only field that decides.
    let heartbeat = Date.parse("2026-09-29T19:00:00.000Z");
    const h = harness({
      nowMs: heartbeat,
      probe: () =>
        probeEngineLiveness(
          PROBE_CONFIG,
          fetchJson({
            rows: [
              {
                name: "automata-worker-b1",
                lastHeartbeatAt: new Date(heartbeat).toISOString(),
                maxRuns: 1,
                availableRuns: 1,
                recentStepRuns: [],
              },
            ],
          }),
        ),
    });
    for (let i = 0; i < 40; i += 1) {
      expect((await h.handle.tick()).kind).toBe("healthy");
      h.advance(POLL_MS);
      heartbeat += POLL_MS;
    }
    expect(h.onWedged).not.toHaveBeenCalled();
    h.handle.stop();
  });

  it("a rejected probe becomes unreadable; tick never throws", async () => {
    const h = harness({
      probe: async () => {
        throw new Error("boom");
      },
    });
    const verdict = await h.handle.tick();
    expect(verdict.kind).toBe("unreadable");
    expect(h.onWedged).not.toHaveBeenCalled();
    h.handle.stop();
  });

  it("logs a new unreadable line only when the streak restarts", async () => {
    let readable = false;
    const h = harness({
      probe: async (now): Promise<LivenessReading> =>
        readable
          ? { kind: "reading", lastHeartbeatAtMs: now() }
          : { kind: "unreadable", reason: "http 500" },
    });
    await h.handle.tick();
    await h.handle.tick();
    expect(h.log).toHaveBeenCalledTimes(1);
    readable = true;
    await h.handle.tick();
    readable = false;
    await h.handle.tick();
    expect(h.log).toHaveBeenCalledTimes(2);
    h.handle.stop();
  });

  it("drives tick() directly with a frozen clock — no Date.now, no process.exit", async () => {
    // The driver reads time only through the injected `now` and exits only through the
    // injected `onWedged` (D-9). Freezing the clock at a value that makes the SAME
    // reading wedged proves the verdict came from the injection, not from the wall clock.
    const frozen = 10_000_000;
    const probe = vi.fn(
      async (): Promise<LivenessReading> => ({
        kind: "reading",
        lastHeartbeatAtMs: frozen - 1_000_000,
      }),
    );
    const onWedged = vi.fn();
    const handle = startEngineLivenessWatchdog({
      staleAfterMs: STALE_AFTER_MS,
      pollIntervalMs: POLL_MS,
      probeWorkerName: "automata-worker-b1",
      probe,
      now: () => frozen,
      onWedged,
    });
    handle.stop();
    const verdict = await handle.tick();
    expect(verdict).toEqual({ kind: "wedged", stalenessMs: 1_000_000 });
    expect(onWedged).toHaveBeenCalledTimes(1);
  });

  it("inert when unconfigured: staleAfterMs 0 → no probe, no exit, stop() is safe", async () => {
    const probe = vi.fn(
      async (): Promise<LivenessReading> => ({
        kind: "reading",
        lastHeartbeatAtMs: 0,
      }),
    );
    const onWedged = vi.fn();
    const handle = startEngineLivenessWatchdog({
      staleAfterMs: 0,
      pollIntervalMs: POLL_MS,
      probeWorkerName: "automata-worker-b1",
      probe,
      now: () => 0,
      onWedged,
    });
    await handle.tick();
    expect(probe).not.toHaveBeenCalled();
    expect(onWedged).not.toHaveBeenCalled();
    handle.stop();
    handle.stop();
  });
});

describe("namespaced probe matches the engine's row (FACT 2)", () => {
  const ROWS = {
    rows: [
      {
        name: "ns_automata-worker-b1",
        lastHeartbeatAt: "2026-09-29T19:19:05.000Z",
      },
    ],
  };
  const NOW = Date.parse("2026-09-29T20:00:00.000Z"); // 2455s stale

  it("the namespaced name reads the row and the verdict is wedged", async () => {
    const name = resolveProbeWorkerName("automata-worker-b1", "ns_");
    expect(name).toBe("ns_automata-worker-b1");
    const reading = await probeEngineLiveness(
      { ...PROBE_CONFIG, probeWorkerName: name },
      fetchJson(ROWS),
    );
    expect(evaluateLiveness(reading, NOW, STALE_AFTER_MS).kind).toBe("wedged");
  });

  it("NEGATIVE CONTROL: the RAW name finds no row → unreadable forever, the silent-inert bug", async () => {
    const reading = await probeEngineLiveness(
      { ...PROBE_CONFIG, probeWorkerName: "automata-worker-b1" },
      fetchJson(ROWS),
    );
    expect(reading.kind).toBe("unreadable");
    // The difference is the whole point: same rows, same clock, opposite verdicts — a box
    // probing under the raw name would look guarded and never exit.
    expect(evaluateLiveness(reading, NOW, STALE_AFTER_MS).kind).toBe(
      "unreadable",
    );
  });
});
