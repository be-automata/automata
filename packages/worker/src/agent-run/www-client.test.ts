import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pollThreadStatus,
  postEgressEvents,
  postRunCredentialSource,
  pollUntilTerminal,
  postRunFailed,
  postRunTerminal,
  postSelfHealAuditChecks,
  postSelfHealFixCheck,
  checkRunStaleness,
  pullAgentCredentials,
  CREDENTIAL_PULL_ATTEMPTS,
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

  it("redacts credential material from the reason before it is persisted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("OK", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const b64 = Buffer.from(
      "x-access-token:ghs_3211193_abcdefghijklmnop",
    ).toString("base64");
    await postRunFailed(opts, {
      reason: `run: Command failed: git -c http.extraHeader=AUTHORIZATION: basic ${b64} clone`,
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.messages[0].error_info).not.toContain(b64);
    expect(body.messages[0].error_info).toContain("basic <redacted>");
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

describe("postRunCredentialSource (#209 item 1, worker half)", () => {
  // Patterns that must NEVER appear in an attribution payload. The function
  // takes a closed union, so this is asserted rather than assumed.
  const SECRET_SHAPED =
    /sk-ant|sk-|ghp_|ghs_|Bearer |-----BEGIN|"contents"|"value"/;

  it("POSTs exactly {threadId, threadChatId, source} to the attribution route", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { recorded: true }));
    vi.stubGlobal("fetch", fetchMock);

    await postRunCredentialSource(opts, { source: "user-credential" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://www.example.com/api/daemon/run-credential-source",
    );
    expect(init.method).toBe("POST");
    expect(init.headers["x-daemon-token"]).toBe("daemon-token-abc");
    expect(JSON.parse(init.body)).toEqual({
      threadId: "thread-1",
      threadChatId: "chat-1",
      source: "user-credential",
    });
  });

  it("carries the trace + generation headers when the opts have them", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { recorded: true }));
    vi.stubGlobal("fetch", fetchMock);

    await postRunCredentialSource(
      { ...opts, traceparent: "00-abc-def-01", runExternalId: "run-ext-9" },
      { source: "box-key" },
    );

    const init = fetchMock.mock.calls[0]![1];
    expect(init.headers.traceparent).toBe("00-abc-def-01");
    expect(init.headers["x-run-external-id"]).toBe("run-ext-9");
  });

  it.each(["user-credential", "built-in-credits", "box-key"] as const)(
    "the serialized body for %s matches no secret-shaped pattern",
    async (source) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { recorded: true }));
      vi.stubGlobal("fetch", fetchMock);

      await postRunCredentialSource(opts, { source });

      const body = fetchMock.mock.calls[0]![1].body as string;
      expect(JSON.parse(body)).toEqual({
        threadId: "thread-1",
        threadChatId: "chat-1",
        source,
      });
      expect(SECRET_SHAPED.test(body)).toBe(false);
    },
  );

  it("NEVER throws: a non-2xx and a network error are both logged and swallowed", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(500, { error: "x" })),
    );
    await expect(
      postRunCredentialSource(opts, { source: "built-in-credits" }),
    ).resolves.toBeUndefined();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(
      postRunCredentialSource(opts, { source: "built-in-credits" }),
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

  it("returns stopped as soon as www reports `stopping` — the worker must tear down instead of waiting for terminal=true", async () => {
    const responses = [
      jsonResponse(200, { status: "working", terminal: false }),
      jsonResponse(200, { status: "stopping", terminal: false }),
      jsonResponse(200, { status: "stopping", terminal: false }), // never reached
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollUntilTerminal(ctx(), opts, 1, noSleep);
    expect(result).toEqual({ outcome: "stopped", finalStatus: "stopping" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

describe("pollUntilTerminal: the agent dies mid-run (#204)", () => {
  const working = () =>
    jsonResponse(200, { status: "working", terminal: false });
  const noSleep = async () => {};

  it("fails the run with the agent's own classified error, not a cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => working()),
    );
    const oom = new Error("agent run exceeded its memory ceiling");
    const ctx: PollContext = {
      cancelled: false,
      log: () => {},
      agentFailure: () => oom,
    };
    await expect(pollUntilTerminal(ctx, opts, 0, noSleep)).rejects.toBe(oom);
  });

  it("needs TWO consecutive sightings — one poll of grace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => working()),
    );
    let looks = 0;
    const ctx: PollContext = {
      // Ends the loop on the 3rd pass so the test terminates whatever happens;
      // the assertion is that it got there WITHOUT throwing.
      get cancelled() {
        return looks >= 3;
      },
      log: () => {},
      // Dead on the first look, alive on the second: a transient reading must
      // not fail the run.
      agentFailure: () => (++looks === 1 ? new Error("gone") : null),
    };
    const result = await pollUntilTerminal(ctx, opts, 0, noSleep);
    expect(result.outcome).toBe("cancelled");
    expect(looks).toBeGreaterThanOrEqual(3);
  });

  it("a terminal status wins over a dead agent — the daemon may exit first", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { status: "done", terminal: true }),
        ),
    );
    const result = await pollUntilTerminal(
      {
        cancelled: false,
        log: () => {},
        agentFailure: () => new Error("gone"),
      },
      opts,
      0,
      noSleep,
    );
    expect(result).toEqual({ outcome: "completed", finalStatus: "done" });
  });

  it("without the predicate the loop is what it always was", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { status: "done", terminal: true }),
        ),
    );
    const result = await pollUntilTerminal(
      { cancelled: false, log: () => {} },
      opts,
      0,
      noSleep,
    );
    expect(result.outcome).toBe("completed");
  });
});

