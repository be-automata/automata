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

import type { EgressPolicyShape } from "./types";

export type { EgressPolicyShape } from "./types";

/** One proxy decision, for the audit sink. `destinationPort` is null when unknown. */
export type EgressDecisionEvent = {
  destinationHost: string;
  destinationPort: number | null;
  action: "allow" | "deny";
  policyLevel: "none" | "ip_port" | "domain";
  /**
   * WHICH POSTURE PRODUCED THIS DECISION (#108). Without it the audit trail
   * would claim "enforced" about traffic that was merely carried: an observe
   * run allows everything, so an `action:"allow"` row from it means only "this
   * happened", never "the policy permitted this". Every consumer that reads
   * egress_events as evidence of enforcement must filter on `mode:"enforce"`.
   */
  mode: EgressProxyMode;
};

/**
 * "enforce" (the default) — today's behaviour: matchEgress decides, denies are
 * denied.
 *
 * "observe" — every destination is ALLOWED, and every decision is still POSTED.
 * This is the agent-uid default for a repo with no policy. Under the PF anchor
 * the agent has NO direct route to 80/443, so a proxy must exist on every run
 * or the agent CLI's own api.anthropic.com call dies; but a box that has no
 * policy must not silently acquire a deny-all fence either.
 *
 * Allow-all WITHOUT audit was rejected outright: this proxy is loopback-only
 * with no client auth, the anchor passes lo0 unconditionally, and the agent is
 * HANDED the proxy URL — that combination is an unaudited open relay egressing
 * as the operator's uid. Auditing it is what makes it defensible, and it is
 * also the only way to earn a tighter default: one trivial `claude -p` run on
 * the pilot box reached api.anthropic.com, mcp-proxy.anthropic.com,
 * docs.mcp.cloudflare.com, stitch.googleapis.com, registry.npmjs.org and two
 * telemetry hosts, so the legitimate set cannot be enumerated from the repo.
 */
export type EgressProxyMode = "enforce" | "observe";

export type EgressProxy = {
  /** `http://127.0.0.1:<port>` — what daemon-env sets HTTP(S)_PROXY to. */
  url: string;
  port: number;
  /** The posture this proxy is running under. */
  mode: EgressProxyMode;
  /** Distinct destination hosts seen, with a decision count each (step logging). */
  observedHosts: () => Map<string, number>;
  /** Stop listening and sever live tunnels; resolves when closed. */
  close: () => Promise<void>;
};

/**
 * Liveness path (#108 A2). A plain, NON-absolute-form GET here answers 200 and
 * is NOT audited — it is the worker probing its own listener, not run traffic.
 * Every other non-absolute-form request still fails closed with 403.
 */
export const EGRESS_HEALTH_PATH = "/__automata/egress-health";

export type StartEgressProxyOptions = {
  policy: EgressPolicyShape;
  /**
   * Sync callback fired for EVERY decision — allow and deny both (AC3). The
   * caller owns batching/posting; a throwing callback is swallowed so audit
   * plumbing can never break enforcement.
   */
  onEvent: (event: EgressDecisionEvent) => void;
  /** See {@link EgressProxyMode}. Defaults to "enforce" — today's behaviour. */
  mode?: EgressProxyMode;
};

const LEVELS = new Set(["none", "ip_port", "domain"]);

/** Sentinel host for fail-closed denies where no host string could be parsed. */
const UNPARSEABLE = "unparseable";

/** `host:port` splitter — the port suffix is digits-only, so domains and IPv4 are safe. */
const HOST_PORT_RE = /^(.+):(\d{1,5})$/;

/**
 * The immutable policy compiled ONCE at proxy startup, so per-connection
 * matching is a Map/Set lookup plus a wildcard-suffix scan — never a re-parse
 * of every allowlist entry per connection.
 */
export type CompiledEgressPolicy = {
  level: "none" | "ip_port" | "domain";
  /**
   * exact host → allowed ports. `null` = any port (a bare `ip_port` entry);
   * for "domain"/"none" a bare entry compiles to {443, 80} (web ports only)
   * and a `host:port` pin adds its port to the set.
   */
  exactHosts: Map<string, Set<number> | null>;
  /** `*.suffix` entries → dot-prefixed suffix + optional port pin (null = 443/80). */
  wildcardSuffixes: Array<{ suffix: string; port: number | null }>;
};

/** Compile the shape's allowlist into {@link CompiledEgressPolicy}. */
export function compileEgressPolicy(
  policy: EgressPolicyShape,
): CompiledEgressPolicy {
  const exactHosts = new Map<string, Set<number> | null>();
  const wildcardSuffixes: Array<{ suffix: string; port: number | null }> = [];
  const addExact = (host: string, ports: number[] | null): void => {
    const existing = exactHosts.get(host);
    if (existing === null) {
      return; // already any-port — nothing can widen it further
    }
    if (ports === null) {
      exactHosts.set(host, null);
      return;
    }
    const set = existing ?? new Set<number>();
    for (const p of ports) {
      set.add(p);
    }
    exactHosts.set(host, set);
  };
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
      addExact(entryHost, entryPort === null ? null : [entryPort]);
    } else if (entryHost.startsWith("*.")) {
      // "*.example.com" → ".example.com" suffix
      wildcardSuffixes.push({ suffix: entryHost.slice(1), port: entryPort });
    } else {
      // Plain-domain entries allow the two web ports only; pins add theirs.
      addExact(entryHost, entryPort === null ? [443, 80] : [entryPort]);
    }
  }
  return { level: policy.level, exactHosts, wildcardSuffixes };
}

