import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  armGrowthTriggers,
  GROWTH_RUNS_MAX_PAGES,
  GROWTH_RUNS_PAGE_LIMIT,
  GROWTH_SNAPSHOT_FILENAME,
  GROWTH_SNAPSHOT_MODE,
  postWebhook,
  readMemSample,
  readRunWindow,
  type GrowthTriggerDeps,
  type WriteSnapshot,
} from "./growth-triggers-io";
import {
  buildWebhookBody,
  DAY_MS,
  growthWindow,
  type GrowthSnapshot,
  type GrowthWebhookBody,
} from "./growth-triggers";
import { writeSnapshotAtomic } from "./scheduling-maintenance";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const API_URL = "http://engine.test:8888";
const TENANT = "tenant-1";
const TOKEN = "tok-SECRET-engine-token";
const WEBHOOK_URL = "https://hooks.example.test/services/T000/B000/SECRETPATH";
const BOX_ID = "box-a";
const SNAPSHOT_DIR = "/run/automata";

/** Every engine URL any test requested — asserted to be the collection route only. */
const ENGINE_URLS: string[] = [];
/** Every log line any arm test captured — asserted never to carry a secret. */
const LOG_LINES: string[] = [];

const COLLECTION_ROUTE =
  /^http:\/\/engine\.test:8888\/api\/v1\/stable\/tenants\/tenant-1\/workflow-runs\?since=[^&]+&limit=200&offset=\d+&only_tasks=true$/;