describe("pullAgentCredentials: one network blip must not end a run (#212)", () => {
  const noSleep = async () => {};

  it("retries a throwing fetch and succeeds on a later attempt", async () => {
    // The exact transient that ended a real review run on 2026-09-29. The PR was
    // then left saying the review intent could not be parsed, which reads like
    // the agent misbehaved; it was the network.
    let calls = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls < 3) throw new TypeError("fetch failed");
        return jsonResponse(200, {
          agent: "claude",
          credentials: { type: "oauth" },
        });
      }),
    );
    const out = await pullAgentCredentials(opts, undefined, noSleep);
    expect(calls).toBe(3);
    expect(out.agent).toBe("claude");
    warn.mockRestore();
  });

  it("STILL propagates once the attempts are spent — never masked as credits", async () => {
    // Deliberate, and pinned by the pre-existing test above: the caller cleans
    // up the workdir on this path, so swallowing it would hide a cancelled run
    // behind a successful-looking credits fallback. Retrying changes how OFTEN
    // we get here, never what happens when we do.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn().mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", f);
    await expect(
      pullAgentCredentials(opts, undefined, noSleep),
    ).rejects.toThrow(/fetch failed/);
    expect(f).toHaveBeenCalledTimes(CREDENTIAL_PULL_ATTEMPTS);
    warn.mockRestore();
  });

  it("never retries an abort — the cancelled run has its answer", async () => {
    const f = vi
      .fn()
      .mockRejectedValue(new DOMException("aborted", "AbortError"));
    vi.stubGlobal("fetch", f);
    await expect(
      pullAgentCredentials(opts, undefined, noSleep),
    ).rejects.toThrow(/aborted/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("an HTTP error still falls back on the FIRST try, unchanged", async () => {
    // A 5xx or a 404 from an older control plane is not a network throw and must
    // not spend retries — that path was already correct.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    vi.stubGlobal("fetch", f);
    const out = await pullAgentCredentials(opts, undefined, noSleep);
    expect(out.credentials.type).toBe("built-in-credits");
    expect(f).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("bounds the attempts", () => {
    expect(CREDENTIAL_PULL_ATTEMPTS).toBeGreaterThan(1);
    expect(CREDENTIAL_PULL_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});

/**
 * Prod 2026-10-04 (e335c83d): 16 processes were OOM-killed inside a task run's
 * cgroup and the thread still ended as a clean "complete". A child OOM kill
 * (`next build` under the agent's Bash tool) does not end the agent's turn, so
 * the only signal is the cgroup's counter — and it has to be acted on BEFORE
 * the read that serves terminal=true, because that read revokes the daemon
 * token and onFailure could no longer mark the thread.
 */
describe("pollUntilTerminal: the run was memory-starved", () => {
  const noSleep = async () => {};

  it("fails the run with the starvation error while the thread is still working", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { status: "working", terminal: false }),
        ),
    );
    const oom = new Error("Out of memory: 16 process(es) killed");
    let looks = 0;
    const ctx: PollContext = {
      cancelled: false,
      log: () => {},
      // Healthy on the first pass, starved on the second: no grace — the
      // kernel counter is a positive signal, not an exit-vs-write race.
      memoryStarvation: () => (++looks >= 2 ? oom : null),
    };
    await expect(pollUntilTerminal(ctx, opts, 0, noSleep)).rejects.toBe(oom);
    expect(looks).toBe(2);
  });

  it("checks BEFORE the status read, so a finished-but-starved run never consumes its terminal read", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { status: "complete", terminal: true }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const oom = new Error("Out of memory: 2 process(es) killed");
    await expect(
      pollUntilTerminal(
        { cancelled: false, log: () => {}, memoryStarvation: () => oom },
        opts,
        0,
        noSleep,
      ),
    ).rejects.toBe(oom);
    // The terminal read is what revokes the token onFailure needs.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an OOM that lands during the terminal read still fails the run", async () => {
    // The narrow residual: clean at the pre-read check, starved by the time
    // terminal comes back. The thread may no longer be markable (token
    // revoked), but the run must not report success.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { status: "complete", terminal: true }),
        ),
    );
    const oom = new Error("Out of memory: 1 process(es) killed");
    let looks = 0;
    const logs: string[] = [];
    await expect(
      pollUntilTerminal(
        {
          cancelled: false,
          log: (m) => logs.push(m),
          memoryStarvation: () => (++looks >= 2 ? oom : null),
        },
        opts,
        0,
        noSleep,
      ),
    ).rejects.toBe(oom);
    expect(logs.join("\n")).toMatch(/memory-starved after the thread/);
  });

  it("a healthy run completes exactly as before", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { status: "complete", terminal: true }),
        ),
    );
    const result = await pollUntilTerminal(
      { cancelled: false, log: () => {}, memoryStarvation: () => null },
      opts,
      0,
      noSleep,
    );
    expect(result).toEqual({ outcome: "completed", finalStatus: "complete" });
  });

  it("a cancellation still wins — a superseded run is not re-labelled OOM", async () => {
    const result = await pollUntilTerminal(
      {
        cancelled: true,
        log: () => {},
        memoryStarvation: () => new Error("Out of memory"),
      },
      opts,
      0,
      noSleep,
    );
    expect(result.outcome).toBe("cancelled");
  });
});

