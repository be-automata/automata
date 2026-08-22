import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { graphqlHasMutation, startGhBroker, type GhBroker } from "./gh-broker";

const TOKEN = "ghs_installation_token_secret";
const BEARER = "run-bearer-abc123";

let broker: GhBroker | null = null;
let tmpDirs: string[] = [];

afterEach(async () => {
  await broker?.close();
  broker = null;
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function shortSocketPath(): string {
  // /tmp directly (not os.tmpdir(), which on macOS is a long /var/folders path)
  // to stay under the sun_path assertion like production's /tmp default root.
  const dir = fs.mkdtempSync("/tmp/gh-broker-t-");
  tmpDirs.push(dir);
  return path.join(dir, "gh.sock");
}

/** A fetch stand-in that records what the broker sent upstream. */
function recordingFetch(
  respond: () => Response = () =>
    new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
) {
  const calls: Array<{
    url: string;
    method?: string;
    auth?: string | undefined;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method,
      auth: headers.get("Authorization") ?? undefined,
      headers: Object.fromEntries(headers),
      body: init?.body
        ? Buffer.from(init.body as Buffer).toString()
        : undefined,
    });
    return respond();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function start(fetchImpl: typeof fetch, socketPath = shortSocketPath()) {
  broker = await startGhBroker({
    installationToken: TOKEN,
    runBearer: BEARER,
    socketPath,
    fetchImpl,
  });
  return broker;
}

function request(
  socketPath: string,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: opts.method ?? "GET",
        path: opts.path ?? "/user",
        headers: {
          host: "api.github.com",
          authorization: `token ${BEARER}`,
          ...opts.headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("startGhBroker — construction fences", () => {
  it("fails loudly on an empty bearer or token (a collapsed fence must not serve)", async () => {
    await expect(
      startGhBroker({
        installationToken: TOKEN,
        runBearer: "",
        socketPath: shortSocketPath(),
      }),
    ).rejects.toThrow(/runBearer/);
    await expect(
      startGhBroker({
        installationToken: "",
        runBearer: BEARER,
        socketPath: shortSocketPath(),
      }),
    ).rejects.toThrow(/installationToken/);
  });

  it("asserts the sun_path length — macOS bind silently TRUNCATES, so a bind error never surfaces it", async () => {
    const longPath = path.join("/tmp", "x".repeat(120), "gh.sock");
    await expect(
      startGhBroker({
        installationToken: TOKEN,
        runBearer: BEARER,
        socketPath: longPath,
      }),
    ).rejects.toThrow(/sun_path/);
  });

  it("creates a missing socket directory (broker starts before DaemonProcess's own mkdir)", async () => {
    const dir = fs.mkdtempSync("/tmp/gh-broker-t-");
    tmpDirs.push(dir);
    const socketPath = path.join(dir, "nested", "gh.sock");
    const { impl } = recordingFetch();
    const b = await start(impl, socketPath);
    expect((await request(b.socketPath)).status).toBe(200);
  });

  it("rebinds over a stale socket file left by a crashed prior run of the same threadId", async () => {
    const socketPath = shortSocketPath();
    fs.writeFileSync(socketPath, "");
    const { impl } = recordingFetch();
    const b = await start(impl, socketPath);
    expect((await request(b.socketPath)).status).toBe(200);
  });
});

describe("startGhBroker — per-request fencing", () => {
  it("401s a missing or wrong bearer without touching upstream; accepts both token and Bearer schemes", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
    expect(
      (await request(b.socketPath, { headers: { authorization: "" } })).status,
    ).toBe(401);
    expect(
      (
        await request(b.socketPath, {
          headers: { authorization: "token wrong" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(b.socketPath, {
          headers: { authorization: `Bearer wrong` },
        })
      ).status,
    ).toBe(401);
    expect(calls).toHaveLength(0);
    expect((await request(b.socketPath)).status).toBe(200); // token <bearer>
    expect(
      (
        await request(b.socketPath, {
          headers: { authorization: `Bearer ${BEARER}` },
        })
      ).status,
    ).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("403s any Host other than api.github.com (uploads/objects hosts are out of scope)", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
    for (const host of ["uploads.github.com", "github.com", "evil.example"]) {
      const res = await request(b.socketPath, { headers: { host } });
      expect(res.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it("allows GET/HEAD on any path — including the preflight's GET /", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
    expect((await request(b.socketPath, { path: "/" })).status).toBe(200);
    expect(
      (await request(b.socketPath, { path: "/repos/o/r/pulls/1" })).status,
    ).toBe(200);
    expect(
      (await request(b.socketPath, { method: "HEAD", path: "/user" })).status,
    ).toBe(200);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /",
      "GET /repos/o/r/pulls/1",
      "HEAD /user",
    ]);
  });

  it("403s REST writes: POST/PATCH/PUT/DELETE never reach upstream", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const res = await request(b.socketPath, {
        method,
        path: "/repos/o/r/issues/1",
        body: "{}",
      });
      expect(res.status, method).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("startGhBroker — GraphQL (load-bearing for the gh auth status preflight)", () => {
  it("passes a mutation-free POST /graphql — gh auth status's viewer query — body forwarded verbatim", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
    // The exact shape gh 2.95.0's `gh auth status` sends through the socket.
    const body = JSON.stringify({
      query: "query UserCurrent{viewer{login}}",
    });
    const res = await request(b.socketPath, {
      method: "POST",
      path: "/graphql",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/graphql");
    expect(calls[0]!.body).toBe(body);
  });

  it("403s a GraphQL mutation, an absent query, and an unparseable body (fail closed)", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
    const cases = [
      JSON.stringify({
        query: "mutation { addComment(input: {}) { clientMutationId } }",
      }),
      JSON.stringify({ variables: { a: 1 } }), // no query field
      "not json",
    ];
    for (const body of cases) {
      const res = await request(b.socketPath, {
        method: "POST",
        path: "/graphql",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status, body).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it("a query merely MENTIONING mutation in a string literal still passes", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
    const res = await request(b.socketPath, {
      method: "POST",
      path: "/graphql",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query:
          'query{search(query:"mutation testing",type:ISSUE,first:1){issueCount}}',
      }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe("graphqlHasMutation", () => {
  it("detects mutations, ignores strings/comments, fails closed on bare keyword", () => {
    expect(graphqlHasMutation("query{viewer{login}}")).toBe(false);
    expect(graphqlHasMutation("mutation{x}")).toBe(true);
    expect(graphqlHasMutation("query A{a} mutation B{b}")).toBe(true);
    expect(graphqlHasMutation('query{f(q:"mutation")}')).toBe(false);
    expect(graphqlHasMutation('"""mutation docs""" query{a}')).toBe(false);
    expect(graphqlHasMutation("# mutation comment\nquery{a}")).toBe(false);
    // Superset of operation position — deliberate fail-closed.
    expect(graphqlHasMutation("query{mutation}")).toBe(true);
  });
});

describe("startGhBroker — upstream forwarding", () => {
  it("injects `token <installationToken>` upstream and never forwards the client's bearer or host", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
    await request(b.socketPath, {
      path: "/user",
      headers: {
        accept: "application/vnd.github+json",
        "x-gh-custom": "kept",
        connection: "keep-alive",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBe(`token ${TOKEN}`);
    const headers = calls[0]!.headers;
    expect(headers["accept"]).toBe("application/vnd.github+json");
    expect(headers["x-gh-custom"]).toBe("kept");
    expect(headers["connection"]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(BEARER);
    // fetch sets Host from the target url; the socket's host is never copied.
    expect(headers["host"] ?? "api.github.com").toBe("api.github.com");
  });

  it("relays upstream status/headers/body, stripping hop-by-hop response headers", async () => {
    const { impl } = recordingFetch(
      () =>
        new Response("UPSTREAM-BODY", {
          status: 418,
          headers: {
            "content-type": "text/plain",
            "x-ratelimit-remaining": "42",
            "transfer-encoding": "chunked",
          },
        }),
    );
    const b = await start(impl);
    const res = await request(b.socketPath);
    expect(res.status).toBe(418);
    expect(res.body).toBe("UPSTREAM-BODY");
    expect(res.headers["x-ratelimit-remaining"]).toBe("42");
  });

  it("upstream failure → bare 502, never the token", async () => {
    const impl = (async () => {
      throw new Error(`connect refused (${TOKEN} must never appear)`);
    }) as unknown as typeof fetch;
    const b = await start(impl);
    const res = await request(b.socketPath);
    expect(res.status).toBe(502);
    expect(res.body).not.toContain(TOKEN);
    expect(JSON.stringify(res.headers)).not.toContain(TOKEN);
  });

  it("close() unlinks the socket file (no stale socket for the next run)", async () => {
    const { impl } = recordingFetch();
    const b = await start(impl);
    const socketPath = b.socketPath;
    expect(fs.existsSync(socketPath)).toBe(true);
    await b.close();
    broker = null;
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});
