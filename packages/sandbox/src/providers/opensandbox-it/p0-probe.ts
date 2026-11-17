/**
 * The P0 probe driver (#656 G0b, decision 8): runs on a THROWAWAY box, from
 * `opensandbox-p0-probe.sh`, against a throwaway OpenSandbox server. The
 * enforced cell is made by the production adapter, so the create body is the
 * production one and the adapter's self-check gates it. The negative control
 * is the IT's own (no policy, no credential proxy). Prints `PASS|FAIL|NOTE`
 * lines and never a secret: the key is read from a file, never argv or env.
 *
 *   node --import tsx packages/sandbox/src/providers/opensandbox-it/p0-probe.ts \
 *     --base-url http://127.0.0.1:18092 --key-file <path> --allow-host httpbin.org \
 *     --example-v4 <ip> --example-v6 <ip|none> --box-ip <ip> [--out <json>]
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

import type {
  CellVaultEntry,
  ICellProvider,
  OpenSandboxCellCreatePlan,
  OpenSandboxNetworkPolicy,
} from "@terragon/types/cell";

import {
  CellProviderError,
  createOpenSandboxCellProvider,
} from "../opensandbox-cell";
import {
  GUEST_ENTRYPOINT,
  GUEST_IMAGE,
  parseProbeOutput,
  probeArgv,
  SELF_CHECK_ARGV,
  sleep,
  type ProbeResult,
  type ProbeSpec,
} from "./harness";

export interface P0Args {
  baseUrl: string;
  keyFile: string;
  allowHost: string;
  exampleV4: string;
  exampleV6: string | null;
  boxIp: string;
  out: string | null;
}

type Status = "PASS" | "FAIL" | "NOTE";

interface Line {
  status: Status;
  check: string;
}

const NETWORK_ERROR =
  /^(TimeoutError|timeout|URLError|gaierror|OSError|ConnectionRefusedError|ConnectionResetError|ConnectionAbortedError|BrokenPipeError|SSLError|SSLCertVerificationError|SSLEOFError|SSLZeroReturnError|RemoteDisconnected|IncompleteRead)\b/;
const EXEC_TIMEOUT_MS = 120_000;
const CAP_NET_ADMIN = 12n;
const CAP_NET_RAW = 13n;
const SIDECAR_POLICY_URL = "http://127.0.0.1:18080/policy";
const FLAGS = [
  "--base-url",
  "--key-file",
  "--allow-host",
  "--example-v4",
  "--example-v6",
  "--box-ip",
  "--out",
] as const;

/** Parses the flags; throws on a missing or unknown one. */
export function parseArgs(argv: readonly string[]): P0Args {
  const got = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const value = argv[i + 1];
    if (!(FLAGS as readonly string[]).includes(flag) || value === undefined) {
      throw new Error(`bad argument: ${flag}`);
    }
    got.set(flag, value);
  }
  const need = (flag: (typeof FLAGS)[number]): string => {
    const v = got.get(flag);
    if (v === undefined || v === "") throw new Error(`missing ${flag}`);
    return v;
  };
  const v6 = need("--example-v6");
  return {
    baseUrl: need("--base-url"),
    keyFile: need("--key-file"),
    allowHost: need("--allow-host"),
    exampleV4: need("--example-v4"),
    exampleV6: v6 === "none" ? null : v6,
    boxIp: need("--box-ip"),
    out: got.get("--out") ?? null,
  };
}

/** Blocked: a probe network error. Any HTTP status, or a probe bug, is not. */
export function isBlocked(r: ProbeResult | undefined): boolean {
  return r !== undefined && !r.ok && NETWORK_ERROR.test(r.err ?? "");
}

/** Whether a CapEff hex mask holds NET_ADMIN or NET_RAW. */
export function hasNetCaps(capEffHex: string): boolean {
  const mask = BigInt(`0x${capEffHex}`);
  return (
    ((mask >> CAP_NET_ADMIN) & 1n) === 1n || ((mask >> CAP_NET_RAW) & 1n) === 1n
  );
}

