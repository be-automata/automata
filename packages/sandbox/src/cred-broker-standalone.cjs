/**
 * Standalone GIT CREDENTIAL BROKER for the Docker sandbox plane (#114). Runs
 * inside a per-run credential-broker sidecar container that docker-provider.ts
 * stands up (setUpCredentialBroker) when a sandbox is created with a broker
 * shape (Docker + flag on).
 *
 * Self-contained on purpose: plain CommonJS, node stdlib only, no imports —
 * it is copied/bind-mounted into the sidecar and executed with a bare `node`.
 * The build step (scripts/build-cred-broker.mjs) copies it to
 * dist/cred-broker-standalone.cjs and embeds it into
 * src/cred-broker-standalone.generated.ts for webpack-safe consumption (no fs
 * asset resolution in bundled server code — see the repo's www-bundle
 * constraint). A vitest test asserts the generated file is byte-in-sync.
 *
 * MIRROR NOTE: the handler fences deliberately mirror
 * packages/worker/src/agent-run/git-broker.ts + broker-common.ts — packages/
 * worker cannot be imported from packages/sandbox (plane boundary), so per the
 * repo's mirror convention the broker logic is COPIED, one source per package.
 * Behavioral changes to the fences must land in BOTH files.
 *
 * THREAT MODEL (identical to git-broker.ts): a prompt-injected agent in the
 * guest must never be able to read a reusable GitHub credential. The real
 * installation token stays inside THIS sidecar container (read from a
 * bind-mounted `:ro` secret file, held in this process's heap) — never in the
 * guest's env, argv, `ps`, or on the guest disk. The guest's git points at
 * `http://<alias>:<port>/<owner>/<repo>.git` with a per-run `Bearer` (useless
 * off-box); this broker verifies the bearer, injects `Authorization: Basic
 * x-access-token:<token>` server-side, and streams to
 * `https://github.com/<owner>/<repo>.git`. The token is NEVER logged and NEVER
 * sent to the guest.
 *
 * Differences from the worker broker (loopback, per-run, token-in-heap):
 * - binds 0.0.0.0 — the guest container reaches it over the INTERNAL docker
 *   network, not loopback.
 * - secrets are read from a bind-mounted `:ro` file (installationToken +
 *   runBearer), NOT from argv/`-e` — so `docker inspect .Config.Env` and the
 *   control-plane logs never carry the token (see docker-cred-broker.ts §4).
 *
 * Config:
 * - CRED_BROKER_SECRETS_FILE: path to a `:ro` JSON file
 *   `{"installationToken": "...", "runBearer": "..."}` (default
 *   /run/cred-broker/secrets.json).
 * - CRED_BROKER_REPO_FULL_NAME: `owner/repo` this run may reach (non-secret).
 * - CRED_BROKER_GIT_PORT: listen port (default 3129).
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { timingSafeEqual } = require("node:crypto");

const UPLOAD_PACK = "git-upload-pack";
const RECEIVE_PACK = "git-receive-pack";

// Hop-by-hop / body-framing headers neither direction may copy verbatim — Node
// (response) and fetch (request) re-frame the body, so a stale
// length/encoding/connection header corrupts it. MIRRORS broker-common.ts.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "upgrade",
]);

// Request headers the broker OWNS — everything else is forwarded VERBATIM (a
// denylist, symmetric with HOP_BY_HOP on the response side). `authorization` is
// replaced with the injected credential (never the client's bearer); `host` is
// set by fetch to the upstream. A denylist forwards future git headers by
// default — the allowlist trap already bit us once: `git-protocol` was
// load-bearing and its omission silently downgraded protocol v2→v0. MIRRORS
// broker-common.ts.
const REQUEST_OWNED = new Set([...HOP_BY_HOP, "authorization", "host"]);

/** MIRRORS broker-common.ts timingSafeEqualStr. */
function timingSafeEqualStr(a, bBuf) {
  const ab = Buffer.from(a);
  // Length check first is safe: bearer length is not secret, and timingSafeEqual
  // throws on length mismatch. `bBuf` is precomputed once in the closure.
  return ab.length === bBuf.length && timingSafeEqual(ab, bBuf);
}

