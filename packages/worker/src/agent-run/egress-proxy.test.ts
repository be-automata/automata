import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  matchEgress,
  startEgressProxy,
  type EgressDecisionEvent,
  type EgressPolicyShape,
  type EgressProxy,
} from "./egress-proxy";

const domainPolicy = (allowlist: string[]): EgressPolicyShape => ({
  level: "domain",
  allowlist,
});

describe("matchEgress (pure decision table)", () => {
  it.each<[string, EgressPolicyShape, string, number, boolean]>([
    // domain level: exact + web ports only for plain entries
    [
      "exact domain, 443",
      domainPolicy(["api.github.com"]),
      "api.github.com",
      443,
      true,
    ],
    [
      "exact domain, 80",
      domainPolicy(["api.github.com"]),
      "api.github.com",
      80,
      true,
    ],
    [
      "exact domain, odd port denied",
      domainPolicy(["api.github.com"]),
      "api.github.com",
      8443,
      false,
    ],
    [
      "different host denied",
      domainPolicy(["api.github.com"]),
      "evil.example.com",
      443,
      false,
    ],
    [
      "subdomain NOT covered by plain entry",
      domainPolicy(["github.com"]),
      "api.github.com",
      443,
      false,
    ],
    // wildcard entries
    [
      "wildcard matches subdomain",
      domainPolicy(["*.github.com"]),
      "api.github.com",
      443,
      true,
    ],
    [
      "wildcard matches deep subdomain",
      domainPolicy(["*.github.com"]),
      "a.b.github.com",
      443,
      true,
    ],
    [
      "wildcard does NOT match the apex",
      domainPolicy(["*.github.com"]),
      "github.com",
      443,
      false,
    ],
    [
      "wildcard is a suffix, not a substring",
      domainPolicy(["*.github.com"]),
      "evilgithub.com",
      443,
      false,
    ],
    // host:port entries pin the port
    [
      "host:port pins that port",
      domainPolicy(["api.example.com:9443"]),
      "api.example.com",
      9443,
      true,
    ],
    [
      "host:port denies the web ports",
      domainPolicy(["api.example.com:9443"]),
      "api.example.com",
      443,
      false,
    ],
    // case + trailing-dot normalization
    [
      "case-insensitive host",
      domainPolicy(["API.GitHub.com"]),
      "api.github.com",
      443,
      true,
    ],
    [
      "trailing-dot FQDN normalized",
      domainPolicy(["api.github.com"]),
      "api.github.com.",
      443,
      true,
    ],
    // ip_port level: exact IPv4[:port]
    [
      "ip exact, any port",
      { level: "ip_port", allowlist: ["10.0.0.5"] },
      "10.0.0.5",
      12345,
      true,
    ],
    [
      "ip:port pinned allow",
      { level: "ip_port", allowlist: ["10.0.0.5:443"] },
      "10.0.0.5",
      443,
      true,
    ],
    [
      "ip:port pinned deny",
      { level: "ip_port", allowlist: ["10.0.0.5:443"] },
      "10.0.0.5",
      80,
      false,
    ],
    [
      "other ip denied",
      { level: "ip_port", allowlist: ["10.0.0.5"] },
      "10.0.0.6",
      443,
      false,
    ],
    [
      "domain never matches at ip_port level",
      { level: "ip_port", allowlist: ["10.0.0.5"] },
      "github.com",
      443,
      false,
    ],
    // none level: ONLY the (system) allowlist entries — nothing implicit but loopback
    [
      "none: system host allowed",
      { level: "none", allowlist: ["api.anthropic.com"] },
      "api.anthropic.com",
      443,
      true,
    ],
    [
      "none: anything else denied",
      { level: "none", allowlist: ["api.anthropic.com"] },
      "github.com",
      443,
      false,
    ],
    [
      "none: empty allowlist denies all",
      { level: "none", allowlist: [] },
      "example.com",
      443,
      false,
    ],
    // implicit loopback allow at every level (broker + proxy live there)
    [
      "loopback ip implicit at none",
      { level: "none", allowlist: [] },
      "127.0.0.1",
      5432,
      true,
    ],
    [
      "localhost implicit at ip_port",
      { level: "ip_port", allowlist: [] },
      "localhost",
      80,
      true,
    ],
    // fail-closed shapes
    ["empty host denied", domainPolicy(["*.github.com"]), "", 443, false],
    [
      "unparseable sentinel denied",
      domainPolicy(["*.github.com"]),
      "unparseable",
      0,
      false,
    ],
  ])("%s", (_name, policy, host, port, expected) => {
    expect(matchEgress(policy, host, port)).toBe(expected);
  });
});

