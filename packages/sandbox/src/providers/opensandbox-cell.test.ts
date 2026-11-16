import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CELL_MIN_TTL_MS,
  CELL_SELF_CHECK_BLOCKED_EXIT,
  type CellCreatePlan,
} from "@terragon/types/cell";

import {
  CellProviderError,
  createOpenSandboxCellProvider,
  OPENSANDBOX_MIN_TTL_MS,
  OPENSANDBOX_SELF_CHECK_BLOCKED_EXIT,
  type OpenSandboxCellConfig,
  type OpenSandboxCellDeps,
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

/** A body delivered in the given chunks, then closed or errored (an aborted read). */
function chunked(chunks: string[], fail?: Error, status = 200): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      if (fail) controller.error(fail);
      else controller.close();
    },
  });
  return new Response(stream, { status });
}

const emptyList = () =>
  json(200, { items: [], pagination: { hasNextPage: false } });

function timeoutError(): Error {
  return new DOMException("The operation timed out.", "TimeoutError");
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
  server.on("GET /sandboxes/c1/networkpolicy", () => policyResponse());
}

function policyModeResponse(mode: string | undefined): Response {
  return json(200, {
    ...(mode === undefined ? {} : { mode }),
    policy: {
      egress: [{ action: "allow", target: "broker.test", ports: [443] }],
      defaultAction: "deny",
    },
  });
}

/** The server's echo of the plan's policy: reordered, with a targetless deny. */
function policyResponse(patch: Record<string, unknown> = {}): Response {
  return json(200, {
    status: "ok",
    mode: "enforcing",
    enforcementMode: "dns+nft",
    policy: {
      egress: [{ action: "allow", target: "broker.test", ports: [443] }],
      defaultAction: "deny",
      ...patch,
    },
  });
}

function plan(patch: Partial<CellCreatePlan> = {}): CellCreatePlan {
  return {
    provider: "opensandbox",
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

const PLAN_TAGS = plan().tags;

/** A listed cell as the server returns it: id plus its metadata. */
function cellItem(id: string, tags: object = PLAN_TAGS) {
  return { id, metadata: tags };
}

function setup(
  configPatch: Partial<OpenSandboxCellConfig> = {},
  depsPatch: Partial<OpenSandboxCellDeps> = {},
) {
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
      ...depsPatch,
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
    [
      "provider not opensandbox",
      { provider: "gondolin" } as unknown,
      "wrong_provider",
    ],
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
    ["ttl NaN", { ttlMs: Number.NaN } as unknown, "ttl_too_short"],
    ["ttl Infinity", { ttlMs: Infinity } as unknown, "ttl_too_short"],
    ...(["worker", "epoch", "stepKey", "attempt", "expiresAt"] as const)
      .flatMap(
        (k) =>
          [
            [`blank tags.${k}`, { tags: { ...PLAN_TAGS, [k]: " " } }],
            [`missing tags.${k}`, { tags: { ...PLAN_TAGS, [k]: undefined } }],
          ] as [string, unknown][],
      )
      .map(
        ([n, patch]) => [n, patch, "invalid_plan"] as [string, unknown, string],
      ),
    [
      "tags.automata not cell",
      { tags: { ...PLAN_TAGS, automata: "x" } } as unknown,
      "invalid_plan",
    ],
    [
      "cpu 0",
      { resources: { cpu: 0, memoryMiB: 64 } } as unknown,
      "invalid_plan",
    ],
    [
      "cpu NaN",
      { resources: { cpu: Number.NaN, memoryMiB: 64 } } as unknown,
      "invalid_plan",
    ],
    [
      "memory negative",
      { resources: { cpu: 1, memoryMiB: -1 } } as unknown,
      "invalid_plan",
    ],
    [
      "memory Infinity",
      { resources: { cpu: 1, memoryMiB: Infinity } } as unknown,
      "invalid_plan",
    ],
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

  const BAD_2XX: [string, Handler][] = [
    ["no id", () => json(202, {})],
    ["an empty id", () => json(202, { id: "" })],
    ["a numeric id", () => json(201, { id: 7 })],
    ["a non-JSON body", () => new Response("accepted", { status: 202 })],
  ];

  it.each(BAD_2XX)(
    "a 2xx with %s and nothing listed throws http_error and warns once",
    async (_n, h) => {
      const { server, provider, logger } = setup();
      server.on("POST /sandboxes", h);
      server.on("GET /sandboxes?metadata", emptyList);
      const err = await rejection(provider.create(plan()));
      expect(err.code).toBe("http_error");
      expect(server.count("POST /sandboxes/")).toBe(0);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "cell create adoption found nothing",
        {
          op: "create",
          stepKey: "step-1",
          attempt: "2",
          status: expect.any(Number),
        },
      );
    },
  );

  it.each(BAD_2XX)("a 2xx with %s adopts the listed cell", async (_n, h) => {
    const { server, provider } = setup();
    happyRoutes(server);
    server.on("POST /sandboxes", h);
    server.on("GET /sandboxes?metadata", () =>
      json(200, {
        items: [cellItem("c1")],
        pagination: { hasNextPage: false },
      }),
    );
    await expect(provider.create(plan())).resolves.toEqual({ cellId: "c1" });
  });
});