/**
 * Start the git credential broker. Mirrors startGitBroker in git-broker.ts,
 * relocated to bind the internal docker network instead of loopback.
 *
 * @param {{
 *   installationToken: string,
 *   repoFullName: string,
 *   runBearer: string,
 *   port?: number,
 *   host?: string,
 *   fetchImpl?: typeof fetch,
 * }} opts
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
async function startCredBroker(opts) {
  const { installationToken, repoFullName, runBearer } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  // 0.0.0.0 in production (guest reaches it over the internal network); tests
  // pass 127.0.0.1 + port 0 for an ephemeral loopback listener.
  const host = opts.host ?? "0.0.0.0";
  const listenPort = opts.port ?? 0;

  // Trim + lowercase mirrors @terragon/shared's normalizeRepo WITHOUT importing
  // it (this standalone is dependency-free). GitHub slugs are case-insensitive;
  // matching that normalization keeps a padded slug fencing identically here.
  const parts = String(repoFullName).trim().toLowerCase().split("/");
  const owner = parts[0];
  const repo = parts[1];
  const rest = parts.slice(2);
  if (!owner || !repo || rest.length > 0) {
    throw new Error(
      `cred-broker: repoFullName must be 'owner/repo', got: ${repoFullName}`,
    );
  }
  // The entire fence rests on the bearer compare and the token injection. An
  // empty bearer would make the check pass for the literal, secret-less
  // "Authorization: Bearer "; an empty token would inject useless auth. Fail
  // loudly at construction rather than serve a collapsed fence.
  if (String(runBearer).length === 0) {
    throw new Error(
      "cred-broker: runBearer must be a non-empty per-run secret",
    );
  }
  if (String(installationToken).length === 0) {
    throw new Error("cred-broker: installationToken must be non-empty");
  }
  const pathPrefix = `/${owner}/${repo}.git/`;
  const injectedAuth =
    "Basic " +
    Buffer.from(`x-access-token:${installationToken}`).toString("base64");
  const expectedBearerBuf = Buffer.from(`Bearer ${runBearer}`);

  async function handle(req, res) {
    // 1. Per-run bearer — the agent's git presents it via http.extraHeader.
    if (
      !timingSafeEqualStr(req.headers["authorization"] ?? "", expectedBearerBuf)
    ) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // 2. Repo path fence — case-insensitively, only this run's repo.
    const lowerPath = url.pathname.toLowerCase();
    if (!lowerPath.startsWith(pathPrefix)) {
      res.writeHead(404).end("not found");
      return;
    }
    const endpoint = url.pathname.slice(pathPrefix.length);
    const service = url.searchParams.get("service");
    // 3. Method + endpoint allowlist — the only three git-smart-HTTP calls.
    const allowed =
      (req.method === "GET" &&
        endpoint === "info/refs" &&
        (service === UPLOAD_PACK || service === RECEIVE_PACK)) ||
      (req.method === "POST" &&
        (endpoint === UPLOAD_PACK || endpoint === RECEIVE_PACK));
    if (!allowed) {
      res.writeHead(403).end("forbidden");
      return;
    }

    // 4. Proxy to GitHub with the token injected server-side. The upstream path
    //    is rebuilt from the FENCED owner/repo/endpoint, never echoed from the
    //    request, so a normalized-away traversal can't retarget it.
    const target = `https://github.com/${owner}/${repo}.git/${endpoint}${url.search}`;
    // Forward every request header VERBATIM except the ones the broker owns
    // (REQUEST_OWNED), then inject the real credential last so it always wins
    // over any client-supplied authorization.
    const fwd = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (REQUEST_OWNED.has(k)) continue;
      if (typeof v === "string") fwd[k] = v;
      else if (Array.isArray(v)) fwd[k] = v.join(", ");
    }
    fwd.authorization = injectedAuth;
    const hasBody = req.method === "POST";
    const upstream = await fetchImpl(target, {
      method: req.method,
      headers: fwd,
      body: hasBody ? Readable.toWeb(req) : undefined,
      // Node requires duplex for a streaming request body.
      ...(hasBody ? { duplex: "half" } : {}),
    });

    const outHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } else {
      res.end();
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Never leak the token; report a bare 502 to the agent's git.
      console.error("cred-broker: proxy error", err && err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end("bad gateway");
    });
  });

  await new Promise((resolve) => server.listen(listenPort, host, resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/**
 * Read + validate the sidecar secret file (installationToken + runBearer).
 * Throws (fail-closed) on missing/garbage input — a collapsed fence must never
 * start.
 */
function parseSecrets(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("cred-broker: secrets file is not JSON");
  }
  if (
    !parsed ||
    typeof parsed.installationToken !== "string" ||
    typeof parsed.runBearer !== "string"
  ) {
    throw new Error(
      "cred-broker: secrets must be {installationToken: string, runBearer: string}",
    );
  }
  return {
    installationToken: parsed.installationToken,
    runBearer: parsed.runBearer,
  };
}

async function main() {
  const secretsFile =
    process.env.CRED_BROKER_SECRETS_FILE || "/run/cred-broker/secrets.json";
  const { installationToken, runBearer } = parseSecrets(
    fs.readFileSync(secretsFile, "utf8"),
  );
  const repoFullName = process.env.CRED_BROKER_REPO_FULL_NAME || "";
  const port = Number(process.env.CRED_BROKER_GIT_PORT || 3129);
  const broker = await startCredBroker({
    installationToken,
    repoFullName,
    runBearer,
    port,
    host: "0.0.0.0",
  });
  // Non-secret startup line only — never the token or the bearer.
  console.log(
    JSON.stringify({
      msg: "cred-broker-standalone listening",
      port: broker.port,
      repoFullName: repoFullName.trim().toLowerCase(),
    }),
  );
}

module.exports = { startCredBroker, parseSecrets };

if (require.main === module) {
  main().catch((err) => {
    // Fail-closed: never start a collapsed fence; do not leak secrets.
    console.error("cred-broker: failed to start", err && err.message);
    process.exit(1);
  });
}
