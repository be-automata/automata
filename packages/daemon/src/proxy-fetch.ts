import { request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/**
 * Proxy-aware JSON POST for the daemon's ONE outbound control-plane call
 * (`runtime.ts` → `POST /api/daemon-event`).
 *
 * WHY THIS EXISTS (#108 D1): on a worker box where the agent uid is fenced by
 * the PF anchor (deploy/egress-pf.conf), a direct 443 connect from the daemon
 * is dropped at the packet level — SILENTLY. undici surfaces it as a connect
 * timeout minutes later, the run emits zero events, and the forensic signature
 * is exactly the #107 "run produced no output" class. The callback therefore
 * has to travel through the per-run loopback egress proxy, which is reachable
 * (the anchor's first rule passes lo0).
 *
 * WHY NOT `NODE_USE_ENV_PROXY=1`: it exists only on node ≥22.21.0 / ≥24.0.0
 * (nodejs CHANGELOG_V22/V24; Stability 1.1). The daemon bundle targets node20
 * and the box's node is an operator variable, so relying on the flag means a
 * SILENT no-op on the wrong runtime — reproducing the very bug being fixed.
 * This module is dependency-free and node20-safe.
 *
 * DEFAULT-OFF CONTRACT: unless the worker EXPLICITLY opts this run in via
 * `AUTOMATA_DAEMON_CALLBACK_VIA_PROXY=1`, `postJson` calls global `fetch` with
 * exactly the arguments `runtime.ts` used before — byte-for-byte today's
 * behaviour.
 *
 * WHY AN EXPLICIT GATE AND NOT JUST "IS HTTP(S)_PROXY SET" (#108 F5). Runs have
 * carried an egress policy — and therefore HTTPS_PROXY — since #66 slice 2,
 * with the daemon callback going DIRECT. Keying off the proxy vars alone would
 * silently move every one of those existing runs onto a new transport with new
 * syscalls, new timeout and error behaviour, and a new dependency on the
 * policy's allowlist containing the callback host. Nobody opted into that. The
 * worker sets this variable ONLY in agent-uid mode, where the PF anchor makes
 * the direct route genuinely unusable.
 */

/**
 * The opt-in. Set by the worker (daemon-env.ts) only when a run is BOTH
 * agent-uid-fenced and proxied. Absent ⇒ plain `fetch`, whatever the proxy
 * variables say.
 */
export const CALLBACK_VIA_PROXY_ENV = "AUTOMATA_DAEMON_CALLBACK_VIA_PROXY";

/** Lowercase env lookup precedence documented by Claude Code's network-config. */
function pick(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * NO_PROXY matching. Pure. Supports:
 *  - `*`            → bypass everything
 *  - `example.com`  → the host itself and any subdomain of it
 *  - `.example.com` → the same (leading-dot form)
 *  - exact IPs / `localhost`
 * Entries are comma (or whitespace) separated; a `host:port` entry matches on
 * the host part only (we never proxy per-port).
 */
export function shouldBypassProxy(
  hostname: string,
  noProxy: string | undefined,
): boolean {
  if (!noProxy) {
    return false;
  }
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host.length === 0) {
    return false;
  }
  for (const rawEntry of noProxy.split(/[,\s]+/)) {
    const entry = rawEntry.trim().toLowerCase();
    if (entry.length === 0) {
      continue;
    }
    if (entry === "*") {
      return true;
    }
    // Drop a port suffix: NO_PROXY is host-scoped here.
    const bare = entry.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
    if (bare.length === 0) {
      continue;
    }
    const suffix = bare.startsWith(".") ? bare : `.${bare}`;
    if (host === bare.replace(/^\./, "") || host.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

/**
 * Which proxy (if any) applies to `target`. Pure. Returns the proxy URL string,
 * or null when the request should go direct.
 */
export function resolveProxyForUrl(
  target: string,
  env: NodeJS.ProcessEnv,
): string | null {
  // #108 F5: fail SHUT unless the worker explicitly opted this run in. A run
  // that merely has an egress policy keeps the direct callback it has always
  // had.
  if (env[CALLBACK_VIA_PROXY_ENV] !== "1") {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return null; // not our problem — let the direct path surface the error
  }
  // `no_proxy` wins when both are set (documented node behaviour).
  const noProxy = pick(env, ["no_proxy", "NO_PROXY"]);
  if (shouldBypassProxy(parsed.hostname, noProxy)) {
    return null;
  }
  const proxy =
    parsed.protocol === "https:"
      ? pick(env, ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"])
      : pick(env, ["http_proxy", "HTTP_PROXY"]);
  if (!proxy) {
    return null;
  }
  try {
    // A scheme-less proxy value ("127.0.0.1:8080") is a configuration error we
    // must not silently "fix" — bail to direct rather than guess a scheme.
    const proxyUrl = new URL(proxy);
    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
      return null;
    }
    return proxy;
  } catch {
    return null;
  }
}

export type PostJsonResult = { status: number };

export type PostJsonOptions = {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

/**
 * POST a JSON body, honouring HTTP(S)_PROXY / NO_PROXY.
 *
 * No applicable proxy → plain `fetch` (identical to the pre-#108 call).
 * `http:` target + proxy → absolute-form request to the proxy.
 * `https:` target + proxy → HTTP CONNECT tunnel, then TLS over the tunnel.
 *
 * Errors never carry request headers: `X-Daemon-Token` must not reach a log or
 * a persisted failure reason.
 */
export async function postJson(
  opts: PostJsonOptions,
): Promise<PostJsonResult> {
  const { url, headers, body } = opts;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const proxy = resolveProxyForUrl(url, env);
  if (!proxy) {
    const response = await fetch(url, { method: "POST", headers, body });
    return { status: response.status };
  }
  const target = new URL(url);
  const proxyUrl = new URL(proxy);
  const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80));
  if (target.protocol === "https:") {
    const socket = await connectTunnel({
      proxyHost: proxyUrl.hostname,
      proxyPort,
      host: target.hostname,
      port: Number(target.port || 443),
      timeoutMs,
    });
    return await sendOverSocket({ target, headers, body, socket, timeoutMs });
  }
  return await sendAbsoluteForm({
    proxyHost: proxyUrl.hostname,
    proxyPort,
    target,
    headers,
    body,
    timeoutMs,
  });
}

/** Open an HTTP CONNECT tunnel through `proxyHost:proxyPort` to `host:port`. */
function connectTunnel(args: {
  proxyHost: string;
  proxyPort: number;
  host: string;
  port: number;
  timeoutMs: number;
}): Promise<Socket> {
  const { proxyHost, proxyPort, host, port, timeoutMs } = args;
  return new Promise<Socket>((resolve, reject) => {
    const authority = `${host}:${port}`;
    const req = httpRequest({
      host: proxyHost,
      port: proxyPort,
      method: "CONNECT",
      path: authority,
      // `setHost:false` + explicit Host keeps the origin authority in the frame
      // the proxy matches on.
      headers: { host: authority },
      timeout: timeoutMs,
    });
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        req.destroy();
        reject(err);
      }
    };
    req.on("connect", (res, socket) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (res.statusCode !== 200) {
        socket.destroy();
        // Names the host so an operator can fix the allowlist. NEVER the headers.
        fail(
          new Error(
            `egress proxy refused CONNECT ${authority} (status ${res.statusCode ?? "unknown"})`,
          ),
        );
        return;
      }
      settled = true;
      resolve(socket);
    });
    req.on("timeout", () => fail(new Error(`egress proxy CONNECT ${authority} timed out after ${timeoutMs}ms`)));
    req.on("error", (err) =>
      fail(new Error(`egress proxy CONNECT ${authority} failed: ${err.message}`)),
    );
    req.end();
  });
}