describe("create retries and list-and-adopt", () => {
  it.each([
    [
      "transport failure",
      () => {
        throw timeoutError();
      },
      undefined,
    ],
    ["non-connection 502", () => json(502, { code: "OTHER" }), 502],
  ] as [string, Handler, number | undefined][])(
    "%s with nothing listed warns exactly once and leaks no secret",
    async (_n, h, status) => {
      const { server, provider, logger, logs } = setup();
      server.on("POST /sandboxes", h);
      server.on("GET /sandboxes?metadata", emptyList);
      const err = await rejection(provider.create(plan()));
      expect(err.code).toBe("http_error");
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "cell create adoption found nothing",
        {
          op: "create",
          stepKey: "step-1",
          attempt: "2",
          ...(status === undefined ? {} : { status }),
        },
      );
      const all = JSON.stringify(logs) + err.message + JSON.stringify(err);
      expect(all).not.toContain(API_KEY);
      expect(all).not.toContain(CREDENTIAL);
    },
  );

  it.each([[503], [504]])(
    "a %i on create lists and adopts the one match",
    async (status) => {
      const { server, provider } = setup();
      happyRoutes(server);
      server.on("POST /sandboxes", () => json(status, {}));
      server.on("GET /sandboxes?metadata", () =>
        json(200, {
          items: [cellItem("c1")],
          pagination: { hasNextPage: false },
        }),
      );
      await expect(provider.create(plan())).resolves.toEqual({ cellId: "c1" });
      expect(server.count("GET /sandboxes?metadata")).toBe(1);
    },
  );

  it("a 500 on create with nothing listed warns once and throws http_error", async () => {
    const { server, provider, logger } = setup();
    server.on("POST /sandboxes", () => json(500, {}));
    server.on("GET /sandboxes?metadata", emptyList);
    const err = await rejection(provider.create(plan()));
    expect(err).toMatchObject({ code: "http_error", status: 500 });
    expect(server.count("POST /sandboxes")).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("a 400 on create is a plain http_error with no list call", async () => {
    const { server, provider } = setup();
    server.on("POST /sandboxes", () => json(400, {}));
    const err = await rejection(provider.create(plan()));
    expect(err).toMatchObject({ code: "http_error", status: 400 });
    expect(server.count("GET /sandboxes?metadata")).toBe(0);
  });

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
        items: [cellItem("c1")],
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
      worker: "w1",
      epoch: "e1",
      stepKey: "step-1",
      attempt: "2",
    });
    expect(
      server.calls.filter(
        (c) => c.method === "POST" && c.path === "/sandboxes",
      ),
    ).toHaveLength(1);
  });

  it("a rejected create fetch lists and adopts the cell, then proceeds", async () => {
    const { server, provider } = setup();
    happyRoutes(server);
    server.on("POST /sandboxes", () => {
      throw timeoutError();
    });
    server.on("GET /sandboxes?metadata", () =>
      json(200, {
        items: [cellItem("c1")],
        pagination: { hasNextPage: false },
      }),
    );
    await expect(provider.create(plan())).resolves.toEqual({ cellId: "c1" });
    expect(server.count("POST /sandboxes/c1/credential-vault")).toBe(1);
  });

  it("a rejected create fetch with nothing listed within the budget is http_error", async () => {
    const { server, provider } = setup();
    server.on("POST /sandboxes", () => {
      throw timeoutError();
    });
    server.on("GET /sandboxes?metadata", emptyList);
    const err = await rejection(provider.create(plan()));
    expect(err).toMatchObject({ code: "http_error", op: "create" });
    expect(err.cause).toBeUndefined();
  });

  it.each([
    ["worker", { worker: "w2" }],
    ["epoch", { epoch: "e2" }],
  ])(
    "adopt skips a listed cell whose %s differs: not adopted, not torn down",
    async (_n, diff) => {
      const { server, provider } = setup();
      server.on("POST /sandboxes", () => json(502, { code: "OTHER" }));
      server.on("GET /sandboxes?metadata", () =>
        json(200, {
          items: [cellItem("x", { ...PLAN_TAGS, ...diff })],
          pagination: { hasNextPage: false },
        }),
      );
      const err = await rejection(provider.create(plan()));
      expect(err.code).toBe("http_error");
      expect(server.count("PUT ")).toBe(0);
      expect(server.count("DELETE ")).toBe(0);
      expect(server.count("POST /sandboxes/x")).toBe(0);
    },
  );

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
          items: [cellItem("c1")],
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
        items: [cellItem("a"), cellItem("b")],
        pagination: { hasNextPage: false },
      }),
    );
    for (const id of ["a", "b"]) {
      server.on(
        `DELETE /sandboxes/${id}/credential-vault`,
        () => new Response(null, { status: 204 }),
      );
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
    for (const id of ["a", "b"]) {
      const order = server.calls
        .map((c) => `${c.method} ${c.path}`)
        .filter((c) => c.includes(`/sandboxes/${id}`));
      expect(order).toEqual([
        `DELETE /sandboxes/${id}/credential-vault`,
        `PUT /sandboxes/${id}/networkpolicy?dropEstablished=true`,
        `DELETE /sandboxes/${id}`,
      ]);
    }
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
      "an error event carrying exit 1",
      () => sse([{ type: "error", error: { exit_code: 1 } }]),
    ],
    [
      "an execution_complete without an exit code",
      () => sse([{ type: "execution_complete" }]),
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
    [
      "a non-JSON 502",
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    ],
    [
      "a body read aborted before the terminal event",
      () => chunked(['data: {"type":"stdout","text":"x"}\n\n'], timeoutError()),
    ],
    [
      "a truncated terminal event",
      () => chunked(['data: {"type":"execution_complete","exit_c']),
    ],
    [
      "a timeout on the request",
      () => {
        throw timeoutError();
      },
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
  });

  it("an error event carrying exit 3 (blocked) passes the self-check", async () => {
    const { server, provider } = setup();
    happyRoutes(server);
    server.on("POST /sandboxes/c1/proxy/44772/command", () =>
      sse([
        { type: "error", error: { ename: "CommandExecError", exit_code: 3 } },
      ]),
    );
    await expect(provider.create(plan())).resolves.toEqual({ cellId: "c1" });
    expect(server.count("POST /sandboxes/c1/credential-vault")).toBe(1);
  });

  it("the adapter's probe exit equals the contract constant", () => {
    expect(OPENSANDBOX_SELF_CHECK_BLOCKED_EXIT).toBe(
      CELL_SELF_CHECK_BLOCKED_EXIT,
    );
    expect(OPENSANDBOX_MIN_TTL_MS).toBe(CELL_MIN_TTL_MS);
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

  it("every teardown step failing still throws the original error", async () => {
    const { server, provider, logger, logs } = setup();
    happyRoutes(server);
    server.on("POST /sandboxes/c1/credential-vault", () => json(500, {}));
    server.on("DELETE /sandboxes/c1/credential-vault", () => {
      throw new Error(`down ${API_KEY}`);
    });
    server.on("PUT /sandboxes/c1/networkpolicy?dropEstablished=true", () =>
      json(501, { key: API_KEY }),
    );
    server.on("DELETE /sandboxes/c1", () => json(500, { key: API_KEY }));
    const err = await rejection(provider.create(plan()));
    expect(err).toMatchObject({ code: "http_error", op: "vault", status: 500 });
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls.map((c) => c[1])).toEqual([
      { cellId: "c1", op: "revoke", code: "http_error", status: undefined },
      { cellId: "c1", op: "quarantine", code: "http_error", status: 501 },
      { cellId: "c1", op: "delete", code: "http_error", status: 500 },
    ]);
    expect(JSON.stringify(logs)).not.toContain(API_KEY);
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

  it.each([
    [
      "an error event with error.exit_code 7",
      [{ type: "error", error: { exit_code: 7 } }],
      7,
    ],
    [
      "an error event with a top-level exit_code 5",
      [{ type: "error", exit_code: 5 }],
      5,
    ],
    [
      "an error exit code beating execution_complete",
      [
        { type: "error", error: { exit_code: 2 } },
        { type: "execution_complete", exit_code: 0 },
      ],
      2,
    ],
    [
      "an error exit code beating a malformed execution_complete",
      [
        { type: "error", error: { exit_code: 2 } },
        { type: "execution_complete" },
      ],
      2,
    ],
  ])("exec returns the exit code of %s", async (_n, events, code) => {
    const { server, provider } = setup();
    server.on("POST /sandboxes/c1/proxy/44772/command", () => sse(events));
    expect((await provider.exec("c1", ["x"])).exitCode).toBe(code);
  });

  it.each([
    [
      "an execution_complete without exit_code",
      [{ type: "execution_complete" }],
    ],
    [
      "an execution_complete with a non-numeric exit_code",
      [{ type: "execution_complete", exit_code: "0" }],
    ],
    [
      "an execution_complete with a fractional exit_code",
      [{ type: "execution_complete", exit_code: 1.5 }],
    ],
    [
      "an error event without an exit code",
      [{ type: "error", error: { ename: "boom" } }],
    ],
    [
      "an error event then execution_complete exit 0",
      [
        { type: "error", error: { message: "boom" } },
        { type: "execution_complete", exit_code: 0 },
      ],
    ],
  ])("exec throws http_error on %s", async (_n, events) => {
    const { server, provider } = setup();
    server.on("POST /sandboxes/c1/proxy/44772/command", () => sse(events));
    const err = await rejection(provider.exec("c1", ["x"]));
    expect(err).toMatchObject({ code: "http_error", op: "exec" });
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

  it("a request timeout or an aborted body read is http_error with no cause", async () => {
    const { server, provider } = setup();
    server.on(
      "POST /sandboxes/c1/proxy/44772/command",
      () => {
        throw timeoutError();
      },
      () => chunked(['data: {"type":"stdout","text":"x"}\n'], timeoutError()),
    );
    for (let i = 0; i < 2; i++) {
      const err = await rejection(provider.exec("c1", ["x"]));
      expect(err).toMatchObject({ code: "http_error", op: "exec" });
      expect(err.cause).toBeUndefined();
    }
    expect(server.count("POST /sandboxes/c1/proxy/44772/command")).toBe(2);
  });

  it("an over-cap 502 body on /command is not retried and is cancelled", async () => {
    const { server, provider, sleeps } = setup();
    const cancelled = vi.fn();
    const enc = new TextEncoder();
    server.on(
      "POST /sandboxes/c1/proxy/44772/command",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              c.enqueue(enc.encode("x".repeat(32 * 1024)));
            },
            cancel: cancelled,
          }),
          { status: 502 },
        ),
    );
    const err = await rejection(provider.exec("c1", ["x"]));
    expect(err).toMatchObject({ code: "http_error", status: 502 });
    expect(sleeps).toEqual([]);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("a non-JSON 502 on /command is not retried", async () => {
    const { server, provider, sleeps } = setup();
    server.on(
      "POST /sandboxes/c1/proxy/44772/command",
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    );
    const err = await rejection(provider.exec("c1", ["x"]));
    expect(err).toMatchObject({ code: "http_error", status: 502 });
    expect(err.message).not.toContain("html");
    expect(sleeps).toEqual([]);
  });

  it.each([
    [
      "lines split across chunks",
      () =>
        chunked([
          'data: {"type":"std',
          'out","text":"a"}\n\ndata: {"type":"execution_',
          'complete","exit_code":4}\n\n',
        ]),
    ],
    [
      "multi-line data in one event",
      () =>
        chunked([
          'data: {"type":"stdout",\ndata: "text":"a"}\n\n',
          'data: {"type":"execution_complete",\ndata: "exit_code":4}\n\n',
        ]),
    ],
    [
      "CRLF, comments and event lines",
      () =>
        chunked([
          ": keep-alive\r\nevent: message\r\n",
          'data: {"type":"stdout","text":"a"}\r\n\r\n',
          'data:{"type":"execution_complete","exit_code":4}\r\n\r\n',
        ]),
    ],
    [
      "one event per data line with no blank line between",
      () =>
        chunked([
          'data: {"type":"stdout","text":"a"}\n',
          'data: {"type":"execution_complete","exit_code":4}\n',
        ]),
    ],
    [
      "bare JSON lines",
      () =>
        chunked([
          '{"type":"stdout","text":"a"}\n',
          '{"type":"execution_complete","exit_code":4}\n',
        ]),
    ],
  ])("parses %s", async (_n, body) => {
    const { server, provider } = setup();
    server.on("POST /sandboxes/c1/proxy/44772/command", body);
    await expect(provider.exec("c1", ["x"])).resolves.toEqual({
      exitCode: 4,
      stdout: "a",
      stderr: "",
    });
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

  const frozen = { now: () => 0, sleep: async () => {} };

  it.each([
    [
      "readiness pings (1000 ms / 100 ms, plus the first)",
      { readyTimeoutMs: 1000 },
      "not_ready",
      "GET /sandboxes/c1/proxy/44772/ping",
      11,
      (s: ReturnType<typeof setup>) => {
        happyRoutes(s.server);
        s.server.on("GET /sandboxes/c1/proxy/44772/ping", () => json(503, {}));
        return s.provider.create(plan());
      },
    ],
    [
      "an idempotent 502 retry",
      {},
      "http_error",
      "DELETE /sandboxes/c1",
      9,
      (s: ReturnType<typeof setup>) => {
        s.server.on("DELETE /sandboxes/c1", () => json(502, {}));
        return s.provider.delete("c1");
      },
    ],
    [
      "list-and-adopt",
      {},
      "http_error",
      "GET /sandboxes?metadata",
      41,
      (s: ReturnType<typeof setup>) => {
        s.server.on("POST /sandboxes", () => json(502, { code: "OTHER" }));
        s.server.on("GET /sandboxes?metadata", () =>
          json(200, { items: [], pagination: { hasNextPage: false } }),
        );
        return s.provider.create(plan());
      },
    ],
  ])(
    "%s stays bounded when the injected clock never advances",
    async (_n, config, code, key, calls, act) => {
      const s = setup(config, frozen);
      const err = await rejection(act(s));
      expect(err.code).toBe(code);
      expect(s.server.count(key)).toBe(calls);
    },
  );

  it.each([
    [
      "delete",
      "DELETE /sandboxes/c1",
      (p: ReturnType<typeof setup>["provider"]) => p.delete("c1"),
    ],
  ])("a 500 on %s is http_error and not retried", async (_n, key, act) => {
    const { server, provider, sleeps } = setup();
    server.on(key, () => json(500, { code: "X" }));
    const err = await rejection(act(provider));
    expect(err).toMatchObject({ code: "http_error", status: 500 });
    expect(server.count(key)).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("delete, revoke, quarantine, copyOut", () => {
  it.each([200, 202, 204])("delete returns deleted on %i", async (status) => {
    const { server, provider } = setup();
    server.on(
      "DELETE /sandboxes/c1",
      () => new Response(status === 204 ? null : "{}", { status }),
    );
    await expect(provider.delete("c1")).resolves.toBe("deleted");
  });

  it.each([
    ["delete", "DELETE /sandboxes/c1", "gone"],
    ["revoke", "DELETE /sandboxes/c1/credential-vault", undefined],
    [
      "quarantine",
      "PUT /sandboxes/c1/networkpolicy?dropEstablished=true",
      undefined,
    ],
  ] as const)("%s on 404 is done", async (op, key, expected) => {
    const { server, provider } = setup();
    server.on(key, () => json(404, {}));
    await expect(provider[op]("c1")).resolves.toBe(expected);
  });

  it("an ignored body is cancelled, not left open", async () => {
    const { server, provider } = setup();
    const cancelled = vi.fn();
    server.on(
      "DELETE /sandboxes/c1",
      () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          status: 202,
        }),
    );
    await provider.delete("c1");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("teardown revokes, quarantines, then deletes, each 404 being done", async () => {
    const { server, provider } = setup();
    server.on("DELETE /sandboxes/c1/credential-vault", () => json(404, {}));
    server.on("PUT /sandboxes/c1/networkpolicy?dropEstablished=true", () =>
      json(404, {}),
    );
    server.on("DELETE /sandboxes/c1", () => json(404, {}));
    await expect(provider.teardown("c1")).resolves.toBeUndefined();
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /sandboxes/c1/credential-vault",
      "PUT /sandboxes/c1/networkpolicy?dropEstablished=true",
      "DELETE /sandboxes/c1",
    ]);
  });

  it("teardown attempts every step and rejects when all three fail", async () => {
    const { server, provider } = setup();
    server.on("DELETE /sandboxes/c1/credential-vault", () =>
      json(500, { key: API_KEY }),
    );
    server.on("PUT /sandboxes/c1/networkpolicy?dropEstablished=true", () =>
      json(500, { key: API_KEY }),
    );
    server.on("DELETE /sandboxes/c1", () => json(500, { key: API_KEY }));
    const err: unknown = await provider.teardown("c1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    const agg = err as AggregateError;
    expect(agg.message).toBe("teardown");
    expect(agg.errors).toHaveLength(3);
    expect(agg.errors.every((e) => e instanceof CellProviderError)).toBe(true);
    expect(
      JSON.stringify([agg.message, agg.errors.map((e) => e.message)]),
    ).not.toContain(API_KEY);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /sandboxes/c1/credential-vault",
      "PUT /sandboxes/c1/networkpolicy?dropEstablished=true",
      "DELETE /sandboxes/c1",
    ]);
  });

  it("teardown rejects with the one failing step's error and still runs the rest", async () => {
    const { server, provider } = setup();
    server.on("DELETE /sandboxes/c1/credential-vault", () => json(404, {}));
    server.on("PUT /sandboxes/c1/networkpolicy?dropEstablished=true", () =>
      json(500, { key: API_KEY }),
    );
    server.on("DELETE /sandboxes/c1", () => json(404, {}));
    const err = await rejection(provider.teardown("c1"));
    expect(err.op).toBe("quarantine");
    expect(err.status).toBe(500);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toContain(
      "DELETE /sandboxes/c1",
    );
  });

  it("exec fails closed and cancels the stream once the body passes maxExecOutputBytes", async () => {
    const { server, provider } = setup({ maxExecOutputBytes: 100 });
    const cancelled = vi.fn();
    const enc = new TextEncoder();
    server.on(
      "POST /sandboxes/c1/proxy/44772/command",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              c.enqueue(enc.encode(`: ${"x".repeat(60)}\n`));
            },
            cancel: cancelled,
          }),
          { status: 200 },
        ),
    );
    const err = await rejection(provider.exec("c1", ["/x"]));
    expect(err.code).toBe("http_error");
    expect(err.message).not.toContain("xxx");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("exec decodes a code point and a CRLF split across byte chunks", async () => {
    const { server, provider } = setup();
    const bytes = new TextEncoder().encode(
      'data: {"type":"stdout","text":"ñ"}\r\n\r\n' +
        'data: {"type":"execution_complete","exit_code":0}\r\n\r\n',
    );
    const mid = bytes.indexOf(0xc3) + 1; // inside the two-byte "ñ"
    const crlf = bytes.indexOf(0x0d) + 1; // between \r and \n
    server.on(
      "POST /sandboxes/c1/proxy/44772/command",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(bytes.slice(0, mid));
              c.enqueue(bytes.slice(mid, crlf));
              c.enqueue(bytes.slice(crlf));
              c.close();
            },
          }),
          { status: 200 },
        ),
    );
    await expect(provider.exec("c1", ["/x"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ñ",
    });
  });

  it("exec accepts a body exactly at maxExecOutputBytes and rejects one byte less", async () => {
    const done = 'data: {"type":"execution_complete","exit_code":0}\n\n';
    const bytes = new TextEncoder().encode(done).byteLength;
    const execWithCap = (maxExecOutputBytes: number) => {
      const { server, provider } = setup({ maxExecOutputBytes });
      server.on(
        "POST /sandboxes/c1/proxy/44772/command",
        () => new Response(done, { status: 200 }),
      );
      return provider.exec("c1", ["/x"]);
    };
    await expect(execWithCap(bytes)).resolves.toMatchObject({ exitCode: 0 });
    expect((await rejection(execWithCap(bytes - 1))).code).toBe("http_error");
  });

  it("an over-cap self-check tears down and fails closed", async () => {
    const { server, provider } = setup({ maxExecOutputBytes: 10 });
    happyRoutes(server);
    const err = await rejection(provider.create(plan()));
    expect(err.code).toBe("egress_not_enforced");
    expect(server.count("DELETE /sandboxes/c1")).toBe(1);
    expect(server.count("POST /sandboxes/c1/credential-vault")).toBe(0);
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

  it("copyOut cancels the stream and fails once the body passes maxCopyOutBytes", async () => {
    const { server, provider } = setup({ maxCopyOutBytes: 100 });
    const cancelled = vi.fn();
    server.on(
      "GET /sandboxes/c1/proxy/44772/files/download?path=",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              c.enqueue(new Uint8Array(60));
            },
            cancel: cancelled,
          }),
          { status: 200 },
        ),
    );
    const err = await rejection(provider.copyOut("c1", "/x"));
    expect(err).toMatchObject({ code: "http_error", op: "copyOut" });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("copyOut accepts a body exactly at maxCopyOutBytes", async () => {
    const { server, provider } = setup({ maxCopyOutBytes: 5 });
    server.on(
      "GET /sandboxes/c1/proxy/44772/files/download?path=",
      () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 }),
    );
    expect((await provider.copyOut("c1", "/x")).byteLength).toBe(5);
  });

  it("copyOut maps an aborted body read to http_error", async () => {
    const { server, provider } = setup();
    server.on("GET /sandboxes/c1/proxy/44772/files/download?path=", () =>
      chunked(["partial"], timeoutError()),
    );
    const err = await rejection(provider.copyOut("c1", "/x"));
    expect(err).toMatchObject({ code: "http_error", op: "copyOut" });
  });
});

