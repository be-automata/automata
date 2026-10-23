import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  armGrowthTriggers,
  EMPTY_PAGE_WITH_MORE,
  GROWTH_ENGINE_REFRESH_MS,
  GROWTH_ENGINE_REQUEST_TIMEOUT_CAP_MS,
  GROWTH_RUNS_MAX_PAGES,
  GROWTH_RUNS_PAGE_LIMIT,
  GROWTH_SNAPSHOT_FILENAME,
  GROWTH_SNAPSHOT_MODE,
  GROWTH_WEBHOOK_BACKOFF_CAP_MS,
  MALFORMED_RUN_ROW,
  postWebhook,
  readMemSample,
  readRunWindow,
  TENANT_SIGNALS_OFF,
  UNRECOGNIZED_PAGE,
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
  /^http:\/\/engine\.test:8888\/api\/v1\/stable\/tenants\/tenant-1\/workflow-runs\?since=[^&]+&until=[^&]+&limit=200&offset=\d+&only_tasks=true$/;

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
  /** `additionalMetadata.lane`; absent → the row carries no lane. */
  lane?: string;
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
    additionalMetadata: {
      ...(opts.orgId ? { orgId: opts.orgId } : {}),
      ...(opts.lane ? { lane: opts.lane } : {}),
    },
    ...(opts.id !== undefined ? { metadata: { id: opts.id } } : {}),
  };
}

/**
 * One collection-route body in the ENGINE'S REAL SHAPE (measured on the box's hatchet-lite,
 * 2026-10-19): `next_page` is always `current_page + 1`, the last page included, and an
 * empty window reports `num_pages: 0`. Only `num_pages` says where the data ends.
 */