/** TLS POST over an already-established tunnel socket. */
function sendOverSocket(args: {
  target: URL;
  headers: Record<string, string>;
  body: string;
  socket: Socket;
  timeoutMs: number;
}): Promise<PostJsonResult> {
  const { target, headers, body, socket, timeoutMs } = args;
  return new Promise<PostJsonResult>((resolve, reject) => {
    // Set by connectTls when the handshake itself fails; preferred over the
    // ClientRequest's generic "socket hang up" when both arrive.
    let handshakeError: Error | null = null;

    // TLS over the already-established CONNECT tunnel.
    //
    // THIS MUST BE A ONE-SHOT AGENT, NOT `agent: false`. Node's docs for
    // `agent: false` say it "causes a new Agent with default values to be
    // used" — and a default Agent's createConnection is net.createConnection,
    // so a `createConnection` passed in the REQUEST options is never called.
    // The effect was silent and total: the CONNECT tunnel was opened, then
    // IGNORED, and the request dialled the origin DIRECTLY. Verified against a
    // local fake proxy — it logged the CONNECT and the response still came back
    // from the real origin (405 from www.example.com). On a PF-fenced box that
    // direct connect is exactly what is blocked, so this module would have
    // failed at the one job it exists to do, on every agent-uid run.
    //
    // Overriding createConnection on our OWN Agent instance is what actually
    // binds the request to `socket`.
    const agent = new HttpsAgent({ keepAlive: false, maxSockets: 1 });
    // `createConnection` is a documented Agent hook but is absent from
    // @types/node's Agent surface, hence the cast rather than a subclass.
    (
      agent as unknown as {
        createConnection: (
          opts: unknown,
          cb: (err: Error | null, s: Socket) => void,
        ) => Socket;
      }
    ).createConnection = (
      _opts: unknown,
      cb: (err: Error | null, s: Socket) => void,
    ) =>
      connectTls(socket, target.hostname, timeoutMs, cb, (err) => {
        handshakeError = err;
      });

    const req = httpsRequest({
      method: "POST",
      host: target.hostname,
      port: Number(target.port || 443),
      path: `${target.pathname}${target.search}`,
      headers: { ...headers, host: target.host },
      agent,
      servername: target.hostname,
      timeout: timeoutMs,
    });
    req.once("close", () => agent.destroy());
    wireResponse(
      req,
      resolve,
      (err) => reject(handshakeError ?? err),
      timeoutMs,
      socket,
    );
    req.end(body);
  });
}

