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

// Response headers we must NOT copy verbatim from GitHub — Node re-frames the
// body (chunked), so a stale length/encoding/connection header corrupts it.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "upgrade",
]);

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

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Length check first is safe: bearer length is not secret, and timingSafeEqual
  // throws on length mismatch.
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function startGitBroker(
  opts: StartGitBrokerOptions,
): Promise<GitBroker> {
  const { installationToken, repoFullName, runBearer } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const slash = repoFullName.indexOf("/");
  if (slash <= 0 || slash !== repoFullName.lastIndexOf("/")) {
    throw new Error(
      `git-broker: repoFullName must be 'owner/repo', got: ${repoFullName}`,
    );
  }
  const owner = repoFullName.slice(0, slash).toLowerCase();
  const repo = repoFullName.slice(slash + 1).toLowerCase();
  const pathPrefix = `/${owner}/${repo}.git/`;
  const injectedAuth =
    "Basic " +
    Buffer.from(`x-access-token:${installationToken}`).toString("base64");
  const expectedBearer = `Bearer ${runBearer}`;

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // 1. Per-run bearer — the agent's git presents it via http.extraHeader.
    if (
      !timingSafeEqualStr(req.headers["authorization"] ?? "", expectedBearer)
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
    const fwd: Record<string, string> = { Authorization: injectedAuth };
    // Forward the git-relevant request headers. `Git-Protocol` is load-bearing:
    // git requests protocol v2 with it, and GitHub answers v0 if it is missing,
    // so the client and server disagree and the clone fails. Content-Type/Accept
    // carry the pack negotiation media types.
    for (const h of ["content-type", "accept", "git-protocol"] as const) {
      const v = req.headers[h];
      if (typeof v === "string") fwd[h] = v;
    }
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
