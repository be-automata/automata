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
});
