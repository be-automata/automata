import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";

/**
 * Worker-box-LOCAL git credential broker (#65, be-automata/automata).
 *
 * The problem: today the agent child gets the GitHub installation token in its
 * own env (`GH_TOKEN`/`GITHUB_TOKEN`) and git `extraheader` config
 * (`daemon-env.ts`), so a prompt-injected agent can read a reusable credential
 * (`echo $GH_TOKEN`, `ps eww`). Any credential the agent's OWN git can present,
 * the agent can also read — so the real token must live in a SEPARATE trust
 * context the agent authenticates to with a non-reusable, per-run, on-box-only
 * bearer.
 *
 * This broker is a byte-transparent git-smart-HTTP reverse proxy on
 * `127.0.0.1`. The real token stays in the WORKER PROCESS HEAP (never in any
 * child env, argv, `ps`, or on disk). The agent's git is pointed at
 * `http://127.0.0.1:<port>/<owner>/<repo>.git` with a per-run `Bearer` (useless
 * off-box); the broker verifies the bearer, injects `Authorization: Basic
 * x-access-token:<token>`, and streams to `https://github.com/<owner>/<repo>.git`.
 *
 * Fencing (identical to the control-plane design the ticket first sketched):
 *   - per-run bearer, timing-safe compared;
 *   - repo path fence — only `/<owner>/<repo>.git/…` for THIS run;
 *   - method + endpoint allowlist — GET info/refs (upload|receive), POST
 *     git-upload-pack, POST git-receive-pack. Nothing else.
 * The token is NEVER logged.
 */

const UPLOAD_PACK = "git-upload-pack";
const RECEIVE_PACK = "git-receive-pack";

// Hop-by-hop / body-framing headers neither direction may copy verbatim — Node
// (response) and fetch (request) re-frame the body, so a stale
// length/encoding/connection header corrupts it.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "upgrade",
]);

// Request headers the broker OWNS — everything else is forwarded VERBATIM
// (a denylist, symmetric with HOP_BY_HOP on the response side). `authorization`
// is replaced with the injected Basic auth (never the client's bearer); `host`
// is set by fetch to the upstream. A denylist forwards future git headers by
// default — the allowlist trap already bit us once: `git-protocol` was
// load-bearing and its omission silently downgraded protocol v2→v0.
const REQUEST_OWNED = new Set([...HOP_BY_HOP, "authorization", "host"]);

export type GitBroker = {
  /** `http://127.0.0.1:<port>` — the base the agent's git remote points at. */
  url: string;
  port: number;
  /** Stop listening; resolves when the socket is closed. */
  close: () => Promise<void>;
};

export type StartGitBrokerOptions = {
  /** The GitHub installation token — held in heap only, injected per request. */
  installationToken: string;
  /** `owner/repo` this run may reach (case-insensitive, GitHub-slug rules). */
  repoFullName: string;
  /** Per-run bearer the agent's git presents; verified timing-safe. */
  runBearer: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

function timingSafeEqualStr(a: string, bBuf: Buffer): boolean {
  const ab = Buffer.from(a);
  // Length check first is safe: bearer length is not secret, and timingSafeEqual
  // throws on length mismatch. `bBuf` is precomputed once in the closure.
  return ab.length === bBuf.length && timingSafeEqual(ab, bBuf);
}

export async function startGitBroker(
  opts: StartGitBrokerOptions,
): Promise<GitBroker> {
  const { installationToken, repoFullName, runBearer } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Trim + lowercase mirrors @terragon/shared's normalizeRepo (the platform's
  // single repo-slug normalization) WITHOUT importing it — the worker is a lean
  // plane and does not depend on @terragon/shared. GitHub slugs are
  // case-insensitive; matching that normalization keeps a padded slug fencing
  // identically here.
  const [owner, repo, ...rest] = repoFullName.trim().toLowerCase().split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(
      `git-broker: repoFullName must be 'owner/repo', got: ${repoFullName}`,
    );
  }
  const pathPrefix = `/${owner}/${repo}.git/`;
  const injectedAuth =
    "Basic " +
    Buffer.from(`x-access-token:${installationToken}`).toString("base64");
  const expectedBearerBuf = Buffer.from(`Bearer ${runBearer}`);

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
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
    const fwd: Record<string, string> = {};
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
      body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
      // Node requires duplex for a streaming request body.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);

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
      // Never leak the token; report a bare 502 to the agent's git.
      console.error("git-broker: proxy error", (err as Error).message);
      if (!res.headersSent) res.writeHead(502);
      res.end("bad gateway");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
