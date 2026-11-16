import { afterEach, describe, expect, it, vi } from "vitest";

import type { CellCreatePlan } from "@terragon/types/cell";

import {
  CellProviderError,
  createOpenSandboxCellProvider,
  OPENSANDBOX_SELF_CHECK_BLOCKED_EXIT,
  type OpenSandboxCellConfig,
} from "./opensandbox-cell";

const API_KEY = "API-KEY-CANARY-123";
const CREDENTIAL = "VAULT-CREDENTIAL-CANARY-456";
const BASE = "http://os.test";

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}
type Handler = (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function sse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { status: 200 });
}

const probe = (code: number) =>
  sse([
    { type: "stdout", text: "probe\n" },
    { type: "execution_complete", exit_code: code },
  ]);

/** Routes by "METHOD path-prefix"; a list of handlers is consumed in order, the last repeats. */
function makeServer() {
  const calls: Call[] = [];
  const routes: { key: string; handlers: Handler[] }[] = [];
  const on = (key: string, ...handlers: Handler[]) => {
    routes.unshift({ key, handlers });
  };
  const fetchSpy = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const call: Call = {
        method: init?.method ?? "GET",
        path: url.pathname + url.search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: { ...(init?.headers as Record<string, string>) },
      };
      calls.push(call);
      const line = `${call.method} ${call.path}`;
      const route = routes
        .filter((r) => line.startsWith(r.key))
        .reduce<
          (typeof routes)[number] | undefined
        >((best, r) => (!best || r.key.length > best.key.length ? r : best), undefined);
      if (!route) throw new Error(`unrouted ${call.method} ${call.path}`);
      const handler =
        route.handlers.length > 1 ? route.handlers.shift() : route.handlers[0];
      return handler!(call);
    },
  );
  const count = (key: string) =>
    calls.filter((c) => `${c.method} ${c.path}`.startsWith(key)).length;
  return { calls, on, fetchSpy, count };
}

function happyRoutes(server: ReturnType<typeof makeServer>) {
  server.on("POST /sandboxes/c1/proxy/44772/command", () => probe(3));
  server.on("POST /sandboxes/c1/credential-vault", () => json(201, {}));
  server.on(
    "DELETE /sandboxes/c1/credential-vault",
    () => new Response(null, { status: 204 }),
  );
  server.on("PUT /sandboxes/c1/networkpolicy?dropEstablished=true", () =>
    json(200, {}),
  );
  server.on("DELETE /sandboxes/c1", () => new Response(null, { status: 204 }));
  server.on("GET /sandboxes/c1/proxy/44772/ping", () => json(200, {}));
  server.on("POST /sandboxes", () => json(202, { id: "c1" }));
}

function plan(patch: Partial<CellCreatePlan> = {}): CellCreatePlan {
  return {
    runtime: "runc",
    tags: {
      automata: "cell",
      worker: "w1",
      epoch: "e1",
      stepKey: "step-1",
      attempt: "2",
      expiresAt: "1795000000000",
    },
    networkPolicy: {
      defaultAction: "deny",
      egress: [{ action: "allow", target: "broker.test", ports: [443] }],
    },
    vault: [
      {
        name: "model",
        hosts: ["broker.test"],
        paths: ["/v1/*"],
        auth: "bearer",
        credential: CREDENTIAL,
      },
    ],
    resources: { cpu: 2, memoryMiB: 2048 },
    ttlMs: 600_000,
    egressDigest: "digest",
    profileId: "test/profile",
    ...patch,
  };
}

function setup(configPatch: Partial<OpenSandboxCellConfig> = {}) {
  const server = makeServer();
  let clock = 0;
  const sleeps: number[] = [];
  const logs: unknown[][] = [];
  const logger = {
    info: vi.fn((...a: unknown[]) => void logs.push(a)),
    warn: vi.fn((...a: unknown[]) => void logs.push(a)),
  };
  const provider = createOpenSandboxCellProvider(
    {
      baseUrl: BASE,
      apiKey: API_KEY,
      image: "registry.test/cell@sha256:abc",
      entrypoint: ["/bin/sleep", "infinity"],
      selfCheck: { argv: ["/probe"] },
      ...configPatch,
    },
    {
      fetch: server.fetchSpy as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      logger,
    },
  );
  return { server, provider, sleeps, logs, logger };
}

