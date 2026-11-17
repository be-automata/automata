import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { probeArgv, type ProbeResult } from "./harness";
import {
  buildPlan,
  deploymentTag,
  hasNetCaps,
  isBlocked,
  parseArgs,
  reportDns6,
  reportIpv4,
  reportIpv6Bypass,
  Reporter,
} from "./p0-probe";

const r = (o: Partial<ProbeResult> & { ok: boolean }): ProbeResult => ({
  kind: "x",
  ...o,
});

const silent = () => vi.spyOn(console, "log").mockImplementation(() => {});

describe("isBlocked", () => {
  it("is true for a network error", () => {
    for (const err of [
      "TimeoutError",
      "gaierror:-2",
      "URLError",
      "OSError:ENETUNREACH",
    ]) {
      expect(isBlocked(r({ ok: false, err }))).toBe(true);
    }
  });

  // negative controls: anything else is not proof of a block
  it("is false for success, an HTTP-level error, a probe bug or no result", () => {
    expect(isBlocked(r({ ok: true }))).toBe(false);
    expect(isBlocked(r({ ok: false }))).toBe(false);
    expect(isBlocked(r({ ok: false, err: "NameError" }))).toBe(false);
    expect(isBlocked(r({ ok: false, err: "short_reply" }))).toBe(false);
    expect(isBlocked(undefined)).toBe(false);
  });
});

describe("hasNetCaps", () => {
  it("sees NET_ADMIN (bit 12) and NET_RAW (bit 13)", () => {
    expect(hasNetCaps("0000000000001000")).toBe(true);
    expect(hasNetCaps("0000000000002000")).toBe(true);
    expect(hasNetCaps("00000000a80425fb")).toBe(true);
  });

  it("is false for an empty mask and a dropped set", () => {
    expect(hasNetCaps("0000000000000000")).toBe(false);
    expect(hasNetCaps("00000000a80405fb")).toBe(false);
  });
});

describe("parseArgs", () => {
  const full = [
    "--base-url",
    "http://127.0.0.1:18092",
    "--key-file",
    "/k",
    "--allow-host",
    "httpbin.org",
    "--example-v4",
    "93.184.215.14",
    "--example-v6",
    "none",
    "--box-ip",
    "10.0.0.5",
  ];

  it("parses every flag; none for v6 is null and --out is optional", () => {
    expect(parseArgs(full)).toEqual({
      baseUrl: "http://127.0.0.1:18092",
      keyFile: "/k",
      allowHost: "httpbin.org",
      exampleV4: "93.184.215.14",
      exampleV6: null,
      boxIp: "10.0.0.5",
      out: null,
    });
    expect(parseArgs([...full, "--out", "/o.json"]).out).toBe("/o.json");
  });

  it("throws on an unknown flag, a dangling flag and a missing one", () => {
    expect(() => parseArgs([...full, "--nope", "x"])).toThrow(/bad argument/);
    expect(() => parseArgs([...full, "--out"])).toThrow(/bad argument/);
    expect(() => parseArgs(full.slice(2))).toThrow(/missing --base-url/);
    expect(() => parseArgs(full.map((a) => (a === "none" ? "" : a)))).toThrow(
      /missing --example-v6/,
    );
  });
});

describe("deploymentTag and buildPlan labels", () => {
  const LABEL = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;

  it("keeps a short host readable", () => {
    expect(deploymentTag("box-1")).toBe("p0-box-1");
  });

  it("cuts and hashes a long host to at most 63 label-safe chars", () => {
    const a = deploymentTag(`${"a".repeat(80)}.example.internal`);
    const b = deploymentTag(`${"a".repeat(80)}.example.other`);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(a).toMatch(LABEL);
    expect(a).not.toBe(b);
  });

  it("replaces unsafe characters and never ends on punctuation", () => {
    expect(deploymentTag("my host/ü")).toMatch(LABEL);
    expect(deploymentTag(`${"b".repeat(59)}.---`)).toMatch(LABEL);
  });

  it("puts a label-safe deployment in the plan for a long hostname", () => {
    const plan = buildPlan("httpbin.org", "c", "h".repeat(200));
    expect(plan.tags.deployment).toMatch(LABEL);
    expect(plan.tags.deployment?.length).toBeLessThanOrEqual(63);
    expect(plan.tags.automata).toBe("cell");
  });
});

