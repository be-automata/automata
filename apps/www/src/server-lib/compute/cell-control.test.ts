import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DB } from "@terragon/shared/db";
import { cellKeyId } from "@terragon/types/cell";

const h = vi.hoisted(() => ({
  order: [] as string[],
  revokeAttempt: vi.fn(),
  deadCellAttempts: vi.fn(),
  envState: {
    url: "",
    key: "",
    image: "",
    accessId: "",
    accessSecret: "",
  },
}));

vi.mock("@terragon/shared/model/cell-authority", () => ({
  revokeAttempt: h.revokeAttempt,
  deadCellAttempts: h.deadCellAttempts,
}));
vi.mock("@terragon/env/apps-www", () => ({
  env: {
    get OPENSANDBOX_URL() {
      return h.envState.url;
    },
    get OPENSANDBOX_API_KEY() {
      return h.envState.key;
    },
    get OPENSANDBOX_GUEST_IMAGE() {
      return h.envState.image;
    },
    get OPENSANDBOX_ACCESS_CLIENT_ID() {
      return h.envState.accessId;
    },
    get OPENSANDBOX_ACCESS_CLIENT_SECRET() {
      return h.envState.accessSecret;
    },
  },
}));

vi.mock("./cell-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cell-gate")>()),
  cellBrokerHost: () => "broker.test",
}));

import { opensandboxConfigured } from "./cell-gate";
import { accessFetch, cellProvider, runCellReconciler } from "./cell-control";

const db = {} as DB;
const ACCESS_ID = "access-id-canary-1a2b";
const ACCESS_SECRET = "access-secret-canary-3c4d";
const BOX = "https://box.example.test";

function tags(stepKey: string, attempt: number, expiresAt: number) {
  return {
    automata: "cell",
    stepKey,
    attempt: String(attempt),
    expiresAt: String(expiresAt),
    worker: "w",
    epoch: "1",
    deployment: "broker.test",
  };
}

beforeEach(() => {
  h.order.length = 0;
  h.envState.url = "";
  h.envState.key = "";
  h.envState.accessId = "";
  h.envState.accessSecret = "";
  h.revokeAttempt.mockReset();
  h.revokeAttempt.mockImplementation(async (a: { stepKey: string }) => {
    h.order.push(`revoke:${a.stepKey}`);
    return true;
  });
  h.deadCellAttempts.mockReset();
  h.deadCellAttempts.mockResolvedValue(new Set<string>());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("opensandboxConfigured / cellProvider", () => {
  it("is off unless URL and key are both set", () => {
    expect(opensandboxConfigured()).toBe(false);
    expect(cellProvider()).toBeNull();
    h.envState.url = "http://127.0.0.1:8090";
    expect(opensandboxConfigured()).toBe(false);
    h.envState.key = "k";
    expect(opensandboxConfigured()).toBe(true);
    expect(cellProvider()).not.toBeNull();
  });

  it("one Access value set, or both set over http, keeps it off with one fixed warn", async () => {
    vi.resetModules();
    const fresh = await import("./cell-control");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.envState.key = "k";
    h.envState.url = BOX;
    h.envState.accessId = ACCESS_ID;
    expect(fresh.cellProvider()).toBeNull();
    h.envState.accessSecret = ACCESS_SECRET;
    h.envState.url = "http://box.example.test";
    expect(fresh.cellProvider()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(ACCESS_ID);
    expect(logged).not.toContain(ACCESS_SECRET);
    // negative control: both set over https is on
    h.envState.url = BOX;
    expect(fresh.cellProvider()).not.toBeNull();
  });
});

describe("runCellReconciler isDead wiring (AC-5)", () => {
  const NOW = 1_000_000;
  function fakeProvider(entries: Array<{ cellId: string; tags: object }>) {
    return {
      listByTags: vi.fn(async () => entries),
      teardown: vi.fn(async (id: string) => {
        h.order.push(`teardown:${id}`);
      }),
    };
  }

  it("reaps an expired cell, revoking through revokeAttempt first", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = fakeProvider([
      { cellId: "x", tags: tags("cell-x", 3, 10) },
    ]);
    const r = await runCellReconciler({
      db,
      provider: provider as never,
      now: () => NOW,
    });
    expect(h.order).toEqual(["revoke:cell-x", "teardown:x"]);
    expect(h.revokeAttempt).toHaveBeenCalledWith({
      db,
      stepKey: "cell-x",
      attempt: 3,
    });
    expect(r).toMatchObject({ expired: 1, reaped: 1, failed: 0 });
    expect(provider.listByTags).toHaveBeenCalledWith(
      { deployment: "broker.test" },
      { maxPages: 5 },
    );
  });

  it("reaps an unexpired cell that deadCellAttempts names, with the lease rule off", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    h.deadCellAttempts.mockResolvedValue(
      new Set([cellKeyId({ stepKey: "cell-dead", attempt: 1 })]),
    );
    const provider = fakeProvider([
      { cellId: "dead", tags: tags("cell-dead", 1, NOW + 60_000) },
      { cellId: "live", tags: tags("cell-live", 1, NOW + 60_000) },
    ]);
    const r = await runCellReconciler({
      db,
      provider: provider as never,
      now: () => NOW,
    });
    expect(h.deadCellAttempts).toHaveBeenCalledWith({
      db,
      keys: [
        { stepKey: "cell-dead", attempt: 1 },
        { stepKey: "cell-live", attempt: 1 },
      ],
      staleMs: null,
    });
    expect(h.order).toEqual(["revoke:cell-dead", "teardown:dead"]);
    expect(r).toMatchObject({ dead: 1, reaped: 1 });
    // negative control: the unnamed one is kept
    expect(provider.teardown).not.toHaveBeenCalledWith("live");
  });

  it("a throwing deadCellAttempts reaps expired cells only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.deadCellAttempts.mockRejectedValue(new Error("db down"));
    const provider = fakeProvider([
      { cellId: "old", tags: tags("cell-old", 1, 10) },
      { cellId: "live", tags: tags("cell-live", 1, NOW + 60_000) },
    ]);
    await runCellReconciler({
      db,
      provider: provider as never,
      now: () => NOW,
    });
    expect(provider.teardown.mock.calls.map((c) => c[0])).toEqual(["old"]);
  });
});