afterEach(() => {
  for (const url of ENGINE_URLS) expect(url).toMatch(COLLECTION_ROUTE);
  for (const line of LOG_LINES) {
    expect(line).not.toContain(WEBHOOK_URL);
    expect(line).not.toContain("SECRETPATH");
    expect(line).not.toContain(TOKEN);
  }
  ENGINE_URLS.length = 0;
  LOG_LINES.length = 0;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RowOpts {
  day?: number;
  waitS?: number;
  runS?: number;
  status?: string;
  orgId?: string;
  actionId?: string;
  /** Engine run id (`metadata.id`); absent → the row has no id. */
  id?: string;
}

/** A raw engine row inside the 7-complete-day window of NOW. */
function rawRow(opts: RowOpts = {}): Record<string, unknown> {
  const start = growthWindow(NOW).startMs;
  const created = start + (opts.day ?? 0) * DAY_MS + 3_600_000;
  const started = created + (opts.waitS ?? 10) * 1000;
  const finished = started + (opts.runS ?? 60) * 1000;
  return {
    actionId: opts.actionId ?? "agent-run:run",
    status: opts.status ?? "COMPLETED",
    createdAt: new Date(created).toISOString(),
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    additionalMetadata: opts.orgId ? { orgId: opts.orgId } : {},
    ...(opts.id !== undefined ? { metadata: { id: opts.id } } : {}),
  };
}

function page(
  rows: unknown[],
  current: number,
  next: number | null,
): Record<string, unknown> {
  return {
    pagination: { current_page: current, next_page: next, num_pages: 99 },
    rows,
  };
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

// ---------------------------------------------------------------------------
// readRunWindow
// ---------------------------------------------------------------------------

describe("readRunWindow", () => {
  const base = {
    apiUrl: API_URL,
    tenantId: TENANT,
    token: TOKEN,
    sinceMs: growthWindow(NOW).startMs,
    deadlineMs: NOW + 60_000,
    now: () => NOW,
  };

  function engineFetch(
    respond: (offset: number) => Response | Promise<Response>,
  ): ReturnType<typeof vi.fn> {
    return vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = urlOf(input);
        ENGINE_URLS.push(url);
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${TOKEN}`,
        );
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const offset = Number(new URL(url).searchParams.get("offset"));
        return respond(offset);
      },
    );
  }

  it("paginates across 3 pages and stops on the short last page", async () => {
    const full = Array.from({ length: GROWTH_RUNS_PAGE_LIMIT }, () => rawRow());
    const last = [
      ...Array.from({ length: 49 }, () => rawRow()),
      rawRow({ actionId: "agent-run:on-failure-task" }),
    ];
    const fetchImpl = engineFetch((offset) => {
      if (offset === 0) return jsonResponse(page(full, 1, 2));
      if (offset === 200) return jsonResponse(page(full, 2, 3));
      return jsonResponse(page(last, 3, null));
    });
    const r = await readRunWindow({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("rows");
    if (r.kind === "rows") expect(r.rows).toHaveLength(449); // on-failure row dropped
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const offsets = ENGINE_URLS.map((u) =>
      new URL(u).searchParams.get("offset"),
    );
    expect(offsets).toEqual(["0", "200", "400"]);
    expect(new URL(ENGINE_URLS[0] ?? "").searchParams.get("since")).toBe(
      new Date(base.sinceMs).toISOString(),
    );
  });

  it("stops on a full page whose next_page is missing or not past current_page", async () => {
    const full = Array.from({ length: GROWTH_RUNS_PAGE_LIMIT }, () => rawRow());
    const fetchImpl = engineFetch(() => jsonResponse(page(full, 1, 1)));
    const r = await readRunWindow({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("rows");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const noPagination = engineFetch(() => jsonResponse({ rows: full }));
    const r2 = await readRunWindow({
      ...base,
      fetchImpl: noPagination as unknown as typeof fetch,
    });
    expect(r2.kind).toBe("rows");
    expect(noPagination).toHaveBeenCalledTimes(1);
  });

  it("hits the page cap → unreadable 'page cap'", async () => {
    const full = Array.from({ length: GROWTH_RUNS_PAGE_LIMIT }, () => rawRow());
    const fetchImpl = engineFetch((offset) => {
      const p = offset / GROWTH_RUNS_PAGE_LIMIT + 1;
      return jsonResponse(page(full, p, p + 1));
    });
    const r = await readRunWindow({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ kind: "unreadable", reason: "engine read: page cap" });
    expect(fetchImpl).toHaveBeenCalledTimes(GROWTH_RUNS_MAX_PAGES);
  });

  it.each([
    [
      "403",
      () => new Response("forbidden: tok-SECRET-engine-token", { status: 403 }),
      "engine read: http 403",
    ],
    [
      "non-JSON",
      () =>
        new Response("<html>tok-SECRET-engine-token</html>", { status: 200 }),
      "engine read: body is not JSON",
    ],
    [
      "shape mismatch",
      () => jsonResponse({ rows: "nope" }),
      "engine read: body does not match the workflow-runs list",
    ],
    [
      "throw",
      () => {
        throw new TypeError(`fetch failed for ${API_URL} with ${TOKEN}`);
      },
      "engine read: request failed (TypeError)",
    ],
  ])("%s → unreadable with a fixed phrase", async (_name, respond, reason) => {
    const fetchImpl = engineFetch(respond);
    const r = await readRunWindow({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ kind: "unreadable", reason });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("dedupes rows by id across pages; rows without an id are all kept", async () => {
    const full = Array.from({ length: GROWTH_RUNS_PAGE_LIMIT }, (_, i) =>
      rawRow({ id: `run-${i}` }),
    );
    // The collection grew between requests: run-199 shifted onto page 2.
    const second = [rawRow({ id: "run-199" }), rawRow(), rawRow()];
    const fetchImpl = engineFetch((offset) =>
      offset === 0
        ? jsonResponse(page(full, 1, 2))
        : jsonResponse(page(second, 2, null)),
    );
    const r = await readRunWindow({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("rows");
    if (r.kind !== "rows") return;
    expect(r.rows).toHaveLength(GROWTH_RUNS_PAGE_LIMIT + 2);
    expect(r.rows.filter((row) => row.id === "run-199")).toHaveLength(1);
    expect(r.rows.filter((row) => row.id === null)).toHaveLength(2);
  });

  it("an engine that never answers is abandoned at the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Ignores the abort signal entirely.
      const fetchImpl = engineFetch(() => new Promise<Response>(() => {}));
      const pending = readRunWindow({
        ...base,
        deadlineMs: NOW + 5_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({
        kind: "unreadable",
        reason: "engine read: tick deadline exceeded",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("past the deadline → unreadable without a request", async () => {
    const fetchImpl = engineFetch(() => jsonResponse(page([], 1, null)));
    const r = await readRunWindow({
      ...base,
      deadlineMs: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({
      kind: "unreadable",
      reason: "engine read: tick deadline exceeded",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// readMemSample
// ---------------------------------------------------------------------------

const MEMINFO_LOW =
  "MemTotal:       16000000 kB\nMemAvailable:   12000000 kB\n";
const VMSTAT = "pgpgin 1\npswpin 5\npswpout 7\n";

describe("readMemSample", () => {
  it("reads MemTotal/MemAvailable and pswpin", async () => {
    const readText = vi.fn(async (p: string) =>
      p === "/proc/meminfo" ? MEMINFO_LOW : VMSTAT,
    );
    const r = await readMemSample(readText, NOW);
    expect(r).toEqual({
      kind: "sample",
      sample: {
        atMs: NOW,
        memTotal: 16000000 * 1024,
        memAvailable: 12000000 * 1024,
        pswpin: 5,
      },
    });
  });

  it("unreadable /proc/meminfo → unreadable; malformed → unreadable", async () => {
    const r = await readMemSample(async () => {
      throw Object.assign(new Error("ENOENT /proc/meminfo"), { name: "Error" });
    }, NOW);
    expect(r).toEqual({
      kind: "unreadable",
      reason: "cannot read /proc/meminfo (Error)",
    });
    const r2 = await readMemSample(async () => "garbage", NOW);
    expect(r2.kind).toBe("unreadable");
  });

  it("unreadable /proc/vmstat → a sample with pswpin null", async () => {
    const r = await readMemSample(async (p) => {
      if (p === "/proc/vmstat") throw new Error("nope");
      return MEMINFO_LOW;
    }, NOW);
    expect(r.kind).toBe("sample");
    if (r.kind === "sample") expect(r.sample.pswpin).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// postWebhook
// ---------------------------------------------------------------------------

describe("postWebhook", () => {
  const body: GrowthWebhookBody = buildWebhookBody({
    evaluation: {
      trigger: "supersede_waste",
      verdict: "over",
      value: 0.5,
      threshold: 0.2,
      summary: "s",
    },
    boxId: BOX_ID,
    nowMs: NOW,
    state: "fired",
  });

  it("POSTs JSON and reports a 2xx as delivered", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const r = await postWebhook(
      WEBHOOK_URL,
      body,
      5000,
      fetchImpl as unknown as typeof fetch,
    );
    expect(r).toEqual({ delivered: true, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it("non-2xx, throw and timeout are not delivered and never echo the URL", async () => {
    const r1 = await postWebhook(
      WEBHOOK_URL,
      body,
      5000,
      (async () => new Response("x", { status: 500 })) as typeof fetch,
    );
    expect(r1).toEqual({ delivered: false, status: 500, reason: "non-2xx" });
    const r2 = await postWebhook(WEBHOOK_URL, body, 5000, (async () => {
      throw new TypeError(`Failed to parse URL from ${WEBHOOK_URL}`);
    }) as typeof fetch);
    expect(r2).toEqual({
      delivered: false,
      reason: "request failed (TypeError)",
    });
    const r3 = await postWebhook(WEBHOOK_URL, body, 5000, (async () => {
      throw new DOMException(`timed out ${WEBHOOK_URL}`, "TimeoutError");
    }) as typeof fetch);
    expect(r3).toEqual({ delivered: false, reason: "timeout" });
    for (const r of [r1, r2, r3]) {
      expect(JSON.stringify(r)).not.toContain("SECRETPATH");
    }
  });

  it("does not follow redirects: a 3xx or an opaque redirect is not delivered", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://elsewhere.test/" },
        }),
    );
    const r = await postWebhook(
      WEBHOOK_URL,
      body,
      5000,
      fetchImpl as unknown as typeof fetch,
    );
    expect(r).toEqual({
      delivered: false,
      status: 302,
      reason: "redirect not followed",
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.redirect).toBe("manual");

    const opaque = { type: "opaqueredirect", status: 0, ok: false };
    const r2 = await postWebhook(
      WEBHOOK_URL,
      body,
      5000,
      (async () => opaque as unknown as Response) as typeof fetch,
    );
    expect(r2).toEqual({ delivered: false, reason: "redirect not followed" });
  });
});

// ---------------------------------------------------------------------------
// armGrowthTriggers
// ---------------------------------------------------------------------------

const ENV_ON: NodeJS.ProcessEnv = {
  WORKER_ALERT_WEBHOOK_URL: WEBHOOK_URL,
  WORKER_GROWTH_TRIGGER_INTERVAL_S: "300",
};

interface Harness {
  deps: GrowthTriggerDeps;
  clock: { ms: number };
  posts: GrowthWebhookBody[];
  logs: string[];
  writes: Array<{
    dir: string;
    snapshot: GrowthSnapshot;
    filename: string;
    mode: number;
  }>;
  intervalFns: Array<() => void>;
  setEngine: (r: () => Response | Promise<Response>) => void;
  setWebhookStatus: (status: number) => void;
}

/** Engine rows that put supersede waste over (one CANCELLED run, all of the time). */
const WASTEFUL = [rawRow({ status: "CANCELLED", runS: 600 })];
const CLEAN = [rawRow({ status: "COMPLETED", runS: 600 })];

function harness(opts: { snapshotText?: string | null } = {}): Harness {
  const clock = { ms: NOW };
  const posts: GrowthWebhookBody[] = [];
  const logs: string[] = [];
  const writes: Harness["writes"] = [];
  const intervalFns: Array<() => void> = [];
  let engine: () => Response | Promise<Response> = () =>
    jsonResponse(page(WASTEFUL, 1, null));
  let webhookStatus = 200;

  const fetchImpl = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = urlOf(input);
      if (url === WEBHOOK_URL) {
        posts.push(JSON.parse(String(init?.body)) as GrowthWebhookBody);
        return new Response("", { status: webhookStatus });
      }
      ENGINE_URLS.push(url);
      return engine();
    },
  );
  const writeSnapshot: WriteSnapshot = (dir, snapshot, { filename, mode }) => {
    writes.push({ dir, snapshot: structuredClone(snapshot), filename, mode });
  };

  const deps: GrowthTriggerDeps = {
    resolveEngine: vi.fn(() => ({
      apiUrl: API_URL,
      tenantId: TENANT,
      token: TOKEN,
    })),
    boxId: BOX_ID,
    snapshotDir: SNAPSHOT_DIR,
    now: vi.fn(() => clock.ms),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    readText: vi.fn(async (p: string) =>
      p === "/proc/meminfo" ? MEMINFO_LOW : VMSTAT,
    ),
    writeSnapshot: vi.fn(writeSnapshot),
    readSnapshot: vi.fn(() => opts.snapshotText ?? null),
    setInterval: vi.fn((fn: () => void) => {
      intervalFns.push(fn);
      return "handle-1";
    }),
    clearInterval: vi.fn(),
    log: vi.fn((line: string) => {
      logs.push(line);
      LOG_LINES.push(line);
    }),
  };
  return {
    deps,
    clock,
    posts,
    logs,
    writes,
    intervalFns,
    setEngine: (r) => {
      engine = r;
    },
    setWebhookStatus: (s) => {
      webhookStatus = s;
    },
  };
}

describe("armGrowthTriggers", () => {
  it("webhook unset → null, and NO dep is touched (AC 1)", () => {
    const h = harness();
    expect(armGrowthTriggers({}, h.deps)).toBeNull();
    expect(
      armGrowthTriggers({ WORKER_ALERT_WEBHOOK_URL: "  " }, h.deps),
    ).toBeNull();
    for (const [name, dep] of Object.entries(h.deps)) {
      if (typeof dep === "function") {
        expect(vi.mocked(dep), name).not.toHaveBeenCalled();
      }
    }
  });

  it("arms an interval at intervalS and stop() clears it", async () => {
    const h = harness();
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    expect(handle).not.toBeNull();
    expect(h.deps.setInterval).toHaveBeenCalledWith(
      expect.any(Function),
      300_000,
    );
    await handle?.firstTick;
    handle?.stop();
    expect(h.deps.clearInterval).toHaveBeenCalledWith("handle-1");
  });

  it("a fire POSTs once with the body shape and does not re-fire within 24 h", async () => {
    const h = harness();
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;

    expect(h.posts).toHaveLength(1);
    const body = h.posts[0];
    expect(body).toMatchObject({
      trigger: "supersede_waste",
      value: 1,
      threshold: 0.2,
      authorizedMove: "Revisit the default policy",
      boxId: BOX_ID,
      firedAt: new Date(NOW).toISOString(),
      state: "fired",
    });
    expect(typeof body?.text).toBe("string");
    expect(
      h.logs.filter((l) => l.startsWith("growth.trigger_fired ")),
    ).toHaveLength(1);
    const fired = h.logs.find((l) => l.startsWith("growth.trigger_fired "));
    expect(
      JSON.parse(fired?.slice("growth.trigger_fired ".length) ?? ""),
    ).toMatchObject({
      trigger: "supersede_waste",
      boxId: BOX_ID,
    });

    // Snapshot: atomic writer, mode 0640, committed state.
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({
      dir: SNAPSHOT_DIR,
      filename: GROWTH_SNAPSHOT_FILENAME,
      mode: GROWTH_SNAPSHOT_MODE,
    });
    expect(GROWTH_SNAPSHOT_MODE).toBe(0o640);
    expect(h.writes[0]?.snapshot.triggers.supersede_waste).toMatchObject({
      verdict: "over",
      firing: true,
      lastFiredAt: new Date(NOW).toISOString(),
    });

    // Next tick, still over, 5 min later: no POST; the snapshot is still written.
    h.clock.ms = NOW + 300_000;
    await handle?.tick();
    expect(h.posts).toHaveLength(1);
    expect(h.writes).toHaveLength(2);
    handle?.stop();
  });

  it("a failed POST is not committed and is retried next tick", async () => {
    const h = harness();
    h.setWebhookStatus(503);
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    expect(h.posts).toHaveLength(1);
    const failed = h.logs.find((l) => l.startsWith("growth.webhook_failed "));
    expect(
      JSON.parse(failed?.slice("growth.webhook_failed ".length) ?? ""),
    ).toEqual({
      trigger: "supersede_waste",
      state: "fired",
      status: 503,
      reason: "non-2xx",
    });
    expect(h.logs.some((l) => l.startsWith("growth.trigger_fired "))).toBe(
      false,
    );
    expect(h.writes[0]?.snapshot.triggers.supersede_waste.firing).toBe(false);

    h.setWebhookStatus(200);
    h.clock.ms = NOW + 300_000;
    await handle?.tick();
    expect(h.posts).toHaveLength(2);
    expect(h.writes[1]?.snapshot.triggers.supersede_waste.firing).toBe(true);
    handle?.stop();
  });

  it("cleared is POSTed once when the trigger drops under", async () => {
    const h = harness();
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    h.setEngine(() => jsonResponse(page(CLEAN, 1, null)));
    h.clock.ms = NOW + 300_000;
    await handle?.tick();
    h.clock.ms = NOW + 600_000;
    await handle?.tick();

    expect(h.posts.map((p) => p.state)).toEqual(["fired", "cleared"]);
    expect(h.posts[1]).toMatchObject({ trigger: "supersede_waste", value: 0 });
    expect(
      h.logs.filter((l) => l.startsWith("growth.trigger_cleared ")),
    ).toHaveLength(1);
    expect(h.writes.at(-1)?.snapshot.triggers.supersede_waste.firing).toBe(
      false,
    );
    handle?.stop();
  });

  it("dedupe seeded from the snapshot suppresses a re-fire after restart", async () => {
    const first = harness();
    const h1 = armGrowthTriggers(ENV_ON, first.deps);
    await h1?.firstTick;
    h1?.stop();
    expect(first.posts).toHaveLength(1);

    // "Restart": a new arm reads the snapshot the previous process wrote.
    const text = JSON.stringify(first.writes.at(-1)?.snapshot);
    const second = harness({ snapshotText: text });
    second.clock.ms = NOW + 3_600_000;
    const h2 = armGrowthTriggers(ENV_ON, second.deps);
    await h2?.firstTick;
    expect(second.deps.readSnapshot).toHaveBeenCalledWith(
      `${SNAPSHOT_DIR}/${GROWTH_SNAPSHOT_FILENAME}`,
    );
    expect(second.posts).toHaveLength(0);
    expect(second.writes[0]?.snapshot.triggers.supersede_waste.firing).toBe(
      true,
    );
    h2?.stop();
  });

  it.each([
    ["403", () => new Response("no", { status: 403 })],
    ["non-JSON", () => new Response("<html>", { status: 200 })],
    [
      "throw",
      () => {
        throw new TypeError("boom");
      },
    ],
  ])(
    "engine %s → run triggers unknown, nothing fires, snapshot still written",
    async (_name, respond) => {
      const h = harness();
      h.setEngine(respond);
      const handle = armGrowthTriggers(ENV_ON, h.deps);
      const result = await handle?.firstTick;
      expect(result?.skipped).toBe(false);
      expect(h.posts).toHaveLength(0);
      expect(h.writes).toHaveLength(1);
      const t = h.writes[0]?.snapshot.triggers;
      for (const id of [
        "queue_wait_p90",
        "client_share",
        "scale_composite",
        "supersede_waste",
      ] as const) {
        expect(t?.[id].verdict).toBe("unknown");
        expect(t?.[id].reason).toMatch(/^engine read: /);
      }
      // One sample is not a sustained window yet (R1 a).
      expect(t?.ram_swap).toMatchObject({
        verdict: "unknown",
        reason: "warming up",
      });
      expect(
        h.logs.filter(
          (l) =>
            l.startsWith("growth.trigger_unknown ") &&
            l.includes("engine read: "),
        ),
      ).toHaveLength(4);
      handle?.stop();
    },
  );

  it("logs trigger_unknown once per (trigger, reason) streak and trigger_known on recovery", async () => {
    const h = harness();
    h.setEngine(() => new Response("no", { status: 403 }));
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    for (const k of [1, 2]) {
      h.clock.ms = NOW + k * 300_000;
      await handle?.tick();
    }
    const lines = (event: string, trigger: string) =>
      h.logs.filter(
        (l) => l.startsWith(`${event} `) && l.includes(`"${trigger}"`),
      );
    expect(lines("growth.trigger_unknown", "supersede_waste")).toEqual([
      'growth.trigger_unknown {"trigger":"supersede_waste","reason":"engine read: http 403"}',
    ]);
    // 4 engine-backed triggers + ram_swap warming up, once each over 3 ticks.
    expect(
      h.logs.filter((l) => l.startsWith("growth.trigger_unknown ")),
    ).toHaveLength(5);
    expect(lines("growth.trigger_known", "supersede_waste")).toHaveLength(0);

    h.setEngine(() => jsonResponse(page(CLEAN, 1, null)));
    h.clock.ms = NOW + 900_000;
    await handle?.tick();
    h.clock.ms = NOW + 1_200_000;
    await handle?.tick();
    expect(lines("growth.trigger_known", "supersede_waste")).toEqual([
      'growth.trigger_known {"trigger":"supersede_waste"}',
    ]);
    expect(lines("growth.trigger_unknown", "supersede_waste")).toHaveLength(1);

    // A new reason starts a new streak.
    h.setEngine(() => new Response("no", { status: 500 }));
    h.clock.ms = NOW + 1_500_000;
    await handle?.tick();
    expect(lines("growth.trigger_unknown", "supersede_waste")).toHaveLength(2);
    handle?.stop();
  });

  it("a never-answering engine still lets a ram_swap fire POST through in the same tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness();
      // 15/16 of RAM in use on every sample.
      h.deps.readText = vi.fn(async (p: string) =>
        p === "/proc/meminfo"
          ? "MemTotal:       16000000 kB\nMemAvailable:    1000000 kB\n"
          : VMSTAT,
      );
      h.setEngine(() => jsonResponse(page(CLEAN, 1, null)));
      const handle = armGrowthTriggers(ENV_ON, h.deps);
      await handle?.firstTick;
      for (const k of [1, 2]) {
        h.clock.ms = NOW + k * 300_000;
        await handle?.tick();
      }
      expect(h.posts).toHaveLength(0); // still warming up (sustain 900 s)

      // Tick 4 spans the sustain window; the engine accepts and never answers.
      h.setEngine(() => new Promise<Response>(() => {}));
      h.clock.ms = NOW + 900_000;
      const pending = handle?.tick();
      // The engine read is abandoned at 0.5 × the 300 s interval.
      await vi.advanceTimersByTimeAsync(150_000);
      const r = await pending;

      expect(h.posts.map((p) => [p.trigger, p.state])).toEqual([
        ["ram_swap", "fired"],
      ]);
      expect(r?.snapshot?.triggers.ram_swap).toMatchObject({
        verdict: "over",
        firing: true,
      });
      expect(r?.snapshot?.triggers.supersede_waste).toMatchObject({
        verdict: "unknown",
        reason: "engine read: tick deadline exceeded",
      });
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unknown tick leaves a firing trigger firing (no clear)", async () => {
    const h = harness();
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    h.setEngine(() => new Response("no", { status: 403 }));
    h.clock.ms = NOW + 300_000;
    await handle?.tick();
    expect(h.posts).toHaveLength(1);
    expect(h.writes.at(-1)?.snapshot.triggers.supersede_waste).toMatchObject({
      verdict: "unknown",
      firing: true,
    });
    handle?.stop();
  });

  it("overlapping ticks are skipped and logged once", async () => {
    const h = harness();
    let release: (r: Response) => void = () => {};
    h.setEngine(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    // The first tick is in flight (engine hangs). The interval fires twice.
    h.intervalFns[0]?.();
    const skipped = await handle?.tick();
    expect(skipped).toEqual({ skipped: true, snapshot: null });
    expect(
      h.logs.filter((l) => l.startsWith("growth.tick_skipped ")),
    ).toHaveLength(1);

    release(jsonResponse(page(CLEAN, 1, null)));
    const first = await handle?.firstTick;
    expect(first?.skipped).toBe(false);
    expect(h.writes).toHaveLength(1);
    expect(h.posts).toHaveLength(0);

    // Not in flight any more: the next tick runs.
    h.setEngine(() => jsonResponse(page(CLEAN, 1, null)));
    const next = await handle?.tick();
    expect(next?.skipped).toBe(false);
    handle?.stop();
  });

  it("a tick never throws: snapshot write and /proc failures are logged", async () => {
    const h = harness();
    h.deps.writeSnapshot = vi.fn(() => {
      throw Object.assign(new Error(`EACCES ${SNAPSHOT_DIR}`), {
        code: "EACCES",
      });
    });
    h.deps.readText = vi.fn(async () => {
      throw new Error("no /proc here");
    });
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    const r = await handle?.firstTick;
    expect(r?.skipped).toBe(false);
    expect(r?.snapshot?.triggers.ram_swap.verdict).toBe("unknown");
    expect(h.logs).toContain('growth.snapshot_write_failed {"error":"EACCES"}');
    handle?.stop();
  });

  it("an unexpected throw inside the tick becomes growth.tick_error", async () => {
    const h = harness();
    // Arm itself never reads the clock; the tick's first read blows up.
    h.deps.now = vi.fn((): number => {
      throw new RangeError("clock broke");
    });
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    const r = await handle?.firstTick;
    expect(r).toEqual({ skipped: false, snapshot: null });
    expect(h.logs.some((l) => l.startsWith("growth.tick_error "))).toBe(true);
    handle?.stop();
  });

  it("an unreadable seed snapshot starts from the initial states", async () => {
    const h = harness({ snapshotText: "{not json" });
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    expect(
      h.logs.some((l) => l.startsWith("growth.snapshot_seed_failed ")),
    ).toBe(true);
    expect(h.posts).toHaveLength(1);
    handle?.stop();
  });
});

// ---------------------------------------------------------------------------
// writeSnapshotAtomic (the writer the driver uses by default)
// ---------------------------------------------------------------------------

describe("writeSnapshotAtomic", () => {
  function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "growth-snap-"));
  }

  it("writes the file and leaves no temp file behind (default behaviour)", () => {
    const root = tmpRoot();
    try {
      writeSnapshotAtomic(root, { a: 1 }, { filename: "s.json" });
      expect(
        JSON.parse(fs.readFileSync(path.join(root, "s.json"), "utf8")),
      ).toEqual({ a: 1 });
      writeSnapshotAtomic(root, { a: 2 }, { filename: "m.json", mode: 0o640 });
      expect(fs.statSync(path.join(root, "m.json")).mode & 0o777).toBe(0o640);
      expect(fs.readdirSync(root).sort()).toEqual(["m.json", "s.json"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["default mode", undefined],
    ["explicit mode", 0o640],
  ])(
    "a failed rename (%s) unlinks the temp file and rethrows",
    (_name, mode) => {
      const root = tmpRoot();
      try {
        // The target is a non-empty directory: rename(2) of a file onto it fails.
        fs.mkdirSync(path.join(root, "busy.json"));
        fs.writeFileSync(path.join(root, "busy.json", "x"), "x");
        expect(() =>
          writeSnapshotAtomic(root, { a: 1 }, { filename: "busy.json", mode }),
        ).toThrow();
        expect(fs.readdirSync(root)).toEqual(["busy.json"]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
