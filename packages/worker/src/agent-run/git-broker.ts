import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";
import { HOP_BY_HOP, REQUEST_OWNED, timingSafeEqualStr } from "./broker-common";
import {
  checkRefFence,
  parseReceivePackCommands,
  type RefFenceResult,
} from "./receive-pack-refs";

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
 *   - ref fence (FENCE-01, phase 9; only when `refFence` is set — the self-heal
 *     fix lane): a receive-pack POST is buffered until its pkt-line command
 *     section ends (flush-pkt, capped at 64 KiB → 413), and EVERY ref update
 *     must target exactly `refFence.exactRef` with a non-zero new sha. Any
 *     other ref, a tag, a delete, a malformed/truncated list or a compressed
 *     body is refused (403/415) before a byte is sent to GitHub; an accepted
 *     push forwards the buffered prefix plus the rest of the stream unchanged.
 *     Runs without `refFence` keep the plain streaming proxy, byte for byte.
 *     The broker does NOT inspect pack objects, so the fix lane's path
 *     deny-list cannot be enforced here: it is enforced on the pushed diff by
 *     the worker's post-agent check (09-10) and on the compare diff by the www
 *     guard (09-11).
 * The token is NEVER logged.
 */

const UPLOAD_PACK = "git-upload-pack";
const RECEIVE_PACK = "git-receive-pack";
/** Cap on the buffered receive-pack command section under a ref fence. */
const MAX_COMMAND_SECTION_BYTES = 64 * 1024;

export type GitBroker = {
  /** `http://127.0.0.1:<port>` — the base the agent's git remote points at. */
  url: string;
  port: number;
  /**
   * The new sha of the last fenced push GitHub accepted (HTTP 2xx), or null.
   * Always null without `refFence`. The post-agent check (09-10) runs on it.
   */
  lastPushedSha: () => string | null;
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
  /**
   * FENCE-01: when set, pushes may update ONLY this fully-qualified ref
   * (`refs/heads/automata/fix-…`). Absent ⇒ no fence and no buffering.
   */
  refFence?: { exactRef: string };
};

export async function startGitBroker(
  opts: StartGitBrokerOptions,
): Promise<GitBroker> {
  const { installationToken, repoFullName, runBearer, refFence } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (refFence && !refFence.exactRef.startsWith("refs/heads/")) {
    throw new Error(
      `git-broker: refFence.exactRef must be a refs/heads/ ref, got: ${refFence.exactRef}`,
    );
  }
  let lastPushedSha: string | null = null;

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
  // The entire fence rests on the bearer compare and the token injection. An
  // empty bearer would make the check pass for the literal, secret-less
  // "Authorization: Bearer "; an empty token would inject useless auth. Fail
  // loudly at construction rather than serve a collapsed fence.
  if (runBearer.length === 0) {
    throw new Error("git-broker: runBearer must be a non-empty per-run secret");
  }
  if (installationToken.length === 0) {
    throw new Error("git-broker: installationToken must be non-empty");
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
    // Every refusal logs one inert line (method + path, never a header), so a
    // refused push is always visible whichever gate stopped it.
    const refuse = (status: 401 | 403 | 404, reason: string, body: string) => {
      console.error(
        `git-broker: refused request (${reason}) ` +
          printable(`${req.method ?? "?"} ${req.url ?? "/"}`),
      );
      res.writeHead(status).end(body);
    };
    if (
      !timingSafeEqualStr(req.headers["authorization"] ?? "", expectedBearerBuf)
    ) {
      refuse(401, "bad_bearer", "unauthorized");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // 2. Repo path fence — case-insensitively, only this run's repo.
    const lowerPath = url.pathname.toLowerCase();
    if (!lowerPath.startsWith(pathPrefix)) {
      refuse(404, "repo_not_allowed", "not found");
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
      refuse(403, "endpoint_not_allowed", "forbidden");
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
    let body: ReadableStream | undefined;
    // 5. FENCE-01: a fenced push is checked before GitHub is dialled.
    let fencedPushSha: string | null = null;
    if (refFence && hasBody && endpoint === RECEIVE_PACK) {
      const gate = await gateReceivePack(req, refFence.exactRef);
      if (!gate.ok) {
        console.error(
          `git-broker: ref fence refused push (${gate.reason})` +
            (gate.ref ? ` ref=${printable(gate.ref)}` : ""),
        );
        // The rest of the body is never read: close the connection.
        res
          .writeHead(gate.status, { connection: "close" })
          .end("push refused by the self-heal ref fence");
        return;
      }
      fencedPushSha = gate.pushedSha;
      body = gate.body;
    } else if (hasBody) {
      // Only wrap `req` when nothing else reads it: toWeb's 'data' listener
      // would otherwise mirror every chunk the fence reads into a stream
      // nobody drains.
      body = Readable.toWeb(req) as ReadableStream;
    }
    const upstream = await fetchImpl(target, {
      method: req.method,
      headers: fwd,
      body,
      // Node requires duplex for a streaming request body.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
    if (fencedPushSha && upstream.ok) lastPushedSha = fencedPushSha;

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
    lastPushedSha: () => lastPushedSha,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

type ReceivePackGate =
  | { ok: true; pushedSha: string; body: ReadableStream }
  | {
      ok: false;
      status: 403 | 413 | 415;
      reason:
        | Extract<RefFenceResult, { ok: false }>["reason"]
        | "malformed"
        | "command_section_too_large"
        | "encoded_body";
      ref?: string;
    };

/**
 * Buffer a receive-pack body until its command section is complete, check it
 * against the exact ref, and hand back a stream that replays the buffered
 * prefix followed by the rest of the request, unchanged.
 */
async function gateReceivePack(
  req: IncomingMessage,
  exactRef: string,
): Promise<ReceivePackGate> {
  // git never compresses a receive-pack request; an encoded body could hide
  // its command list from the parser, so it is refused rather than guessed at.
  const encoding = req.headers["content-encoding"];
  if (encoding !== undefined && encoding.toLowerCase() !== "identity") {
    return { ok: false, status: 415, reason: "encoded_body" };
  }
  const chunks = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let buffered = Buffer.alloc(0);
  for (;;) {
    const parsed = parseReceivePackCommands(buffered);
    if (parsed.ok) {
      if (parsed.consumed > MAX_COMMAND_SECTION_BYTES) {
        return { ok: false, status: 413, reason: "command_section_too_large" };
      }
      const fence = checkRefFence(parsed.commands, { exactRef });
      if (!fence.ok) {
        return { ok: false, status: 403, reason: fence.reason, ref: fence.ref };
      }
      return {
        ok: true,
        pushedSha: fence.pushedSha,
        body: replayThenStream(buffered, chunks),
      };
    }
    if (parsed.reason === "malformed") {
      return { ok: false, status: 403, reason: "malformed" };
    }
    if (buffered.length > MAX_COMMAND_SECTION_BYTES) {
      return { ok: false, status: 413, reason: "command_section_too_large" };
    }
    const next = await chunks.next();
    // The body ended before the flush-pkt: a truncated command list.
    if (next.done) return { ok: false, status: 403, reason: "malformed" };
    buffered = Buffer.concat([buffered, next.value]);
  }
}

function replayThenStream(
  prefix: Buffer,
  rest: AsyncIterator<Buffer>,
): ReadableStream {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(prefix));
    },
    async pull(controller) {
      const next = await rest.next();
      if (next.done) controller.close();
      else controller.enqueue(new Uint8Array(next.value));
    },
    async cancel() {
      await rest.return?.();
    },
  });
}

/** Ref names and paths are agent-controlled: print them inert and bounded. */
function printable(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
}