async function rejection(p: Promise<unknown>): Promise<CellProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CellProviderError);
    return e as CellProviderError;
  }
  throw new Error("expected a rejection");
}

afterEach(() => vi.restoreAllMocks());

describe("create guards (AC-2)", () => {
  it.each([
    ["runtime not runc", { runtime: "runsc" } as unknown, "runtime_not_runc"],
    [
      "no networkPolicy",
      { networkPolicy: undefined } as unknown,
      "policy_required",
    ],
    [
      "non-deny default",
      { networkPolicy: { defaultAction: "allow", egress: [] } } as unknown,
      "policy_required",
    ],
    [
      "egress not an array",
      { networkPolicy: { defaultAction: "deny", egress: null } } as unknown,
      "policy_required",
    ],
    ["ttl under 60 s", { ttlMs: 59_000 } as unknown, "ttl_too_short"],
  ])("%s: refused with zero fetch calls", async (_n, patch, code) => {
    const { server, provider } = setup();
    const err = await rejection(
      provider.create(plan(patch as Partial<CellCreatePlan>)),
    );
    expect(err.code).toBe(code);
    expect(server.fetchSpy).not.toHaveBeenCalled();
  });
});

describe("create", () => {
  it("posts the exact body, self-checks, then writes the vault", async () => {
    const { server, provider } = setup();
    happyRoutes(server);
    const p = plan();
    await expect(provider.create(p)).resolves.toEqual({ cellId: "c1" });
    const post = server.calls[0]!;
    expect(post.path).toBe("/sandboxes");
    expect(post.headers["OPEN-SANDBOX-API-KEY"]).toBe(API_KEY);
    expect(post.headers["content-type"]).toBe("application/json");
    expect(post.body).toEqual({
      image: { uri: "registry.test/cell@sha256:abc" },
      entrypoint: ["/bin/sleep", "infinity"],
      timeout: 600,
      resourceLimits: { cpu: "2000m", memory: "2048Mi" },
      metadata: p.tags,
      networkPolicy: p.networkPolicy,
      credentialProxy: { enabled: true },
    });
    const order = server.calls.map((c) => `${c.method} ${c.path}`);
    expect(order).toEqual([
      "POST /sandboxes",
      "GET /sandboxes/c1/proxy/44772/ping",
      "POST /sandboxes/c1/proxy/44772/command",
      "POST /sandboxes/c1/credential-vault",
    ]);
    expect(server.calls[2]!.body).toEqual({
      argv: ["/probe"],
      timeout: 120_000,
    });
    expect(server.calls[3]!.body).toEqual({
      credentials: [
        { name: "model", source: { type: "inline", value: CREDENTIAL } },
      ],
      bindings: [
        {
          name: "model",
          match: { hosts: ["broker.test"], paths: ["/v1/*"] },
          auth: { type: "bearer", credential: "model" },
        },
      ],
    });
  });

  it("omits match.paths when the entry has none and floors cpu at 1m", async () => {
    const { server, provider } = setup();
    happyRoutes(server);
    const base = plan();
    const entry = { ...base.vault[0]!, paths: undefined };
    await provider.create(
      plan({ vault: [entry], resources: { cpu: 0.0001, memoryMiB: 64 } }),
    );
    expect(server.calls[0]!.body).toMatchObject({
      resourceLimits: { cpu: "1m", memory: "64Mi" },
    });
    expect(server.calls[3]!.body).toMatchObject({
      bindings: [{ match: { hosts: ["broker.test"] } }],
    });
  });

  it("a 2xx without an id throws http_error", async () => {
    const { server, provider } = setup();
    server.on("POST /sandboxes", () => json(202, {}));
    const err = await rejection(provider.create(plan()));
    expect(err.code).toBe("http_error");
  });

  it("a 500 on create is http_error and not retried", async () => {
    const { server, provider } = setup();
    server.on("POST /sandboxes", () => json(500, { code: "X" }));
    const err = await rejection(provider.create(plan()));
    expect(err).toMatchObject({ code: "http_error", status: 500 });
    expect(server.count("POST /sandboxes")).toBe(1);
  });
});