describe("listByTags", () => {
  it("follows pages and double-encodes values", async () => {
    const { server, provider } = setup();
    server.on(
      "GET /sandboxes?metadata",
      () =>
        json(200, {
          items: [cellItem("a", { automata: "cell", worker: "w&=+%" })],
          pagination: { hasNextPage: true },
        }),
      () =>
        json(200, {
          items: [cellItem("b", { automata: "cell", worker: "w&=+%" })],
          pagination: { hasNextPage: false },
        }),
    );
    const out = await provider.listByTags({ worker: "w&=+%" });
    expect(out).toEqual([
      { cellId: "a", tags: { automata: "cell", worker: "w&=+%" } },
      { cellId: "b", tags: { automata: "cell", worker: "w&=+%" } },
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

  const CELL_A = cellItem("a", { automata: "cell" });

  it.each([
    ["hasNextPage absent", { items: [CELL_A] }],
    ["pagination absent", { items: [CELL_A], pagination: {} }],
    [
      "hasNextPage not true",
      { items: [CELL_A], pagination: { hasNextPage: "yes" } },
    ],
  ])("stops after one page when %s", async (_n, page) => {
    const { server, provider } = setup();
    server.on("GET /sandboxes?metadata", () => json(200, page));
    await expect(provider.listByTags({})).resolves.toEqual([
      { cellId: "a", tags: { automata: "cell" } },
    ]);
    expect(server.calls).toHaveLength(1);
  });

  it("an empty page ends the walk even if hasNextPage stays true", async () => {
    const { server, provider } = setup();
    server.on(
      "GET /sandboxes?metadata",
      () => json(200, { items: [CELL_A], pagination: { hasNextPage: true } }),
      () => json(200, { items: [], pagination: { hasNextPage: true } }),
    );
    await expect(provider.listByTags({})).resolves.toHaveLength(1);
    expect(server.calls).toHaveLength(2);
  });

  it("a server that never stops paging fails after the page cap", async () => {
    const { server, provider } = setup();
    server.on("GET /sandboxes?metadata", () =>
      json(200, { items: [{ id: "a" }], pagination: { hasNextPage: true } }),
    );
    const err = await rejection(provider.listByTags({}));
    expect(err).toMatchObject({ code: "http_error", op: "list" });
    expect(server.calls).toHaveLength(1_000);
  });

  it.each([
    [
      "a non-JSON body",
      () => new Response(`<html>${API_KEY}</html>`, { status: 200 }),
    ],
    ["items not an array", () => json(200, { items: {} })],
    ["an item without an id", () => json(200, { items: [{ metadata: {} }] })],
  ])("%s is http_error and never quotes the body", async (_n, h) => {
    const { server, provider } = setup();
    server.on("GET /sandboxes?metadata", h);
    const err = await rejection(provider.listByTags({}));
    expect(err).toMatchObject({ code: "http_error", op: "list", status: 200 });
    expect(err.message).toBe("list: http_error 200");
    expect(err.cause).toBeUndefined();
  });

  it("keeps the string tags of an item with a non-string value; matches on exact strings", async () => {
    const { server, provider } = setup();
    server.on("GET /sandboxes?metadata", () =>
      json(200, {
        items: [
          cellItem("a", { automata: "cell", worker: "w1", extra: 5 }),
          cellItem("b", { automata: "cell", worker: 1 }),
          cellItem("c", { automata: "cell", worker: "w1 " }),
        ],
        pagination: { hasNextPage: false },
      }),
    );
    await expect(provider.listByTags({ worker: "w1" })).resolves.toEqual([
      { cellId: "a", tags: { automata: "cell", worker: "w1" } },
    ]);
  });

  it("drops an item lacking automata=cell", async () => {
    const { server, provider } = setup();
    server.on("GET /sandboxes?metadata", () =>
      json(200, {
        items: [
          cellItem("a", { automata: "cell", worker: "w1" }),
          cellItem("b", { worker: "w1" }),
        ],
        pagination: { hasNextPage: false },
      }),
    );
    const out = await provider.listByTags({ worker: "w1" });
    expect(out.map((c) => c.cellId)).toEqual(["a"]);
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
    // An Error cause stringifies to {}, so read its message and stack directly.
    const cause = err.cause instanceof Error ? err.cause : undefined;
    const surfaces = [
      JSON.stringify(s.logs),
      err.message,
      JSON.stringify(err),
      JSON.stringify(err.cause ?? null),
      String(err.cause),
      cause?.message,
      cause?.stack,
      err.stack,
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

describe("an adopted cell's policy is verified (finding 4)", () => {
  function adoptSetup(policy: () => Response) {
    const ctx = setup();
    happyRoutes(ctx.server);
    ctx.server.on("POST /sandboxes", () => json(502, { code: "OTHER" }));
    ctx.server.on("GET /sandboxes?metadata", () =>
      json(200, {
        items: [cellItem("c1")],
        pagination: { hasNextPage: false },
      }),
    );
    ctx.server.on("GET /sandboxes/c1/networkpolicy", policy);
    return ctx;
  }

  it('proceeds when the policy matches, reordered and with target ""', async () => {
    const { server, provider } = adoptSetup(() =>
      policyResponse({
        egress: [
          { action: "deny", target: "", ports: [80] },
          { action: "allow", target: "broker.test", ports: [443] },
        ],
      }),
    );
    const p = plan({
      networkPolicy: {
        defaultAction: "deny",
        egress: [
          { action: "allow", target: "broker.test", ports: [443] },
          { action: "deny", ports: [80] },
        ],
      },
    });
    await expect(provider.create(p)).resolves.toEqual({ cellId: "c1" });
    expect(server.count("GET /sandboxes/c1/networkpolicy")).toBe(1);
    expect(server.count("POST /sandboxes/c1/credential-vault")).toBe(1);
  });

  it.each([
    [
      "deny_all mode",
      () =>
        json(200, {
          mode: "deny_all",
          policy: { defaultAction: "deny", egress: [] },
        }),
    ],
    ["observe mode", () => policyModeResponse("observe")],
    ["disabled mode", () => policyModeResponse("disabled")],
    ["a missing mode", () => policyModeResponse(undefined)],
    [
      "an extra allow rule",
      () =>
        policyResponse({
          egress: [
            { action: "allow", target: "broker.test", ports: [443] },
            { action: "allow", target: "evil.test" },
          ],
        }),
    ],
    ["a non-deny default", () => policyResponse({ defaultAction: "allow" })],
    ["a non-JSON body", () => new Response("<html>", { status: 200 })],
    ["a 404", () => json(404, {})],
  ])(
    "%s: revokes, tears down and never writes the vault",
    async (_n, policy) => {
      const { server, provider } = adoptSetup(policy);
      const err = await rejection(provider.create(plan()));
      expect(err).toMatchObject({ code: "http_error", op: "create" });
      expect(server.count("DELETE /sandboxes/c1/credential-vault")).toBe(1);
      expect(
        server.calls.filter(
          (c) => c.method === "DELETE" && c.path === "/sandboxes/c1",
        ),
      ).toHaveLength(1);
      expect(server.count("POST /sandboxes/c1/credential-vault")).toBe(0);
    },
  );
});