function page(
  rows: unknown[],
  current: number,
  numPages: number,
): Record<string, unknown> {
  return {
    pagination: {
      current_page: current,
      next_page: current + 1,
      num_pages: numPages,
    },
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
    untilMs: growthWindow(NOW).endMs,
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
      if (offset === 0) return jsonResponse(page(full, 1, 3));
      if (offset === 200) return jsonResponse(page(full, 2, 3));
      return jsonResponse(page(last, 3, 3));
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
    // Every page carries the same `until`: the window end, not a moving "now".
    for (const u of ENGINE_URLS) {
      expect(new URL(u).searchParams.get("until")).toBe(
        new Date(base.untilMs).toISOString(),
      );
    }
  });

  it("stops when current_page reaches num_pages, even on a full page whose next_page points past it", async () => {
    const full = Array.from({ length: GROWTH_RUNS_PAGE_LIMIT }, () => rawRow());
    for (const body of [page(full, 1, 1), page(full, 2, 2)]) {
      const fetchImpl = engineFetch(() => jsonResponse(body));
      const r = await readRunWindow({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(r.kind).toBe("rows");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("a short page whose pagination says more pages exist does not end the read", async () => {
    // An engine that caps `limit` at 100: every page is "short", yet next_page is set.
    const hundred = (from: number) =>
      Array.from({ length: 100 }, (_, i) => rawRow({ id: `run-${from + i}` }));
    const fetchImpl = engineFetch((offset) => {
      if (offset === 0) return jsonResponse(page(hundred(0), 1, 3));
      if (offset === 100) return jsonResponse(page(hundred(100), 2, 3));
      return jsonResponse(page(hundred(200).slice(0, 7), 3, 3));
    });
    const r = await readRunWindow({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("rows");
    if (r.kind === "rows") expect(r.rows).toHaveLength(207);
    expect(
      ENGINE_URLS.map((u) => new URL(u).searchParams.get("offset")),
    ).toEqual(["0", "100", "200"]);
  });

  it("without pagination (or a non-numeric current_page) only a short page ends the read", async () => {
    const full = Array.from({ length: GROWTH_RUNS_PAGE_LIMIT }, () => rawRow());
    const short = full.slice(0, 3);
    for (const wrap of [
      (rows: unknown[]) => ({ rows }),
      (rows: unknown[]) => ({
        pagination: { current_page: "1", next_page: 2 },
        rows,
      }),
    ]) {
      const fetchImpl = engineFetch((offset) =>
        jsonResponse(wrap(offset === 0 ? full : short)),
      );
      const r = await readRunWindow({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(r.kind).toBe("rows");
      if (r.kind === "rows") expect(r.rows).toHaveLength(203);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("the engine's real last page (next_page = current + 1) on a one-page window ends the read", async () => {
    const few = Array.from({ length: 22 }, () => rawRow());
    const fetchImpl = engineFetch(() => jsonResponse(page(few, 1, 1)));
    const r = await readRunWindow({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("rows");
    if (r.kind === "rows") expect(r.rows).toHaveLength(22);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an empty page with no more pages ends the read: num_pages 0, current >= num_pages, or no pagination", async () => {
    for (const body of [
      page([], 1, 0),
      page([], 5, 5),
      page([], 6, 5),
      { rows: [] },
    ]) {
      const fetchImpl = engineFetch(() => jsonResponse(body));
      const r = await readRunWindow({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(r).toEqual({ kind: "rows", rows: [] });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("an empty page while current_page < num_pages is unreadable, never the rows read so far (B)", async () => {
    const full = Array.from({ length: GROWTH_RUNS_PAGE_LIMIT }, () => rawRow());
    const fetchImpl = engineFetch((offset) =>
      offset === 0
        ? jsonResponse(page(full, 1, 5))
        : jsonResponse(page([], 2, 5)),
    );
    expect(
      await readRunWindow({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toEqual({ kind: "unreadable", reason: EMPTY_PAGE_WITH_MORE });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // On the first page too.
    const first = engineFetch(() => jsonResponse(page([], 1, 2)));
    expect(
      await readRunWindow({
        ...base,
        fetchImpl: first as unknown as typeof fetch,
      }),
    ).toEqual({ kind: "unreadable", reason: EMPTY_PAGE_WITH_MORE });
  });

  it("hits the page cap → unreadable 'page cap'", async () => {
    const full = Array.from({ length: GROWTH_RUNS_PAGE_LIMIT }, () => rawRow());
    const fetchImpl = engineFetch((offset) => {
      const p = offset / GROWTH_RUNS_PAGE_LIMIT + 1;
      return jsonResponse(page(full, p, 1000));
    });
    const r = await readRunWindow({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ kind: "unreadable", reason: "engine read: page cap" });
    expect(fetchImpl).toHaveBeenCalledTimes(GROWTH_RUNS_MAX_PAGES);
  });

  it("releases the body of a non-ok engine response", async () => {
    const cancel = vi.fn();
    const fetchImpl = engineFetch(
      () => new Response(new ReadableStream({ cancel }), { status: 503 }),
    );
    const r = await readRunWindow({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ kind: "unreadable", reason: "engine read: http 503" });
    expect(cancel).toHaveBeenCalledTimes(1);
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
        : jsonResponse(page(second, 2, 2)),
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

  it("one hanging page is abandoned at the per-request cap, not the long engine budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchImpl = engineFetch(() => new Promise<Response>(() => {}));
      let settled = false;
      const pending = readRunWindow({
        ...base,
        // A one-day interval: half of it is the engine budget.
        deadlineMs: NOW + DAY_MS / 2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      void pending.finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(
        GROWTH_ENGINE_REQUEST_TIMEOUT_CAP_MS - 1,
      );
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({
        kind: "unreadable",
        reason: "engine read: request timed out after 30000 ms",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(init?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a page whose rows are all unrecognizable is unreadable, never an empty window (N1)", async () => {
    const fetchImpl = engineFetch(() =>
      jsonResponse(page([{ foo: 1 }, "row", null, { actionId: 7 }], 1, 1)),
    );
    expect(
      await readRunWindow({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toEqual({ kind: "unreadable", reason: UNRECOGNIZED_PAGE });
  });

  it("one malformed :run row makes the read unreadable, on any page (N1)", async () => {
    const full = Array.from({ length: GROWTH_RUNS_PAGE_LIMIT }, () => rawRow());
    const bad = { ...rawRow(), createdAt: "not-a-time" };
    const fetchImpl = engineFetch((offset) =>
      offset === 0
        ? jsonResponse(page(full, 1, 2))
        : jsonResponse(page([rawRow(), bad], 2, 2)),
    );
    expect(
      await readRunWindow({
        ...base,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toEqual({ kind: "unreadable", reason: MALFORMED_RUN_ROW });
  });

  it("non-:run rows are still skipped silently, even a page of nothing else (N1)", async () => {
    const failure = (createdAt?: string) => ({
      ...rawRow({ actionId: "agent-run:on-failure-task" }),
      ...(createdAt !== undefined ? { createdAt } : {}),
    });
    const fetchImpl = engineFetch(() =>
      jsonResponse(
        page([rawRow({ id: "a" }), failure("garbage"), { foo: 1 }], 1, 1),
      ),
    );
    const r = await readRunWindow({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.kind).toBe("rows");
    if (r.kind === "rows") expect(r.rows.map((row) => row.id)).toEqual(["a"]);

    const onlyFailures = engineFetch(() =>
      jsonResponse(page([failure(), failure("garbage")], 1, 1)),
    );
    expect(
      await readRunWindow({
        ...base,
        fetchImpl: onlyFailures as unknown as typeof fetch,
      }),
    ).toEqual({ kind: "rows", rows: [] });
  });

  it("past the deadline → unreadable without a request", async () => {
    const fetchImpl = engineFetch(() => jsonResponse(page([], 1, 0)));
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

  it("releases the response body it never reads, on every status", async () => {
    for (const status of [200, 302, 500]) {
      const cancel = vi.fn();
      const stream = new ReadableStream({ cancel });
      const r = await postWebhook(
        WEBHOOK_URL,
        body,
        5000,
        (async () => new Response(stream, { status })) as typeof fetch,
      );
      expect(r.delivered).toBe(status === 200);
      expect(cancel).toHaveBeenCalledTimes(1);
    }
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

/** Engine rows that put supersede waste over (one CANCELLED review run, all of the time). */
const WASTEFUL = [rawRow({ status: "CANCELLED", runS: 600, lane: "review" })];
const CLEAN = [rawRow({ status: "COMPLETED", runS: 600 })];

function harness(opts: { snapshotText?: string | null } = {}): Harness {
  const clock = { ms: NOW };
  const posts: GrowthWebhookBody[] = [];
  const logs: string[] = [];
  const writes: Harness["writes"] = [];
  const intervalFns: Array<() => void> = [];
  let engine: () => Response | Promise<Response> = () =>
    jsonResponse(page(WASTEFUL, 1, 1));
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

    // Snapshot: atomic writer, mode 0640, committed state — written right after the
    // delivered fire and again at the end of the tick.
    expect(h.writes).toHaveLength(2);
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
    expect(h.writes).toHaveLength(3);
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
    // The engine answer changes between ticks: re-read it every tick.
    h.deps.engineRefreshMs = 0;
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
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
    // The engine answer changes between ticks: re-read it every tick.
    h.deps.engineRefreshMs = 0;
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

    h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
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
      // The engine answer changes between ticks: re-read it every tick.
      h.deps.engineRefreshMs = 0;
      // 15/16 of RAM in use on every sample.
      h.deps.readText = vi.fn(async (p: string) =>
        p === "/proc/meminfo"
          ? "MemTotal:       16000000 kB\nMemAvailable:    1000000 kB\n"
          : VMSTAT,
      );
      h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
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
      // The page request is abandoned at the 30 s per-request cap, well inside the
      // 0.5 × 300 s engine budget.
      await vi.advanceTimersByTimeAsync(GROWTH_ENGINE_REQUEST_TIMEOUT_CAP_MS);
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
        reason: "engine read: request timed out after 30000 ms",
      });
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unknown tick leaves a firing trigger firing (no clear)", async () => {
    const h = harness();
    // The engine answer changes between ticks: re-read it every tick.
    h.deps.engineRefreshMs = 0;
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

    release(jsonResponse(page(CLEAN, 1, 1)));
    const first = await handle?.firstTick;
    expect(first?.skipped).toBe(false);
    expect(h.writes).toHaveLength(1);
    expect(h.posts).toHaveLength(0);

    // Not in flight any more: the next tick runs.
    h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
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

  it("logs one snapshot_write_failed per same-error streak and one recovered line", async () => {
    const h = harness();
    h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
    let failWith: string | null = "EACCES";
    h.deps.writeSnapshot = vi.fn(() => {
      if (failWith !== null) {
        throw Object.assign(new Error(`${failWith} ${SNAPSHOT_DIR}`), {
          code: failWith,
        });
      }
    });
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    await handle?.tick();
    await handle?.tick();
    const failed = () =>
      h.logs.filter((l) => l.startsWith("growth.snapshot_write_failed "));
    const recovered = () =>
      h.logs.filter((l) => l.startsWith("growth.snapshot_write_recovered "));
    // Three failing persists with the same code: one line.
    expect(h.deps.writeSnapshot).toHaveBeenCalledTimes(3);
    expect(failed()).toEqual([
      'growth.snapshot_write_failed {"error":"EACCES"}',
    ]);

    // A different code starts a new streak.
    failWith = "ENOSPC";
    await handle?.tick();
    await handle?.tick();
    expect(failed()).toEqual([
      'growth.snapshot_write_failed {"error":"EACCES"}',
      'growth.snapshot_write_failed {"error":"ENOSPC"}',
    ]);
    expect(recovered()).toHaveLength(0);

    // The first success logs one recovered line; later successes log nothing.
    failWith = null;
    await handle?.tick();
    await handle?.tick();
    expect(recovered()).toEqual([
      'growth.snapshot_write_recovered {"after":"ENOSPC"}',
    ]);

    // A failure after recovery is a new incident, even with an earlier code.
    failWith = "EACCES";
    await handle?.tick();
    expect(failed()).toHaveLength(3);
    handle?.stop();
  });

  it("an unexpected throw inside the tick becomes growth.tick_error", async () => {
    const h = harness();
    // Arm's seed read of the clock falls back to the initial states (logged); the
    // tick's first read blows up.
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

  /**
   * Generated by the /ship Step 7 coverage audit.
   * Value: protects=a fire whose tick budget (0.95 × interval) is already spent is not
   * POSTed, not committed, and is retried next tick; fails_when=the remainingMs <= 0 guard
   * before postWebhook is removed (a 1 ms POST to a fast sink still lands past the
   * budget); why_new=no arm test exhausts the tick budget before a POST; seam=none;
   * no_claim=a real slow engine (the injected clock jumps inside the engine fetch)
   */
  it("a fire whose tick budget is already spent is not POSTed, not committed, and retried next tick", async () => {
    const h = harness();
    // The engine answers, but only once the clock is past 0.95 × 300 s = 285 s.
    h.setEngine(() => {
      h.clock.ms += 290_000;
      return jsonResponse(page(WASTEFUL, 1, 1));
    });
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    const r = await handle?.firstTick;

    expect(h.posts).toHaveLength(0);
    const failed = h.logs.find((l) => l.startsWith("growth.webhook_failed "));
    expect(
      JSON.parse(failed?.slice("growth.webhook_failed ".length) ?? ""),
    ).toEqual({
      trigger: "supersede_waste",
      state: "fired",
      reason: "tick deadline exceeded",
    });
    expect(r?.snapshot?.triggers.supersede_waste).toMatchObject({
      verdict: "over",
      firing: false,
      lastFiredAt: null,
    });

    // A tick with budget left delivers the fire it could not send.
    h.setEngine(() => jsonResponse(page(WASTEFUL, 1, 1)));
    h.clock.ms = NOW + 600_000;
    await handle?.tick();
    expect(h.posts.map((p) => [p.trigger, p.state])).toEqual([
      ["supersede_waste", "fired"],
    ]);
    handle?.stop();
  });

  /**
   * Generated by the /ship Step 7 coverage audit.
   * Value: protects=a POST is bounded by the tick budget left, not only the 10 s webhook
   * cap, so ticks cannot stack (V2); fails_when=Math.min(postTimeoutMs, remainingMs)
   * loses remainingMs and a hung sink holds the tick the full 10 s; why_new=postWebhook
   * timeout tests pass the timeout directly, the arm path is unexercised; seam=none;
   * no_claim=undici abort behaviour (fake timers, a never-settling mocked sink)
   */
  it("a hung sink is abandoned at the tick budget left, not the full webhook cap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness();
      // The engine read leaves 3 s of the 285 s tick budget.
      h.setEngine(() => {
        h.clock.ms = NOW + 282_000;
        return jsonResponse(page(WASTEFUL, 1, 1));
      });
      const engineFetch = h.deps.fetchImpl;
      if (engineFetch === undefined) throw new Error("harness has a fetchImpl");
      h.deps.fetchImpl = vi.fn(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
          urlOf(input) === WEBHOOK_URL
            ? new Promise<Response>(() => {})
            : engineFetch(input, init),
      ) as unknown as typeof fetch;

      const handle = armGrowthTriggers(ENV_ON, h.deps);
      let settled = false;
      const pending = (async () => {
        const result = await handle?.firstTick;
        settled = true;
        return result;
      })();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(settled).toBe(true);
      const r = await pending;

      const failed = h.logs.find((l) => l.startsWith("growth.webhook_failed "));
      expect(
        JSON.parse(failed?.slice("growth.webhook_failed ".length) ?? ""),
      ).toEqual({
        trigger: "supersede_waste",
        state: "fired",
        reason: "timeout",
      });
      expect(r?.snapshot?.triggers.supersede_waste.firing).toBe(false);
      handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("armGrowthTriggers (ship Step 9 decisions)", () => {
  /** Three orgs (client_share's minimum), org-a dominant and all of its time CANCELLED: client_share and supersede_waste over. */
  const THREE_ORGS = [
    rawRow({
      status: "CANCELLED",
      runS: 600,
      orgId: "org-a",
      id: "r-a",
      lane: "review",
    }),
    rawRow({ runS: 100, orgId: "org-b", id: "r-b" }),
    rawRow({ runS: 100, orgId: "org-c", id: "r-c" }),
  ];

  it("reads the engine bounded by until = 00:00 UTC today (the window end)", async () => {
    const h = harness();
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    expect(ENGINE_URLS.length).toBeGreaterThan(0);
    for (const u of ENGINE_URLS) {
      const q = new URL(u).searchParams;
      expect(q.get("since")).toBe(
        new Date(growthWindow(NOW).startMs).toISOString(),
      );
      expect(q.get("until")).toBe(
        new Date(growthWindow(NOW).endMs).toISOString(),
      );
    }
    expect(new URL(ENGINE_URLS[0] ?? "").searchParams.get("until")).toBe(
      "2026-10-19T00:00:00.000Z",
    );
    handle?.stop();
  });

  it("a delivered transition is persisted before the tick ends: a crash mid-tick does not re-send it", async () => {
    const first = harness();
    first.setEngine(() => jsonResponse(page(THREE_ORGS, 1, 1)));
    // Capture what is on disk the moment the SECOND POST goes out — the point at which a
    // process killed mid-tick would leave the file.
    let onDiskAtSecondPost: GrowthSnapshot | undefined;
    const inner = first.deps.fetchImpl;
    if (inner === undefined) throw new Error("harness has a fetchImpl");
    first.deps.fetchImpl = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (urlOf(input) === WEBHOOK_URL && first.posts.length === 1) {
          onDiskAtSecondPost = structuredClone(first.writes.at(-1)?.snapshot);
        }
        return inner(input, init);
      },
    ) as unknown as typeof fetch;
    const h1 = armGrowthTriggers(ENV_ON, first.deps);
    await h1?.firstTick;
    h1?.stop();
    expect(first.posts.map((p) => p.trigger)).toEqual([
      "client_share",
      "supersede_waste",
    ]);
    // One write per delivery, plus the end-of-tick write.
    expect(first.writes).toHaveLength(3);
    expect(onDiskAtSecondPost?.triggers.client_share).toMatchObject({
      firing: true,
      lastFiredAt: new Date(NOW).toISOString(),
      orgLastFiredAt: { "org-a": new Date(NOW).toISOString() },
    });
    expect(onDiskAtSecondPost?.triggers.supersede_waste.firing).toBe(false);

    // "Restart" from the mid-tick file: client_share was delivered and is not re-sent;
    // supersede_waste never made it to disk and is.
    const second = harness({
      snapshotText: JSON.stringify(onDiskAtSecondPost),
    });
    second.setEngine(() => jsonResponse(page(THREE_ORGS, 1, 1)));
    second.clock.ms = NOW + 60_000;
    const h2 = armGrowthTriggers(ENV_ON, second.deps);
    await h2?.firstTick;
    h2?.stop();
    expect(second.posts.map((p) => p.trigger)).toEqual(["supersede_waste"]);
  });

  it("client_share holds 24 h per org: A, B, A, B fires A then B only; A again after 24 h", async () => {
    // Both orgs hold > 40% whichever leads, so client_share is over on every tick. Day 1
    // of NOW's window is also inside the window a day later.
    const lead = (org: "org-a" | "org-b") =>
      jsonResponse(
        page(
          [
            rawRow({
              day: 1,
              runS: org === "org-a" ? 550 : 450,
              orgId: "org-a",
              id: "r-a",
            }),
            rawRow({
              day: 1,
              runS: org === "org-b" ? 550 : 450,
              orgId: "org-b",
              id: "r-b",
            }),
            // A third, small org: client_share needs ≥ 3 orgs holding run time.
            rawRow({ day: 1, runS: 50, orgId: "org-c", id: "r-c" }),
          ],
          1,
          1,
        ),
      );
    const h = harness();
    let leader: "org-a" | "org-b" = "org-a";
    h.setEngine(() => lead(leader));
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    const sequence: Array<"org-a" | "org-b"> = ["org-b", "org-a", "org-b"];
    for (const [i, org] of sequence.entries()) {
      leader = org;
      // An hour apart: each tick's engine read is due (GROWTH_ENGINE_REFRESH_MS).
      h.clock.ms = NOW + (i + 1) * GROWTH_ENGINE_REFRESH_MS;
      await handle?.tick();
    }
    const shareFires = () =>
      h.posts.filter((p) => p.trigger === "client_share");
    expect(shareFires().map((p) => p.text.includes("org-b"))).toEqual([
      false,
      true,
    ]);
    expect(shareFires()[0]?.text).toContain("org-a holds");
    expect(shareFires()[1]?.text).toContain("org-b holds");
    expect(h.writes.at(-1)?.snapshot.triggers.client_share).toMatchObject({
      firing: true,
      orgLastFiredAt: {
        "org-a": new Date(NOW).toISOString(),
        "org-b": new Date(NOW + GROWTH_ENGINE_REFRESH_MS).toISOString(),
      },
    });

    leader = "org-a";
    h.clock.ms = NOW + DAY_MS;
    await handle?.tick();
    expect(shareFires()).toHaveLength(3);
    expect(shareFires()[2]?.text).toContain("org-a holds");
    handle?.stop();
  });

  it("a tick crossing 00:00 UTC evaluates the window it read: no empty-yesterday clear", async () => {
    const readStart = Date.parse("2026-10-19T23:59:59.900Z");
    const afterRead = Date.parse("2026-10-20T00:00:00.100Z");
    const w = growthWindow(readStart);
    // Every day of the READ window waits 700 s (queue_wait over); 2026-10-19 itself —
    // the newest day of the post-midnight window — was never read.
    const rows = w.dayStartsMs.map((dayStart, i) => {
      const created = dayStart + 3_600_000;
      return {
        actionId: "agent-run:run",
        status: "COMPLETED",
        createdAt: new Date(created).toISOString(),
        startedAt: new Date(created + 700_000).toISOString(),
        finishedAt: new Date(created + 760_000).toISOString(),
        additionalMetadata: {},
        metadata: { id: `r-${i}` },
      };
    });
    const firedAt = new Date(readStart - 3_600_000).toISOString();
    const h = harness({
      snapshotText: JSON.stringify({
        triggers: { queue_wait_p90: { firing: true, lastFiredAt: firedAt } },
      }),
    });
    h.clock.ms = readStart;
    h.setEngine(() => {
      // The clock crosses midnight while the engine read is in flight.
      h.clock.ms = afterRead;
      return jsonResponse(page(rows, 1, 1));
    });
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    handle?.stop();
    expect(new URL(ENGINE_URLS[0] ?? "").searchParams.get("until")).toBe(
      "2026-10-19T00:00:00.000Z",
    );
    expect(h.posts.filter((p) => p.trigger === "queue_wait_p90")).toEqual([]);
    expect(h.writes.at(-1)?.snapshot).toMatchObject({
      evaluatedAt: new Date(afterRead).toISOString(),
      triggers: {
        queue_wait_p90: { verdict: "over", firing: true, lastFiredAt: firedAt },
      },
    });
  });

  it("a tick with no transition ends the webhook_failed streak: the same outage later is logged again", async () => {
    const h = harness();
    // The engine answer changes between ticks: re-read it every tick.
    h.deps.engineRefreshMs = 0;
    h.setWebhookStatus(503);
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick; // supersede_waste over: fire fails (503), logged
    const failed = () =>
      h.logs.filter((l) => l.startsWith("growth.webhook_failed "));
    expect(failed()).toHaveLength(1);

    // Under while never committed as firing: no transition for supersede_waste.
    h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
    h.clock.ms = NOW + 300_000;
    await handle?.tick();
    expect(h.posts).toHaveLength(1);

    // Over again, the sink still answering 503: a new streak, logged again.
    h.setEngine(() => jsonResponse(page(WASTEFUL, 1, 1)));
    h.clock.ms = NOW + 600_000;
    await handle?.tick();
    expect(h.posts).toHaveLength(2);
    expect(failed()).toHaveLength(2);
    expect(failed()[1]).toContain('"reason":"non-2xx"');
    handle?.stop();
  });

  /**
   * Extended by the /ship Step 7 coverage audit (second pass): a new reason in the same
   * state is a new streak (the sinkUnreachable rows).
   * Value: protects=webhook_failed streaks are keyed by reason as well as state, so a sink
   * going from 503 to unreachable is logged again; fails_when=the streak key drops the
   * reason (state-only) and the second failure mode is never logged; why_new=the rest of
   * this test changes only the state (fired → cleared); seam=none; no_claim=a real network
   * failure (the injected fetch throws a TypeError)
   */
  it("logs webhook_failed once per (trigger, state, reason) streak and webhook_recovered on the next delivery", async () => {
    const h = harness();
    // The engine answer changes between ticks: re-read it every tick.
    h.deps.engineRefreshMs = 0;
    let sinkUnreachable = false;
    const inner = h.deps.fetchImpl;
    if (inner === undefined) throw new Error("harness has a fetchImpl");
    h.deps.fetchImpl = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (sinkUnreachable && urlOf(input) === WEBHOOK_URL) {
          throw new TypeError("fetch failed");
        }
        return inner(input, init);
      },
    ) as unknown as typeof fetch;
    h.setWebhookStatus(503);
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    for (const k of [1, 2]) {
      h.clock.ms = NOW + k * 300_000;
      await handle?.tick();
    }
    const events = (event: string) =>
      h.logs.filter((l) => l.startsWith(`${event} `));
    expect(h.posts).toHaveLength(3); // retried every tick (V2) ...
    expect(events("growth.webhook_failed")).toHaveLength(1); // ... logged once
    expect(events("growth.webhook_recovered")).toHaveLength(0);

    // Same state, new reason (503 → unreachable): a new streak, logged once more.
    sinkUnreachable = true;
    for (const ms of [700_000, 800_000]) {
      h.clock.ms = NOW + ms;
      await handle?.tick();
    }
    sinkUnreachable = false;
    expect(events("growth.webhook_failed")).toHaveLength(2);
    expect(events("growth.webhook_failed")[1]).toContain(
      '"reason":"request failed (TypeError)"',
    );

    h.setWebhookStatus(200);
    h.clock.ms = NOW + 900_000;
    await handle?.tick();
    expect(events("growth.webhook_recovered")).toEqual([
      'growth.webhook_recovered {"trigger":"supersede_waste","state":"fired"}',
    ]);
    expect(events("growth.trigger_fired")).toHaveLength(1);

    // A new failure after the recovery is a new streak: logged again.
    h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
    h.setWebhookStatus(503);
    h.clock.ms = NOW + 1_200_000;
    await handle?.tick();
    h.clock.ms = NOW + 1_500_000;
    await handle?.tick();
    const failed = events("growth.webhook_failed");
    expect(failed).toHaveLength(3);
    expect(failed[2]).toContain('"state":"cleared"');
    handle?.stop();
  });

  it("the default writer refuses a pre-existing temp file, cleans it, and the next tick writes 0640", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "growth-chmod-"));
    try {
      const target = path.join(root, GROWTH_SNAPSHOT_FILENAME);
      // A leftover (or planted) temp file: the writer creates its temp file exclusively,
      // so this one is refused rather than truncated and reused.
      const tmp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, "stale", { mode: 0o600 });
      const h = harness();
      // Nothing fires, so each tick writes exactly once.
      h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
      delete h.deps.writeSnapshot;
      h.deps.snapshotDir = root;
      const handle = armGrowthTriggers(ENV_ON, h.deps);
      await handle?.firstTick;
      expect(h.posts).toHaveLength(0);
      expect(
        h.logs.filter((l) => l.startsWith("growth.snapshot_write_failed ")),
      ).toEqual(['growth.snapshot_write_failed {"error":"EEXIST"}']);
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.existsSync(tmp)).toBe(false);

      h.clock.ms = NOW + 300_000;
      await handle?.tick();
      handle?.stop();
      expect(fs.statSync(target).mode & 0o777).toBe(GROWTH_SNAPSHOT_MODE);
      expect(fs.existsSync(tmp)).toBe(false);
      expect(
        (JSON.parse(fs.readFileSync(target, "utf8")) as GrowthSnapshot).boxId,
      ).toBe(BOX_ID);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a throwing resolveEngine makes arm throw before any timer, fetch, file or log", () => {
    const h = harness();
    h.deps.resolveEngine = vi.fn(() => {
      throw new Error("HATCHET_CLIENT_TOKEN is not set");
    });
    // A fixed phrase naming only the cause's class: the boot site prints what arm throws.
    expect(() => armGrowthTriggers(ENV_ON, h.deps)).toThrow(
      "growth triggers: cannot resolve the engine target (Error)",
    );
    for (const name of [
      "setInterval",
      "fetchImpl",
      "readSnapshot",
      "writeSnapshot",
      "log",
      "readText",
      "now",
    ] as const) {
      expect(vi.mocked(h.deps[name]), name).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// writeSnapshotAtomic (the writer the driver uses by default)
// ---------------------------------------------------------------------------

describe("armGrowthTriggers (final review: engine cache, clear text)", () => {
  const engineReads = () => ENGINE_URLS.length;

  it("a second tick within the hour evaluates the cached rows without a fetch", async () => {
    const h = harness();
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    expect(engineReads()).toBe(1);
    // Different engine data now — but the cached read is still fresh.
    h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
    h.clock.ms = NOW + GROWTH_ENGINE_REFRESH_MS - 1;
    const r = await handle?.tick();
    expect(engineReads()).toBe(1);
    // Evaluated from the cache: still WASTEFUL, so still over (and held, not re-sent).
    expect(r?.snapshot?.triggers.supersede_waste).toMatchObject({
      verdict: "over",
      firing: true,
    });
    expect(h.posts).toHaveLength(1);
    // /proc is still sampled every tick.
    const readText = h.deps.readText;
    if (readText === undefined) throw new Error("harness has a readText");
    expect(
      vi.mocked(readText).mock.calls.filter(([p]) => p === "/proc/meminfo"),
    ).toHaveLength(2);
    handle?.stop();
  });

  it("an hour after the last successful read the engine is read again", async () => {
    const h = harness();
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
    h.clock.ms = NOW + GROWTH_ENGINE_REFRESH_MS;
    const r = await handle?.tick();
    expect(engineReads()).toBe(2);
    expect(r?.snapshot?.triggers.supersede_waste.verdict).toBe("under");
    expect(h.posts.map((p) => p.state)).toEqual(["fired", "cleared"]);
    handle?.stop();
  });

  it("a UTC day roll re-reads the engine at once, whatever the cache age", async () => {
    const h = harness();
    h.clock.ms = Date.parse("2026-10-19T23:59:00.000Z");
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    expect(engineReads()).toBe(1);
    h.clock.ms = Date.parse("2026-10-20T00:01:00.000Z");
    await handle?.tick();
    expect(engineReads()).toBe(2);
    expect(new URL(ENGINE_URLS[1] ?? "").searchParams.get("until")).toBe(
      "2026-10-20T00:00:00.000Z",
    );
    handle?.stop();
  });

  it("an unreadable read keeps the old cache age, so the next tick retries", async () => {
    const h = harness();
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    h.setEngine(() => new Response("no", { status: 503 }));
    h.clock.ms = NOW + GROWTH_ENGINE_REFRESH_MS;
    const failed = await handle?.tick();
    expect(engineReads()).toBe(2);
    expect(failed?.snapshot?.triggers.supersede_waste).toMatchObject({
      verdict: "unknown",
      reason: "engine read: http 503",
      firing: true,
    });
    // One tick later — well inside an hour of the FAILED read — it is still due.
    h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
    h.clock.ms = NOW + GROWTH_ENGINE_REFRESH_MS + 300_000;
    const retried = await handle?.tick();
    expect(engineReads()).toBe(3);
    expect(retried?.snapshot?.triggers.supersede_waste.verdict).toBe("under");
    // And that successful read is fresh again.
    h.clock.ms = NOW + GROWTH_ENGINE_REFRESH_MS + 600_000;
    await handle?.tick();
    expect(engineReads()).toBe(3);
    handle?.stop();
  });

  it("a tick whose start is before the cached read time (clock stepped back) refetches", async () => {
    const h = harness();
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    expect(engineReads()).toBe(1);
    h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
    // Same UTC day, so the window is unchanged, and well inside the refresh age.
    h.clock.ms = NOW - 60_000;
    const r = await handle?.tick();
    expect(engineReads()).toBe(2);
    expect(r?.snapshot?.triggers.supersede_waste.verdict).toBe("under");
    handle?.stop();
  });

  it("the snapshot writer's tmp-cleanup failure reaches the driver's log as its event with fields", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "growth-log-"));
    try {
      // A DIRECTORY at the temp path: the exclusive open refuses it (EEXIST) and the
      // cleanup unlink fails with something other than ENOENT (EPERM / EISDIR).
      const tmp = path.join(
        root,
        `${GROWTH_SNAPSHOT_FILENAME}.tmp-${process.pid}`,
      );
      fs.mkdirSync(tmp);
      const h = harness();
      h.deps.snapshotDir = root;
      h.deps.writeSnapshot = writeSnapshotAtomic;
      const handle = armGrowthTriggers(ENV_ON, h.deps);
      await handle?.firstTick;
      handle?.stop();
      const cleanup = h.logs.find((l) =>
        l.startsWith("snapshot.tmp_cleanup_failed "),
      );
      expect(cleanup).toBeDefined();
      const fields = JSON.parse(
        (cleanup ?? "").slice("snapshot.tmp_cleanup_failed ".length),
      ) as Record<string, unknown>;
      expect(fields).toEqual({ file: tmp, code: expect.any(String) });
      expect(fields.code).not.toBe("ENOENT");
      expect(fields).not.toHaveProperty("event");
      // The original error still surfaces as the driver's own line.
      expect(h.logs).toContain(
        'growth.snapshot_write_failed {"error":"EEXIST"}',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a client_share clear names the orgs it announced, not only the current top org", async () => {
    const shareRows = (aS: number) => [
      rawRow({ day: 1, runS: aS, orgId: "org-a", id: "r-a" }),
      rawRow({ day: 1, runS: 300, orgId: "org-b", id: "r-b" }),
      rawRow({ day: 1, runS: 300, orgId: "org-c", id: "r-c" }),
    ];
    const h = harness();
    h.deps.engineRefreshMs = 0;
    h.setEngine(() => jsonResponse(page(shareRows(900), 1, 1)));
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    // Balanced: org-a is still on top by a hair, org-b/org-c were never announced.
    h.setEngine(() => jsonResponse(page(shareRows(301), 1, 1)));
    h.clock.ms = NOW + 300_000;
    await handle?.tick();
    const share = h.posts.filter((p) => p.trigger === "client_share");
    expect(share.map((p) => p.state)).toEqual(["fired", "cleared"]);
    expect(share[1]?.text).toContain(
      "no longer over for org-a (announced in the last 24 h)",
    );
    handle?.stop();
  });
});

describe("armGrowthTriggers (adversarial review N1/N2/N6)", () => {
  const tickAt = async (
    h: Harness,
    handle: ReturnType<typeof armGrowthTriggers>,
    k: number,
  ) => {
    h.clock.ms = NOW + k * 300_000;
    return handle?.tick();
  };

  const malformed = (fields: Record<string, unknown>): unknown[] => [
    ...CLEAN,
    { ...rawRow({ id: "bad" }), ...fields },
  ];
  it.each<[string, unknown[], string, number]>([
    [
      "an all-unrecognizable page",
      [{ foo: 1 }, { bar: 2 }],
      UNRECOGNIZED_PAGE,
      1,
    ],
    [
      "one malformed :run row",
      malformed({ createdAt: "garbage" }),
      MALFORMED_RUN_ROW,
      1,
    ],
    [
      "a :run row with no status (A1)",
      malformed({ status: undefined }),
      MALFORMED_RUN_ROW,
      1,
    ],
    [
      "a terminal :run row with no finishedAt (A2)",
      malformed({ status: "CANCELLED", finishedAt: undefined }),
      MALFORMED_RUN_ROW,
      1,
    ],
    [
      "a started :run row with an unparseable startedAt (A3)",
      malformed({ status: "RUNNING", startedAt: "garbage" }),
      MALFORMED_RUN_ROW,
      1,
    ],
    [
      "a task row with an id and a createdAt but no actionId (A4)",
      malformed({ actionId: undefined }),
      MALFORMED_RUN_ROW,
      1,
    ],
    ["an empty page before the last (B)", [], EMPTY_PAGE_WITH_MORE, 2],
  ])(
    "%s reads unknown and never clears a firing trigger (N1)",
    async (_name, rows, reason, numPages) => {
      const h = harness();
      h.deps.engineRefreshMs = 0;
      const handle = armGrowthTriggers(ENV_ON, h.deps);
      await handle?.firstTick;
      expect(h.posts.map((p) => p.state)).toEqual(["fired"]);

      h.setEngine(() => jsonResponse(page(rows, 1, numPages)));
      const r = await tickAt(h, handle, 1);
      expect(h.posts.map((p) => p.state)).toEqual(["fired"]);
      expect(r?.snapshot?.triggers.supersede_waste).toMatchObject({
        verdict: "unknown",
        reason,
        firing: true,
      });
      handle?.stop();
    },
  );

  it("timed-out POSTs back off 1, 2, 4, … ticks up to the 1 h cap; a delivery resets it (N2)", async () => {
    expect(GROWTH_WEBHOOK_BACKOFF_CAP_MS).toBe(3_600_000);
    const h = harness();
    h.deps.engineRefreshMs = 0;
    let tick = 0;
    let sinkTimesOut = true;
    const attempts: Array<[number, string]> = [];
    const inner = h.deps.fetchImpl;
    if (inner === undefined) throw new Error("harness has a fetchImpl");
    h.deps.fetchImpl = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (urlOf(input) === WEBHOOK_URL) {
          const body = JSON.parse(String(init?.body)) as GrowthWebhookBody;
          attempts.push([tick, body.state]);
          if (sinkTimesOut) {
            throw new DOMException("late", "TimeoutError");
          }
        }
        return inner(input, init);
      },
    ) as unknown as typeof fetch;
    const handle = armGrowthTriggers(ENV_ON, h.deps);
    await handle?.firstTick;
    for (tick = 1; tick <= 39; tick++) await tickAt(h, handle, tick);

    // 300 s ticks: the cap is 12 ticks (1 h). Never dropped: every attempt is the fire.
    const fireTicks = attempts.map(([t]) => t);
    expect(fireTicks).toEqual([0, 1, 3, 7, 15, 27, 39]);
    expect(fireTicks.slice(1).map((t, i) => t - (fireTicks[i] ?? 0))).toEqual([
      1, 2, 4, 8, 12, 12,
    ]);
    expect(attempts.every(([, state]) => state === "fired")).toBe(true);
    const failed = () =>
      h.logs.filter((l) => l.startsWith("growth.webhook_failed "));
    expect(failed()).toHaveLength(1);
    expect(failed()[0]).toContain('"reason":"timeout"');

    // The sink recovers: the fire is delivered at the next due attempt (tick 51).
    sinkTimesOut = false;
    for (tick = 40; tick <= 51; tick++) await tickAt(h, handle, tick);
    expect(attempts.slice(7)).toEqual([[51, "fired"]]);
    expect(h.posts.at(-1)?.state).toBe("fired");

    // A new timeout streak (the clear) starts again at one tick apart.
    sinkTimesOut = true;
    h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
    for (tick = 52; tick <= 56; tick++) await tickAt(h, handle, tick);
    expect(attempts.slice(8)).toEqual([
      [52, "cleared"],
      [53, "cleared"],
      [55, "cleared"],
    ]);

    // The transition stops applying (over again, held by the tick-51 fire): backoff reset,
    // so the next clear is attempted at once rather than at tick 59.
    h.setEngine(() => jsonResponse(page(WASTEFUL, 1, 1)));
    tick = 57;
    await tickAt(h, handle, tick);
    h.setEngine(() => jsonResponse(page(CLEAN, 1, 1)));
    tick = 58;
    await tickAt(h, handle, tick);
    expect(attempts.slice(11)).toEqual([[58, "cleared"]]);
    handle?.stop();
  });

  it("tenant signals off: no engine resolve or fetch, run triggers unknown, ram_swap still fires (N6)", async () => {
    const seeded = JSON.stringify({
      triggers: {
        supersede_waste: {
          firing: true,
          lastFiredAt: new Date(NOW - 3_600_000).toISOString(),
        },
      },
    });
    const h = harness({ snapshotText: seeded });
    h.deps.engineRefreshMs = 0;
    h.deps.readText = vi.fn(async (p: string) =>
      p === "/proc/meminfo"
        ? "MemTotal:       16000000 kB\nMemAvailable:    1000000 kB\n"
        : VMSTAT,
    );
    const handle = armGrowthTriggers(
      { ...ENV_ON, WORKER_GROWTH_TRIGGER_TENANT_SIGNALS: "off" },
      h.deps,
    );
    await handle?.firstTick;
    for (const k of [1, 2, 3]) await tickAt(h, handle, k);

    expect(h.deps.resolveEngine).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(h.deps.fetchImpl as unknown as typeof fetch)
        .mock.calls.map(([input]) => urlOf(input))
        .filter((u) => u !== WEBHOOK_URL),
    ).toEqual([]);
    expect(h.posts.map((p) => [p.trigger, p.state])).toEqual([
      ["ram_swap", "fired"],
    ]);
    // A snapshot every tick; the seeded firing trigger is neither cleared nor re-fired.
    const last = h.writes.at(-1)?.snapshot.triggers;
    for (const id of [
      "queue_wait_p90",
      "client_share",
      "scale_composite",
      "supersede_waste",
    ] as const) {
      expect(last?.[id]).toMatchObject({
        verdict: "unknown",
        reason: TENANT_SIGNALS_OFF,
      });
    }
    expect(TENANT_SIGNALS_OFF).toBe("tenant signals off on this box");
    expect(last?.supersede_waste.firing).toBe(true);
    expect(last?.ram_swap).toMatchObject({ verdict: "over", firing: true });
    expect(h.writes.length).toBeGreaterThanOrEqual(4);
    expect(
      h.logs.filter(
        (l) =>
          l.startsWith("growth.trigger_unknown ") &&
          l.includes(TENANT_SIGNALS_OFF),
      ),
    ).toHaveLength(4);
    handle?.stop();
  });
});

describe("writeSnapshotAtomic", () => {
  function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "growth-snap-"));
  }

  it("a symlink at the temp path is refused, never followed, and the temp path is cleaned", () => {
    const root = tmpRoot();
    try {
      const victim = path.join(root, "victim.txt");
      fs.writeFileSync(victim, "do not touch", { mode: 0o600 });
      const tmp = path.join(root, `snap.json.tmp-${process.pid}`);
      fs.symlinkSync(victim, tmp);
      let thrown: unknown;
      try {
        writeSnapshotAtomic(
          root,
          { a: 1 },
          { filename: "snap.json", mode: 0o640 },
        );
      } catch (err) {
        thrown = err;
      }
      expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe(
        "EEXIST",
      );
      expect(fs.readFileSync(victim, "utf8")).toBe("do not touch");
      expect(fs.statSync(victim).mode & 0o777).toBe(0o600);
      expect(() => fs.lstatSync(tmp)).toThrow(/ENOENT/);
      expect(fs.existsSync(path.join(root, "snap.json"))).toBe(false);
      // The cleaned path lets the next write through, at the requested mode.
      writeSnapshotAtomic(
        root,
        { a: 2 },
        { filename: "snap.json", mode: 0o640 },
      );
      expect(fs.statSync(path.join(root, "snap.json")).mode & 0o777).toBe(
        0o640,
      );
      expect(fs.readdirSync(root).sort()).toEqual(["snap.json", "victim.txt"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("mode 0640 holds under a restrictive umask, and the default mode is unchanged", () => {
    const root = tmpRoot();
    const previous = process.umask(0o077);
    try {
      writeSnapshotAtomic(root, { a: 1 }, { filename: "m.json", mode: 0o640 });
      expect(fs.statSync(path.join(root, "m.json")).mode & 0o777).toBe(0o640);
      writeSnapshotAtomic(root, { a: 1 }, { filename: "d.json" });
      // writeFileSync's default: 0666 filtered by the umask.
      expect(fs.statSync(path.join(root, "d.json")).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(path.join(root, "d.json"), "utf8")).toBe(
        JSON.stringify({ a: 1 }, null, 2),
      );
    } finally {
      process.umask(previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a cleanup failure goes to options.log when one is given", () => {
    const root = tmpRoot();
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: unlink"), { code: "EPERM" });
    });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const lines: Array<Record<string, unknown>> = [];
    try {
      fs.mkdirSync(path.join(root, "busy.json"));
      fs.writeFileSync(path.join(root, "busy.json", "x"), "x");
      expect(() =>
        writeSnapshotAtomic(
          root,
          { a: 1 },
          { filename: "busy.json", log: (l) => lines.push(l) },
        ),
      ).toThrow();
      expect(lines).toEqual([
        {
          event: "snapshot.tmp_cleanup_failed",
          file: path.join(root, `busy.json.tmp-${process.pid}`),
          code: "EPERM",
        },
      ]);
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      unlink.mockRestore();
      consoleLog.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Extended by the /ship Step 7 coverage audit (the no-options call).
   * Value: protects=with no options the writer still targets scheduling-health.json, the
   * file the deploy README tells operators to read; fails_when=the positional→options
   * refactor drops the filename default and the maintenance tick writes elsewhere;
   * why_new=every other call passes a filename; seam=none; no_claim=none beyond protects
   */
  it("writes the file and leaves no temp file behind (default behaviour)", () => {
    const root = tmpRoot();
    try {
      writeSnapshotAtomic(root, { a: 1 }, { filename: "s.json" });
      expect(
        JSON.parse(fs.readFileSync(path.join(root, "s.json"), "utf8")),
      ).toEqual({ a: 1 });
      writeSnapshotAtomic(root, { a: 2 }, { filename: "m.json", mode: 0o640 });
      expect(fs.statSync(path.join(root, "m.json")).mode & 0o777).toBe(0o640);
      writeSnapshotAtomic(root, { a: 3 });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(root, "scheduling-health.json"), "utf8"),
        ),
      ).toEqual({ a: 3 });
      expect(fs.readdirSync(root).sort()).toEqual([
        "m.json",
        "s.json",
        "scheduling-health.json",
      ]);
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

  /**
   * Generated by the /ship Step 7 coverage audit.
   * Value: protects=a temp-file cleanup failure other than ENOENT is logged and never
   * masks the original write/rename error; fails_when=the inner unlink try/catch is
   * removed or rethrows, so callers see EPERM instead of the real cause; why_new=the
   * rename-failure rows only cover a cleanup that succeeds; seam=none;
   * no_claim=a real EPERM from the kernel (fs.unlinkSync is spied to throw)
   */
  it("a cleanup failure other than ENOENT is logged and the original error still propagates", () => {
    const root = tmpRoot();
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: unlink"), { code: "EPERM" });
    });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      fs.mkdirSync(path.join(root, "busy.json"));
      fs.writeFileSync(path.join(root, "busy.json", "x"), "x");
      let thrown: unknown;
      try {
        writeSnapshotAtomic(root, { a: 1 }, { filename: "busy.json" });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as NodeJS.ErrnoException).code).not.toBe("EPERM");
      expect(unlink).toHaveBeenCalledWith(
        path.join(root, `busy.json.tmp-${process.pid}`),
      );
      const lines = consoleLog.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some(
          (l) =>
            l.includes('"snapshot.tmp_cleanup_failed"') &&
            l.includes('"EPERM"'),
        ),
      ).toBe(true);
    } finally {
      unlink.mockRestore();
      consoleLog.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
