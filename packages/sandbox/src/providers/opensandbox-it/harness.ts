/**
 * Test-only helpers for the OPENSANDBOX_IT harness (#634 S3). Nothing here is
 * imported by production code. No helper prints a secret: probes return
 * booleans, status codes and env var NAMES only, and the logger drops fields.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { OpenSandboxCellDeps } from "../opensandbox-cell";

const execFileAsync = promisify(execFile);

/** Name of the throwaway docker:dind container `up.sh` creates. */
const DIND_NAME = "osbit-dind";
/** The lifecycle API as published on the host by `up.sh`. */
export const API_BASE_URL = "http://127.0.0.1:18091";
/** Digest-pinned guest image (python:3.12-slim), pulled inside dind by `up.sh`. */
export const GUEST_IMAGE =
  "python@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b";
/** Guest entrypoint for every IT cell. */
export const GUEST_ENTRYPOINT: readonly string[] = ["sleep", "infinity"];

/** Directory `up.sh` writes the API key and config to (mirrors its default). */
export function stateDir(): string {
  return (
    process.env.OPENSANDBOX_IT_STATE ??
    join(process.env.TMPDIR ?? "/tmp", "osbit")
  );
}

/** The per-run API key from the state file; never log or return it to a test body. */
export function readApiKey(): string {
  return readFileSync(join(stateDir(), "api_key"), "utf8").trim();
}

/** A logger that drops every message and field (matches the adapter's logger dep). */
export const SILENT_LOGGER: OpenSandboxCellDeps["logger"] = {
  info() {},
  warn() {},
};

/** `osbit-<scenario>-<random>`: the stepKey every IT cell is tagged with. */
export function newStepKey(scenario: string): string {
  return `osbit-${scenario}-${randomBytes(4).toString("hex")}`;
}