describe("create retries and list-and-adopt", () => {
  it("retries a 502 BACKEND_CONNECTION_FAILED on create", async () => {
    const { server, provider, sleeps } = setup();
    happyRoutes(server);
    server.on(
      "POST /sandboxes",
      () => json(502, { code: "BACKEND_CONNECTION_FAILED" }),
      () => json(202, { id: "c1" }),
    );
    await expect(provider.create(plan())).resolves.toEqual({ cellId: "c1" });
    expect(sleeps).toContain(250);
    expect(server.count("GET /sandboxes?metadata")).toBe(0);
  });

  it("a connection-failed 502 that outlasts the budget throws without listing", async () => {
    const { server, provider } = setup();
    server.on("POST /sandboxes", () =>
      json(502, { code: "BACKEND_CONNECTION_FAILED" }),
    );
    const err = await rejection(provider.create(plan()));
    expect(err).toMatchObject({ code: "http_error", status: 502 });
    expect(server.count("GET /sandboxes?metadata")).toBe(0);
  });

  it("any other 502 lists by stepKey+attempt and adopts exactly one match", async () => {
    const { server, provider } = setup();
    happyRoutes(server);
    server.on("POST /sandboxes", () => json(502, { code: "OTHER" }));
    server.on("GET /sandboxes?metadata", () =>
      json(200, {
        items: [{ id: "c1", metadata: { stepKey: "step-1" } }],
        pagination: { hasNextPage: false },
      }),
    );
    await expect(provider.create(plan())).resolves.toEqual({ cellId: "c1" });
    expect(server.count("POST /sandboxes/c1/credential-vault")).toBe(1);
    const list = server.calls.find((c) =>
      c.path.startsWith("/sandboxes?metadata"),
    )!;
    const filter = new URLSearchParams(
      decodeURIComponent(
        new URL(BASE + list.path).searchParams.get("metadata")!,
      ),
    );
    expect(Object.fromEntries(filter)).toEqual({
      automata: "cell",
      stepKey: "step-1",
      attempt: "2",
    });
    expect(
      server.calls.filter(
        (c) => c.method === "POST" && c.path === "/sandboxes",
      ),
    ).toHaveLength(1);
  });

  it("finds nothing at first, then a match within the budget", async () => {
    const { server, provider } = setup();
    happyRoutes(server);
    server.on(
      "POST /sandboxes",
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    );
    server.on(
      "GET /sandboxes?metadata",
      () => json(200, { items: [], pagination: { hasNextPage: false } }),
      () =>
        json(200, {
          items: [{ id: "c1", metadata: {} }],
          pagination: { hasNextPage: false },
        }),
    );
    await expect(provider.create(plan())).resolves.toEqual({ cellId: "c1" });
    expect(server.count("GET /sandboxes?metadata")).toBe(2);
  });

  it("finds nothing after the budget and throws http_error", async () => {
    const { server, provider } = setup();
    server.on("POST /sandboxes", () => json(502, { code: "OTHER" }));
    server.on("GET /sandboxes?metadata", () =>
      json(200, { items: [], pagination: { hasNextPage: false } }),
    );
    const err = await rejection(provider.create(plan()));
    expect(err).toMatchObject({ code: "http_error", status: 502 });
    expect(server.count("POST /sandboxes")).toBe(1);
  });

  it("more than one match quarantines and deletes them all, then throws", async () => {
    const { server, provider } = setup();
    server.on("POST /sandboxes", () => json(502, { code: "OTHER" }));
    server.on("GET /sandboxes?metadata", () =>
      json(200, {
        items: [{ id: "a" }, { id: "b" }],
        pagination: { hasNextPage: false },
      }),
    );
    for (const id of ["a", "b"]) {
      server.on(`PUT /sandboxes/${id}/networkpolicy?dropEstablished=true`, () =>
        json(200, {}),
      );
      server.on(
        `DELETE /sandboxes/${id}`,
        () => new Response(null, { status: 204 }),
      );
    }
    const err = await rejection(provider.create(plan()));
    expect(err.code).toBe("http_error");
    expect(server.count("PUT /sandboxes/a/networkpolicy")).toBe(1);
    expect(server.count("PUT /sandboxes/b/networkpolicy")).toBe(1);
    expect(server.count("DELETE /sandboxes/a")).toBe(1);
    expect(server.count("DELETE /sandboxes/b")).toBe(1);
  });
});

