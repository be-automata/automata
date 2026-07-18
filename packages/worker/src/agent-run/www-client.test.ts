import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pollThreadStatus,
  pollUntilTerminal,
  pullNextMessage,
  type PollContext,
  type WwwClientOpts,
} from "./www-client";

const opts: WwwClientOpts = {
  baseUrl: "https://www.example.com/",
  daemonToken: "daemon-token-abc",
  threadId: "thread-1",
  threadChatId: "chat-1",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pullNextMessage", () => {
  it("POSTs the ids in the body with the daemon-token header, returns the message", async () => {
    const message = {
      type: "claude",
      model: "sonnet",
      agent: "claudeCode",
      agentVersion: 1,
      prompt: "do the thing",
      sessionId: null,
      permissionMode: "allowAll",
      featureFlags: {},
    };
    const fetchMock = vi.fn(async () => jsonResponse(200, message));
    vi.stubGlobal("fetch", fetchMock);

    const result = await pullNextMessage(opts);

    expect(result).toEqual(message);
    const [url, init] = fetchMock.mock.calls[0]!;
    // Trailing slash on baseUrl is normalised (no double slash).
    expect(url).toBe("https://www.example.com/api/daemon/next-message");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>)["x-daemon-token"]).toBe(
      "daemon-token-abc",
    );
    expect(JSON.parse(init!.body as string)).toEqual({
      threadId: "thread-1",
      threadChatId: "chat-1",
    });
  });

  it("returns null on 204 (nothing to run)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(204, null)));
    expect(await pullNextMessage(opts)).toBeNull();
  });

  it("throws on a non-2xx that is not 204", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "x" })));
    await expect(pullNextMessage(opts)).rejects.toThrow(/HTTP 500/);
  });
});

describe("pollThreadStatus", () => {
  it("returns the status body on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { status: "working", terminal: false })),
    );
    expect(await pollThreadStatus(opts)).toEqual({
      kind: "status",
      status: "working",
      terminal: false,
    });
  });

  it("maps 401 and 403 to auth-error (candidate revocation signal)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "x" })));
    expect(await pollThreadStatus(opts)).toEqual({
      kind: "auth-error",
      httpStatus: 401,
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { error: "x" })));
    expect(await pollThreadStatus(opts)).toEqual({
      kind: "auth-error",
      httpStatus: 403,
    });
  });

  it("throws on other non-2xx (e.g. 500)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, {})));
    await expect(pollThreadStatus(opts)).rejects.toThrow(/HTTP 500/);
  });
});

describe("pollUntilTerminal — revoke-race ruling", () => {
  const noSleep = async () => {};
  function ctx(): PollContext & { logs: string[] } {
    const logs: string[] = [];
    return { cancelled: false, log: (m: string) => logs.push(m), logs };
  }

  it("returns completed when a poll reports terminal:true", async () => {
    const responses = [
      jsonResponse(200, { status: "working", terminal: false }),
      jsonResponse(200, { status: "complete", terminal: true }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));

    const result = await pollUntilTerminal(ctx(), opts, 1, noSleep);
    expect(result).toEqual({ outcome: "completed", finalStatus: "complete" });
  });

  it("treats a 401 AFTER a successful poll as terminal-inferred-from-revocation", async () => {
    const responses = [
      jsonResponse(200, { status: "working", terminal: false }),
      jsonResponse(401, { error: "revoked" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));

    const c = ctx();
    const result = await pollUntilTerminal(c, opts, 1, noSleep);
    expect(result).toEqual({ outcome: "completed", finalStatus: "working" });
    expect(c.logs).toContain("terminal-inferred-from-revocation");
  });

  it("throws when the FIRST poll is a 401 (a real auth error)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "x" })));
    await expect(pollUntilTerminal(ctx(), opts, 1, noSleep)).rejects.toThrow(
      /first poll/,
    );
  });

  it("stops with outcome cancelled when the context is cancelled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { status: "working", terminal: false })),
    );
    const cancelledCtx: PollContext = { cancelled: true, log: () => {} };
    const result = await pollUntilTerminal(cancelledCtx, opts, 1, noSleep);
    expect(result.outcome).toBe("cancelled");
  });
});