function brief(r: ProbeResult | undefined): string {
  if (!r) return "no result";
  return [`ok=${r.ok}`, r.err, r.status, r.rcode, r.answers]
    .filter((x) => x !== undefined)
    .join(" ");
}

export class Reporter {
  readonly lines: Line[] = [];
  readonly timingsMs: Record<string, number> = {};

  add(status: Status, check: string, detail: string): void {
    this.lines.push({ status, check });
    console.log(`${status} ${check} ${detail}`.trimEnd());
  }

  check(check: string, ok: boolean, detail: string): void {
    this.add(ok ? "PASS" : "FAIL", check, detail);
  }

  failed(): string[] {
    return this.lines.filter((l) => l.status === "FAIL").map((l) => l.check);
  }
}

function policyFor(allowHost: string): OpenSandboxNetworkPolicy {
  return {
    defaultAction: "deny",
    egress: [
      { action: "allow", target: allowHost },
      { action: "deny", ports: [80] },
    ],
  };
}

/** Mirrors the IT's `plan()`, so `create` never refuses it as invalid_plan. */
export function buildPlan(
  allowHost: string,
  canary: string,
): OpenSandboxCellCreatePlan {
  const ttlMs = 15 * 60 * 1000;
  const vault: CellVaultEntry[] = [
    {
      name: "probe",
      hosts: [allowHost],
      paths: ["/bearer"],
      auth: "bearer",
      credential: canary,
    },
  ];
  return {
    provider: "opensandbox",
    runtime: "runc",
    tags: {
      automata: "cell",
      worker: "p0",
      epoch: "1",
      deployment: `p0-${hostname()}`,
      stepKey: `p0-${randomBytes(4).toString("hex")}`,
      attempt: "1",
      expiresAt: String(Date.now() + ttlMs),
    },
    networkPolicy: policyFor(allowHost),
    vault,
    resources: { cpu: 1, memoryMiB: 512 },
    ttlMs,
    egressDigest: "p0",
    profileId: "opensandbox/runc",
  };
}