describe("readiness", () => {
  it("counts a rejection and a non-2xx as not yet, then proceeds", async () => {
    const { server, provider, sleeps } = setup();
    happyRoutes(server);
    server.on(
      "GET /sandboxes/c1/proxy/44772/ping",
      () => {
        throw new Error("ECONNRESET");
      },
      () => json(503, {}),
      () => json(200, {}),
    );
    await provider.create(plan());
    expect(sleeps.filter((s) => s === 100)).toHaveLength(2);
  });

  it("times out: tears down and throws not_ready", async () => {
    const { server, provider } = setup({ readyTimeoutMs: 1000 });
    happyRoutes(server);
    server.on("GET /sandboxes/c1/proxy/44772/ping", () => json(503, {}));
    const err = await rejection(provider.create(plan()));
    expect(err.code).toBe("not_ready");
    expect(server.count("PUT /sandboxes/c1/networkpolicy")).toBe(1);
    expect(server.count("DELETE /sandboxes/c1")).toBe(1);
    expect(server.count("POST /sandboxes/c1/credential-vault")).toBe(0);
    expect(server.count("DELETE /sandboxes/c1/credential-vault")).toBe(0);
  });
});

describe("self-check fails closed (AC-4)", () => {
  it.each([
    ["exit 0", () => probe(0)],
    ["exit 1", () => probe(1)],
    [
      "error event without an exit code",
      () => sse([{ type: "error", error: { message: "boom" } }]),
    ],
    [
      "an error event even carrying exit 3",
      () => sse([{ type: "error", error: { exit_code: 3 } }]),
    ],
    ["a 500 from /command", () => json(500, {})],
    [
      "a stream with no terminal event",
      () => sse([{ type: "stdout", text: "x" }]),
    ],
    [
      "a BACKEND_RESPONSE_FAILED 502",
      () => json(502, { code: "BACKEND_RESPONSE_FAILED" }),
    ],
  ])("%s: tears down, never writes the vault", async (_n, command) => {
    const { server, provider } = setup();
    happyRoutes(server);
    server.on("POST /sandboxes/c1/proxy/44772/command", command);
    const err = await rejection(provider.create(plan()));
    expect(err.code).toBe("egress_not_enforced");
    expect(
      server.count("PUT /sandboxes/c1/networkpolicy?dropEstablished=true"),
    ).toBe(1);
    expect(server.count("DELETE /sandboxes/c1")).toBe(1);
    expect(server.count("POST /sandboxes/c1/credential-vault")).toBe(0);
    expect(server.count("DELETE /sandboxes/c1/credential-vault")).toBe(0);
    expect(OPENSANDBOX_SELF_CHECK_BLOCKED_EXIT).toBe(3);
  });

  it("a BACKEND_RESPONSE_FAILED 502 is not retried", async () => {
    const { server, provider } = setup();
    happyRoutes(server);
    server.on("POST /sandboxes/c1/proxy/44772/command", () =>
      json(502, { code: "BACKEND_RESPONSE_FAILED" }),
    );
    await rejection(provider.create(plan()));
    expect(server.count("POST /sandboxes/c1/proxy/44772/command")).toBe(1);
  });

  it("a first BACKEND_CONNECTION_FAILED 502 is retried, then exit 3 enforces", async () => {
    const { server, provider } = setup();
    happyRoutes(server);
    server.on(
      "POST /sandboxes/c1/proxy/44772/command",
      () => json(502, { code: "BACKEND_CONNECTION_FAILED" }),
      () => probe(3),
    );
    await expect(provider.create(plan())).resolves.toEqual({ cellId: "c1" });
    expect(server.count("POST /sandboxes/c1/proxy/44772/command")).toBe(2);
    expect(server.count("POST /sandboxes/c1/credential-vault")).toBe(1);
  });
});

