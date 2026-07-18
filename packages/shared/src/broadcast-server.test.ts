import { describe, it, expect, vi, afterEach } from "vitest";

// Force the realtime relay URL + secret so the publisher reaches the fetch call
// (otherwise it short-circuits on the missing-URL guard), and give it a concrete
// value to POST to.
vi.mock("@terragon/env/next-public", () => ({
  publicBroadcastUrl: () => "http://127.0.0.1:1/broadcast",
}));
vi.mock("@terragon/env/pkg-shared", () => ({
  env: { INTERNAL_SHARED_SECRET: "test-secret" },
}));

// The Workers service-binding path resolves env.BROADCAST via getCloudflareContext.
// Default: no context (throws) → off-Workers URL-fetch path. Tests that exercise
// the binding path set ctxHolder.value.
const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { value: undefined as unknown },
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    if (!ctxHolder.value) {
      throw new Error("context not available");
    }
    return ctxHolder.value;
  },
}));

import { publishBroadcastUserMessage } from "./broadcast-server";

const message = {
  type: "user" as const,
  id: "user-123",
  data: {},
};

describe("publishBroadcastUserMessage", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    ctxHolder.value = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not throw when the realtime relay is unreachable (fetch rejects)", async () => {
    // Bypass the NODE_ENV==="test" short-circuit so the real transport path runs.
    process.env.NODE_ENV = "development";
    const connRefused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const fetchMock = vi.fn().mockRejectedValue(connRefused);
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The realtime relay is a soft dependency: a failed publish must resolve,
    // never reject into the caller's lifecycle path (signup, thread creation…).
    await expect(publishBroadcastUserMessage(message)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("does not throw when the relay returns a non-OK status", async () => {
    process.env.NODE_ENV = "development";
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503 } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(publishBroadcastUserMessage(message)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("still skips the network entirely under NODE_ENV=test", async () => {
    // Guards the existing behavior: in the test environment no fetch is made.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishBroadcastUserMessage(message)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the BROADCAST service binding (not global fetch) when on Workers", async () => {
    process.env.NODE_ENV = "development";
    const bindingFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    ctxHolder.value = {
      env: {
        BROADCAST: { fetch: bindingFetch },
        INTERNAL_SHARED_SECRET: "ctx-secret",
      },
    };
    // If the binding path is taken, the global fetch must never be called (that
    // is the sibling-worker workers.dev fetch that 404s in production).
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);

    await expect(publishBroadcastUserMessage(message)).resolves.toBeUndefined();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(bindingFetch).toHaveBeenCalledTimes(1);

    const request = bindingFetch.mock.calls[0]![0] as Request;
    expect(new URL(request.url).pathname).toBe("/parties/main/user:user-123");
    expect(request.headers.get("X-Terragon-Secret")).toBe("ctx-secret");
  });

  it("falls back to the URL fetch when the binding is absent from the Workers env", async () => {
    process.env.NODE_ENV = "development";
    // Context present but no BROADCAST binding → URL fetch path.
    ctxHolder.value = { env: { INTERNAL_SHARED_SECRET: "ctx-secret" } };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishBroadcastUserMessage(message)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe("http://127.0.0.1:1/broadcast/parties/main/user:user-123");
  });
});
