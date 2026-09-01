import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { postJson, resolveProxyForUrl, shouldBypassProxy } from "./proxy-fetch";

const servers: Server[] = [];

afterEach(async () => {
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
        https_proxy: "http://127.0.0.1:3333",
      }),
    ).toBe("http://127.0.0.1:3333");
  });

  it("bypasses a loopback callback url under the injected NO_PROXY", () => {
    expect(
      resolveProxyForUrl("http://127.0.0.1:9999/api/daemon-event", {
        HTTP_PROXY: "http://127.0.0.1:1111",
        NO_PROXY: "127.0.0.1,localhost",
      }),
    ).toBeNull();
  });

  it("ignores a scheme-less proxy value instead of guessing a scheme", () => {
    expect(
      resolveProxyForUrl("https://a.example.com", {
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
      env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` },
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
        env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
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
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
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
});
