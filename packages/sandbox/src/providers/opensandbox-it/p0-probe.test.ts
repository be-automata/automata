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
  ipv4Rows,
  isBlocked,
  parseArgs,
  reportIpv6Bypass,
  reportRows,
  Reporter,
  serverReason,
  type P0Args,
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

describe("serverReason", () => {
  it("joins a JSON body's code and message, or keeps a text body", () => {
    expect(serverReason({ code: "SANDBOX::X", message: "bad" })).toBe(
      "SANDBOX::X: bad",
    );
    expect(serverReason({ code: "only" })).toBe("only");
    expect(serverReason("plain text")).toBe("plain text");
  });

  // negative controls: nothing printable beyond ASCII, nothing past 300 chars, nothing from other shapes
  it("strips non-printable characters, caps the length and ignores other shapes", () => {
    expect(serverReason("a\u00fcb\nc")).toBe("a b c");
    expect(serverReason("x".repeat(500))).toHaveLength(300);
    expect(serverReason(null)).toBe("");
    expect(serverReason({ code: 4, message: ["x"] })).toBe("");
  });
});

describe("the enforced-cell check rows", () => {
  const ARGS: P0Args = {
    baseUrl: "http://127.0.0.1:18092",
    keyFile: "/k",
    allowHost: "httpbin.org",
    exampleV4: "93.184.215.14",
    exampleV6: null,
    boxIp: "10.0.0.5",
    out: null,
  };
  const rows = ipv4Rows(ARGS, "canary");
  const at = (name: string) => rows.findIndex((x) => x.name === name);
  const blockedAll = (): ProbeResult[] =>
    rows.map(() => r({ ok: false, err: "TimeoutError" }));
  const failedWith = (name: string, result: ProbeResult): string[] => {
    const results = blockedAll();
    results[at(name)] = result;
    const rep = new Reporter();
    reportRows(rep, rows, results);
    return rep.failed();
  };

  it("has unique names and folds dns6 into the batch", () => {
    const names = rows.map((x) => x.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("dns6-no-answer");
    expect(rows.map((x) => x.spec.kind)).toContain("dns6");
  });

  it("udp-dns needs the reply id to match the query", () => {
    silent();
    const name = "udp-dns-sidecar-nxdomain";
    const reply = (idMatch: boolean) =>
      r({ ok: true, idMatch, rcode: 3, answers: 0 });
    expect(failedWith(name, reply(true))).not.toContain(name);
    expect(failedWith(name, reply(false))).toContain(name);
    vi.restoreAllMocks();
  });

  it("dns6-no-answer fails on a probe bug", () => {
    silent();
    const name = "dns6-no-answer";
    expect(failedWith(name, r({ ok: false, err: "gaierror:-2" }))).toEqual([
      "allowed-https-200",
      "example-dns-nxdomain",
      "udp-dns-sidecar-nxdomain",
      "sidecar-policy-refuses-guest",
      "canary-scan-clean",
    ]);
    expect(failedWith(name, r({ ok: false, err: "NameError" }))).toContain(
      name,
    );
    vi.restoreAllMocks();
  });

  // negative controls: a missing result and an HTTP-level answer are not a block
  it("a missing result or an HTTP answer fails a blocked row", () => {
    silent();
    const rep = new Reporter();
    reportRows(rep, rows, []);
    expect(rep.failed()).toContain("metadata-blocked");
    expect(
      failedWith("metadata-blocked", r({ ok: true, status: 200 })),
    ).toContain("metadata-blocked");
    vi.restoreAllMocks();
  });

  // negative control: a refused connection (nothing on 18080) is not a sidecar refusal
  it("sidecar-policy-refuses-guest needs an HTTP 401 or 403", () => {
    silent();
    const name = "sidecar-policy-refuses-guest";
    expect(failedWith(name, r({ ok: true, status: 401 }))).not.toContain(name);
    expect(failedWith(name, r({ ok: true, status: 403 }))).not.toContain(name);
    expect(failedWith(name, r({ ok: false, err: "TimeoutError" }))).toContain(
      name,
    );
    expect(
      failedWith(name, r({ ok: false, err: "ConnectionRefusedError" })),
    ).toContain(name);
    expect(failedWith(name, r({ ok: true, status: 200 }))).toContain(name);
    vi.restoreAllMocks();
  });

  it("the gateway is a NOTE, never a pass or a failure", () => {
    silent();
    const rep = new Reporter();
    reportRows(rep, rows, blockedAll());
    expect(rep.lines.find((l) => l.check === "guest-gateway")?.status).toBe(
      "NOTE",
    );
    vi.restoreAllMocks();
  });
});

describe("ipv6-udp-dns-no-answer", () => {
  it("fails on a bug and on a spoofed id", () => {
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

  // One python process for every sample: the probe's code runs once per
  // sample file, with the route path swapped in.
  const DRIVER = `import contextlib, io, json, sys
cfg = json.load(sys.stdin)
out = []
for f in cfg["files"]:
    sys.argv = ["-c", '[{"kind":"ipv6_route"}]']
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(cfg["py"].replace("/proc/net/ipv6_route", f), "probe", "exec"), {"__name__": "probe"})
    out.append(json.loads(buf.getvalue().strip())[0].get("default"))
print(json.dumps(out))`;

  const hasPython = (): boolean =>
    spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

  const runAll = (samples: string[][]): unknown[] => {
    const dir = mkdtempSync(join(tmpdir(), "ipv6route-"));
    const files = samples.map((rows, i) => {
      const file = join(dir, `ipv6_route-${i}`);
      writeFileSync(file, `${rows.join("\n")}\n`);
      return file;
    });
    const py = probeArgv([{ kind: "ipv6_route" }])[2] ?? "";
    const out = spawnSync("python3", ["-I", "-c", DRIVER], {
      encoding: "utf8",
      input: JSON.stringify({ py, files }),
    });
    expect(out.status).toBe(0);
    return JSON.parse(out.stdout.trim()) as unknown[];
  };

  it("finds a gateway default route", (ctx) => {
    if (!hasPython()) ctx.skip();
    expect(runAll([[LINK_LOCAL, DEFAULT_ETH, REJECT_LO]])).toEqual([true]);
  });

  // negative controls
  it("ignores link-local-only, reject-only and lo-only tables", (ctx) => {
    if (!hasPython()) ctx.skip();
    expect(
      runAll([[LINK_LOCAL], [LINK_LOCAL, REJECT_LO], [REJECT_ETH], [""]]),
    ).toEqual([false, false, false, false]);
  });
});