describe("postSelfHealAuditChecks (FORGE-01 / TMO-01)", () => {
  const TOKEN = "CHECK_TOKEN_SENTINEL_123";
  const RESULTS = [
    { fingerprint: "0123456789abcdef", outcome: "pass" as const },
  ];
  const noSleep = vi.fn(async (_ms: number) => {});

  function post(fetchImpl: typeof fetch, sleep = noSleep) {
    return postSelfHealAuditChecks({
      baseUrl: "https://www.example.com/",
      checkToken: TOKEN,
      threadId: "thread-1",
      results: RESULTS,
      fetchImpl,
      sleep,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    noSleep.mockClear();
  });

  it("maps recorded true/false to recorded/duplicate", async () => {
    const f1 = vi.fn(async () => jsonResponse(200, { recorded: true }));
    expect(await post(f1 as unknown as typeof fetch)).toBe("recorded");
    const f2 = vi.fn(async () => jsonResponse(200, { recorded: false }));
    expect(await post(f2 as unknown as typeof fetch)).toBe("duplicate");
  });

  it.each([
    [409, "sealed"],
    [401, "error"],
    [403, "error"],
    [404, "error"],
  ])("status %i is final (no retry) -> %s", async (status, expected) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async () => jsonResponse(status, {}));
    expect(await post(f as unknown as typeof fetch)).toBe(expected);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 after a 2 s backoff with the SAME token and never sends the daemon token", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { recorded: true }));
    expect(await post(f as unknown as typeof fetch)).toBe("recorded");
    expect(noSleep).toHaveBeenCalledWith(2_000);
    for (const call of f.mock.calls) {
      const init = call[1] as RequestInit;
      const h = init.headers as Record<string, string>;
      expect(h["x-self-heal-check-token"]).toBe(TOKEN);
      expect(h["x-daemon-token"]).toBeUndefined();
      expect(call[0]).toBe(
        "https://www.example.com/api/self-heal/audit-checks",
      );
    }
  });

  it("bounds each attempt with a 10 s abort signal, tries 3 times with 2/4 s backoff, then errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await post(f as unknown as typeof fetch)).toBe("error");
    expect(f).toHaveBeenCalledTimes(3);
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([2_000, 4_000]);
  });

  it("never logs the token", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await post(
      vi.fn(async () => jsonResponse(503, {})) as unknown as typeof fetch,
    );
    await post(
      vi.fn(async () => jsonResponse(404, {})) as unknown as typeof fetch,
    );
    await post(
      vi.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch,
    );
    const logged = JSON.stringify([
      err.mock.calls,
      warn.mock.calls,
      log.mock.calls,
    ]);
    expect(logged).not.toContain(TOKEN);
  });
});

