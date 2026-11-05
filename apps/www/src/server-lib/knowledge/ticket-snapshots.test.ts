import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/redis", () => ({ redis: {} }));

import { ticketPinTarget } from "@terragon/knowledge/reconcile-wire";

import type { TrackerConfig } from "@/server-lib/tracker/tracker-config";
import type {
  TrackerClient,
  TrackerIssue,
} from "@/server-lib/tracker/tracker-types";

import {
  KNOWLEDGE_TICKET_LIMITS,
  loadTicketSnapshots,
  type TicketSnapshotDeps,
} from "./ticket-snapshots";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG: TrackerConfig = {
  kind: "youtrack",
  baseUrl: "https://tracker.example.test",
  token: "tok-secret-value",
  projects: [],
  writes: "off",
};

const issue = (
  key: string,
  over: Partial<TrackerIssue> = {},
): TrackerIssue => ({
  key,
  summary: `Summary of ${key}`,
  stage: "Open",
  resolved: false,
  description: "Long description",
  links: [],
  comments: [{ id: "1", text: "first comment" }],
  ...over,
});

const pin = (uri: string) => {
  const p = ticketPinTarget(uri);
  if (!p) throw new Error("bad fixture uri");
  return p;
};

function setup(
  getIssue: (key: string) => Promise<TrackerIssue> = async (key) => issue(key),
  over: Partial<TicketSnapshotDeps> = {},
) {
  let clock = 1_000_000;
  const store = new Map<string, { value: unknown; until: number }>();
  const calls: string[] = [];
  const logs: { message: string; fields: Record<string, unknown> }[] = [];
  const client = {
    getIssue: vi.fn(async (key: string) => {
      calls.push(key);
      return getIssue(key);
    }),
  } as unknown as TrackerClient;
  const deps: TicketSnapshotDeps = {
    resolveConfig: vi.fn(async () => CONFIG),
    createClient: vi.fn(() => client),
    cache: {
      async get(key) {
        const hit = store.get(key);
        if (!hit || hit.until <= clock) return null;
        return JSON.parse(JSON.stringify(hit.value));
      },
      async set(key, value, ttlS) {
        store.set(key, { value, until: clock + ttlS * 1000 });
      },
    },
    now: () => clock,
    log: (message, fields) => logs.push({ message, fields }),
    ...over,
  };
  return {
    deps,
    calls,
    logs,
    advance: (s: number) => {
      clock += s * 1000;
    },
  };
}