describe("vault write", () => {
  it("retries a BACKEND_CONNECTION_FAILED 502 once and succeeds", async () => {
    const { server, provider } = setup();
    happyRoutes(server);
    server.on(
      "POST /sandboxes/c1/credential-vault",
      () => json(502, { code: "BACKEND_CONNECTION_FAILED" }),
      () => json(201, {}),
    );
    await expect(provider.create(plan())).resolves.toEqual({ cellId: "c1" });
    expect(server.count("POST /sandboxes/c1/credential-vault")).toBe(2);
  });

  it("a failure revokes first, then quarantines and deletes, and throws http_error", async () => {
    const { server, provider } = setup();
    happyRoutes(server);
    server.on("POST /sandboxes/c1/credential-vault", () => json(500, {}));
    const err = await rejection(provider.create(plan()));
    expect(err).toMatchObject({ code: "http_error", op: "vault", status: 500 });
    const tail = server.calls.slice(-3).map((c) => `${c.method} ${c.path}`);
    expect(tail).toEqual([
      "DELETE /sandboxes/c1/credential-vault",
      "PUT /sandboxes/c1/networkpolicy?dropEstablished=true",
      "DELETE /sandboxes/c1",
    ]);
  });

  it("a teardown failure is logged and the original error is thrown", async () => {
    const { server, provider, logger } = setup();
    happyRoutes(server);
    server.on("POST /sandboxes/c1/credential-vault", () => json(500, {}));
    server.on("PUT /sandboxes/c1/networkpolicy?dropEstablished=true", () =>
      json(500, {}),
    );
    const err = await rejection(provider.create(plan()));
    expect(err.op).toBe("vault");
    expect(logger.warn).toHaveBeenCalled();
    expect(server.count("DELETE /sandboxes/c1")).toBe(2); // vault + sandbox share the prefix
  });
});