describe("reports use isBlocked, not any ok:false", () => {
  const probes = (): ProbeResult[] =>
    Array.from({ length: 17 }, () => r({ ok: false, err: "TimeoutError" }));

  it("udp-dns needs the reply id to match the query", () => {
    silent();
    const good = probes();
    good[7] = r({ ok: true, idMatch: true, rcode: 3, answers: 0 });
    const spoof = probes();
    spoof[7] = r({ ok: true, idMatch: false, rcode: 3, answers: 0 });
    const a = new Reporter();
    reportIpv4(a, good);
    const b = new Reporter();
    reportIpv4(b, spoof);
    expect(a.failed()).not.toContain("udp-dns-sidecar-nxdomain");
    expect(b.failed()).toContain("udp-dns-sidecar-nxdomain");
    vi.restoreAllMocks();
  });

  it("dns6-no-answer fails on a probe bug", () => {
    silent();
    const ok = new Reporter();
    reportDns6(ok, r({ ok: false, err: "gaierror:-2" }));
    const bug = new Reporter();
    reportDns6(bug, r({ ok: false, err: "NameError" }));
    expect(ok.failed()).toEqual([]);
    expect(bug.failed()).toEqual(["dns6-no-answer"]);
    vi.restoreAllMocks();
  });

  it("ipv6-udp-dns-no-answer fails on a bug and on a spoofed id", () => {
    silent();
    const blocked = r({ ok: false, err: "TimeoutError" });
    const cases: [ProbeResult, boolean][] = [
      [r({ ok: false, err: "TimeoutError" }), true],
      [r({ ok: true, idMatch: true, answers: 0 }), true],
      [r({ ok: false, err: "NameError" }), false],
      [r({ ok: true, idMatch: false, answers: 0 }), false],
      [r({ ok: true, idMatch: true, answers: 1 }), false],
    ];
    for (const [udp, pass] of cases) {
      const rep = new Reporter();
      reportIpv6Bypass(rep, blocked, udp);
      expect(rep.failed().includes("ipv6-udp-dns-no-answer")).toBe(!pass);
    }
    vi.restoreAllMocks();
  });
});

describe("the guest's ipv6_route parser on /proc/net/ipv6_route samples", () => {
  const Z = "0".repeat(32);
  const row = (
    dest: string,
    plen: string,
    nh: string,
    flags: string,
    dev: string,
  ) =>
    `${dest} ${plen} ${Z} 00 ${nh} 00000400 00000001 00000000 ${flags} ${dev}`;
  const DEFAULT_ETH = row(
    Z,
    "00",
    "fe80000000000000a8c0ffeefe000001",
    "00000003",
    "eth0",
  );
  const LINK_LOCAL = row(
    "fe800000000000000000000000000000",
    "40",
    Z,
    "00000001",
    "eth0",
  );
  const REJECT_LO = row(Z, "00", Z, "00200200", "lo");
  const REJECT_ETH = row(Z, "00", Z, "00000200", "eth0");

  const run = (rows: string[]): unknown => {
    const dir = mkdtempSync(join(tmpdir(), "ipv6route-"));
    const file = join(dir, "ipv6_route");
    writeFileSync(file, `${rows.join("\n")}\n`);
    const py = (probeArgv([{ kind: "ipv6_route" }])[2] ?? "").replace(
      "/proc/net/ipv6_route",
      file,
    );
    const out = spawnSync(
      "python3",
      ["-I", "-c", py, '[{"kind":"ipv6_route"}]'],
      {
        encoding: "utf8",
      },
    );
    expect(out.status).toBe(0);
    return (JSON.parse(out.stdout.trim()) as { default?: boolean }[])[0]
      ?.default;
  };

  it("finds a gateway default route", () => {
    expect(run([LINK_LOCAL, DEFAULT_ETH, REJECT_LO])).toBe(true);
  });

  // negative controls
  it("ignores link-local-only, reject-only and lo-only tables", () => {
    expect(run([LINK_LOCAL])).toBe(false);
    expect(run([LINK_LOCAL, REJECT_LO])).toBe(false);
    expect(run([REJECT_ETH])).toBe(false);
    expect(run([""])).toBe(false);
  });
});
