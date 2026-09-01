import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  CALLBACK_VIA_PROXY_ENV,
  postJson,
  resolveProxyForUrl,
  shouldBypassProxy,
} from "./proxy-fetch";

/** Every proxying case requires the worker's explicit opt-in (#108 F5). */
const ON = { [CALLBACK_VIA_PROXY_ENV]: "1" };

const servers: Server[] = [];
/**
 * Sockets handed to us by the 'connect' event. These are UPGRADED out of the
 * server's own connection tracking, so `closeAllConnections()` does not reach
 * them and `close()` waits on them forever — a 10s hook timeout instead of a
 * test failure. Any test that answers a CONNECT must register its socket here.
 */
const tunnels: { destroy: () => void }[] = [];

afterEach(async () => {
  tunnels.splice(0).forEach((s) => s.destroy());
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
  });
}

describe("resolveProxyForUrl", () => {
  it("returns null when no proxy env is set", () => {
    expect(resolveProxyForUrl("https://www.example.com/api", {})).toBeNull();
  });

  it("prefers HTTPS_PROXY for an https target and HTTP_PROXY for an http target", () => {
    const env = {
      ...ON,
      HTTPS_PROXY: "http://127.0.0.1:1111",
      HTTP_PROXY: "http://127.0.0.1:2222",
    };
    expect(resolveProxyForUrl("https://a.example.com/x", env)).toBe(
      "http://127.0.0.1:1111",
    );
    expect(resolveProxyForUrl("http://a.example.com/x", env)).toBe(
      "http://127.0.0.1:2222",
    );
  });

  it("honours lowercase https_proxy when the uppercase form is absent", () => {
    expect(
      resolveProxyForUrl("https://a.example.com", {
        ...ON,
        https_proxy: "http://127.0.0.1:3333",
      }),
    ).toBe("http://127.0.0.1:3333");
  });

  it("bypasses a loopback callback url under the injected NO_PROXY", () => {
    expect(
      resolveProxyForUrl("http://127.0.0.1:9999/api/daemon-event", {
        ...ON,
        HTTP_PROXY: "http://127.0.0.1:1111",
        NO_PROXY: "127.0.0.1,localhost",
      }),
    ).toBeNull();
  });

  it("stays DIRECT for a policy-bearing run that was never opted in (#108 F5)", () => {
    // The pre-#108 world: an egress policy is in force, HTTPS_PROXY is injected
    // for the AGENT CLI child, and the daemon's own callback has always gone
    // direct. Nothing about that run may change.
    expect(
      resolveProxyForUrl("https://www.example.com/api/daemon-event", {
        HTTPS_PROXY: "http://127.0.0.1:1111",
        HTTP_PROXY: "http://127.0.0.1:1111",
        https_proxy: "http://127.0.0.1:1111",
        http_proxy: "http://127.0.0.1:1111",
      }),
    ).toBeNull();
    // Only the exact opt-in value flips it.
    expect(
      resolveProxyForUrl("https://www.example.com/api/daemon-event", {
        [CALLBACK_VIA_PROXY_ENV]: "true",
        HTTPS_PROXY: "http://127.0.0.1:1111",
      }),
    ).toBeNull();
    expect(
      resolveProxyForUrl("https://www.example.com/api/daemon-event", {
        ...ON,
        HTTPS_PROXY: "http://127.0.0.1:1111",
      }),
    ).toBe("http://127.0.0.1:1111");
  });

  it("ignores a scheme-less proxy value instead of guessing a scheme", () => {
    expect(
      resolveProxyForUrl("https://a.example.com", {
        ...ON,
        HTTPS_PROXY: "127.0.0.1:1111",
      }),
    ).toBeNull();
  });
});

describe("shouldBypassProxy", () => {
  it("matches a suffix entry against a subdomain but not a sibling", () => {
    expect(shouldBypassProxy("a.example.com", ".example.com")).toBe(true);
    expect(shouldBypassProxy("notexample.com", ".example.com")).toBe(false);
    expect(shouldBypassProxy("example.com", "example.com")).toBe(true);
  });

  it('bypasses every target for "*"', () => {
    expect(shouldBypassProxy("anything.internal", "*")).toBe(true);
  });

  it("is false for an empty NO_PROXY", () => {
    expect(shouldBypassProxy("a.example.com", undefined)).toBe(false);
    expect(shouldBypassProxy("a.example.com", "")).toBe(false);
  });
});