describe("postSelfHealFixCheck (GATE-01 / TMO-01)", () => {
  const TOKEN = "GATE_TOKEN_SENTINEL_456";
  const ATTEMPT = "11111111-1111-4111-8111-111111111111";
  const REPORT = {
    workerStatus: "completed" as const,
    headSha: "a".repeat(40),
    checkOutcome: "pass" as const,
    deniedPaths: [],
  };
  const noSleep = vi.fn(async (_ms: number) => {});

  function post(fetchImpl: typeof fetch, sleep = noSleep) {
    return postSelfHealFixCheck({
      baseUrl: "https://www.example.com/",
      gateToken: TOKEN,
      attemptId: ATTEMPT,
      report: REPORT,
      fetchImpl,
      sleep,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    noSleep.mockClear();
  });

  it("POSTs the 09-09 body to /api/self-heal/fix-check with x-self-heal-gate-token and no daemon token", async () => {
    const f = vi.fn(async () => jsonResponse(200, { recorded: true }));
    expect(await post(f as unknown as typeof fetch)).toBe("recorded");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.example.com/api/self-heal/fix-check");
    const h = init.headers as Record<string, string>;
    expect(h["x-self-heal-gate-token"]).toBe(TOKEN);
    expect(h["x-daemon-token"]).toBeUndefined();
    expect(h["X-Daemon-Token"]).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({
      attemptId: ATTEMPT,
      ...REPORT,
    });
  });

  it("recorded:false is a duplicate and is not retried", async () => {
    const f = vi.fn(async () => jsonResponse(200, { recorded: false }));
    expect(await post(f as unknown as typeof fetch)).toBe("duplicate");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("503 then 200 → recorded, after a 2 s backoff, with the SAME token", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { recorded: true }));
    expect(await post(f as unknown as typeof fetch)).toBe("recorded");
    expect(f).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledWith(2_000);
    const tokens = f.mock.calls.map(
      (c) =>
        ((c[1] as RequestInit).headers as Record<string, string>)[
          "x-self-heal-gate-token"
        ],
    );
    expect(tokens).toEqual([TOKEN, TOKEN]);
  });

  it.each([400, 401, 403, 404, 422])(
    "status %i is final: error, no retry",
    async (status) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const f = vi.fn(async () => jsonResponse(status, {}));
      expect(await post(f as unknown as typeof fetch)).toBe("error");
      expect(f).toHaveBeenCalledTimes(1);
    },
  );

  it("a hang is cut at 10 s per attempt; 3 attempts with 2/4 s backoff, then error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await post(f as unknown as typeof fetch)).toBe("error");
    expect(f).toHaveBeenCalledTimes(3);
    expect(timeoutSpy.mock.calls.map((c) => c[0])).toEqual([
      10_000, 10_000, 10_000,
    ]);
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([2_000, 4_000]);
  });

  it("never logs the token", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await post(
      vi.fn(async () => jsonResponse(503, {})) as unknown as typeof fetch,
    );
    await post(
      vi.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch,
    );
    await post(
      vi.fn(async () => {
        throw new Error(`boom ${TOKEN}`);
      }) as unknown as typeof fetch,
    );
    const logged = JSON.stringify([
      err.mock.calls,
      warn.mock.calls,
      log.mock.calls,
    ]);
    expect(logged).not.toContain(TOKEN);
    expect(err).toHaveBeenCalled();
  });
});
