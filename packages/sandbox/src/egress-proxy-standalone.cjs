/**
 * Standalone egress FILTERING FORWARD PROXY for the Docker sandbox plane
 * (#66 slice 3, spec §3.5). Runs inside the egress sidecar container.
 *
 * Self-contained on purpose: plain CommonJS, node stdlib only, no imports —
 * it is copied/bind-mounted into the sidecar and executed with a bare `node`.
 * The build step (scripts/build-egress-proxy.mjs) copies it to
 * dist/egress-proxy-standalone.cjs and embeds it into
 * src/egress-proxy-standalone.generated.ts for webpack-safe consumption by
 * docker-provider.ts.
 *
 * MIRROR NOTE: `matchEgress` deliberately mirrors
 * packages/worker/src/agent-run/egress-proxy.ts — packages/worker cannot be
 * imported from packages/sandbox (plane boundary), so per the repo's mirror
 * convention the pure matcher is copied, one matcher source per package.
 * Behavioral changes must land in BOTH files.
 *
 * Differences from the worker proxy (loopback, per-run):
 * - binds 0.0.0.0 — the sandbox container reaches it over the internal
 *   docker network, not loopback.
 * - audit v1: every decision is logged as a JSON line on stdout
 *   (`docker logs <sidecar>`); no control-plane POSTs from this plane yet
 *   (documented limitation, docs/egress-enforcement.md).
 *
 * Config via env:
 * - EGRESS_POLICY_JSON: {"level":"none"|"ip_port"|"domain","allowlist":[...]}
 * - EGRESS_PROXY_PORT: listen port (default 3128)
 */
"use strict";

const http = require("node:http");
const net = require("node:net");

const LEVELS = new Set(["none", "ip_port", "domain"]);
const UNPARSEABLE = "unparseable";
/** `host:port` splitter — digits-only port suffix, so domains and IPv4 are safe. */
const HOST_PORT_RE = /^(.+):(\d{1,5})$/;

/**
 * Compile the immutable allowlist ONCE at startup so per-connection matching
 * is a Map/Set lookup plus a wildcard-suffix scan — never a re-parse of every
 * entry per connection. MIRRORS `compileEgressPolicy` in
 * packages/worker/src/agent-run/egress-proxy.ts — keep in sync.
 *
 * Shape: { level, exactHosts: Map<host, Set<port>|null>, wildcardSuffixes:
 * [{suffix, port|null}] }. exactHosts value null = any port (a bare ip_port
 * entry); for "domain"/"none" a bare entry compiles to {443, 80} and a
 * `host:port` pin adds its port. Wildcard pin null = the two web ports.
 */
function compileEgressPolicy(policy) {
  const exactHosts = new Map();
  const wildcardSuffixes = [];
  const addExact = (host, ports) => {
    const existing = exactHosts.get(host);
    if (existing === null) {
      return; // already any-port — nothing can widen it further
    }
    if (ports === null) {
      exactHosts.set(host, null);
      return;
    }
    const set = existing ?? new Set();
    for (const p of ports) {
      set.add(p);
    }
    exactHosts.set(host, set);
  };
  for (const raw of policy.allowlist) {
    const entry = String(raw).trim().toLowerCase();
    if (entry.length === 0) {
      continue;
    }
    const m = HOST_PORT_RE.exec(entry);
    const entryHost = m ? m[1] : entry;
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
 * Pure allow/deny decision for one destination. MIRRORS `matchEgress` in
 * packages/worker/src/agent-run/egress-proxy.ts — keep in sync. Accepts the
 * raw shape (compiled on the fly — table tests) or the startup-compiled form
 * (the proxy's per-connection hot path).
 *
 * - level "domain": exact host match, or `*.wildcard` suffix match; a plain
 *   domain entry allows ports 443 and 80 only; a `host:port` entry pins it.
 * - level "ip_port": exact IPv4 entry (any port) or IPv4:port (pinned).
 * - level "none": allowlist entries only (the shape already carries the
 *   control-plane-resolved system hosts), matched with the domain rules.
 * - loopback (127.0.0.1 / localhost / ::1) is implicitly allowed.
 * - fail closed: empty/garbage host is a deny.
 */
function matchEgress(policy, host, port) {
  const compiled = policy.exactHosts ? policy : compileEgressPolicy(policy);
  const h = String(host).trim().toLowerCase().replace(/\.$/, "");
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

/** Parse + validate the policy shape; throws (fail-closed) on garbage. */
function parsePolicy(json) {
  let policy;
  try {
    policy = JSON.parse(json);
  } catch (error) {
    throw new Error("egress-proxy-standalone: EGRESS_POLICY_JSON is not JSON");
  }
  if (
    !policy ||
    !LEVELS.has(policy.level) ||
    !Array.isArray(policy.allowlist) ||
    !policy.allowlist.every((entry) => typeof entry === "string")
  ) {
    throw new Error(
      "egress-proxy-standalone: policy must be {level: none|ip_port|domain, allowlist: string[]}",
    );
  }
  return { level: policy.level, allowlist: policy.allowlist };
}

/**
 * Start the proxy. Mirrors the worker proxy's request handling; every
 * decision (allow AND deny) goes through `onEvent`.
 */
function startProxy(policy, listenPort, onEvent) {
  // Compile the immutable allowlist ONCE at startup; every connection then
  // matches against the compiled form.
  const compiled = compileEgressPolicy(policy);

  function decide(host, port) {
    const allowed = matchEgress(compiled, host, port);
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
  function handleRequest(req, res) {
    let target;
    try {
      if (!req.url || !/^http:\/\//i.test(req.url)) {
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
    const fwdHeaders = { ...req.headers };
    delete fwdHeaders["proxy-connection"];
    delete fwdHeaders["connection"];
    const upstream = http.request(
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
  function handleConnect(req, clientSocket, head) {
    const m = HOST_PORT_RE.exec(req.url ?? "");
    if (!m) {
      decide(UNPARSEABLE, null);
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }
    // Strip IPv6 brackets ("[::1]:443") so the matcher sees the bare host.
    const host = m[1].replace(/^\[/, "").replace(/\]$/, "");
    const port = Number(m[2]);
    if (!decide(host, port)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    // On error on either side, destroy BOTH — a half-open tunnel leaks sockets.
    // Unlike the worker proxy (which tracks upstreams for a graceful close()),
    // this process has no shutdown path: it dies with its container (SIGKILL
    // on `docker rm -f`), and the OS reclaims every socket then.
    const destroyBoth = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", destroyBoth);
    clientSocket.on("error", destroyBoth);
  }

  const server = http.createServer(handleRequest);
  server.on("connect", handleConnect);
  // 0.0.0.0: the sandbox container connects over the internal docker network.
  server.listen(listenPort, "0.0.0.0");
  return server;
}

function main() {
  const policy = parsePolicy(process.env.EGRESS_POLICY_JSON ?? "");
  const port = Number(process.env.EGRESS_PROXY_PORT || 3128);
  const server = startProxy(policy, port, (event) => {
    // v1 audit: one JSON line per decision on stdout (`docker logs`).
    console.log(JSON.stringify({ ...event, ts: new Date().toISOString() }));
  });
  server.on("listening", () => {
    console.log(
      JSON.stringify({
        msg: "egress-proxy-standalone listening",
        port,
        policyLevel: policy.level,
        allowlistSize: policy.allowlist.length,
      }),
    );
  });
}

module.exports = { compileEgressPolicy, matchEgress, parsePolicy, startProxy };

if (require.main === module) {
  main();
}
