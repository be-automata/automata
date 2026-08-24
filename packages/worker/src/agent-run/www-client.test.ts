import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pollThreadStatus,
  postEgressEvents,
  pollUntilTerminal,
  postRunFailed,
  postRunTerminal,
  checkRunStaleness,
  pullAgentCredentials,
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

describe("postEgressEvents (#66 audit sink, worker half)", () => {
  it("POSTs the batch to /api/daemon/egress-event with the daemon-token header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { inserted: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    await postEgressEvents(opts, [
      {
        destinationHost: "api.github.com",
        destinationPort: 443,
        action: "allow",
        policyLevel: "domain",
        source: "worker",
      },
      {
        destinationHost: "evil.example.com",
        action: "deny",
        policyLevel: "domain",
        source: "worker",
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.example.com/api/daemon/egress-event");
    expect(init.method).toBe("POST");
    expect(init.headers["x-daemon-token"]).toBe("daemon-token-abc");
    const body = JSON.parse(init.body);
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toEqual({
      destinationHost: "api.github.com",
      destinationPort: 443,
      action: "allow",
      policyLevel: "domain",
      source: "worker",
    });
    // Port is genuinely absent (not null) when unknown — the route's zod
    // schema takes optional, not nullable.
    expect("destinationPort" in body.events[1]).toBe(false);
  });

  it("sends a batch as ONE POST (callers keep batches ≤ the route's 100 cap)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { inserted: 20 }));
    vi.stubGlobal("fetch", fetchMock);

    await postEgressEvents(
      opts,
      Array.from({ length: 20 }, (_, i) => ({
        destinationHost: `h${i}.example.com`,
        action: "deny" as const,
        source: "worker" as const,
      })),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).events).toHaveLength(
      20,
    );
  });

  it("does nothing at all for an empty batch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await postEgressEvents(opts, []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("NEVER throws: a non-2xx and a network error are both logged and swallowed", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(500, { error: "x" })),
    );
    await expect(
      postEgressEvents(opts, [
        { destinationHost: "a.example.com", action: "deny", source: "worker" },
      ]),
    ).resolves.toBeUndefined();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(
      postEgressEvents(opts, [
        { destinationHost: "a.example.com", action: "deny", source: "worker" },
      ]),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(2);
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

describe("pullAgentCredentials (D1 credential delivery)", () => {
  it("POSTs the ids with the daemon-token header and returns the served credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        agent: "claude",
        credentials: { type: "json-file", contents: '{"token":"x"}' },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await pullAgentCredentials(opts);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.example.com/api/daemon/agent-credentials");
    expect(init.method).toBe("POST");
    expect(init.headers["x-daemon-token"]).toBe("daemon-token-abc");
    expect(JSON.parse(init.body)).toEqual({
      threadId: "thread-1",
      threadChatId: "chat-1",
    });
    expect(result).toEqual({
      agent: "claude",
      credentials: { type: "json-file", contents: '{"token":"x"}' },
    });
  });

  it("returns credits-only on 204 (user has no credential to deliver)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(204, null)));

    expect(await pullAgentCredentials(opts)).toEqual({
      agent: "",
      credentials: { type: "built-in-credits" },
    });
  });

  it.each([404, 500])(
    "falls back to credits (never throws) on %i — an older or wobbling control plane must not strand the run",
    async (status) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(status, { error: "nope" })),
      );

      expect(await pullAgentCredentials(opts)).toEqual({
        agent: "",
        credentials: { type: "built-in-credits" },
      });
      // The fallback is silent to the run but never silent in the logs.
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it("propagates a rejected fetch (abort/network) rather than masking it as credits", async () => {
    // The caller cleans up the workdir on this path; swallowing it here would
    // hide a cancelled run behind a successful-looking credits fallback.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
    );

    await expect(pullAgentCredentials(opts)).rejects.toThrow(/aborted/);
  });

  it("forwards the abort signal so a cancelled run aborts the in-flight pull", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(204, null));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await pullAgentCredentials(opts, controller.signal);

    expect(fetchMock.mock.calls[0]![1].signal).toBe(controller.signal);
  });
});

describe("postRunTerminal — superseded (#125 C1)", () => {
  const opts = {
    baseUrl: "https://www.example.com/",
    daemonToken: "tok",
    threadId: "thr_1",
    threadChatId: "tc_1",
    traceparent: "00-aa-bb-01",
  };

  it("POSTs the fenced terminal body and reports applied", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ applied: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const r = await postRunTerminal(opts, {
      runExternalId: "run-1",
      cause: "superseded",
      policy: "newest-wins",
    });
    expect(r).toBe("applied");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.example.com/api/daemon/run-terminal");
    expect(init.headers["x-daemon-token"]).toBe("tok");
    expect(init.headers.traceparent).toBe("00-aa-bb-01");
    expect(JSON.parse(init.body)).toEqual({
      threadId: "thr_1",
      threadChatId: "tc_1",
      runExternalId: "run-1",
      cause: "superseded",
      detail: { policy: "newest-wins" },
    });
    vi.unstubAllGlobals();
  });

  it("409 (generation fence) → 'rejected', never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("superseded", { status: 409 })),
    );
    await expect(
      postRunTerminal(opts, {
        runExternalId: "old",
        cause: "superseded",
        policy: "newest-wins",
      }),
    ).resolves.toBe("rejected");
    vi.unstubAllGlobals();
  });

  it("network failure → 'error', swallowed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(
      postRunTerminal(opts, {
        runExternalId: "r",
        cause: "superseded",
        policy: "newest-wins",
      }),
    ).resolves.toBe("error");
    vi.unstubAllGlobals();
  });
});

describe("postRunTerminal / checkRunStaleness (#125 C4)", () => {
  const opts = {
    baseUrl: "https://www.example.com/",
    daemonToken: "tok",
    threadId: "thr_1",
    threadChatId: "tc_1",
    runExternalId: "run-1",
  };

  it("posts a typed cause with the generation header; policy detail optional", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ applied: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await postRunTerminal(opts, { runExternalId: "run-1", cause: "timeout" }),
    ).toBe("applied");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["x-run-external-id"]).toBe("run-1");
    expect(JSON.parse(init.body)).toEqual({
      threadId: "thr_1",
      threadChatId: "tc_1",
      runExternalId: "run-1",
      cause: "timeout",
    });
    vi.unstubAllGlobals();
  });

  it("checkRunStaleness: true only on {stale:true}; any failure fails OPEN", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ stale: true }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response("nope", { status: 500 }))
        .mockRejectedValueOnce(new Error("ECONNRESET")),
    );
    expect(await checkRunStaleness(opts, { runExternalId: "run-1" })).toBe(
      true,
    );
    expect(await checkRunStaleness(opts, { runExternalId: "run-1" })).toBe(
      false,
    );
    expect(await checkRunStaleness(opts, { runExternalId: "run-1" })).toBe(
      false,
    );
    vi.unstubAllGlobals();
  });
});
