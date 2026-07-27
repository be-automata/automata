import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pollThreadStatus,
  pollUntilTerminal,
  postRunFailed,
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

describe("postRunFailed (#2 terminal-failure callback)", () => {
  it("POSTs exactly one custom-error with the reason + the daemon-token header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("OK", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await postRunFailed(opts, { reason: "run: daemon rejected the message" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.example.com/api/daemon-event");
    expect(init.method).toBe("POST");
    expect(init.headers["x-daemon-token"]).toBe("daemon-token-abc");
    const body = JSON.parse(init.body);
    expect(body.threadId).toBe("thread-1");
    expect(body.threadChatId).toBe("chat-1");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      type: "custom-error",
      error_info: "run: daemon rejected the message",
    });
  });

  it("truncates a long reason and never carries prompt/agent content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("OK", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const reason = "E".repeat(2000);
    await postRunFailed(opts, { reason });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.messages[0].error_info.length).toBe(500);
    // Nothing prompt-shaped is ever in the payload — it's a bare error summary.
    expect(JSON.stringify(body)).not.toContain("prompt");
  });

  it("a 401 (revoked token) is logged, NOT thrown (watchdog is the backstop)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("no", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      postRunFailed(opts, { reason: "run: revoked" }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });

  it("a network error is swallowed (onFailure must never throw)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      postRunFailed(opts, { reason: "run: boom" }),
    ).resolves.toBeUndefined();
  });
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
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, message),
    );
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(204, null)),
    );
    expect(await pullNextMessage(opts)).toBeNull();
  });

  it("forwards the traceparent header when set (#7), and omits it when unset", async () => {
    // With a traceparent on the opts, every www call carries it so the control-plane
    // handler + GitHub post join the dispatch-minted trace.
    const withTrace: WwwClientOpts = {
      ...opts,
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    };
    const fetchWith = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, { status: "working", terminal: false }),
    );
    vi.stubGlobal("fetch", fetchWith);
    await pollThreadStatus(withTrace);
    expect(
      (fetchWith.mock.calls[0]![1]!.headers as Record<string, string>)
        .traceparent,
    ).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");

    // Without one (the pre-#7 / in-sandbox path) the header is simply absent.
    const fetchWithout = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, { status: "working", terminal: false }),
    );
    vi.stubGlobal("fetch", fetchWithout);
    await pollThreadStatus(opts);
    expect(
      (fetchWithout.mock.calls[0]![1]!.headers as Record<string, string>)
        .traceparent,
    ).toBeUndefined();
  });

  it("throws on a non-2xx that is not 204", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { error: "x" })),
    );
    await expect(pullNextMessage(opts)).rejects.toThrow(/HTTP 500/);
  });
});

describe("pollThreadStatus", () => {
  it("returns the status body on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, { status: "working", terminal: false }),
      ),
    );
    expect(await pollThreadStatus(opts)).toEqual({
      kind: "status",
      status: "working",
      terminal: false,
    });
  });

  it("maps 401 and 403 to auth-error (candidate revocation signal)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "x" })),
    );
    expect(await pollThreadStatus(opts)).toEqual({
      kind: "auth-error",
      httpStatus: 401,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: "x" })),
    );
    expect(await pollThreadStatus(opts)).toEqual({
      kind: "auth-error",
      httpStatus: 403,
    });
  });

  it("throws on other non-2xx (e.g. 500)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, {})),
    );
    await expect(pollThreadStatus(opts)).rejects.toThrow(/HTTP 500/);
  });
});

describe("pollUntilTerminal — terminal via terminal=true; auth-error is failure", () => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses.shift()!),
    );

    const result = await pollUntilTerminal(ctx(), opts, 1, noSleep);
    expect(result).toEqual({ outcome: "completed", finalStatus: "complete" });
  });

  it("throws on a 401 AFTER a successful poll without terminal=true (premature revocation, not completion)", async () => {
    // Under revoke-on-terminal-read www revokes only after serving terminal=true (which
    // the loop returns on). A 401 here means the token died mid-run without the worker
    // observing terminal — a premature revocation → LOUD failure, never silent completed.
    const responses = [
      jsonResponse(200, { status: "working", terminal: false }),
      jsonResponse(401, { error: "revoked" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses.shift()!),
    );

    await expect(pollUntilTerminal(ctx(), opts, 1, noSleep)).rejects.toThrow(
      /premature revocation/,
    );
  });

  it("returns completed on terminal=true even if the token is revoked immediately after (revoke-on-read happy path)", async () => {
    // The terminal=true poll returns before the next poll would see the 401, so the
    // revoke-on-read revocation never reaches the worker's loop.
    const responses = [
      jsonResponse(200, { status: "working", terminal: false }),
      jsonResponse(200, { status: "complete", terminal: true }),
      jsonResponse(401, { error: "revoked" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses.shift()!),
    );

    const result = await pollUntilTerminal(ctx(), opts, 1, noSleep);
    expect(result).toEqual({ outcome: "completed", finalStatus: "complete" });
  });

  it("throws when the FIRST poll is a 401 (a real auth error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "x" })),
    );
    await expect(pollUntilTerminal(ctx(), opts, 1, noSleep)).rejects.toThrow(
      /first poll/,
    );
  });

  it("stops with outcome cancelled when the context is cancelled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, { status: "working", terminal: false }),
      ),
    );
    const cancelledCtx: PollContext = { cancelled: true, log: () => {} };
    const result = await pollUntilTerminal(cancelledCtx, opts, 1, noSleep);
    expect(result.outcome).toBe("cancelled");
  });

  it("stops with outcome cancelled when the abort signal fires (Hatchet cancel/timeout)", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, { status: "working", terminal: false }),
      ),
    );
    const abortedCtx: PollContext = {
      cancelled: false,
      log: () => {},
      signal: controller.signal,
    };
    const result = await pollUntilTerminal(abortedCtx, opts, 1, noSleep);
    expect(result.outcome).toBe("cancelled");
  });

  it("treats a mid-poll AbortError as cancellation (not a hard failure) so teardown runs", async () => {
    const controller = new AbortController();
    // First poll works; then cancel + make the next fetch reject as if aborted.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return jsonResponse(200, { status: "working", terminal: false });
        }
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      }),
    );
    const abortCtx: PollContext = {
      cancelled: false,
      get signal() {
        return controller.signal;
      },
      log: () => {},
    };
    const result = await pollUntilTerminal(abortCtx, opts, 1, noSleep);
    expect(result.outcome).toBe("cancelled");
  });
});