describe("exec", () => {
  it("sends argv and cwd and parses the stream", async () => {
    const { server, provider } = setup();
    server.on("POST /sandboxes/c1/proxy/44772/command", () =>
      sse([
        { type: "stdout", text: "a" },
        { type: "stderr", text: "e" },
        { type: "stdout", text: "b" },
        { type: "execution_complete", exit_code: 7 },
      ]),
    );
    const result = await provider.exec("c1", ["ls", "-l"], {
      cwd: "/work",
      timeoutMs: 5000,
    });
    expect(result).toEqual({ exitCode: 7, stdout: "ab", stderr: "e" });
    expect(server.calls[0]!.body).toEqual({
      argv: ["ls", "-l"],
      timeout: 5000,
      cwd: "/work",
    });
  });

  it("defaults a missing exit_code to 0 and maps an error event to its exit code", async () => {
    const { server, provider } = setup();
    server.on(
      "POST /sandboxes/c1/proxy/44772/command",
      () => sse([{ type: "execution_complete" }]),
      () => sse([{ type: "error", error: { exit_code: 9 } }]),
    );
    expect((await provider.exec("c1", ["x"])).exitCode).toBe(0);
    expect((await provider.exec("c1", ["x"])).exitCode).toBe(9);
  });

  it.each([[[]], [[""]]])("refuses argv %j with no HTTP call", async (argv) => {
    const { server, provider } = setup();
    const err = await rejection(provider.exec("c1", argv));
    expect(err.code).toBe("invalid_argv");
    expect(server.fetchSpy).not.toHaveBeenCalled();
  });

  it("a non-2xx or a stream with no terminal event is http_error", async () => {
    const { server, provider } = setup();
    server.on(
      "POST /sandboxes/c1/proxy/44772/command",
      () => json(500, {}),
      () => sse([{ type: "stdout", text: "x" }]),
    );
    expect((await rejection(provider.exec("c1", ["x"]))).code).toBe(
      "http_error",
    );
    expect((await rejection(provider.exec("c1", ["x"]))).code).toBe(
      "http_error",
    );
  });

  it("a 150 s exec gets its own timeout, not requestTimeoutMs", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const { server, provider } = setup({ requestTimeoutMs: 30_000 });
    server.on("POST /sandboxes/c1/proxy/44772/command", () => probe(0));
    server.on(
      "DELETE /sandboxes/c1",
      () => new Response(null, { status: 204 }),
    );
    await provider.exec("c1", ["x"], { timeoutMs: 150_000 });
    await provider.delete("c1");
    expect(timeoutSpy.mock.calls.map((c) => c[0])).toEqual([160_000, 30_000]);
  });
});