describe("postJson", () => {
  it("posts directly when no proxy env is set (today's behaviour)", async () => {
    let seen: {
      method?: string;
      url?: string;
      token?: string | string[];
      body?: string;
    } = {};
    const port = await listen(
      createServer((req: IncomingMessage, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          seen = {
            method: req.method,
            url: req.url,
            token: req.headers["x-daemon-token"],
            body,
          };
          res.writeHead(200).end();
        });
      }),
    );
    const result = await postJson({
      url: `http://127.0.0.1:${port}/api/daemon-event`,
      headers: { "Content-Type": "application/json", "X-Daemon-Token": "tok" },
      body: JSON.stringify({ hello: "world" }),
      env: {},
    });
    expect(result).toEqual({ status: 200 });
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/api/daemon-event");
    expect(seen.token).toBe("tok");
    expect(seen.body).toBe('{"hello":"world"}');
  });

  it("policy present, agentUser empty ⇒ plain fetch straight to the origin (#108 F5)", async () => {
    let originHit = false;
    let proxyHit = false;
    const proxyPort = await listen(
      createServer((req, res) => {
        proxyHit = true;
        req.resume();
        res.writeHead(200).end();
      }),
    );
    const originPort = await listen(
      createServer((req, res) => {
        originHit = true;
        req.resume();
        req.on("end", () => res.writeHead(200).end());
      }),
    );
    const result = await postJson({
      url: `http://127.0.0.1:${originPort}/api/daemon-event`,
      headers: { "X-Daemon-Token": "tok" },
      body: "{}",
      // HTTP_PROXY set (the run has an egress policy) but NO opt-in.
      env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` },
    });
    expect(result).toEqual({ status: 200 });
    expect(originHit).toBe(true);
    expect(proxyHit).toBe(false);
  });

  it("sends an absolute-form request to the proxy for an http target", async () => {
    let proxiedUrl: string | undefined;
    const proxyPort = await listen(
      createServer((req, res) => {
        proxiedUrl = req.url;
        req.resume();
        req.on("end", () => res.writeHead(200).end());
      }),
    );
    let originHit = false;
    const originPort = await listen(
      createServer((req, res) => {
        originHit = true;
        req.resume();
        res.writeHead(200).end();
      }),
    );
    const result = await postJson({
      url: `http://origin.invalid:${originPort}/api/daemon-event`,
      headers: { "Content-Type": "application/json" },
      body: "{}",
      env: { ...ON, HTTP_PROXY: `http://127.0.0.1:${proxyPort}` },
    });
    expect(result).toEqual({ status: 200 });
    expect(proxiedUrl?.startsWith("http://origin.invalid:")).toBe(true);
    expect(originHit).toBe(false);
  });

  it("issues CONNECT host:443 to the proxy for an https target", async () => {
    let connectTarget: string | undefined;
    let connectMethod: string | undefined;
    const server = createServer();
    server.on("connect", (req, socket) => {
      connectMethod = req.method;
      connectTarget = req.url;
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.end();
    });
    const proxyPort = await listen(server);
    await expect(
      postJson({
        url: "https://www.example.com/api/daemon-event",
        headers: { "X-Daemon-Token": "super-secret-token" },
        body: "{}",
        env: { ...ON, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
      }),
    ).rejects.toThrow(/www\.example\.com:443/);
    expect(connectMethod).toBe("CONNECT");
    expect(connectTarget).toBe("www.example.com:443");
  });

  it("never puts the daemon token in a CONNECT rejection message", async () => {
    const server = createServer();
    server.on("connect", (_req, socket) => {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.end();
    });
    const proxyPort = await listen(server);
    const err = await postJson({
      url: "https://www.example.com/api/daemon-event",
      headers: { "X-Daemon-Token": "super-secret-token" },
      body: "{}",
      env: { ...ON, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toContain("super-secret-token");
    expect(err?.message).toContain("403");
  });

  it("surfaces a non-2xx origin status instead of throwing", async () => {
    const port = await listen(
      createServer((req, res) => {
        req.resume();
        res.writeHead(401).end();
      }),
    );
    const result = await postJson({
      url: `http://127.0.0.1:${port}/api/daemon-event`,
      headers: {},
      body: "{}",
      env: {},
    });
    expect(result).toEqual({ status: 401 });
  });

  /**
   * The CONNECT succeeds and the handshake then fails or stalls. Both used to
   * be unreachable by any handler: node throws on an unhandled socket 'error',
   * which kills the whole daemon (no uncaughtException handler in this
   * package), and a stall was covered by nothing because https.request's
   * `timeout` is socket-scoped and only arms once the socket is assigned.
   *
   * Both assertions below are really "the process is still alive and we got a
   * rejection" — if either regresses, vitest reports an unhandled error and the
   * worker box gets a run that dies with no explanation.
   */
  it("rejects instead of crashing when TLS fails AFTER a successful CONNECT", async () => {
    const server = createServer();
    server.on("connect", (_req, socket) => {
      tunnels.push(socket);
      socket.on("error", () => {}); // the client destroys it; not a test failure
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // Tunnel is up; now speak garbage instead of TLS so the handshake fails.
      socket.write("this is definitely not a TLS ServerHello\r\n");
    });
    const proxyPort = await listen(server);
    const err = await postJson({
      url: "https://www.example.com/api/daemon-event",
      headers: { "X-Daemon-Token": "super-secret-token" },
      body: "{}",
      env: { ...ON, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
      timeoutMs: 300,
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toContain("super-secret-token");
  });

  it("times out instead of hanging when the TLS handshake stalls after CONNECT", async () => {
    const server = createServer();
    server.on("connect", (_req, socket) => {
      tunnels.push(socket);
      socket.on("error", () => {});
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // ...and then say nothing at all, forever.
    });
    const proxyPort = await listen(server);
    const started = Date.now();
    const err = await postJson({
      url: "https://www.example.com/api/daemon-event",
      headers: {},
      body: "{}",
      env: { ...ON, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
      timeoutMs: 300,
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(4000); // bounded, not hung
  });
});
