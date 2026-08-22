import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Worker-box-LOCAL gh-API credential broker (#81, be-automata/automata) — the
 * REST/GraphQL sibling of git-broker.ts.
 *
 * The problem: the agent's `gh` needs to reach api.github.com (the fail-closed
 * `gh auth status` preflight, `gh pr view`, `gh api` reads), but handing it the
 * installation token in `GH_TOKEN` gives a prompt-injected agent a reusable
 * credential (`gh auth token`, `echo $GH_TOKEN`). Same ruling as the git half:
 * any credential the agent's own gh can present, the agent can read — so the
 * real token lives in the WORKER PROCESS HEAP and the agent authenticates to
 * this broker with a non-reusable per-run bearer.
 *
 * Transport (spike-verified, gh 2.95.0): `http_unix_socket` in the run's
 * isolated GH_CONFIG_DIR makes gh send CLEARTEXT HTTP through a unix socket
 * with the original `Host: api.github.com` and `authorization: token
 * $GH_TOKEN` — no TLS, no GHES path prefix. `GH_TOKEN` is set to the per-run
 * bearer (it doubles as the non-empty placeholder gh requires), so `gh auth
 * token` prints only the bearer — useless off-box.
 *
 * Fencing, per request and in order:
 *   - per-run bearer, timing-safe (`token <bearer>` — gh's scheme — or
 *     `Bearer <bearer>` for hand-rolled curls). Socket file permissions are NOT
 *     a fence: the agent runs as the same uid.
 *   - Host must be `api.github.com` (uploads.github.com /
 *     objects.githubusercontent.com are out of scope — documented limitation).
 *   - method/path allowlist, v1 = read-only: GET/HEAD any path (reads cannot
 *     mutate, and authority is the installation token's own repo scoping, which
 *     this broker cannot widen); POST /graphql ONLY when the query contains no
 *     mutation operation — `gh auth status` and `gh pr view/list/checks` are
 *     GraphQL reads and MUST pass (the preflight is load-bearing on this path);
 *     everything else 403 (gh API writes are control-plane server-actions, and
 *     loosening later is an allowlist change, not an architecture change).
 * The token is NEVER logged.
 */

/**
 * macOS `sun_path` is ~104 bytes and — worse than the client's `connect:
 * invalid argument` — Node's server bind SILENTLY TRUNCATES an over-long path
 * (verified: a 133-char path bound at its 103-char truncation, no error). A
 * bind error will never surface the problem, so the length is asserted
 * explicitly at construction, with margin.
 */
const MAX_SOCKET_PATH_BYTES = 100;

/** Cap the buffered GraphQL body; gh's queries are a few KB. Fail closed. */
const MAX_GRAPHQL_BODY_BYTES = 1024 * 1024;

// Hop-by-hop / body-framing headers neither direction may copy verbatim —
// same set and reasoning as git-broker.ts.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "upgrade",
]);

// Request headers the broker OWNS — everything else is forwarded VERBATIM
// (denylist model, symmetric with git-broker.ts's REQUEST_OWNED: a denylist
// forwards future gh headers by default).
const REQUEST_OWNED = new Set([...HOP_BY_HOP, "authorization", "host"]);

export type GhBroker = {
  /** The unix socket gh dials (the run's `http_unix_socket` config value). */
  socketPath: string;
  /** Stop listening; resolves when the socket is closed (Node unlinks it). */
  close: () => Promise<void>;
};