describe("retry rules", () => {
  it("an idempotent 502 is retried with capped backoff, then succeeds", async () => {
    const { server, provider, sleeps } = setup();
    server.on(
      "DELETE /sandboxes/c1",
      () => json(502, {}),
      () => json(502, {}),
      () => new Response(null, { status: 204 }),
    );
    await expect(provider.delete("c1")).resolves.toBe("deleted");
    expect(sleeps).toEqual([250, 500]);
  });

  it("stops at the budget and caps backoff at 2 s", async () => {
    const { server, provider, sleeps } = setup();
    server.on("DELETE /sandboxes/c1", () => json(502, {}));
    const err = await rejection(provider.delete("c1"));
    expect(err).toMatchObject({ code: "http_error", status: 502 });
    expect(sleeps).toEqual([250, 500, 1000, 2000, 2000, 2000, 2000, 2000]);
  });

  it("a 500 is not retried", async () => {
    const { server, provider, sleeps } = setup();
    server.on("DELETE /sandboxes/c1", () => json(500, {}));
    await rejection(provider.delete("c1"));
    expect(server.count("DELETE /sandboxes/c1")).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("delete, revoke, quarantine, copyOut", () => {
  it("delete returns gone on 404", async () => {
    const { server, provider } = setup();
    server.on("DELETE /sandboxes/c1", () => json(404, {}));
    await expect(provider.delete("c1")).resolves.toBe("gone");
  });

  it("revoke and quarantine are no-ops on 404", async () => {
    const { server, provider } = setup();
    server.on("DELETE /sandboxes/c1/credential-vault", () => json(404, {}));
    server.on("PUT /sandboxes/c1/networkpolicy?dropEstablished=true", () =>
      json(404, {}),
    );
    await expect(provider.revoke("c1")).resolves.toBeUndefined();
    await expect(provider.quarantine("c1")).resolves.toBeUndefined();
  });

  it("quarantine sends deny-all and throws http_error on another non-2xx", async () => {
    const { server, provider } = setup();
    server.on("PUT /sandboxes/c1/networkpolicy?dropEstablished=true", () =>
      json(501, { code: "DropEstablishedNotImplemented" }),
    );
    const err = await rejection(provider.quarantine("c1"));
    expect(err).toMatchObject({ code: "http_error", status: 501 });
    expect(server.calls[0]!.body).toEqual({
      defaultAction: "deny",
      egress: [],
    });
  });

  it("copyOut returns the bytes and encodes the path", async () => {
    const { server, provider } = setup();
    server.on(
      "GET /sandboxes/c1/proxy/44772/files/download?path=",
      () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      () => json(404, { message: "no" }),
    );
    const bytes = await provider.copyOut("c1", "/a b/c&d");
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(server.calls[0]!.path).toBe(
      "/sandboxes/c1/proxy/44772/files/download?path=%2Fa%20b%2Fc%26d",
    );
    expect((await rejection(provider.copyOut("c1", "/x"))).code).toBe(
      "http_error",
    );
  });
});

describe("listByTags", () => {
  it("follows pages and double-encodes values", async () => {
    const { server, provider } = setup();
    server.on(
      "GET /sandboxes?metadata",
      () =>
        json(200, {
          items: [{ id: "a", metadata: { worker: "w&=+%" } }],
          pagination: { hasNextPage: true },
        }),
      () =>
        json(200, { items: [{ id: "b" }], pagination: { hasNextPage: false } }),
    );
    const out = await provider.listByTags({ worker: "w&=+%" });
    expect(out).toEqual([
      { cellId: "a", tags: { worker: "w&=+%" } },
      { cellId: "b", tags: {} },
    ]);
    const first = server.calls[0]!.path;
    const inner = new URLSearchParams({
      automata: "cell",
      worker: "w&=+%",
    }).toString();
    expect(first).toBe(
      `/sandboxes?metadata=${encodeURIComponent(inner)}&page=1&pageSize=100`,
    );
    expect(server.calls[1]!.path).toContain("&page=2&pageSize=100");
  });

  it("an empty filter still lists only automata=cell", async () => {
    const { server, provider } = setup();
    server.on("GET /sandboxes?metadata", () =>
      json(200, { items: [], pagination: { hasNextPage: false } }),
    );
    await provider.listByTags({});
    expect(server.calls[0]!.path).toContain(
      `metadata=${encodeURIComponent("automata=cell")}`,
    );
  });
});

describe("secrets never leak (canary)", () => {
  const scenarios: [string, (s: ReturnType<typeof setup>) => void][] = [
    [
      "vault 500",
      (s) =>
        s.server.on("POST /sandboxes/c1/credential-vault", () =>
          json(500, { echo: CREDENTIAL, key: API_KEY }),
        ),
    ],
    [
      "probe fails",
      (s) =>
        s.server.on("POST /sandboxes/c1/proxy/44772/command", () =>
          sse([
            { type: "stdout", text: `${CREDENTIAL} ${API_KEY}` },
            { type: "execution_complete", exit_code: 0 },
          ]),
        ),
    ],
    [
      "fetch rejects",
      (s) =>
        s.server.on("POST /sandboxes/c1/credential-vault", () => {
          throw new Error(`down ${API_KEY} ${CREDENTIAL}`);
        }),
    ],
    [
      "teardown fails",
      (s) => {
        s.server.on("POST /sandboxes/c1/credential-vault", () => json(500, {}));
        s.server.on(
          "PUT /sandboxes/c1/networkpolicy?dropEstablished=true",
          () => json(500, { key: API_KEY }),
        );
      },
    ],
  ];

  it.each(scenarios)("%s", async (_n, arrange) => {
    const s = setup();
    happyRoutes(s.server);
    arrange(s);
    const err = await rejection(s.provider.create(plan()));
    const surfaces = [
      JSON.stringify(s.logs),
      err.message,
      JSON.stringify(err),
      JSON.stringify(err.cause ?? null),
      String(err.stack?.split("\n")[0]),
    ].join("\n");
    expect(surfaces).not.toContain(API_KEY);
    expect(surfaces).not.toContain(CREDENTIAL);
  });

  it("the success path logs neither", async () => {
    const s = setup();
    happyRoutes(s.server);
    await s.provider.create(plan());
    expect(JSON.stringify(s.logs)).not.toContain(API_KEY);
    expect(JSON.stringify(s.logs)).not.toContain(CREDENTIAL);
  });
});