async function probe(
  provider: ICellProvider,
  cellId: string,
  specs: ProbeSpec[],
): Promise<ProbeResult[]> {
  const r = await provider.exec(cellId, probeArgv(specs), {
    timeoutMs: EXEC_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) throw new Error(`probe exit ${r.exitCode}`);
  return parseProbeOutput(r.stdout);
}

/** The guest's effective capability mask, read from /proc/self/status. */
async function capEff(
  provider: ICellProvider,
  cellId: string,
): Promise<string> {
  const r = await provider.exec(cellId, ["cat", "/proc/self/status"], {
    timeoutMs: EXEC_TIMEOUT_MS,
  });
  const m = /^CapEff:\s*([0-9a-f]+)$/m.exec(r.stdout);
  if (!m?.[1]) throw new Error("no CapEff line");
  return m[1];
}

function ipv4Probes(a: P0Args, canary: string): ProbeSpec[] {
  const gw = (port: number): string => `http://@gateway:${port}/`;
  return [
    { kind: "https", url: `https://${a.allowHost}/get` },
    { kind: "http", url: `http://${a.allowHost}/get` },
    { kind: "dns", host: "example.org" },
    { kind: "tls_ip", ip: a.exampleV4, sni: "example.org" },
    { kind: "http", url: `http://${a.exampleV4}/` },
    { kind: "tls_ip", ip: "1.1.1.1", sni: "cloudflare-dns.com" },
    { kind: "tcp", host: "1.1.1.1", port: 853 },
    { kind: "udpdns", server: "8.8.8.8", host: "example.org" },
    { kind: "http", url: "http://169.254.169.254/latest/meta-data/" },
    { kind: "http", url: `${gw(18092)}health` },
    { kind: "http", url: gw(8888) },
    { kind: "tcp", host: "10.0.2.2", port: 18092 },
    { kind: "tcp", host: "10.0.2.2", port: 8888 },
    { kind: "tcp", host: a.boxIp, port: 8888 },
    { kind: "http", url: SIDECAR_POLICY_URL },
    { kind: "gateway" },
    {
      kind: "canary_scan",
      canaries: [canary],
      namePattern: "KEY|TOKEN|CANARY",
    },
  ];
}

function reportIpv4(rep: Reporter, r: ProbeResult[]): void {
  const at = (i: number): ProbeResult | undefined => r[i];
  const blocked = (name: string, i: number): void =>
    rep.check(name, isBlocked(at(i)), brief(at(i)));
  rep.check("allowed-https-200", at(0)?.status === 200, brief(at(0)));
  blocked("allowed-80-blocked", 1);
  rep.check(
    "example-dns-nxdomain",
    isBlocked(at(2)) && (at(2)?.err ?? "").startsWith("gaierror"),
    brief(at(2)),
  );
  blocked("example-ip-tls-blocked", 3);
  blocked("example-ip-http-blocked", 4);
  blocked("doh-by-ip-blocked", 5);
  blocked("dot-853-blocked", 6);
  rep.check(
    "udp-dns-sidecar-nxdomain",
    at(7)?.ok === true && at(7)?.rcode === 3 && at(7)?.answers === 0,
    brief(at(7)),
  );
  blocked("metadata-blocked", 8);
  blocked("gateway-18092-blocked", 9);
  blocked("gateway-8888-blocked", 10);
  blocked("slirp-host-18092-blocked", 11);
  blocked("slirp-host-8888-blocked", 12);
  blocked("box-ip-8888-blocked", 13);
  const refused =
    isBlocked(at(14)) || at(14)?.status === 401 || at(14)?.status === 403;
  rep.check("sidecar-policy-refuses-guest", refused, brief(at(14)));
  rep.add("NOTE", "guest-gateway", String(at(15)?.gateway ?? "none"));
  rep.check(
    "canary-scan-clean",
    at(16)?.ok === true && at(16)?.found?.every((f) => !f) === true,
    `scanned=${at(16)?.scanned ?? 0}`,
  );
}

async function ipv6Checks(
  rep: Reporter,
  provider: ICellProvider,
  id: string,
  a: P0Args,
): Promise<void> {
  const [dns6, route] = await probe(provider, id, [
    { kind: "dns6", host: "example.org" },
    { kind: "ipv6_route" },
  ]);
  rep.check("dns6-no-answer", dns6?.ok === false, brief(dns6));
  if (route?.default !== true || a.exampleV6 === null) {
    const why =
      route?.default === true
        ? "host has no v6 address"
        : "guest has no default v6 route";
    rep.add("NOTE", "ipv6-vacuous", `${why}; IPv6 bypass untested on this box`);
    return;
  }
  const [tls, udp] = await probe(provider, id, [
    { kind: "tls_ip", ip: a.exampleV6, sni: "example.org" },
    { kind: "udpdns", server: "2001:4860:4860::8888", host: "example.org" },
  ]);
  rep.check("ipv6-tls-blocked", isBlocked(tls), brief(tls));
  rep.check(
    "ipv6-udp-dns-no-answer",
    udp?.ok === false || udp?.answers === 0,
    brief(udp),
  );
}

async function enforcedCell(
  rep: Reporter,
  provider: ICellProvider,
  a: P0Args,
  canary: string,
): Promise<string | null> {
  const t0 = Date.now();
  try {
    const { cellId } = await provider.create(buildPlan(a.allowHost, canary));
    rep.timingsMs.createEnforced = Date.now() - t0;
    rep.add("PASS", "self-check-blocked", "adapter create gated on exit 3");
    return cellId;
  } catch (error) {
    const detail =
      error instanceof CellProviderError
        ? `${error.code} op=${error.op}${error.status ? ` status=${error.status}` : ""}`
        : "other";
    rep.add("FAIL", "self-check-blocked", `create failed: ${detail}`);
    return null;
  }
}

async function runEnforced(
  rep: Reporter,
  provider: ICellProvider,
  id: string,
  a: P0Args,
  canary: string,
): Promise<void> {
  const again = await provider.exec(id, [...SELF_CHECK_ARGV], {
    timeoutMs: EXEC_TIMEOUT_MS,
  });
  rep.check(
    "self-check-exec-3",
    again.exitCode === 3,
    `exit ${again.exitCode}`,
  );
  reportIpv4(rep, await probe(provider, id, ipv4Probes(a, canary)));
  const caps = await capEff(provider, id);
  rep.check("guest-no-net-caps", !hasNetCaps(caps), "NET_ADMIN/NET_RAW bits");
  await ipv6Checks(rep, provider, id, a);
}

/** The server's error code and message for a refused deny-all; neither holds a secret. */
async function quarantineRefusal(
  a: P0Args,
  apiKey: string,
  id: string,
): Promise<string> {
  const res = await fetch(
    `${a.baseUrl}/sandboxes/${encodeURIComponent(id)}/networkpolicy?dropEstablished=true`,
    {
      method: "PUT",
      headers: {
        "OPEN-SANDBOX-API-KEY": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ defaultAction: "deny", egress: [] }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  // The body may be JSON ({code, message}) or plain text; keep printable ASCII only.
  const text = await res.text().catch(() => "");
  let why = text;
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown };
    why = [body.code, body.message]
      .filter((v): v is string => typeof v === "string")
      .join(": ");
  } catch {
    // not JSON: keep the text
  }
  why = why.replace(/[^\x20-\x7e]/g, " ").slice(0, 300);
  return `status ${res.status}${why ? ` (${why})` : ""}`;
}

async function denyAllThenDelete(
  rep: Reporter,
  provider: ICellProvider,
  id: string,
  a: P0Args,
  apiKey: string,
): Promise<void> {
  // Production order (adapter teardown): the vault first. OpenSandbox 1.2.1
  // validates vault bindings against a new policy, so a deny-all is refused
  // (400) while a binding's host is still in the vault.
  await provider.revoke(id);
  try {
    await provider.quarantine(id);
  } catch {
    // Record why, then still delete the cell and run the negative control.
    rep.add(
      "FAIL",
      "deny-all-accepted",
      await quarantineRefusal(a, apiKey, id),
    );
    await provider.teardown(id);
    gone.add(id);
    return;
  }
  rep.add(
    "PASS",
    "deny-all-accepted",
    "PUT networkpolicy dropEstablished=true",
  );
  const [r] = await probe(provider, id, [
    { kind: "https", url: `https://${a.allowHost}/get` },
  ]);
  rep.check("deny-all-blocks-allowed", isBlocked(r), brief(r));
  await provider.teardown(id);
  rep.check(
    "second-delete-gone",
    (await provider.delete(id)) === "gone",
    "404",
  );
  gone.add(id);
}

/**
 * Cells this run confirmed deleted. The final cleanup skips them: on 1.2.1 a
 * revoke or quarantine of a deleted cell answers 502 (its sidecar is gone),
 * not 404, so a second adapter teardown of a gone cell throws (#656 finding).
 */
const gone = new Set<string>();

async function negativeControl(
  rep: Reporter,
  provider: ICellProvider,
  a: P0Args,
  apiKey: string,
): Promise<void> {
  const res = await fetch(`${a.baseUrl}/sandboxes`, {
    method: "POST",
    headers: {
      "OPEN-SANDBOX-API-KEY": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      image: { uri: GUEST_IMAGE },
      entrypoint: [...GUEST_ENTRYPOINT],
      timeout: 600,
      resourceLimits: { cpu: "1000m", memory: "512Mi" },
      metadata: {
        automata: "cell",
        worker: "p0",
        stepKey: `p0-neg-${randomBytes(4).toString("hex")}`,
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    id?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const id = typeof body.id === "string" ? body.id : "";
  if (id === "") {
    // The server's error code and message say why; neither holds a secret.
    const why = [body.code, body.message]
      .filter((v): v is string => typeof v === "string")
      .join(": ")
      .replace(/[^\x20-\x7e]/g, " ")
      .slice(0, 300);
    rep.add(
      "FAIL",
      "negative-control-4of4",
      `create status ${res.status}${why ? ` (${why})` : ""}`,
    );
    return;
  }
  try {
    await waitPing(provider, id);
    const r = await probe(provider, id, [
      { kind: "dns", host: "example.org" },
      { kind: "https", url: "https://example.org/" },
      { kind: "tcp", host: a.exampleV4, port: 80, unproxied: true },
      { kind: "tls_ip", ip: a.exampleV4, sni: "example.org" },
    ]);
    const reached = r.filter((x) => x.ok).length;
    rep.check("negative-control-4of4", reached === 4, `${reached}/4 reached`);
  } finally {
    // No policy means no egress sidecar: revoke and deny-all would be proxied
    // to nothing (502). A plain delete, as the IT's AC-8 does.
    await provider.delete(id);
  }
}

/** execd's ping through the server, the adapter's own readiness test. */
async function waitPing(provider: ICellProvider, id: string): Promise<void> {
  for (let i = 0; i < 360; i++) {
    try {
      const r = await provider.exec(id, ["true"], { timeoutMs: 10_000 });
      if (r.exitCode === 0) return;
    } catch {
      // Not ready yet: execd is still starting.
    }
    await sleep(500);
  }
  throw new Error("negative-control cell never became ready");
}

export async function runProbe(a: P0Args, rep: Reporter): Promise<void> {
  const apiKey = readFileSync(a.keyFile, "utf8").trim();
  const canary = `p0-canary-${randomBytes(8).toString("hex")}`;
  const provider = createOpenSandboxCellProvider(
    {
      baseUrl: a.baseUrl,
      apiKey,
      image: GUEST_IMAGE,
      entrypoint: GUEST_ENTRYPOINT,
      selfCheck: { argv: SELF_CHECK_ARGV },
      readyTimeoutMs: 300_000,
    },
    {
      fetch: (...args) => fetch(...args),
      sleep,
      now: () => Date.now(),
      logger: { info() {}, warn() {} },
    },
  );
  const id = await enforcedCell(rep, provider, a, canary);
  try {
    if (id !== null) {
      await runEnforced(rep, provider, id, a, canary);
      await denyAllThenDelete(rep, provider, id, a, apiKey);
    }
    await negativeControl(rep, provider, a, apiKey);
  } finally {
    // Idempotent (404 is done): leaves no cell behind after a mid-run error.
    if (id !== null && !gone.has(id)) await provider.teardown(id);
  }
}

async function main(): Promise<number> {
  const rep = new Reporter();
  const args = parseArgs(process.argv.slice(2));
  try {
    await runProbe(args, rep);
  } catch (error) {
    // An AggregateError (adapter teardown) names each failed step: op and status only.
    const parts =
      error instanceof AggregateError
        ? error.errors.map((e: unknown) =>
            e instanceof CellProviderError
              ? `${e.op}:${e.code}${e.status ? `:${e.status}` : ""}`
              : "other",
          )
        : [];
    const msg = error instanceof Error ? error.message : "unknown";
    rep.add("FAIL", "driver-error", [msg, ...parts].join(" "));
  }
  const summary = { checks: rep.lines, timingsMs: rep.timingsMs };
  if (args.out !== null) writeFileSync(args.out, JSON.stringify(summary));
  return rep.failed().length === 0 ? 0 : 1;
}

async function entry(): Promise<void> {
  try {
    process.exitCode = await main();
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown";
    console.log(`FAIL driver-error ${msg}`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("p0-probe.ts")) void entry();
