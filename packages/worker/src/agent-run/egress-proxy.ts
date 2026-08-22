import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/**
 * Per-run egress FILTERING FORWARD PROXY for the worker (macOS) plane
 * (#66 slice 2, spec §3.4).
 *
 * The problem: the agent child can open a socket to any host — a prompt-injected
 * agent can exfiltrate repo contents or tokens to an attacker's server. The
 * control plane resolves a per-repo egress policy SHAPE (level + FINAL
 * allowlist, system hosts already merged in control-plane-side) and ships it on
 * the run input; this proxy is the worker-plane enforcer. daemon-env points the
 * child at it via HTTPS_PROXY/HTTP_PROXY, so every proxy-honouring HTTP(S)
 * client in the run is fenced to the allowlist — and EVERY decision (allow AND
 * deny) is surfaced through `onEvent` for the audit sink (AC3).
 *
 * Lifecycle mirrors git-broker.ts (the house loopback-proxy pattern):
 * `http.createServer` + `listen(0, "127.0.0.1")`, returned `{url, port, close}`,
 * fail-closed constructor. Unlike git-broker this proxy carries NO credential —
 * it injects nothing and holds nothing worth stealing — so it needs no per-run
 * bearer: loopback-only binding on a per-run ephemeral port is the same trust
 * story as git-broker's binding, minus the secret.
 *
 * HONESTY NOTE (spec §3.4 backstop): env-var proxying is cooperative. A child
 * that unsets HTTPS_PROXY bypasses this proxy entirely; the host-level PF
 * anchor (deploy/egress-pf.conf, manual config) is the backstop, not this code.
 *
 * Matching (pure, exported as `matchEgress` for table tests):
 *   - level "domain": exact host match, or `*.wildcard` suffix match; a plain
 *     domain entry allows ports 443 and 80 only; a `host:port` entry pins that
 *     port.
 *   - level "ip_port": exact IPv4 entry (any port) or IPv4:port entry (pinned).
 *   - level "none": allowlist entries only — the shape's allowlist already
 *     carries the system hosts, resolved control-plane-side; matched with the
 *     domain rules. The proxy adds NOTHING itself except the implicit loopback
 *     allow (the broker + this proxy live there).
 *   - Fail closed: an unparseable target is a deny, audited with host
 *     "unparseable" so onEvent always gets a string.
 */

/** Structural mirror of the run-input `egressPolicy` shape (types.ts). */
export type EgressPolicyShape = {
  level: "none" | "ip_port" | "domain";
  allowlist: string[];
};

/** One proxy decision, for the audit sink. `destinationPort` is 0 when unknown. */
export type EgressDecisionEvent = {
  destinationHost: string;
  destinationPort: number;
  action: "allow" | "deny";
  policyLevel: "none" | "ip_port" | "domain";
};

export type EgressProxy = {
  /** `http://127.0.0.1:<port>` — what daemon-env sets HTTP(S)_PROXY to. */
  url: string;
  port: number;
  /** Stop listening and sever live tunnels; resolves when closed. */
  close: () => Promise<void>;
};

export type StartEgressProxyOptions = {
  policy: EgressPolicyShape;
  /**
   * Sync callback fired for EVERY decision — allow and deny both (AC3). The
   * caller owns batching/posting; a throwing callback is swallowed so audit
   * plumbing can never break enforcement.
   */
  onEvent: (event: EgressDecisionEvent) => void;
};

const LEVELS = new Set(["none", "ip_port", "domain"]);

/** Sentinel host for fail-closed denies where no host string could be parsed. */
const UNPARSEABLE = "unparseable";

/** `host:port` splitter — the port suffix is digits-only, so domains and IPv4 are safe. */
const HOST_PORT_RE = /^(.+):(\d{1,5})$/;

/**
 * Pure allow/deny decision for one destination. See the module doc for the
 * per-level rules. Loopback (`127.0.0.1`, `localhost`, `::1`) is implicitly
 * allowed at every level — the git broker and this proxy itself live there.
 */
