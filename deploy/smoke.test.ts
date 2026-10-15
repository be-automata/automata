/**
 * Tests for deploy/smoke.ts against a local fake of the deployed www.
 *
 *   Run:  node --test deploy/smoke.test.ts
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { OPEN_REDIRECT_PROBES, runSmoke, type ProbeResult } from "./smoke.ts";

const BUILD_ID = "TestBuild_123abc";
const SESSION_COOKIE = "better-auth.session_token=signed";

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
) => boolean;

/** Per-test overrides; a handler that returns true has answered. */
let overrides: Handler[] = [];
let hits = new Map<string, number>();

function healthy(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
): void {
  const url = new URL(req.url ?? "/", baseUrl);
  const path = url.pathname;
  const signedIn = req.headers.cookie === SESSION_COOKIE;
  if (path === "/api/webhooks/slack" && req.method === "POST") {
    res.writeHead(401).end("unauthorized");
    return;
  }
  if (path === "/") {
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(
        `<html><script>self.__next_f.push([1,"{\\"b\\":\\"${BUILD_ID}\\"}"])</script></html>`,
      );
    return;
  }
  if (path === "/api/auth/get-session") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(signedIn ? { user: { id: "user-1" } } : null));
    return;
  }
  if (path === "/dashboard") {
    if (signedIn) {
      res.writeHead(200).end("dashboard");
    } else {
      res.writeHead(307, { location: "/login" }).end();
    }
    return;
  }
  const org = /^\/o\/([^/]+)(\/.*)?$/.exec(path);
  if (org) {
    // Like Next.js: collapse an empty segment with a same-origin 308.
    if ((req.url ?? "").includes("//")) {
      res
        .writeHead(308, { location: (req.url ?? "").replace(/\/{2,}/g, "/") })
        .end();
      return;
    }
    if (org[2] && org[2] !== "/settings") {
      res.writeHead(404).end("Not found");
      return;
    }
    if (signedIn) {
      res.writeHead(307, { location: `${baseUrl}/dashboard` }).end();
      return;
    }
    const login = new URL("/login", baseUrl);
    login.searchParams.set("returnUrl", `${url.pathname}${url.search}`);
    res.writeHead(307, { location: login.href }).end();
    return;
  }
  res.writeHead(404).end("Not found");
}

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    for (const handler of overrides) {
      if (handler(req, res, baseUrl)) {
        return;
      }
    }
    healthy(req, res, baseUrl);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  overrides = [];
  hits = new Map();
});

function byId(results: ProbeResult[], id: string): ProbeResult {
  const result = results.find((r) => r.id === id);
  assert.ok(result, `no result for ${id}`);
  return result;
}

function failures(results: ProbeResult[]): ProbeResult[] {
  return results.filter((r) => r.status === "fail");
}

