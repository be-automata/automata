import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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
 * DEFAULT-OFF CONTRACT: with no proxy env set, `postJson` calls global `fetch`
 * with exactly the arguments `runtime.ts` used before — byte-for-byte today's
 * behaviour.
 */

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
    const req = httpsRequest({
      method: "POST",
      host: target.hostname,
      port: Number(target.port || 443),
      path: `${target.pathname}${target.search}`,
      headers: { ...headers, host: target.host },
      // TLS over the already-established CONNECT tunnel. `createConnection` is
      // the typed way to hand node an existing socket (`socket` is not on
      // https.RequestOptions); `agent:false` keeps it out of any pool.
      createConnection: ((_opts: unknown, cb: (err: Error | null, s: Socket) => void) =>
        connectTls(socket, target.hostname, cb)) as never,
      agent: false,
      servername: target.hostname,
      timeout: timeoutMs,
    });
    wireResponse(req, resolve, reject, timeoutMs, socket);
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

/** Wrap an established tunnel socket in TLS for `https.request`. */
function connectTls(
  socket: Socket,
  servername: string,
  cb: (err: Error | null, s: Socket) => void,
): Socket {
  const tlsSocket = tlsConnect({ socket, servername });
  tlsSocket.once("secureConnect", () => cb(null, tlsSocket));
  return tlsSocket as unknown as Socket;
}
