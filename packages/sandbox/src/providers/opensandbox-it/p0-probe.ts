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
import { createHash, randomBytes } from "node:crypto";
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
  rawApi,
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

const LABEL_MAX = 63;

/** `p0-<host>` as a label value: [A-Za-z0-9._-], alphanumeric ends, at most 63 chars (a long host is cut and hashed). */
export function deploymentTag(host: string): string {
  const safe = host.replace(/[^A-Za-z0-9._-]/g, "-");
  const whole = `p0-${safe}`;
  if (whole.length <= LABEL_MAX && /[A-Za-z0-9]$/.test(whole)) return whole;
  const hash = createHash("sha256").update(host).digest("hex").slice(0, 8);
  const head = whole.slice(0, LABEL_MAX - hash.length - 1);
  return `${head.replace(/[^A-Za-z0-9]+$/, "")}-${hash}`;
}

/** Mirrors the IT's `plan()`, so `create` never refuses it as invalid_plan. */
export function buildPlan(
  allowHost: string,
  canary: string,
  host: string = hostname(),
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
      deployment: deploymentTag(host),
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

interface Verdict {
  status: Status;
  detail: string;
}

/** One enforced-cell check: the guest probe to run and how to judge its result. */
export interface CheckRow {
  name: string;
  spec: ProbeSpec;
  judge: (r: ProbeResult | undefined) => Verdict;
}

const pass = (ok: boolean, r: ProbeResult | undefined): Verdict => ({
  status: ok ? "PASS" : "FAIL",
  detail: brief(r),
});
const row = (
  name: string,
  spec: ProbeSpec,
  ok: (r: ProbeResult | undefined) => boolean,
): CheckRow => ({ name, spec, judge: (r) => pass(ok(r), r) });
const blockedRow = (name: string, spec: ProbeSpec): CheckRow =>
  row(name, spec, isBlocked);

/** The IPv4 batch plus dns6, in report order; `ipv6_route` is probed beside it. */
export function ipv4Rows(a: P0Args, canary: string): CheckRow[] {
  const gw = (port: number): string => `http://@gateway:${port}/`;
  const tlsIp = (ip: string, sni: string): ProbeSpec => ({
    kind: "tls_ip",
    ip,
    sni,
  });
  return [
    row(
      "allowed-https-200",
      { kind: "https", url: `https://${a.allowHost}/get` },
      (r) => r?.status === 200,
    ),
    blockedRow("allowed-80-blocked", {
      kind: "http",
      url: `http://${a.allowHost}/get`,
    }),
    row(
      "example-dns-nxdomain",
      { kind: "dns", host: "example.org" },
      (r) => isBlocked(r) && (r?.err ?? "").startsWith("gaierror"),
    ),
    blockedRow("example-ip-tls-blocked", tlsIp(a.exampleV4, "example.org")),
    blockedRow("example-ip-http-blocked", {
      kind: "http",
      url: `http://${a.exampleV4}/`,
    }),
    blockedRow("doh-by-ip-blocked", tlsIp("1.1.1.1", "cloudflare-dns.com")),
    blockedRow("dot-853-blocked", { kind: "tcp", host: "1.1.1.1", port: 853 }),
    row(
      "udp-dns-sidecar-nxdomain",
      { kind: "udpdns", server: "8.8.8.8", host: "example.org" },
      (r) =>
        r?.ok === true &&
        r.idMatch === true &&
        r.rcode === 3 &&
        r.answers === 0,
    ),
    blockedRow("metadata-blocked", {
      kind: "http",
      url: "http://169.254.169.254/latest/meta-data/",
    }),
    blockedRow("gateway-18092-blocked", {
      kind: "http",
      url: `${gw(18092)}health`,
    }),
    blockedRow("gateway-8888-blocked", { kind: "http", url: gw(8888) }),
    blockedRow("slirp-host-18092-blocked", {
      kind: "tcp",
      host: "10.0.2.2",
      port: 18092,
    }),
    blockedRow("slirp-host-8888-blocked", {
      kind: "tcp",
      host: "10.0.2.2",
      port: 8888,
    }),
    blockedRow("box-ip-8888-blocked", {
      kind: "tcp",
      host: a.boxIp,
      port: 8888,
    }),
    row(
      "sidecar-policy-refuses-guest",
      { kind: "http", url: SIDECAR_POLICY_URL },
      // An HTTP refusal from the sidecar itself, as the IT requires: a refused
      // connection would also "pass" when nothing listens on 18080.
      (r) => r?.status === 401 || r?.status === 403,
    ),
    {
      name: "guest-gateway",
      spec: { kind: "gateway" },
      judge: (r) => ({ status: "NOTE", detail: String(r?.gateway ?? "none") }),
    },
    {
      name: "canary-scan-clean",
      spec: {
        kind: "canary_scan",
        canaries: [canary],
        namePattern: "KEY|TOKEN|CANARY",
      },
      judge: (r) => ({
        status:
          r?.ok === true && r.found?.every((f) => !f) === true
            ? "PASS"
            : "FAIL",
        detail: `scanned=${r?.scanned ?? 0}`,
      }),
    },
    blockedRow("dns6-no-answer", { kind: "dns6", host: "example.org" }),
  ];
}

/** Judges `results[i]` with `rows[i]` and reports each line. */
export function reportRows(
  rep: Reporter,
  rows: readonly CheckRow[],
  results: readonly (ProbeResult | undefined)[],
): void {
  rows.forEach((r, i) => {
    const v = r.judge(results[i]);
    rep.add(v.status, r.name, v.detail);
  });
}

/** The IPv6 bypass probes, run only when the guest has a default v6 route. */
async function ipv6Bypass(
  rep: Reporter,
  provider: ICellProvider,
  id: string,
  a: P0Args,
  route: ProbeResult | undefined,
): Promise<void> {
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
  reportIpv6Bypass(rep, tls, udp);
}

export function reportIpv6Bypass(
  rep: Reporter,
  tls: ProbeResult | undefined,
  udp: ProbeResult | undefined,
): void {
  rep.check("ipv6-tls-blocked", isBlocked(tls), brief(tls));
  rep.check(
    "ipv6-udp-dns-no-answer",
    isBlocked(udp) ||
      (udp?.ok === true && udp.idMatch === true && udp.answers === 0),
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
  const rows = ipv4Rows(a, canary);
  const results = await probe(provider, id, [
    ...rows.map((r) => r.spec),
    { kind: "ipv6_route" },
  ]);
  reportRows(rep, rows, results);
  const caps = await capEff(provider, id);
  rep.check("guest-no-net-caps", !hasNetCaps(caps), "NET_ADMIN/NET_RAW bits");
  await ipv6Bypass(rep, provider, id, a, results[rows.length]);
}

/**
 * The server's error code and message of a refused call; neither holds a
 * secret. Printable ASCII only, at most 300 characters.
 */
export function serverReason(body: unknown): string {
  let why = "";
  if (typeof body === "string") {
    why = body;
  } else if (typeof body === "object" && body !== null) {
    const { code, message } = body as { code?: unknown; message?: unknown };
    why = [code, message]
      .filter((v): v is string => typeof v === "string")
      .join(": ");
  }
  return why.replace(/[^\x20-\x7e]/g, " ").slice(0, 300);
}

const refusal = (status: number, body: unknown): string => {
  const why = serverReason(body);
  return `status ${status}${why ? ` (${why})` : ""}`;
};

/** Why the server refused a deny-all. */
async function quarantineRefusal(
  a: P0Args,
  apiKey: string,
  id: string,
): Promise<string> {
  const res = await rawApi(
    "PUT",
    `/sandboxes/${encodeURIComponent(id)}/networkpolicy?dropEstablished=true`,
    { defaultAction: "deny", egress: [] },
    { baseUrl: a.baseUrl, apiKey },
  );
  return refusal(res.status, res.body);
}

/**
 * Deny-all the enforced cell, check it, and delete it. `state.deleted` is set
 * the moment the cell is gone (even if a later step throws), and the final
 * cleanup then skips it: on 1.2.1 a revoke or
 * quarantine of a deleted cell answers 502 (its sidecar is gone), not 404, so a
 * second adapter teardown of it throws (#656 finding).
 */
async function denyAllThenDelete(
  rep: Reporter,
  provider: ICellProvider,
  id: string,
  a: P0Args,
  apiKey: string,
  state: { deleted: boolean },
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
    // Not teardown(): it re-runs the refused quarantine and would mask the cause.
    await provider.delete(id);
    state.deleted = true;
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
  state.deleted = true;
  rep.check(
    "second-delete-gone",
    (await provider.delete(id)) === "gone",
    "404",
  );
}

function idOf(body: unknown): string {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : "";
}

async function negativeControl(
  rep: Reporter,
  provider: ICellProvider,
  a: P0Args,
  apiKey: string,
): Promise<void> {
  const res = await rawApi(
    "POST",
    "/sandboxes",
    {
      image: { uri: GUEST_IMAGE },
      entrypoint: [...GUEST_ENTRYPOINT],
      timeout: 600,
      resourceLimits: { cpu: "1000m", memory: "512Mi" },
      metadata: {
        automata: "cell",
        worker: "p0",
        stepKey: `p0-neg-${randomBytes(4).toString("hex")}`,
      },
    },
    { baseUrl: a.baseUrl, apiKey, timeoutMs: 60_000 },
  );
  const id = idOf(res.body);
  if (id === "") {
    rep.add(
      "FAIL",
      "negative-control-4of4",
      `create ${refusal(res.status, res.body)}`,
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
  const state = { deleted: false };
  try {
    if (id !== null) {
      await runEnforced(rep, provider, id, a, canary);
      await denyAllThenDelete(rep, provider, id, a, apiKey, state);
    }
    await negativeControl(rep, provider, a, apiKey);
  } finally {
    // Idempotent (404 is done): leaves no cell behind after a mid-run error.
    if (id !== null && !state.deleted) await provider.teardown(id);
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