/** Absolute-form plain-HTTP POST straight at the proxy. */
function sendAbsoluteForm(args: {
  proxyHost: string;
  proxyPort: number;
  target: URL;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}): Promise<PostJsonResult> {
  const { proxyHost, proxyPort, target, headers, body, timeoutMs } = args;
  return new Promise<PostJsonResult>((resolve, reject) => {
    const req = httpRequest({
      host: proxyHost,
      port: proxyPort,
      method: "POST",
      path: target.toString(),
      headers: { ...headers, host: target.host },
      timeout: timeoutMs,
    });
    wireResponse(req, resolve, reject, timeoutMs, null);
    req.end(body);
  });
}

function wireResponse(
  req: import("node:http").ClientRequest,
  resolve: (r: PostJsonResult) => void,
  reject: (e: Error) => void,
  timeoutMs: number,
  tunnel: Socket | null,
): void {
  let settled = false;
  const fail = (err: Error) => {
    if (!settled) {
      settled = true;
      req.destroy();
      tunnel?.destroy();
      reject(err);
    }
  };
  req.on("response", (res) => {
    const status = res.statusCode ?? 0;
    res.resume(); // drain; the daemon only ever needs the status
    res.on("end", () => {
      if (!settled) {
        settled = true;
        tunnel?.destroy();
        resolve({ status });
      }
    });
  });
  req.on("timeout", () =>
    fail(new Error(`daemon-event POST timed out after ${timeoutMs}ms`)),
  );
  // Message only — an http error object never carries our headers, but we build
  // the message explicitly so nothing else can creep in.
  req.on("error", (err) =>
    fail(new Error(`daemon-event POST failed: ${err.message}`)),
  );
}