describe("startEgressProxy (real loopback servers)", () => {
  let proxy: EgressProxy | null = null;
  const closers: Array<() => void> = [];
  afterEach(async () => {
    await proxy?.close();
    proxy = null;
    for (const close of closers.splice(0)) {
      close();
    }
  });

  /** A real HTTP upstream that echoes a recognisable body. */
  function startUpstreamHttp(): Promise<number> {
    return new Promise((resolve) => {
      const server = createHttpServer((req, res) => {
        res.writeHead(200, { "x-upstream": "yes" });
        res.end(`UPSTREAM:${req.method}:${req.url}`);
      });
      closers.push(() => server.close());
      server.listen(0, "127.0.0.1", () =>
        resolve((server.address() as AddressInfo).port),
      );
    });
  }

  /** A real raw-TCP echo server for CONNECT tunnels. */
  function startUpstreamTcp(): Promise<number> {
    return new Promise((resolve) => {
      const server = createTcpServer((socket) => {
        socket.on("data", (d) => socket.write(`echo:${d.toString()}`));
      });
      closers.push(() => server.close());
      server.listen(0, "127.0.0.1", () =>
        resolve((server.address() as AddressInfo).port),
      );
    });
  }

  async function boot(policy: EgressPolicyShape) {
    const events: EgressDecisionEvent[] = [];
    proxy = await startEgressProxy({ policy, onEvent: (e) => events.push(e) });
    return { p: proxy, events };
  }

  /** Absolute-form request THROUGH the proxy (path = full url). */
  function viaProxy(
    proxyPort: number,
    absoluteUrl: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "GET",
          path: absoluteUrl,
        },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("absolute-form HTTP allow: body roundtrips and an allow event fires", async () => {
    const upstreamPort = await startUpstreamHttp();
    const { p, events } = await boot({
      level: "ip_port",
      allowlist: [`127.0.0.1:${upstreamPort}`],
    });
    const res = await viaProxy(
      p.port,
      `http://127.0.0.1:${upstreamPort}/hello?x=1`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe("UPSTREAM:GET:/hello?x=1");
    expect(events).toEqual([
      {
        destinationHost: "127.0.0.1",
        destinationPort: upstreamPort,
        action: "allow",
        policyLevel: "ip_port",
      },
    ]);
  });

  it("absolute-form HTTP deny: 403, nothing reaches the network, a deny event fires", async () => {
    const { p, events } = await boot(domainPolicy(["allowed.example.com"]));
    // evil.example.com needs no DNS: the deny happens before any connect.
    const res = await viaProxy(p.port, "http://evil.example.com/exfil");
    expect(res.status).toBe(403);
    expect(events).toEqual([
      {
        destinationHost: "evil.example.com",
        destinationPort: 80,
        action: "deny",
        policyLevel: "domain",
      },
    ]);
  });

  it("CONNECT allow: tunnels raw TCP to a real local server (data roundtrip + allow event)", async () => {
    const tcpPort = await startUpstreamTcp();
    const { p, events } = await boot({
      level: "ip_port",
      allowlist: [`127.0.0.1:${tcpPort}`],
    });
    const echoed = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: p.port,
        method: "CONNECT",
        path: `127.0.0.1:${tcpPort}`,
      });
      req.on("connect", (res, socket) => {
        expect(res.statusCode).toBe(200);
        socket.on("data", (d) => {
          resolve(d.toString());
          socket.end();
        });
        socket.write("ping");
      });
      req.on("error", reject);
      req.end();
    });
    expect(echoed).toBe("echo:ping");
    expect(events).toEqual([
      {
        destinationHost: "127.0.0.1",
        destinationPort: tcpPort,
        action: "allow",
        policyLevel: "ip_port",
      },
    ]);
  });

  it("close() severs BOTH ends of an in-flight CONNECT tunnel (no upstream socket leak)", async () => {
    // Regression: close() used to destroy only tracked client-facing sockets;
    // the upstream socket from handleConnect's netConnect() survived teardown.
    let resolveUpstreamSeen!: () => void;
    let resolveUpstreamClosed!: () => void;
    const upstreamSeen = new Promise<void>((r) => (resolveUpstreamSeen = r));
    const upstreamClosed = new Promise<void>(
      (r) => (resolveUpstreamClosed = r),
    );
    const tcpPort = await new Promise<number>((resolve) => {
      const server = createTcpServer((socket) => {
        resolveUpstreamSeen();
        socket.on("close", () => resolveUpstreamClosed());
      });
      closers.push(() => server.close());
      server.listen(0, "127.0.0.1", () =>
        resolve((server.address() as AddressInfo).port),
      );
    });

    const { p } = await boot({
      level: "ip_port",
      allowlist: [`127.0.0.1:${tcpPort}`],
    });

    // Open a tunnel and leave it in flight (no client-side end/destroy).
    const clientSocket = await new Promise<Duplex>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: p.port,
        method: "CONNECT",
        path: `127.0.0.1:${tcpPort}`,
      });
      req.on("connect", (res, socket) => {
        expect(res.statusCode).toBe(200);
        resolve(socket);
      });
      req.on("error", reject);
      req.end();
    });
    const clientClosed = new Promise<void>((r) =>
      clientSocket.on("close", () => r()),
    );
    clientSocket.on("error", () => {}); // severed mid-tunnel: ECONNRESET is the point
    await upstreamSeen;

    await p.close();
    proxy = null; // already closed — afterEach must not double-close

    // BOTH halves die: the upstream server sees its connection destroyed …
    await upstreamClosed;
    // … and the client side is severed too.
    await clientClosed;
  });

  it("CONNECT deny: 403 response and a deny event; no tunnel is opened", async () => {
    const { p, events } = await boot({
      level: "none",
      allowlist: ["api.anthropic.com"],
    });
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: p.port,
        method: "CONNECT",
        path: "evil.example.com:443",
      });
      // Node's client surfaces ANY response to a CONNECT via the 'connect'
      // event — the status code is where allow (200) and deny (403) differ.
      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(events).toEqual([
      {
        destinationHost: "evil.example.com",
        destinationPort: 443,
        action: "deny",
        policyLevel: "none",
      },
    ]);
  });

  it("fails closed on a garbage (non-absolute-form) request: 403 + audited as 'unparseable'", async () => {
    const { p, events } = await boot(domainPolicy(["*.github.com"]));
    // Origin-form path — a proxy should never see this; it is not interpretable
    // as a destination, so it must be denied, not guessed at.
    const res = await viaProxy(p.port, "/not-absolute-form");
    expect(res.status).toBe(403);
    expect(events).toEqual([
      {
        destinationHost: "unparseable",
        destinationPort: null,
        action: "deny",
        policyLevel: "domain",
      },
    ]);
  });

  it("wildcard domain allow decision is audited with the real host (deny for apex)", async () => {
    const { p, events } = await boot(domainPolicy(["*.example.com"]));
    // Both are decided without DNS: sub allowed (but connect fails later — we
    // only care about the DECISION here), apex denied outright.
    const apex = await viaProxy(p.port, "http://example.com/");
    expect(apex.status).toBe(403);
    expect(events).toContainEqual({
      destinationHost: "example.com",
      destinationPort: 80,
      action: "deny",
      policyLevel: "domain",
    });
  });

  it("refuses to start with an invalid policy or missing onEvent (fail-closed constructor)", async () => {
    await expect(
      startEgressProxy({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        policy: { level: "everything" as any, allowlist: [] },
        onEvent: () => {},
      }),
    ).rejects.toThrow(/policy must be/);
    await expect(
      startEgressProxy({
        policy: domainPolicy([]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onEvent: undefined as any,
      }),
    ).rejects.toThrow(/onEvent callback is required/);
  });

  it("a throwing onEvent never breaks enforcement (allow still proxies)", async () => {
    const upstreamPort = await startUpstreamHttp();
    proxy = await startEgressProxy({
      policy: { level: "ip_port", allowlist: [`127.0.0.1:${upstreamPort}`] },
      onEvent: () => {
        throw new Error("audit plumbing exploded");
      },
    });
    const res = await viaProxy(
      proxy.port,
      `http://127.0.0.1:${upstreamPort}/ok`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe("UPSTREAM:GET:/ok");
  });
});