export type StartGhBrokerOptions = {
  /** The GitHub installation token — held in heap only, injected per request. */
  installationToken: string;
  /** Per-run bearer the agent's gh presents (its GH_TOKEN); timing-safe checked. */
  runBearer: string;
  /** Where to bind; must be short (sun_path) — see MAX_SOCKET_PATH_BYTES. */
  socketPath: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

function timingSafeEqualStr(a: string, bBuf: Buffer): boolean {
  const ab = Buffer.from(a);
  return ab.length === bBuf.length && timingSafeEqual(ab, bBuf);
}

/**
 * True iff the GraphQL document contains a `mutation` operation. Strings
 * (block + regular, with escapes) and `#` comments are stripped first so a
 * query mentioning "mutation" in a literal still passes; after stripping, ANY
 * bare `mutation` keyword rejects. That is a superset of "operation position"
 * — deliberately fail-closed (GitHub's Query type has no field spelled
 * `mutation`, so real reads never trip it).
 */
export function graphqlHasMutation(query: string): boolean {
  const stripped = query
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/#[^\n\r]*/g, " ");
  return /\bmutation\b/.test(stripped);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("graphql body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startGhBroker(
  opts: StartGhBrokerOptions,
): Promise<GhBroker> {
  const { installationToken, runBearer, socketPath } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Fail-loud construction, mirroring git-broker.ts: an empty bearer collapses
  // the fence to a secret-less literal; an empty token injects useless auth.
  if (runBearer.length === 0) {
    throw new Error("gh-broker: runBearer must be a non-empty per-run secret");
  }
  if (installationToken.length === 0) {
    throw new Error("gh-broker: installationToken must be non-empty");
  }
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    // See MAX_SOCKET_PATH_BYTES: bind would silently truncate, never error.
    throw new Error(
      `gh-broker: socket path exceeds ${MAX_SOCKET_PATH_BYTES} bytes (sun_path limit; ` +
        `macOS bind silently truncates): ${socketPath}`,
    );
  }
  // The socket dir normally exists (worker boot writes the lock file under it),
  // but this broker starts BEFORE DaemonProcess.start()'s own mkdir — create it
  // defensively rather than depend on boot ordering.
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  // A prior crashed run of the same threadId can leave the socket file behind;
  // bind would EADDRINUSE on a file no server owns.
  fs.rmSync(socketPath, { force: true });

  const injectedAuth = `token ${installationToken}`;
  // gh sends `authorization: token <GH_TOKEN>`; accept `Bearer` too so a
  // hand-rolled curl inside the run can use the same per-run secret.
  const expectedTokenBuf = Buffer.from(`token ${runBearer}`);
  const expectedBearerBuf = Buffer.from(`Bearer ${runBearer}`);

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // 1. Per-run bearer.
    const auth = req.headers["authorization"] ?? "";
    if (
      !timingSafeEqualStr(auth, expectedTokenBuf) &&
      !timingSafeEqualStr(auth, expectedBearerBuf)
    ) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    // 2. Host fence — gh preserves the original Host through the socket.
    if (req.headers.host !== "api.github.com") {
      console.error(`gh-broker: denied host ${req.headers.host ?? "<none>"}`);
      res.writeHead(403).end("forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", "http://api.github.com");
    // 3. Method/path allowlist (read-only v1).
    const isRead = req.method === "GET" || req.method === "HEAD";
    const isGraphql = req.method === "POST" && url.pathname === "/graphql";
    if (!isRead && !isGraphql) {
      // Deny record: method + path only — never the body, never any token.
      console.error(`gh-broker: denied ${req.method} ${url.pathname}`);
      res.writeHead(403).end("forbidden");
      return;
    }
    let body: Buffer | undefined;
    if (isGraphql) {
      // Buffer the (small) GraphQL body to inspect the query for mutations.
      let parsed: unknown;
      try {
        body = await readBody(req, MAX_GRAPHQL_BODY_BYTES);
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        res.writeHead(403).end("forbidden");
        return;
      }
      const query = (parsed as { query?: unknown } | null)?.query;
      if (typeof query !== "string" || graphqlHasMutation(query)) {
        console.error("gh-broker: denied POST /graphql (mutation or no query)");
        res.writeHead(403).end("forbidden");
        return;
      }
    }

    // 4. Proxy to api.github.com with the token injected server-side, last, so
    //    it always wins over any client-supplied authorization.
    const target = `https://api.github.com${url.pathname}${url.search}`;
    const fwd: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (REQUEST_OWNED.has(k)) continue;
      if (typeof v === "string") fwd[k] = v;
      else if (Array.isArray(v)) fwd[k] = v.join(", ");
    }
    fwd.authorization = injectedAuth;
    const upstream = await fetchImpl(target, {
      method: req.method,
      headers: fwd,
      body,
    });

    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body as never), res);
    } else {
      res.end();
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Never leak the token; report a bare 502 to the agent's gh.
      console.error("gh-broker: proxy error", (err as Error).message);
      if (!res.headersSent) res.writeHead(502);
      res.end("bad gateway");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve, reject) =>
        // Node unlinks the socket file on close (verified) — no stale socket.
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