describe("runSmoke", () => {
  it("passes every signed-out probe against a healthy deploy", async () => {
    const results = await runSmoke({ baseUrl, retryDelayMs: 0 });
    assert.deepEqual(failures(results), []);
    // C16, C7, C7b, the open-redirect probes, C17, and the signed-in skip.
    assert.equal(results.length, 3 + OPEN_REDIRECT_PROBES.length + 1 + 1);
    assert.equal(OPEN_REDIRECT_PROBES.length, 8);
    assert.match(byId(results, "C17").detail, new RegExp(BUILD_ID));
  });

  it("fails an open-redirect probe whose 308 leaves the origin", async () => {
    overrides.push((req, res) => {
      if (req.url === "/o/acme/%2F%2Fevil.com") {
        res.writeHead(308, { location: "https://evil.com/" }).end();
        return true;
      }
      return false;
    });
    const results = await runSmoke({ baseUrl, retryDelayMs: 0 });
    const failed = failures(results);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.id, "C8.1");
    assert.match(failed[0]?.detail ?? "", /left origin/);
    assert.equal(hits.get("GET /o/acme/%2F%2Fevil.com"), 1, "no retry");
  });

  it("follows a same-origin 308 and grades the final answer", async () => {
    overrides.push((req, res) => {
      if (req.url === "/o/acme/%5C%5Cevil.com") {
        res.writeHead(308, { location: "/elsewhere" }).end();
        return true;
      }
      if (req.url === "/elsewhere") {
        res.writeHead(200).end("ok");
        return true;
      }
      return false;
    });
    const results = await runSmoke({ baseUrl, retryDelayMs: 0 });
    const failed = failures(results);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.id, "C8.4");
    assert.match(failed[0]?.detail ?? "", /want a final 404/);
  });

  it("fails C17 when the expected build id is not served", async () => {
    const results = await runSmoke({
      baseUrl,
      expectBuildId: "SomeOtherBuild",
      retryDelayMs: 0,
    });
    const c17 = byId(results, "C17");
    assert.equal(c17.status, "fail");
    assert.match(c17.detail, /SomeOtherBuild not served/);
    assert.match(c17.detail, new RegExp(BUILD_ID));
  });

  it("fails C17 when the page carries no build id at all", async () => {
    overrides.push((req, res) => {
      if (req.url === "/") {
        res.writeHead(200).end("<html>maintenance</html>");
        return true;
      }
      return false;
    });
    const c17 = byId(await runSmoke({ baseUrl, retryDelayMs: 0 }), "C17");
    assert.equal(c17.status, "fail");
    assert.match(c17.detail, /no build id/);
  });

  it("passes C17 when the expected build id is served", async () => {
    const results = await runSmoke({
      baseUrl,
      expectBuildId: BUILD_ID,
      retryDelayMs: 0,
    });
    assert.equal(byId(results, "C17").status, "pass");
  });

  it("retries a transient 503 and passes once the server recovers", async () => {
    let served503 = 0;
    overrides.push((req, res) => {
      if (req.url === "/api/webhooks/slack" && served503 < 2) {
        served503 += 1;
        res.writeHead(503).end("busy");
        return true;
      }
      return false;
    });
    const c16 = byId(await runSmoke({ baseUrl, retryDelayMs: 0 }), "C16");
    assert.equal(c16.status, "pass");
    assert.equal(c16.attempts, 3);
  });

  it("fails after the retries are spent on a persistent 503", async () => {
    overrides.push((req, res) => {
      if (req.url === "/api/webhooks/slack") {
        res.writeHead(503).end("busy");
        return true;
      }
      return false;
    });
    const c16 = byId(
      await runSmoke({ baseUrl, retries: 1, retryDelayMs: 0 }),
      "C16",
    );
    assert.equal(c16.status, "fail");
    assert.equal(c16.attempts, 2);
    assert.match(c16.detail, /HTTP 503/);
  });

  it("does not retry a wrong but well-formed answer", async () => {
    overrides.push((req, res) => {
      if (req.url === "/api/webhooks/slack") {
        res.writeHead(200).end("ok");
        return true;
      }
      return false;
    });
    const c16 = byId(await runSmoke({ baseUrl, retryDelayMs: 0 }), "C16");
    assert.equal(c16.status, "fail");
    assert.equal(c16.attempts, 1);
  });

  it("fails C7 when the login redirect drops the query string", async () => {
    overrides.push((req, res, base) => {
      if (req.url === "/o/acme/settings?tab=1") {
        res
          .writeHead(307, {
            location: `${base}/login?returnUrl=%2Fo%2Facme%2Fsettings`,
          })
          .end();
        return true;
      }
      return false;
    });
    const c7 = byId(await runSmoke({ baseUrl, retryDelayMs: 0 }), "C7");
    assert.equal(c7.status, "fail");
  });

  it("skips the signed-in probes without a session cookie", async () => {
    const results = await runSmoke({ baseUrl, retryDelayMs: 0 });
    const skip = byId(results, "S");
    assert.equal(skip.status, "skip");
    assert.equal(
      results.some((r) => r.id.startsWith("S") && r.id !== "S"),
      false,
    );
    assert.equal(hits.get("GET /api/auth/get-session"), undefined);
    assert.equal(hits.get("GET /dashboard"), undefined);
  });

  it("runs the signed-in probes with a session cookie", async () => {
    const results = await runSmoke({
      baseUrl,
      retryDelayMs: 0,
      signedIn: { cookie: SESSION_COOKIE, userId: "user-1", orgSlug: "beta" },
    });
    assert.deepEqual(failures(results), []);
    for (const id of ["S1", "S2", "S3"]) {
      assert.equal(byId(results, id).status, "pass");
    }
  });

  it("fails S1 when the session belongs to someone else", async () => {
    const results = await runSmoke({
      baseUrl,
      retryDelayMs: 0,
      signedIn: { cookie: SESSION_COOKIE, userId: "user-2", orgSlug: "beta" },
    });
    assert.equal(byId(results, "S1").status, "fail");
  });
});