/**
 * Wrap an established tunnel socket in TLS for `https.request`.
 *
 * EVERY failure mode here must end in a rejected promise, never an unhandled
 * event and never a hang. This runs on the daemon's ONE control-plane callback,
 * on every agent-uid run: a throw takes down the whole daemon (there is no
 * uncaughtException handler in this package) and a hang produces a run that
 * dies with no explanation — the exact #107 forensic class this module exists
 * to eliminate. Reintroducing it here would be the worst possible place.
 *
 * Three listeners, all required:
 *  - `error` on the TLS socket: a handshake that fails AFTER a successful
 *    CONNECT (cert mismatch, protocol error, proxy closing the tunnel) emits
 *    here. With no listener node throws on an EventEmitter 'error'.
 *  - `error` on the RAW tunnel socket: it can fail independently, and it has no
 *    listener of its own once handed to tls.
 *  - a handshake timeout: `https.request`'s own `timeout` is socket-scoped and
 *    only arms once the socket is assigned, so a handshake that stalls before
 *    that is covered by nothing.
 *
 * NOTE ON THE TOTAL BOUND: the CONNECT (connectTunnel) and the handshake are
 * bounded SEPARATELY, each by `timeoutMs`, so a stall in both phases takes up
 * to 2x. That is deliberate — one budget per network phase — and deterministic;
 * it is not an unbounded wait.
 *
 * Failures are surfaced by `destroy(err)` rather than by calling `cb(err)`:
 * the socket is already returned synchronously to `https.request`, so
 * destroying it with an error makes the ClientRequest emit 'error', which
 * `wireResponse` already turns into a rejection. Calling `cb` a second time
 * would double-assign the socket.
 */
function connectTls(
  socket: Socket,
  servername: string,
  timeoutMs: number,
  cb: (err: Error | null, s: Socket) => void,
  onHandshakeError: (err: Error) => void = () => {},
): Socket {
  const tlsSocket = tlsConnect({ socket, servername });
  let handshakeDone = false;

  const failHandshake = (err: Error) => {
    if (handshakeDone) {
      return; // past the handshake: the request owns the socket and its errors
    }
    handshakeDone = true;
    // Report BEFORE destroying: destroying makes the ClientRequest emit a
    // generic "socket hang up", which would otherwise be the only thing the
    // caller ever sees. The specific cause is the whole point — a run that
    // fails here must say WHY, not just that it failed.
    onHandshakeError(err);
    socket.destroy();
    tlsSocket.destroy(err);
  };

  tlsSocket.once("secureConnect", () => {
    handshakeDone = true;
    // Re-arm at the same value so the REQUEST phase stays bounded: node's
    // ClientRequest listens for the socket's 'timeout' and re-emits it on the
    // request, which wireResponse already handles.
    tlsSocket.setTimeout(timeoutMs);
    cb(null, tlsSocket as unknown as Socket);
  });
  // Stays registered after the handshake purely so a later socket error is
  // never an unhandled 'error' event; failHandshake no-ops by then and the
  // request's own error handling takes it.
  tlsSocket.on("error", (err: Error) =>
    failHandshake(
      new Error(`TLS handshake to ${servername} failed: ${err.message}`),
    ),
  );
  socket.on("error", (err: Error) =>
    failHandshake(
      new Error(`CONNECT tunnel to ${servername} failed: ${err.message}`),
    ),
  );
  tlsSocket.setTimeout(timeoutMs, () =>
    failHandshake(
      new Error(
        `TLS handshake to ${servername} timed out after ${timeoutMs}ms`,
      ),
    ),
  );
  return tlsSocket as unknown as Socket;
}
