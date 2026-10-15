/**
 * Loaded into the `next start` process with `node --import` (see
 * playwright.config.ts). The app under test must never reach the network:
 *
 * - localhost passes through untouched (the app itself, Redis HTTP, …);
 * - api.github.com is answered from e2e/fixtures/github/*.json, after an
 *   optional delay read per request from E2E_CONTROL_FILE (`githubDelayMs`),
 *   so a spec can hold the repo list in its loading state;
 * - anything else (Slack included) is refused: the call throws and the
 *   attempt is appended to E2E_EGRESS_LOG. e2e/run.ts fails the run when that
 *   log holds a refused call, even if every spec passed.
 *
 * Only the origin and path are logged: a query string can carry a secret.
 *
 * Plain .mjs on purpose: it runs before Next.js and before any TypeScript
 * loader, and needs nothing but node built-ins.
 */
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

import { isLocalHost, normalizeHost } from "./egress-host.mjs";

const EGRESS_LOG = process.env.E2E_EGRESS_LOG;
const CONTROL_FILE = process.env.E2E_CONTROL_FILE;
const FIXTURES_DIR = process.env.E2E_GITHUB_FIXTURES;

const GITHUB_API_HOST = "api.github.com";

function record(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  if (entry.kind === "blocked") {
    console.error(`[e2e egress-guard] ${line}`);
  }
  if (EGRESS_LOG) {
    appendFileSync(EGRESS_LOG, `${line}\n`);
  }
}

function readControl() {
  if (!CONTROL_FILE) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(CONTROL_FILE, "utf8"));
  } catch {
    // A spec is rewriting the file right now, or it was never written.
    return {};
  }
}

/** `{ method, path, status, body }` per file; `:name` matches one segment. */
function loadFixtures() {
  if (!FIXTURES_DIR) {
    return [];
  }
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const fixture = JSON.parse(
        readFileSync(path.join(FIXTURES_DIR, file), "utf8"),
      );
      return { ...fixture, file, segments: fixture.path.split("/") };
    });
}

const FIXTURES = loadFixtures();

function matchFixture(method, pathname) {
  const segments = pathname.replace(/\/+$/, "").split("/");
  return FIXTURES.find(
    (fixture) =>
      fixture.method === method &&
      fixture.segments.length === segments.length &&
      fixture.segments.every(
        (segment, index) =>
          segment.startsWith(":") || segment === segments[index],
      ),
  );
}

function describeRequest(input, init) {
  let url;
  let method = "GET";
  if (typeof input === "string" || input instanceof URL) {
    url = new URL(String(input));
  } else {
    url = new URL(input.url);
    method = input.method ?? method;
  }
  if (init?.method) {
    method = init.method;
  }
  return { url, method: method.toUpperCase() };
}

const realFetch = globalThis.fetch;

async function guardedFetch(input, init) {
  const { url, method } = describeRequest(input, init);
  if (isLocalHost(url.hostname)) {
    return realFetch(input, init);
  }
  const where = `${url.origin}${url.pathname}`;
  if (url.hostname === GITHUB_API_HOST) {
    const delayMs = Number(readControl().githubDelayMs ?? 0);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const fixture = matchFixture(method, url.pathname);
    record({
      kind: fixture ? "github" : "github-unmatched",
      method,
      url: where,
      fixture: fixture?.file ?? null,
      delayMs,
    });
    if (!fixture) {
      return new Response(
        JSON.stringify({ message: "Not Found (no e2e fixture)" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status ?? 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  record({ kind: "blocked", via: "fetch", method, url: where });
  throw new TypeError(`e2e egress guard: refused ${method} ${where}`);
}

globalThis.fetch = guardedFetch;

/** http(s).request/get: anything not on localhost is refused the same way. */
function requestHost(args) {
  const [first, second] = args;
  if (typeof first === "string" || first instanceof URL) {
    return new URL(String(first)).hostname;
  }
  const options = first ?? second ?? {};
  return normalizeHost(options.hostname ?? options.host ?? "localhost");
}

for (const [scheme, module] of [
  ["http", http],
  ["https", https],
]) {
  for (const name of ["request", "get"]) {
    const original = module[name];
    module[name] = function guardedRequest(...args) {
      const host = requestHost(args);
      if (!isLocalHost(host)) {
        const where = `${scheme}://${host}`;
        record({ kind: "blocked", via: `${scheme}.${name}`, url: where });
        throw new Error(`e2e egress guard: refused ${where}`);
      }
      return original.apply(this, args);
    };
  }
}
// ESM `import { get } from "node:https"` bindings only see the patch after this.
syncBuiltinESMExports();