/**
 * Pure allow/deny decision for one destination. See the module doc for the
 * per-level rules. Loopback (`127.0.0.1`, `localhost`, `::1`) is implicitly
 * allowed at every level — the git broker and this proxy itself live there.
 * Accepts the raw shape (compiled on the fly — table tests) or the
 * startup-compiled form (the proxy's per-connection hot path).
 */
export function matchEgress(
  policy: EgressPolicyShape | CompiledEgressPolicy,
  host: string,
  port: number | null,
): boolean {
  const compiled =
    "exactHosts" in policy ? policy : compileEgressPolicy(policy);
  // Trailing-dot FQDNs normalize to the plain name (curl `example.com.` must
  // not slip past a deny of `example.com`).
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h.length === 0) {
    return false;
  }
  if (h === "127.0.0.1" || h === "localhost" || h === "::1") {
    return true; // implicit loopback allow — never part of the shape
  }
  const ports = compiled.exactHosts.get(h);
  if (ports !== undefined) {
    if (ports === null || (port !== null && ports.has(port))) {
      return true;
    }
    // Exact host with a non-matching port: a wildcard entry may still allow it.
  }
  for (const { suffix, port: pin } of compiled.wildcardSuffixes) {
    if (!h.endsWith(suffix)) {
      continue;
    }
    if (pin !== null ? port === pin : port === 443 || port === 80) {
      return true;
    }
  }
  return false;
}

export async function startEgressProxy(
  opts: StartEgressProxyOptions,
): Promise<EgressProxy> {
  const { policy, onEvent } = opts;
  const mode: EgressProxyMode = opts.mode ?? "enforce";
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

  // Compile the immutable allowlist ONCE at startup; every connection then
  // matches against the compiled form.
  const compiled = compileEgressPolicy(policy);

  const observed = new Map<string, number>();

  function decide(host: string, port: number | null): boolean {
    // Observe allows everything — but it is still a DECISION, and it is still
    // audited, carrying the mode marker so nothing downstream can mistake it
    // for enforcement.
    // Fail closed on an unparseable target in EVERY mode. Observe must never
    // synthesise a connection to a destination it could not parse, and the
    // audit row must say what actually happened: denied.
    const allowed =
      host === UNPARSEABLE
        ? false
        : mode === "observe"
          ? true
          : matchEgress(compiled, host, port);
    observed.set(host, (observed.get(host) ?? 0) + 1);
    try {
      onEvent({
        destinationHost: host,
        destinationPort: port,
        action: allowed ? "allow" : "deny",
        policyLevel: policy.level,
        mode,
      });
    } catch {
      // Audit plumbing must never break (or leak into) enforcement.
    }
    return allowed;
  }

  /** Absolute-form plain-HTTP proxying (`GET http://host/...`). */
  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // #108 A2: the worker's own liveness probe. Answered before any decision, so
    // it neither reaches an origin nor pollutes the audit trail. A dead proxy is
    // a SILENT 90s hang for the agent CLI (verified on the pilot box: zero
    // output, zero stderr), which the agent physically cannot report — so the
    // worker must confirm the listener itself before spawning the daemon.
    if (req.url === EGRESS_HEALTH_PATH) {
      req.resume();
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    let target: URL;
    try {
      if (!req.url || !/^http:\/\//i.test(req.url)) {
        // Non-absolute-form (or https:// which never arrives in plaintext) —
        // not a forward-proxy request we can safely interpret. Fail closed.
        throw new Error("not absolute-form http");
      }
      target = new URL(req.url);
    } catch {
      decide(UNPARSEABLE, null);
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
      decide(UNPARSEABLE, null);
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
    mode,
    observedHosts: () => new Map(observed),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Confirm the per-run proxy is actually answering on loopback (#108 A2).
 *
 * WHY THIS IS BLOCKING. Verified on the pilot box: pointed at a proxy that does
 * not answer, the agent CLI produced ZERO output and ZERO stderr for 90 seconds
 * before being killed — the #107 "run produced no output" class exactly, and a
 * failure mode the agent cannot report because it never gets that far. The
 * worker owns the listener, so the worker checks it, before daemon.start().
 */
export async function assertEgressProxyReachable(opts: {
  url: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const target = new URL(EGRESS_HEALTH_PATH, opts.url);
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: target.hostname,
        port: Number(target.port),
        method: "GET",
        path: EGRESS_HEALTH_PATH,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`no answer within ${timeoutMs}ms`));
    });
    req.on("error", (err) => reject(err));
    req.end();
  }).catch((err: Error) => {
    throw new Error(
      `egress proxy health check failed at ${opts.url}: ${err.message} — ` +
        `refusing to start the daemon (a proxy the agent cannot reach makes the ` +
        `run hang silently with no output)`,
    );
  });
  if (status !== 200) {
    throw new Error(
      `egress proxy health check failed at ${opts.url}: status ${status} — ` +
        `refusing to start the daemon`,
    );
  }
}