export function matchEgress(
  policy: EgressPolicyShape,
  host: string,
  port: number,
): boolean {
  // Trailing-dot FQDNs normalize to the plain name (curl `example.com.` must
  // not slip past a deny of `example.com`).
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h.length === 0) {
    return false;
  }
  if (h === "127.0.0.1" || h === "localhost" || h === "::1") {
    return true; // implicit loopback allow — never part of the shape
  }
  for (const raw of policy.allowlist) {
    const entry = raw.trim().toLowerCase();
    if (entry.length === 0) {
      continue;
    }
    const m = HOST_PORT_RE.exec(entry);
    const entryHost = m ? m[1]! : entry;
    const entryPort = m ? Number(m[2]) : null;

    if (policy.level === "ip_port") {
      // Exact IPv4 match; a bare IP entry matches any port, IP:port pins it.
      if (entryHost === h && (entryPort === null || entryPort === port)) {
        return true;
      }
      continue;
    }

    // "domain" and "none" share the domain rules ("none"'s allowlist is the
    // control-plane-resolved system hosts).
    const hostMatches = entryHost.startsWith("*.")
      ? h.endsWith(entryHost.slice(1)) // "*.example.com" → ".example.com" suffix
      : entryHost === h;
    if (!hostMatches) {
      continue;
    }
    if (entryPort !== null) {
      if (entryPort === port) {
        return true;
      }
    } else if (port === 443 || port === 80) {
      return true; // plain-domain entries allow the two web ports only
    }
  }
  return false;
}

export async function startEgressProxy(
  opts: StartEgressProxyOptions,
): Promise<EgressProxy> {
  const { policy, onEvent } = opts;
  // Fail loudly at construction rather than serve a collapsed fence (the
  // git-broker rule): a run dispatched WITH a policy must never proceed with a
  // proxy that cannot decide.
  if (
    !policy ||
    !LEVELS.has(policy.level) ||
    !Array.isArray(policy.allowlist)
  ) {
    throw new Error(
      "egress-proxy: policy must be {level: none|ip_port|domain, allowlist: string[]}",
    );
  }
  if (typeof onEvent !== "function") {
    throw new Error(
      "egress-proxy: onEvent callback is required (audit is AC3)",
    );
  }

  function decide(host: string, port: number): boolean {
    const allowed = matchEgress(policy, host, port);
    try {
      onEvent({
        destinationHost: host,
        destinationPort: port,
        action: allowed ? "allow" : "deny",
        policyLevel: policy.level,
      });
    } catch {
      // Audit plumbing must never break (or leak into) enforcement.
    }
    return allowed;
  }

  /** Absolute-form plain-HTTP proxying (`GET http://host/...`). */
  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    let target: URL;
    try {
      if (!req.url || !/^http:\/\//i.test(req.url)) {
        // Non-absolute-form (or https:// which never arrives in plaintext) —
        // not a forward-proxy request we can safely interpret. Fail closed.
        throw new Error("not absolute-form http");
      }
      target = new URL(req.url);
    } catch {
      decide(UNPARSEABLE, 0);
      res.writeHead(403).end();
      return;
    }
    const host = target.hostname;
    const port = target.port ? Number(target.port) : 80;
    if (!decide(host, port)) {
      res.writeHead(403).end();
      return;
    }
    // Stream-proxy to the origin. Hop-by-hop proxy headers are dropped; the
    // rest (incl. Host) ride through verbatim.
    const fwdHeaders = { ...req.headers };
    delete fwdHeaders["proxy-connection"];
    delete fwdHeaders["connection"];
    const upstream = httpRequest(
      {
        host,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: fwdHeaders,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502);
      }
      res.end();
    });
    req.pipe(upstream);
  }

  /** `CONNECT host:port` tunneling (TLS and any raw TCP the client tunnels). */
  function handleConnect(
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): void {
    const m = HOST_PORT_RE.exec(req.url ?? "");
    if (!m) {
      decide(UNPARSEABLE, 0);
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }
    // Strip IPv6 brackets ("[::1]:443") so the matcher sees the bare host.
    const host = m[1]!.replace(/^\[/, "").replace(/\]$/, "");
    const port = Number(m[2]);
    if (!decide(host, port)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }
    const upstream = netConnect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    // Track the OUTBOUND half of the tunnel too: close() destroys every socket
    // in this set, and destroying only the client half would leak the live
    // upstream TCP connection past the run's teardown.
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    // On error on either side, destroy BOTH — a half-open tunnel leaks sockets.
    const destroyBoth = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", destroyBoth);
    clientSocket.on("error", destroyBoth);
  }

  // Track live sockets — client connections AND the upstream halves of CONNECT
  // tunnels — so close() can sever in-flight tunnels at both ends.
  // server.close() alone waits forever on an open tunnel.
  const sockets = new Set<Socket>();

  const server = createServer(handleRequest);
  server.on("connect", handleConnect);

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