/** Base64 of a secret, the only form it may take in an argv. */
export function encodeSecret(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `docker exec osbit-dind <argv>`: argv only, never a shell string. A non-zero
 * exit is returned, not thrown; a spawn failure or timeout throws.
 */
export async function dind(
  argv: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["exec", DIND_NAME, ...argv],
      { timeout: options.timeoutMs ?? 60_000, maxBuffer: 64 << 20 },
    );
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const e = error as {
      code?: unknown;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    if (typeof e.code === "number" && !e.killed) {
      return {
        exitCode: e.code,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
    throw new Error(
      `dind exec failed (${e.killed ? "timeout" : String(e.code)}): ${argv[0] ?? ""}`,
    );
  }
}

export interface RawApiResponse {
  status: number;
  body: unknown;
}

/**
 * A raw lifecycle API call with the run's key. For the negative control only:
 * the adapter refuses a create without a policy (`policy_required`) by design.
 */
export async function rawApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<RawApiResponse> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      "OPEN-SANDBOX-API-KEY": readApiKey(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  return { status: res.status, body: parsed };
}

export interface DindSnapshot {
  containers: string[];
  volumes: string[];
  networks: string[];
  netns: string[];
  netfilter: string[];
}

/** Non-empty trimmed output lines of a dind command, sorted; throws on a non-zero exit. */
export async function lines(argv: readonly string[]): Promise<string[]> {
  const result = await dind(argv);
  // An empty list on failure would make "before" and "after" match vacuously.
  if (result.exitCode !== 0) {
    throw new Error(`dind listing failed: ${argv[0]} exit ${result.exitCode}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort();
}

/** What the nested daemon holds: containers, volumes, networks, netns files, netfilter rules. */
export async function snapshot(): Promise<DindSnapshot> {
  const [containers, volumes, networks, netns, netfilter] = await Promise.all([
    lines(["docker", "ps", "-a", "--format", "{{.Names}}"]),
    lines(["docker", "volume", "ls", "-q"]),
    lines(["docker", "network", "ls", "--format", "{{.Name}}"]),
    lines(["ls", "-1", "/var/run/docker/netns"]),
    // dind has no nft binary: its iptables ruleset stands in (see below).
    // Per-cell sidecar rules live in the cell's netns, which `netns` covers.
    lines(["iptables-save"]),
  ]);
  return {
    containers,
    volumes,
    networks,
    netns,
    netfilter: normalizeIptablesSave(netfilter),
  };
}

/**
 * Rules (`-A …`) and user chains (`:NAME - …`) only. Table headers and
 * built-in chain policies are left out: a table the kernel loads on first use
 * (an empty `*raw`) is not state a cell left behind. Sorted, deduplicated.
 */
export function normalizeIptablesSave(output: readonly string[]): string[] {
  const kept = output
    .map((line) => line.trim())
    .filter((line) => /^(-A |:[A-Za-z0-9_-]+ - )/.test(line))
    .map((line) => line.replace(/\s*\[\d+:\d+\]$/, ""));
  return [...new Set(kept)].sort();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `snapshot()` every 250 ms until it equals `expected` or `deadlineMs` passes. */
export async function settledSnapshot(
  expected: DindSnapshot,
  deadlineMs: number,
): Promise<{ settled: boolean; snapshot: DindSnapshot }> {
  const want = JSON.stringify(expected);
  const end = Date.now() + deadlineMs;
  let current = await snapshot();
  while (JSON.stringify(current) !== want && Date.now() < end) {
    await sleep(250);
    current = await snapshot();
  }
  return { settled: JSON.stringify(current) === want, snapshot: current };
}

export type ProbeSpec =
  | { kind: "dns"; host: string }
  /**
   * Never :80 or :443 under a policy: the credential proxy answers every TCP
   * handshake there, so use `http`, `https` or `tls_ip`. `unproxied` is for
   * the no-policy negative control only.
   */
  | { kind: "tcp"; host: string; port: number; unproxied?: true }
  | { kind: "tls_ip"; ip: string; sni: string }
  | {
      kind: "https";
      url: string;
      /** Plain marker; encoded into argv, and only `bodyHasMarker` comes back. */
      marker?: string;
    }
  /**
   * POST with the given request headers and an empty body. Only a boolean per
   * marker comes back (computed in the guest), never the body. Markers go into
   * argv base64-encoded (execd logs the command), so a secret may be one; the
   * header values are sent as given, so keep secrets out of them.
   */
  | {
      kind: "https_headers";
      url: string;
      headers: Record<string, string>;
      markers: string[];
    }
  /** Status only, no body. `@gateway` in the host or url is the default gateway. */
  | { kind: "http"; url: string }
  | { kind: "gateway" }
  /** AAAA through getaddrinfo(AF_INET6): the DNS proxy's v6 path. */
  | { kind: "dns6"; host: string }
  /**
   * One raw UDP DNS query to `server:53` (IPv4 or bracket-free IPv6 literal).
   * The query bytes are built here (`buildDnsQuery`) and sent as `query_b64`.
   */
  | {
      kind: "udpdns";
      server: string;
      host: string;
      qtype?: DnsQueryType;
    }
  /** Whether /proc/net/ipv6_route has a default route (else v6 checks are vacuous). */
  | { kind: "ipv6_route" }
  | {
      kind: "canary_scan";
      /** Plain canaries; encoded into argv, never echoed. */
      canaries: string[];
      /** Regex for env var NAMES to report, case-insensitive. */
      namePattern: string;
    };

export interface ProbeResult {
  kind: string;
  ok: boolean;
  /** Exception class (and errno name) of a failure; never a message. */
  err?: string;
  status?: number;
  ms?: number;
  ips?: string[];
  bodyHasMarker?: boolean;
  /** https_headers: per marker, whether the response body held it. */
  markersFound?: boolean[];
  gateway?: string | null;
  /** udpdns: the reply's rcode (header byte 3, low nibble) and ANCOUNT. */
  rcode?: number;
  answers?: number;
  /** ipv6_route: a default route exists. */
  default?: boolean;
  found?: boolean[];
  envNames?: string[];
  /** canary_scan: other processes whose environ was read, and whether pid 1 was. */
  scanned?: number;
  pid1?: boolean;
}

/** Python run inside the guest: reads one JSON arg, prints one JSON line of results. */
const PROBE_PY = String.raw`import base64, concurrent.futures, errno, json, os, random, re, socket, ssl, struct, sys, time, urllib.request, urllib.error

T = 4.0


def kind_of(e):
    name = type(e).__name__
    if isinstance(e, OSError) and e.errno:
        name += ":" + errno.errorcode.get(e.errno, str(e.errno))
    return name


def gateway():
    try:
        with open("/proc/net/route") as fh:
            for line in fh.read().split("\n")[1:]:
                f = line.split()
                if len(f) > 2 and f[1] == "00000000":
                    return socket.inet_ntoa(struct.pack("<L", int(f[2], 16)))
    except Exception:
        pass
    return None


def sub(value):
    return value.replace("@gateway", gateway() or "0.0.0.0")


def dns(host):
    try:
        return {"ok": True, "ips": sorted({a[4][0] for a in socket.getaddrinfo(host, 443, socket.AF_INET)})}
    except Exception as e:
        return {"ok": False, "err": kind_of(e)}


def dns6(host):
    try:
        return {"ok": True, "ips": sorted({a[4][0] for a in socket.getaddrinfo(host, 443, socket.AF_INET6)})}
    except Exception as e:
        return {"ok": False, "err": kind_of(e)}


def udpdns(server, query_b64):
    fam = socket.AF_INET6 if ":" in server else socket.AF_INET
    s = socket.socket(fam, socket.SOCK_DGRAM)
    s.settimeout(T)
    try:
        s.sendto(base64.b64decode(query_b64), (server, 53))
        data = s.recv(4096)
        if len(data) < 12:
            return {"ok": False, "err": "short_reply"}
        return {"ok": True, "rcode": data[3] & 15, "answers": struct.unpack(">H", data[6:8])[0]}
    except Exception as e:
        return {"ok": False, "err": kind_of(e)}
    finally:
        s.close()


def ipv6_route():
    try:
        with open("/proc/net/ipv6_route") as fh:
            for line in fh:
                f = line.split()
                if len(f) < 10 or f[0] != "0" * 32 or f[1] != "00":
                    continue
                if f[9] != "lo" and not (int(f[8], 16) & 0x200):
                    return {"ok": True, "default": True}
    except Exception:
        pass
    return {"ok": True, "default": False}


def tcp(host, port):
    t0 = time.time()
    try:
        s = socket.create_connection((sub(host), port), timeout=T)
        s.close()
        return {"ok": True, "ms": int((time.time() - t0) * 1000)}
    except Exception as e:
        return {"ok": False, "err": kind_of(e), "ms": int((time.time() - t0) * 1000)}


def tls_ip(ip, sni):
    try:
        raw = socket.create_connection((ip, 443), timeout=T)
        s = ssl.create_default_context().wrap_socket(raw, server_hostname=sni)
        s.sendall(("GET / HTTP/1.1\r\nHost: " + sni + "\r\nConnection: close\r\n\r\n").encode())
        line = s.recv(200).split(b"\r\n")[0].decode("latin1").split()
        s.close()
        return {"ok": True, "status": int(line[1]) if len(line) > 1 else 0}
    except Exception as e:
        return {"ok": False, "err": kind_of(e)}


def request(url, method="GET", headers=None):
    # One request path for every HTTP probe: same read cap, TLS context and
    # error mapping. Returns (body, status) or an error result dict.
    sent = {"user-agent": "osbit-probe"}
    sent.update(headers or {})
    data = b"" if method == "POST" else None
    req = urllib.request.Request(sub(url), data=data, method=method, headers=sent)
    try:
        with urllib.request.urlopen(req, timeout=10, context=ssl.create_default_context()) as r:
            return r.read(200000), r.status
    except urllib.error.HTTPError as e:
        return e.read(200000), e.code
    except Exception as e:
        return {"ok": False, "err": kind_of(e)}


def fetch(url, marker):
    got = request(url)
    if isinstance(got, dict):
        return got
    body, status = got
    out = {"ok": True, "status": status}
    if marker is not None:
        out["bodyHasMarker"] = marker in body
    return out


def fetch_headers(url, headers, markers_b64):
    # A public echo rate-limits concurrent probes (429) or briefly 503s; retry
    # those only, a bounded number of times, with jitter so parallel probes do
    # not come back together. Any other status is the result.
    for attempt in range(4):
        got = request(url, "POST", headers)
        if isinstance(got, dict):
            return got
        body, status = got
        if status not in (429, 503) or attempt == 3:
            break
        time.sleep(1.5 * (attempt + 1) * (0.5 + random.random()))
    found = [base64.b64decode(m) in body for m in markers_b64]
    return {"ok": True, "status": status, "markersFound": found}


def canary_scan(canaries_b64, pattern):
    needles = [base64.b64decode(c) for c in canaries_b64]
    found = [False] * len(needles)
    names = set()
    rx = re.compile(pattern, re.I)
    me = str(os.getpid())
    scanned = 0
    pid1 = False
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        for kind in ("environ", "cmdline"):
            try:
                data = open("/proc/" + pid + "/" + kind, "rb").read()
            except Exception:
                continue
            if kind == "environ":
                for entry in data.split(b"\0"):
                    name = entry.split(b"=", 1)[0].decode("latin1")
                    if name and rx.search(name):
                        names.add(name)
            if pid == me:
                continue
            if kind == "environ":
                scanned += 1
                pid1 = pid1 or pid == "1"
            for i, n in enumerate(needles):
                if n in data:
                    found[i] = True
    return {"ok": True, "found": found, "envNames": sorted(names), "scanned": scanned, "pid1": pid1}


def run(spec):
    k = spec.get("kind")
    if k == "dns":
        return dns(spec["host"])
    if k == "tcp":
        return tcp(spec["host"], spec["port"])
    if k == "tls_ip":
        return tls_ip(spec["ip"], spec["sni"])
    if k == "https":
        m = spec.get("marker_b64")
        return fetch(spec["url"], base64.b64decode(m) if m else None)
    if k == "https_headers":
        return fetch_headers(spec["url"], spec["headers"], spec["markers_b64"])
    if k == "http":
        return fetch(spec["url"], None)
    if k == "gateway":
        g = gateway()
        return {"ok": g is not None, "gateway": g}
    if k == "dns6":
        return dns6(spec["host"])
    if k == "udpdns":
        return udpdns(spec["server"], spec["query_b64"])
    if k == "ipv6_route":
        return ipv6_route()
    if k == "canary_scan":
        return canary_scan(spec["canaries_b64"], spec["pattern"])
    return {"ok": False, "err": "unknown_kind"}


def safe(spec):
    try:
        res = run(spec)
    except Exception as e:
        res = {"ok": False, "err": "probe:" + kind_of(e)}
    res["kind"] = spec.get("kind")
    return res


# Concurrent, so blocked probes wait out their timeouts together; map keeps order.
specs = json.loads(sys.argv[1])
with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(specs))) as pool:
    out = list(pool.map(safe, specs))
print(json.dumps(out))
`;

/**
 * Self-check argv for the adapter (contract in @terragon/types/cell): a TLS
 * request to a denied host. Any response exits 0; every exception exits 3.
 * `sys.exit` runs outside the `try`, so no path exits 1.
 */
export const SELF_CHECK_ARGV: readonly string[] = [
  "python3",
  "-c",
  [
    "import sys, urllib.request, urllib.error",
    "code = 3",
    "try:",
    '    urllib.request.urlopen("https://example.org/", timeout=5)',
    "    code = 0",
    "except urllib.error.HTTPError:",
    "    code = 0",
    "except Exception:",
    "    code = 3",
    "sys.exit(code)",
  ].join("\n"),
];

export type DnsQueryType = "A" | "AAAA";

const DNS_QTYPE: Record<DnsQueryType, number> = { A: 1, AAAA: 28 };

/**
 * A standard DNS query: random id, RD set, one question, class IN. Refuses an
 * empty label or one over 63 bytes. Built here so vitest covers the bytes and
 * the guest's python only sends the datagram.
 */
export function buildDnsQuery(
  host: string,
  qtype: DnsQueryType,
  id: number = randomBytes(2).readUInt16BE(0),
): Uint8Array {
  const labels = host.replace(/\.$/, "").split(".");
  const parts: number[] = [
    id >> 8,
    id & 0xff,
    0x01,
    0x00,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  for (const label of labels) {
    const bytes = Buffer.from(label, "utf8");
    if (bytes.length === 0 || bytes.length > 63) {
      throw new Error("dns label must be 1 to 63 bytes");
    }
    parts.push(bytes.length, ...bytes);
  }
  const type = DNS_QTYPE[qtype];
  parts.push(0, type >> 8, type & 0xff, 0, 1);
  return Uint8Array.from(parts);
}

/** argv for the adapter's `exec`: the probe script plus its specs as one JSON arg. */
export function probeArgv(probes: readonly ProbeSpec[]): string[] {
  const wire = probes.map((probe) => {
    switch (probe.kind) {
      case "tcp": {
        const { unproxied, ...rest } = probe;
        if (!unproxied && (probe.port === 80 || probe.port === 443)) {
          throw new Error(
            `tcp probe on :${probe.port} is not meaningful under the proxy; use http, https or tls_ip`,
          );
        }
        return rest;
      }
      case "https": {
        const { marker, ...rest } = probe;
        return marker === undefined
          ? rest
          : { ...rest, marker_b64: encodeSecret(marker) };
      }
      case "https_headers":
        return {
          kind: probe.kind,
          url: probe.url,
          headers: probe.headers,
          markers_b64: probe.markers.map(encodeSecret),
        };
      case "udpdns":
        return {
          kind: probe.kind,
          server: probe.server,
          query_b64: Buffer.from(
            buildDnsQuery(probe.host, probe.qtype ?? "A"),
          ).toString("base64"),
        };
      case "canary_scan":
        return {
          kind: probe.kind,
          canaries_b64: probe.canaries.map(encodeSecret),
          pattern: probe.namePattern,
        };
      default:
        return probe;
    }
  });
  return ["python3", "-c", PROBE_PY, JSON.stringify(wire)];
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optionalNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function optionalBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function booleanArray(v: unknown): boolean[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "boolean")
    ? (v as boolean[])
    : undefined;
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[])
    : undefined;
}

/** Parses the probe's last stdout line into typed results; throws on a malformed shape. */
export function parseProbeOutput(stdout: string): ProbeResult[] {
  const last = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .pop();
  if (last === undefined) throw new Error("probe produced no output");
  const raw: unknown = JSON.parse(last);
  if (!Array.isArray(raw)) throw new Error("probe output is not an array");
  return raw.map((item: unknown): ProbeResult => {
    if (typeof item !== "object" || item === null) {
      throw new Error("probe result is not an object");
    }
    const o = item as Record<string, unknown>;
    if (typeof o.kind !== "string" || typeof o.ok !== "boolean") {
      throw new Error("probe result lacks kind or ok");
    }
    return {
      kind: o.kind,
      ok: o.ok,
      err: optionalString(o.err),
      status: optionalNumber(o.status),
      ms: optionalNumber(o.ms),
      ips: stringArray(o.ips),
      bodyHasMarker: optionalBoolean(o.bodyHasMarker),
      markersFound: booleanArray(o.markersFound),
      gateway:
        typeof o.gateway === "string" || o.gateway === null
          ? o.gateway
          : undefined,
      rcode: optionalNumber(o.rcode),
      answers: optionalNumber(o.answers),
      default: optionalBoolean(o.default),
      found: booleanArray(o.found),
      envNames: stringArray(o.envNames),
      scanned: optionalNumber(o.scanned),
      pid1: optionalBoolean(o.pid1),
    };
  });
}

export interface HostScan {
  /** Per canary: found in `docker inspect` of the named containers. */
  inspect: boolean[];
  /** Per canary: found in `docker logs` of the named containers and the server. */
  logs: boolean[];
  /** Containers inspected, and bytes of inspect and log output scanned. */
  containers: number;
  inspectBytes: number;
  logBytes: number;
}

// Runs inside dind: args are N, N base64 canaries, then container names. The
// decoded canary only ever lives in a 0600 temp file, never in an argv.
const HOST_SCAN_SH = `
umask 077
n=$1; shift
tmp=$(mktemp -d)
trap 'rm -f "$tmp"/*; rmdir "$tmp"' EXIT
i=0
while [ "$i" -lt "$n" ]; do
  printf %s "$1" | base64 -d > "$tmp/c$i"
  shift; i=$((i+1))
done
docker inspect "$@" > "$tmp/inspect" || exit 2
: > "$tmp/logs"
for c in "$@" osb-server; do docker logs "$c" >> "$tmp/logs" 2>&1 || exit 3; done
echo "inputs $# $(wc -c < "$tmp/inspect") $(wc -c < "$tmp/logs")"
i=0
while [ "$i" -lt "$n" ]; do
  grep -qF -f "$tmp/c$i" "$tmp/inspect" && echo "hit $i inspect"
  grep -qF -f "$tmp/c$i" "$tmp/logs" && echo "hit $i logs"
  i=$((i+1))
done
exit 0
`;

/**
 * Looks for the canaries in `docker inspect` and `docker logs` of the given
 * containers (workload and sidecar) and of the server, matching inside dind.
 * Takes the base64 canaries; returns booleans only.
 */
export async function scanHostSide(
  containerNames: readonly string[],
  encodedCanaries: readonly string[],
): Promise<HostScan> {
  if (containerNames.length === 0) throw new Error("no containers to scan");
  const result = await dind([
    "sh",
    "-c",
    HOST_SCAN_SH,
    "sh",
    String(encodedCanaries.length),
    ...encodedCanaries,
    ...containerNames,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`host-side scan failed: exit ${result.exitCode}`);
  }
  const scan: HostScan = {
    inspect: encodedCanaries.map(() => false),
    logs: encodedCanaries.map(() => false),
    containers: 0,
    inspectBytes: 0,
    logBytes: 0,
  };
  for (const line of result.stdout.split("\n")) {
    const inputs = /^inputs (\d+) (\d+) (\d+)$/.exec(line.trim());
    if (inputs) {
      scan.containers = Number(inputs[1]);
      scan.inspectBytes = Number(inputs[2]);
      scan.logBytes = Number(inputs[3]);
    }
    const m = /^hit (\d+) (inspect|logs)$/.exec(line.trim());
    if (m) scan[m[2] as "inspect" | "logs"][Number(m[1])] = true;
  }
  return scan;
}
