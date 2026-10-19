import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { lookup as dnsLookup } from "node:dns";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEgressProxyReachable,
  matchEgress,
  startEgressProxy,
  type EgressDecisionEvent,
  type EgressPolicyShape,
  type EgressProxy,
  EGRESS_HEALTH_PATH,
  PROXY_AUTH_AUDIT_CAP,
  PROXY_AUTH_HOST,
  isHostLocalAddress,
  localInterfaceAddresses,
  makeGuardedLookup,
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
    // #367: NO implicit loopback allow — the proxy dials as the worker uid from
    // inside the worker cgroup, the one socket the box's loopback fence admits.
    [
      "loopback ip is NOT implicit at none",
      { level: "none", allowlist: [] },
      "127.0.0.1",
      5432,
      false,
    ],
    [
      "localhost is NOT implicit at ip_port",
      { level: "ip_port", allowlist: [] },
      "localhost",
      80,
      false,
    ],
    [
      "an explicit loopback entry still matches the pure matcher (decide() refuses it before this is asked)",
      { level: "ip_port", allowlist: ["127.0.0.1:5432"] },
      "127.0.0.1",
      5432,
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
    proxy = await startEgressProxy({
      allowHostLocalUpstreams: true,
      policy,
      onEvent: (e) => events.push(e),
    });
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
        mode: "enforce",
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
        mode: "enforce",
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
        mode: "enforce",
      },
    ]);
  });

  describe("#205: per-run credential (one slot cannot use a sibling's proxy)", () => {
    const credential = { user: "run", secret: "s3cr=t/+x" };
    const basic = `Basic ${Buffer.from("run:s3cr=t/+x").toString("base64")}`;

    async function bootWithCredential(policy: EgressPolicyShape) {
      const events: EgressDecisionEvent[] = [];
      proxy = await startEgressProxy({
        allowHostLocalUpstreams: true,
        policy,
        credential,
        onEvent: (e) => events.push(e),
      });
      return { p: proxy, events };
    }

    function viaProxyWithHeaders(
      proxyPort: number,
      absoluteUrl: string,
      headers: Record<string, string>,
    ): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: proxyPort,
            method: "GET",
            path: absoluteUrl,
            headers,
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

    it("the returned url embeds the credential URL-encoded; the health probe needs none", async () => {
      const { p } = await bootWithCredential({ level: "none", allowlist: [] });
      expect(p.url).toBe(`http://run:s3cr%3Dt%2F%2Bx@127.0.0.1:${p.port}`);
      const u = new URL(p.url);
      expect(decodeURIComponent(u.password)).toBe(credential.secret);
      // assertEgressProxyReachable reads host/port off this url and GETs the
      // health path unauthenticated — the probe must keep working.
      const { status } = await viaProxyWithHeaders(
        p.port,
        EGRESS_HEALTH_PATH,
        {},
      );
      expect(status).toBe(200);
    });

    it("an absolute-form request without the credential is refused with 407, never forwarded, and audited as a proxy-auth deny", async () => {
      const upstreamPort = await startUpstreamHttp();
      const { p, events } = await bootWithCredential({
        level: "ip_port",
        allowlist: [`127.0.0.1:${upstreamPort}`],
      });
      const { status } = await viaProxyWithHeaders(
        p.port,
        `http://127.0.0.1:${upstreamPort}/x`,
        {},
      );
      expect(status).toBe(407);
      const wrong = await viaProxyWithHeaders(
        p.port,
        `http://127.0.0.1:${upstreamPort}/x`,
        {
          "proxy-authorization": `Basic ${Buffer.from("run:nope").toString("base64")}`,
        },
      );
      expect(wrong.status).toBe(407);
      // The stranger's probe is on the record — reason proxy-auth, the sentinel
      // host, NEVER what it asked for or the header it presented: a sibling
      // slot must not be able to write hosts of its choosing into this run's
      // audit trail.
      expect(events).toEqual([
        expect.objectContaining({
          action: "deny",
          reason: "proxy-auth",
          destinationHost: PROXY_AUTH_HOST,
          destinationPort: null,
        }),
        expect.objectContaining({
          action: "deny",
          reason: "proxy-auth",
          destinationHost: PROXY_AUTH_HOST,
        }),
      ]);
      const dumped = JSON.stringify(events);
      expect(dumped).not.toContain("nope");
      expect(dumped).not.toContain(String(upstreamPort));
      expect(p.unauthenticatedRequests()).toBe(2);
    });

    it("the proxy-auth audit is BOUNDED: a flood of unauthenticated requests yields PROXY_AUTH_AUDIT_CAP events and a count, never an unbounded trail", async () => {
      const { p, events } = await bootWithCredential({
        level: "ip_port",
        allowlist: [],
      });
      const flood = 25;
      for (let i = 0; i < flood; i++) {
        const { status } = await viaProxyWithHeaders(
          p.port,
          `http://attacker-chosen-${i}.example/x`,
          {},
        );
        expect(status).toBe(407);
      }
      expect(events).toHaveLength(PROXY_AUTH_AUDIT_CAP);
      expect(
        events.every(
          (e) =>
            e.reason === "proxy-auth" && e.destinationHost === PROXY_AUTH_HOST,
        ),
      ).toBe(true);
      expect(JSON.stringify(events)).not.toContain("attacker-chosen");
      expect(p.unauthenticatedRequests()).toBe(flood);
    });

    it("with the credential the request is proxied and the credential is STRIPPED before the origin", async () => {
      let seenAtOrigin: string | string[] | undefined;
      const port = await new Promise<number>((resolve) => {
        const server = createHttpServer((req, res) => {
          seenAtOrigin = req.headers["proxy-authorization"];
          res.writeHead(200).end("ok");
        });
        closers.push(() => server.close());
        server.listen(0, "127.0.0.1", () =>
          resolve((server.address() as AddressInfo).port),
        );
      });
      const { p, events } = await bootWithCredential({
        level: "ip_port",
        allowlist: [`127.0.0.1:${port}`],
      });
      const { status, body } = await viaProxyWithHeaders(
        p.port,
        `http://127.0.0.1:${port}/x`,
        {
          "proxy-authorization": basic,
        },
      );
      expect(status).toBe(200);
      expect(body).toBe("ok");
      expect(seenAtOrigin).toBeUndefined();
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe("allow");
    });

    it("CONNECT without the credential gets 407 and no tunnel; with it the tunnel opens", async () => {
      const tcpPort = await startUpstreamTcp();
      const { p, events } = await bootWithCredential({
        level: "ip_port",
        allowlist: [`127.0.0.1:${tcpPort}`],
      });
      const connectStatus = (headers: Record<string, string>) =>
        new Promise<number>((resolve, reject) => {
          const req = httpRequest({
            host: "127.0.0.1",
            port: p.port,
            method: "CONNECT",
            path: `127.0.0.1:${tcpPort}`,
            headers,
          });
          req.on("connect", (res, socket) => {
            socket.end();
            resolve(res.statusCode ?? 0);
          });
          req.on("response", (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end();
        });
      expect(await connectStatus({})).toBe(407);
      expect(events).toEqual([
        expect.objectContaining({
          action: "deny",
          reason: "proxy-auth",
          destinationHost: PROXY_AUTH_HOST,
          destinationPort: null,
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain(String(tcpPort));
      expect(await connectStatus({ "proxy-authorization": basic })).toBe(200);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ action: "allow" });
      expect(events[1]?.reason).toBeUndefined();
    });
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
        mode: "enforce",
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
        mode: "enforce",
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
      mode: "enforce",
    });
  });

  it("refuses to start with an invalid policy or missing onEvent (fail-closed constructor)", async () => {
    await expect(
      startEgressProxy({
        allowHostLocalUpstreams: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        policy: { level: "everything" as any, allowlist: [] },
        onEvent: () => {},
      }),
    ).rejects.toThrow(/policy must be/);
    await expect(
      startEgressProxy({
        allowHostLocalUpstreams: true,
        policy: domainPolicy([]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onEvent: undefined as any,
      }),
    ).rejects.toThrow(/onEvent callback is required/);
  });

  describe("#108 observe mode — allow-all AND audited", () => {
    it("defaults to enforce: an existing policy still denies exactly as before", async () => {
      const { p, events } = await boot(domainPolicy(["api.github.com"]));
      expect(p.mode).toBe("enforce");
      const res = await viaProxy(p.port, "http://example.com/x");
      expect(res.status).toBe(403);
      expect(events.at(-1)).toMatchObject({ action: "deny", mode: "enforce" });
    });

    it("observe allows a host the allowlist would deny, and proxies it for real", async () => {
      const upstreamPort = await startUpstreamHttp();
      const events: EgressDecisionEvent[] = [];
      proxy = await startEgressProxy({
        allowHostLocalUpstreams: true,
        policy: domainPolicy(["api.github.com"]), // would deny 127.0.0.1:port
        mode: "observe",
        onEvent: (e) => events.push(e),
      });
      const res = await viaProxy(
        proxy.port,
        `http://127.0.0.1:${upstreamPort}/ok`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe("UPSTREAM:GET:/ok");
    });

    it("observe still fires onEvent for EVERY decision, marked mode:observe", async () => {
      const events: EgressDecisionEvent[] = [];
      proxy = await startEgressProxy({
        allowHostLocalUpstreams: true,
        policy: { level: "none", allowlist: [] },
        mode: "observe",
        onEvent: (e) => events.push(e),
      });
      // Unreachable upstream is fine — the DECISION is what must be audited.
      await viaProxy(proxy.port, "http://denied.example.com/x").catch(() => {});
      expect(events).toContainEqual({
        destinationHost: "denied.example.com",
        destinationPort: 80,
        action: "allow",
        policyLevel: "none",
        mode: "observe",
      });
    });

    it("observe counts distinct hosts for the step log", async () => {
      proxy = await startEgressProxy({
        allowHostLocalUpstreams: true,
        policy: { level: "none", allowlist: [] },
        mode: "observe",
        onEvent: () => {},
      });
      await viaProxy(proxy.port, "http://a.example.com/1").catch(() => {});
      await viaProxy(proxy.port, "http://a.example.com/2").catch(() => {});
      await viaProxy(proxy.port, "http://b.example.com/1").catch(() => {});
      expect(proxy.observedHosts().get("a.example.com")).toBe(2);
      expect(proxy.observedHosts().get("b.example.com")).toBe(1);
    });

    it("observe still fails closed on an unparseable target", async () => {
      const events: EgressDecisionEvent[] = [];
      proxy = await startEgressProxy({
        allowHostLocalUpstreams: true,
        policy: { level: "none", allowlist: [] },
        mode: "observe",
        onEvent: (e) => events.push(e),
      });
      // Non-absolute-form: the proxy cannot know where this was meant to go, so
      // observe must NOT synthesise a connection to it.
      const res = await viaProxy(proxy.port, "/relative");
      expect(res.status).toBe(403);
      expect(events.at(-1)).toMatchObject({
        destinationHost: "unparseable",
        action: "deny",
        mode: "observe",
      });
    });
  });

  describe("#108 A2 — proxy health check", () => {
    it("resolves against a live proxy without producing an audit event", async () => {
      const events: EgressDecisionEvent[] = [];
      proxy = await startEgressProxy({
        allowHostLocalUpstreams: true,
        policy: domainPolicy([]),
        onEvent: (e) => events.push(e),
      });
      await expect(
        assertEgressProxyReachable({ url: proxy.url }),
      ).resolves.toBeUndefined();
      expect(events).toEqual([]);
      expect(proxy.observedHosts().size).toBe(0);
    });

    it("throws, naming host:port and never the URL's userinfo (#205: that is the run's proxy credential), when nothing is listening", async () => {
      // Port 9 (discard) is closed on loopback here — a dead proxy.
      await expect(
        assertEgressProxyReachable({
          url: "http://run:topsecret@127.0.0.1:9",
          timeoutMs: 500,
        }),
      ).rejects.toSatisfy((e: Error) => {
        expect(e.message).toMatch(
          /egress proxy health check failed at 127\.0\.0\.1:9/,
        );
        expect(e.message).not.toContain("topsecret");
        return true;
      });
    });

    it("throws after close(), which is the state that would hang the run", async () => {
      const p = await startEgressProxy({
        allowHostLocalUpstreams: true,
        policy: domainPolicy([]),
        onEvent: () => {},
      });
      const url = p.url;
      await p.close();
      await expect(
        assertEgressProxyReachable({ url, timeoutMs: 500 }),
      ).rejects.toThrow(/refusing to start the daemon/);
    });
  });

  it("a throwing onEvent never breaks enforcement (allow still proxies)", async () => {
    const upstreamPort = await startUpstreamHttp();
    proxy = await startEgressProxy({
      allowHostLocalUpstreams: true,
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

describe("#367: the run's proxy is not a tunnel through the box's loopback fence", () => {
  // protects=an agent cannot reach the engine, cloudflared, sshd or the Docker
  // bridge by asking its own proxy (which dials as the worker uid, inside the
  // worker cgroup) to connect there; fails_when=a host-local literal or a name
  // resolving to one is allowed in any mode, or the worker's call site opts into
  // the test seam; no_claim=the nft table itself (live only).
  it.each([
    ["127.0.0.1", true],
    ["127.1.2.3", true],
    ["localhost", true],
    ["api.localhost", true],
    ["LOCALHOST.", true],
    ["0.0.0.0", true],
    ["10.0.0.5", true],
    ["100.64.1.1", true],
    ["169.254.169.254", true],
    ["172.18.0.2", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["224.0.0.1", true],
    ["::1", true],
    ["[::1]", true],
    ["::", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["::ffff:172.18.0.2", true],
    ["::ffff:93.184.216.34", false],
    ["fe80::1", true],
    ["fd00::1", true],
    ["ff02::1", true],
    ["64:ff9b::7f00:1", true],
    ["2606:4700::6810:84e5", false],
    ["93.184.216.34", false],
    ["github.com", false],
    ["not an ip or name but weird", false],
  ])("isHostLocalAddress(%s) = %s", (host, expected) => {
    expect(isHostLocalAddress(host)).toBe(expected);
  });

  it("the guarded lookup refuses a name that resolves to a host-local address (any of its answers), passes a public one through", async () => {
    const fake = (answers: Array<{ address: string; family: number }>) =>
      ((_h: string, _o: unknown, cb: (e: null, a: unknown) => void) =>
        cb(null, answers)) as unknown as Parameters<
        typeof makeGuardedLookup
      >[0];
    const run = (
      answers: Array<{ address: string; family: number }>,
      all = false,
    ) =>
      new Promise<{
        err: NodeJS.ErrnoException | null;
        address: unknown;
        family?: number;
      }>((resolve) => {
        makeGuardedLookup(fake(answers))(
          "evil.example",
          { all },
          (err, address, family) => resolve({ err, address, family }),
        );
      });
    const rebinding = await run([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(rebinding.err?.code).toBe("EHOSTLOCAL");
    expect(rebinding.err?.message).toContain(
      "resolves to host-local 127.0.0.1",
    );
    const bridge = await run([{ address: "::ffff:172.18.0.2", family: 6 }]);
    expect(bridge.err?.code).toBe("EHOSTLOCAL");
    const empty = await run([]);
    expect(empty.err?.code).toBe("EHOSTLOCAL");
    const fine = await run([{ address: "93.184.216.34", family: 4 }]);
    expect(fine.err).toBeNull();
    expect(fine.address).toBe("93.184.216.34");
    expect(fine.family).toBe(4);
    const fineAll = await run([{ address: "93.184.216.34", family: 4 }], true);
    expect(fineAll.address).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  describe("without the test seam, a real proxy refuses host-local targets in every mode", () => {
    let proxy: EgressProxy | null = null;
    const closers: Array<() => void> = [];
    afterEach(async () => {
      await proxy?.close();
      proxy = null;
      for (const close of closers.splice(0)) close();
    });
    function upstream(): Promise<number> {
      return new Promise((resolve) => {
        const server = createTcpServer((socket) => socket.end("leaked"));
        closers.push(() => server.close());
        server.listen(0, "127.0.0.1", () =>
          resolve((server.address() as AddressInfo).port),
        );
      });
    }
    function connectVia(proxyPort: number, target: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port: proxyPort,
          method: "CONNECT",
          path: target,
        });
        req.on("connect", (res, socket) => {
          socket.destroy();
          resolve(`${res.statusCode}`);
        });
        req.on("response", (res) => {
          res.resume();
          resolve(`${res.statusCode}`);
        });
        req.on("error", reject);
        req.end();
      });
    }
    function getVia(proxyPort: number, url: string): Promise<number> {
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: proxyPort, method: "GET", path: url },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
    }

    it.each(["observe", "enforce"] as const)(
      "%s mode: CONNECT and GET to loopback, a bridge ip, an IPv4-mapped literal and localhost are 403 with reason host-local",
      async (mode) => {
        const port = await upstream();
        const events: EgressDecisionEvent[] = [];
        proxy = await startEgressProxy({
          mode,
          policy: {
            level: "ip_port",
            allowlist: [`127.0.0.1:${port}`, "172.18.0.2:7077", "localhost"],
          },
          onEvent: (e) => events.push(e),
        });
        expect(await connectVia(proxy.port, `127.0.0.1:${port}`)).toBe("403");
        expect(await connectVia(proxy.port, "172.18.0.2:7077")).toBe("403");
        expect(await connectVia(proxy.port, `[::ffff:127.0.0.1]:${port}`)).toBe(
          "403",
        );
        expect(await connectVia(proxy.port, "[::1]:22")).toBe("403");
        expect(await getVia(proxy.port, `http://localhost:${port}/`)).toBe(403);
        expect(
          await getVia(proxy.port, `http://169.254.169.254/latest/meta-data/`),
        ).toBe(403);
        expect(events).toHaveLength(6);
        for (const e of events) {
          expect(e.action).toBe("deny");
          expect(e.reason).toBe("host-local");
          expect(e.mode).toBe(mode);
        }
      },
    );
    it("a NON-LOOPBACK address of this host's own interfaces is host-local (CONNECT <public-ip>:22 must not reach sshd past the cloud firewall)", async () => {
      const candidates = [...localInterfaceAddresses()].filter(
        (a) => !isHostLocalAddress(a),
      );
      // Every local address that the range rules alone would NOT catch must be
      // caught by the interface set; a host with only private addresses has
      // nothing to prove here beyond the set being consulted.
      const local = localInterfaceAddresses();
      for (const a of candidates) {
        expect(isHostLocalAddress(a, local), a).toBe(true);
      }
      expect(isHostLocalAddress("93.184.216.34", local)).toBe(false);
      const port = await upstream();
      const events: EgressDecisionEvent[] = [];
      proxy = await startEgressProxy({
        mode: "observe",
        policy: { level: "none", allowlist: [] },
        onEvent: (e) => events.push(e),
      });
      const target = candidates[0] ?? "127.0.0.1";
      const dest = target.includes(":")
        ? `[${target}]:${port}`
        : `${target}:${port}`;
      expect(await connectVia(proxy.port, dest)).toBe("403");
      expect(events.map((e) => [e.action, e.reason])).toEqual([
        ["deny", "host-local"],
      ]);
    });

    it("a NAME that resolves to a local address is refused on the real CONNECT and GET paths (the lookup option is honoured), the upstream never sees a connection, and a host-local deny is audited", async () => {
      let upstreamConnections = 0;
      const port = await new Promise<number>((resolve) => {
        const server = createTcpServer((socket) => {
          upstreamConnections += 1;
          socket.end();
        });
        closers.push(() => server.close());
        server.listen(0, "127.0.0.1", () =>
          resolve((server.address() as AddressInfo).port),
        );
      });
      const events: EgressDecisionEvent[] = [];
      proxy = await startEgressProxy({
        mode: "observe",
        policy: { level: "none", allowlist: [] },
        onEvent: (e) => events.push(e),
      });
      // `127.1` and `2130706433` are not IP literals to isIP(), so they reach
      // getaddrinfo — which resolves both to 127.0.0.1.
      const tunnel = await new Promise<string>((resolve) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port: proxy!.port,
          method: "CONNECT",
          path: `127.1:${port}`,
        });
        req.on("connect", () => resolve("tunnel-opened"));
        req.on("response", (res) => {
          res.resume();
          resolve(`status ${res.statusCode}`);
        });
        req.on("error", (e) => resolve(`error ${e.message}`));
        req.on("close", () => resolve("closed"));
        req.end();
      });
      expect(tunnel).not.toBe("tunnel-opened");
      const get = await new Promise<string>((resolve) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: proxy!.port,
            method: "GET",
            path: `http://2130706433:${port}/`,
          },
          (res) => {
            res.resume();
            resolve(`status ${res.statusCode}`);
          },
        );
        req.on("error", (e) => resolve(`error ${e.message}`));
        req.end();
      });
      // The WHATWG parser canonicalizes every numeric IPv4 form, so on the GET
      // path `2130706433` arrives as the literal 127.0.0.1 and the literal check
      // refuses it before any lookup.
      expect(get).toBe("status 403");
      await new Promise((r) => setTimeout(r, 50));
      expect(upstreamConnections).toBe(0);
      // Observe mode allowed the CONNECT literal (it is a name), then the lookup
      // refused it: an allow row followed by a host-local deny row.
      expect(
        events.map((e) => [e.destinationHost, e.action, e.reason]),
      ).toEqual([
        ["127.1", "allow", undefined],
        ["127.1", "deny", "host-local"],
        ["127.0.0.1", "deny", "host-local"],
      ]);
      // The GET path reaches getaddrinfo only for a genuine name. This host's
      // own hostname resolves to one of its interface addresses on every CI
      // runner and dev box we use; when it does not resolve at all the dial
      // fails the same way (502, no upstream connection) with no deny row.
      const name = hostname();
      const resolved = await new Promise<boolean>((resolve) =>
        dnsLookup(name, { all: true }, (err, addrs) =>
          resolve(
            !err &&
              addrs.some((x) =>
                isHostLocalAddress(x.address, localInterfaceAddresses()),
              ),
          ),
        ),
      );
      events.length = 0;
      const getName = await new Promise<string>((resolve) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: proxy!.port,
            method: "GET",
            path: `http://${name}:${port}/`,
          },
          (res) => {
            res.resume();
            resolve(`status ${res.statusCode}`);
          },
        );
        req.on("error", (e) => resolve(`error ${e.message}`));
        req.end();
      });
      expect(getName).toBe("status 502");
      await new Promise((r) => setTimeout(r, 50));
      expect(upstreamConnections).toBe(0);
      if (resolved) {
        expect(
          events.map((e) => [e.destinationHost, e.action, e.reason]),
        ).toEqual([
          [name.toLowerCase(), "allow", undefined],
          [name.toLowerCase(), "deny", "host-local"],
        ]);
      }
    });
  });

  it("the worker's call site never opts into the test seam", () => {
    const workflow = readFileSync(
      new URL("./workflow.ts", import.meta.url),
      "utf8",
    );
    expect(workflow).not.toContain("allowHostLocalUpstreams");
  });
});