const req = (
  claims: { claimId: string; uris: string[] }[],
  organizationId = "org1",
) => ({
  organizationId,
  repoFullName: "acme/r",
  intentId: "int1",
  claims: claims.map((c) => ({
    claimId: c.claimId,
    ticketPins: c.uris.map(pin),
  })),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loadTicketSnapshots", () => {
  it("fetches once per issue and minimizes to the pinned fields", async () => {
    const t = setup();
    const out = await loadTicketSnapshots(
      req([
        { claimId: "c1", uris: ["ticket://SUP-12#/summary"] },
        { claimId: "c2", uris: ["ticket://SUP-12#/comments/0/text"] },
      ]),
      t.deps,
    );
    expect(t.calls).toEqual(["SUP-12"]);
    expect(out.unavailableClaims).toEqual([]);
    expect(out.tickets).toHaveLength(1);
    const [ticket] = out.tickets;
    expect(Object.keys(ticket!.snapshot).sort()).toEqual([
      "comments",
      "summary",
    ]);
    const canonical =
      '{"comments":[{"id":"1","text":"first comment"}],"summary":"Summary of SUP-12"}';
    expect(ticket!.revision).toBe(
      createHash("sha256").update(canonical).digest("hex"),
    );
  });

  it("gives identical content an identical revision after the cache expires", async () => {
    const t = setup();
    const r = req([{ claimId: "c1", uris: ["ticket://SUP-12#/summary"] }]);
    const a = await loadTicketSnapshots(r, t.deps);
    t.advance(901);
    const b = await loadTicketSnapshots(r, t.deps);
    expect(t.calls).toHaveLength(2);
    expect(b.tickets[0]!.revision).toBe(a.tickets[0]!.revision);
  });

  it("caches for 900 s, then fetches again, and keeps orgs apart", async () => {
    const t = setup();
    const r = req([{ claimId: "c1", uris: ["ticket://SUP-12#/summary"] }]);
    await loadTicketSnapshots(r, t.deps);
    t.advance(KNOWLEDGE_TICKET_LIMITS.ttlS - 1);
    await loadTicketSnapshots(r, t.deps);
    expect(t.calls).toHaveLength(1);
    await loadTicketSnapshots(
      req([{ claimId: "c1", uris: ["ticket://SUP-12#/summary"] }], "org2"),
      t.deps,
    );
    expect(t.calls).toHaveLength(2);
    t.advance(2);
    await loadTicketSnapshots(r, t.deps);
    expect(t.calls).toHaveLength(3);
  });

  it("lists every claim unavailable when no tracker is configured", async () => {
    const t = setup(undefined, { resolveConfig: vi.fn(async () => null) });
    const out = await loadTicketSnapshots(
      req([{ claimId: "c1", uris: ["ticket://SUP-12#/summary"] }]),
      t.deps,
    );
    expect(out.tickets).toEqual([]);
    expect(out.unavailableClaims).toEqual([
      { claimId: "c1", code: "source_unavailable" },
    ]);
    expect(t.calls).toHaveLength(0);
  });

  it("treats a config resolution failure as unavailable, never a throw", async () => {
    const t = setup(undefined, {
      resolveConfig: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const out = await loadTicketSnapshots(
      req([{ claimId: "c1", uris: ["ticket://SUP-12#/summary"] }]),
      t.deps,
    );
    expect(out.unavailableClaims).toEqual([
      { claimId: "c1", code: "source_unavailable" },
    ]);
  });

  it.each([404, 401, 500])(
    "caches an HTTP %i as unavailable for the TTL",
    async (status) => {
      const t = setup(async () => {
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      });
      const r = req([{ claimId: "c1", uris: ["ticket://SUP-12#/summary"] }]);
      const a = await loadTicketSnapshots(r, t.deps);
      const b = await loadTicketSnapshots(r, t.deps);
      expect(a.unavailableClaims).toEqual([
        { claimId: "c1", code: "source_unavailable" },
      ]);
      expect(b.unavailableClaims).toEqual(a.unavailableClaims);
      expect(t.calls).toHaveLength(1);
    },
  );

  it("treats a fetch timeout as unavailable", async () => {
    vi.useFakeTimers();
    const t = setup(() => new Promise<TrackerIssue>(() => {}));
    const p = loadTicketSnapshots(
      req([{ claimId: "c1", uris: ["ticket://SUP-12#/summary"] }]),
      t.deps,
    );
    await vi.advanceTimersByTimeAsync(KNOWLEDGE_TICKET_LIMITS.perFetchMs + 1);
    const out = await p;
    expect(out.unavailableClaims).toEqual([
      { claimId: "c1", code: "source_unavailable" },
    ]);
  });

  it("marks an unsupported field pin_unsupported without touching sibling claims", async () => {
    const t = setup();
    const out = await loadTicketSnapshots(
      req([
        { claimId: "c1", uris: ["ticket://SUP-12#/resolution/workaround"] },
        { claimId: "c2", uris: ["ticket://SUP-12#/summary"] },
      ]),
      t.deps,
    );
    expect(out.unavailableClaims).toEqual([
      { claimId: "c1", code: "pin_unsupported" },
    ]);
    expect(out.tickets.map((x) => x.key)).toEqual(["SUP-12"]);
    expect(Object.keys(out.tickets[0]!.snapshot)).toEqual(["summary"]);
  });

  it("marks a snapshot over 16 KiB source_too_large", async () => {
    const t = setup(async (key) =>
      issue(key, { description: "x".repeat(17 * 1024) }),
    );
    const out = await loadTicketSnapshots(
      req([{ claimId: "c1", uris: ["ticket://SUP-12#/description"] }]),
      t.deps,
    );
    expect(out.tickets).toEqual([]);
    expect(out.unavailableClaims).toEqual([
      { claimId: "c1", code: "source_too_large" },
    ]);
  });

  it("caps the context at 512 KiB, in key order", async () => {
    const t = setup(async (key) =>
      issue(key, { description: "y".repeat(15 * 1024) }),
    );
    const claims = Array.from({ length: 40 }, (_v, i) => ({
      claimId: `c${String(i).padStart(2, "0")}`,
      uris: [`ticket://SUP-${100 + i}#/description`],
    }));
    const out = await loadTicketSnapshots(req(claims), t.deps);
    const total = out.tickets.reduce(
      (n, x) => n + Buffer.byteLength(JSON.stringify(x.snapshot)),
      0,
    );
    expect(total).toBeLessThanOrEqual(KNOWLEDGE_TICKET_LIMITS.maxTotalBytes);
    expect(out.tickets.length).toBeGreaterThan(0);
    expect(out.tickets.length).toBeLessThan(40);
    expect(out.unavailableClaims.length).toBe(40 - out.tickets.length);
    expect(
      out.unavailableClaims.every((u) => u.code === "source_too_large"),
    ).toBe(true);
    expect(out.tickets.map((x) => x.key)).toEqual(
      [...out.tickets.map((x) => x.key)].sort(),
    );
  });

  it("makes at most 40 fetches with at most 4 in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const t = setup(async (key) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return issue(key);
    });
    const claims = Array.from({ length: 50 }, (_v, i) => ({
      claimId: `c${i}`,
      uris: [`ticket://SUP-${100 + i}#/summary`],
    }));
    const out = await loadTicketSnapshots(req(claims), t.deps);
    expect(t.calls).toHaveLength(40);
    expect(peak).toBeLessThanOrEqual(4);
    expect(out.tickets).toHaveLength(40);
    expect(out.unavailableClaims).toHaveLength(10);
    expect(
      out.unavailableClaims.every((u) => u.code === "source_unavailable"),
    ).toBe(true);
  });

  it("resolves within the 6 s stage budget when the tracker never answers", async () => {
    vi.useFakeTimers();
    const t = setup(() => new Promise<TrackerIssue>(() => {}));
    const claims = Array.from({ length: 50 }, (_v, i) => ({
      claimId: `c${i}`,
      uris: [`ticket://SUP-${100 + i}#/summary`],
    }));
    const p = loadTicketSnapshots(req(claims), t.deps);
    await vi.advanceTimersByTimeAsync(KNOWLEDGE_TICKET_LIMITS.stageMs + 1);
    const out = await p;
    expect(out.tickets).toEqual([]);
    expect(out.unavailableClaims).toHaveLength(50);
    expect(t.calls.length).toBeLessThanOrEqual(8);
  });

  it("is all-or-nothing per claim across issues", async () => {
    const t = setup(async (key) => {
      if (key === "SUP-2") throw new Error("down");
      return issue(key);
    });
    const out = await loadTicketSnapshots(
      req([
        {
          claimId: "c1",
          uris: ["ticket://SUP-1#/summary", "ticket://SUP-2#/summary"],
        },
        { claimId: "c2", uris: ["ticket://SUP-1#/stage"] },
      ]),
      t.deps,
    );
    expect(out.unavailableClaims).toEqual([
      { claimId: "c1", code: "source_unavailable" },
    ]);
    expect(out.tickets.map((x) => x.key)).toEqual(["SUP-1"]);
  });

  it("refetches when a later context needs a field the cache lacks", async () => {
    const t = setup();
    await loadTicketSnapshots(
      req([{ claimId: "c1", uris: ["ticket://SUP-1#/summary"] }]),
      t.deps,
    );
    const out = await loadTicketSnapshots(
      req([{ claimId: "c1", uris: ["ticket://SUP-1#/stage"] }]),
      t.deps,
    );
    expect(t.calls).toHaveLength(2);
    expect(Object.keys(out.tickets[0]!.snapshot)).toEqual(["stage"]);
  });

  it("logs only the intent id and integer counts", async () => {
    const t = setup(async (key) => {
      if (key === "SUP-2") throw new Error("down: tok-secret-value");
      return issue(key);
    });
    await loadTicketSnapshots(
      req([
        { claimId: "c1", uris: ["ticket://SUP-1#/summary"] },
        { claimId: "c2", uris: ["ticket://SUP-2#/description"] },
      ]),
      t.deps,
    );
    expect(t.logs.length).toBeGreaterThan(0);
    for (const { fields } of t.logs) {
      for (const [k, v] of Object.entries(fields)) {
        if (k === "intentId") expect(v).toBe("int1");
        else expect(Number.isInteger(v)).toBe(true);
      }
    }
    const dump = JSON.stringify(t.logs);
    for (const leak of [
      "SUP-1",
      "SUP-2",
      "/summary",
      "Summary of",
      "tok-secret-value",
      "tracker.example",
      "c1",
    ]) {
      expect(dump).not.toContain(leak);
    }
  });
});

describe("module source", () => {
  const src = readFileSync(join(HERE, "ticket-snapshots.ts"), "utf8");
  it("holds no tracker credential reference", () => {
    expect(src).not.toMatch(/JIRA_API_TOKEN|YOUTRACK_TOKEN|process\.env/);
  });
  it("never imports fs", () => {
    expect(src).not.toMatch(/from "(node:)?fs/);
  });
});