describe("Access headers (AC-12 client half)", () => {
  interface Seen {
    method: string;
    url: string;
    headers: Headers;
    redirect: RequestRedirect | undefined;
  }

  function setAccess(): Seen[] {
    h.envState.url = BOX;
    h.envState.key = "box-api-key";
    h.envState.accessId = ACCESS_ID;
    h.envState.accessSecret = ACCESS_SECRET;
    const seen: Seen[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        seen.push({
          method,
          url,
          headers: new Headers(init?.headers),
          redirect: init?.redirect,
        });
        const { pathname, search } = new URL(url);
        if (method === "GET" && pathname === "/sandboxes") {
          return new Response(
            JSON.stringify({
              items: [{ id: "c1", metadata: tags("cell-old", 1, 10) }],
              pagination: { hasNextPage: false },
            }),
            { status: 200 },
          );
        }
        if (pathname.endsWith("/credential-vault")) {
          return new Response("{}", { status: 500 });
        }
        if (method === "PUT" && search.includes("networkpolicy")) {
          return new Response("{}", { status: 204 });
        }
        if (method === "DELETE") return new Response(null, { status: 204 });
        return new Response(
          JSON.stringify({ code: "DOCKER::SANDBOX_NOT_FOUND" }),
          { status: 404 },
        );
      }),
    );
    return seen;
  }

  it("every reconciler request carries both headers, manual redirects, only to the box", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen = setAccess();
    const provider = cellProvider();
    expect(provider).not.toBeNull();
    const r = await runCellReconciler({
      db,
      provider: provider!,
      now: () => 1000,
    });
    expect(r).toMatchObject({ reaped: 1 });
    // list, revoke, quarantine, delete, then the existence GET (revoke failed)
    expect(seen.map((s) => s.method)).toEqual([
      "GET",
      "DELETE",
      "PUT",
      "DELETE",
      "GET",
    ]);
    for (const s of seen) {
      expect(new URL(s.url).origin).toBe(BOX);
      expect(s.headers.get("CF-Access-Client-Id")).toBe(ACCESS_ID);
      expect(s.headers.get("CF-Access-Client-Secret")).toBe(ACCESS_SECRET);
      expect(s.headers.get("OPEN-SANDBOX-API-KEY")).toBe("box-api-key");
      expect(s.redirect).toBe("manual");
    }
  });

  it("both Access values empty sends no Access header", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const seen = setAccess();
    h.envState.accessId = "";
    h.envState.accessSecret = "";
    const provider = cellProvider();
    await runCellReconciler({ db, provider: provider!, now: () => 1000 });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.headers.has("CF-Access-Client-Id")).toBe(false);
      expect(s.headers.has("CF-Access-Client-Secret")).toBe(false);
      expect(s.redirect).toBeUndefined();
    }
  });

  it("accessFetch refuses a foreign origin with no fetch and no URL in the message", () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const f = accessFetch({
      origin: BOX,
      clientId: ACCESS_ID,
      clientSecret: ACCESS_SECRET,
    });
    let message = "";
    try {
      void f("https://evil.example.test/steal");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("evil.example.test");
    expect(spy).not.toHaveBeenCalled();
    // negative control: the configured origin goes through
    void f(`${BOX}/health`);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never leaks the client secret through a failing server, logs or thrown errors", async () => {
    const logs = (["log", "warn", "error", "info"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    h.envState.url = BOX;
    h.envState.key = "box-api-key";
    h.envState.accessId = ACCESS_ID;
    h.envState.accessSecret = ACCESS_SECRET;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_i: unknown, init?: RequestInit) => {
        const echoed = new Headers(init?.headers).get(
          "CF-Access-Client-Secret",
        );
        return new Response(JSON.stringify({ echoed }), { status: 500 });
      }),
    );
    const provider = cellProvider();
    let thrown = "";
    try {
      await runCellReconciler({ db, provider: provider!, now: () => 1000 });
    } catch (e) {
      thrown = JSON.stringify(e) + (e instanceof Error ? e.message : "");
      console.error("[cron:cell-reconciler] failed (non-fatal)", e);
    }
    const all = JSON.stringify(logs.flatMap((s) => s.mock.calls)) + thrown;
    expect(all).not.toContain(ACCESS_SECRET);
    expect(all).not.toContain(ACCESS_ID);
  });
});
