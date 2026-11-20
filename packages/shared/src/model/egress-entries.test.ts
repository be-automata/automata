import { describe, expect, it } from "vitest";

import { EGRESS_WARNING_CODES } from "@terragon/types/egress";

import { BROKER, CATALOG } from "./__fixtures__/cell-egress";
import { CELL_EGRESS_MAX_ENTRIES } from "./cell-egress";
import { planCellEgressForRepo } from "./cell-egress-catalog";
import {
  classifyEgressEntries,
  detectMultiTenantUploadHost,
  egressWarnings,
  type EgressWarning,
} from "./egress-entries";
import { buildEgressPolicyShape } from "./egress-policy";

const PLATFORM_HOSTS = 2; // broker + model host
const REGISTRIES_HOSTS = 17;

function hosts(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `h${i}.acme.example`);
}

function classifyDomain(entries: readonly string[], registries = false) {
  return classifyEgressEntries({
    level: "domain",
    entries,
    registries,
    brokerHost: BROKER,
  });
}

describe("classifyEgressEntries: the AC-6 code table", () => {
  const TABLE: [string, string, string | null][] = [
    ["*.example.com", "wildcard_not_allowed", "*.example.com"],
    ["example.com:8443", "port_not_allowed", "example.com:8443"],
    ["10.0.0.1", "ip_not_allowed", "10.0.0.1"],
    ["::1", "ipv6_not_allowed", "::1"],
    ["exa mple", "invalid_host", null],
    ["*.co.uk", "public_suffix_wildcard", "*.co.uk"],
  ];

  it.each(TABLE)("%s → %s", (entry, code, echoed) => {
    const { errors } = classifyDomain([entry]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code, entry: echoed, index: 0 });
    expect(errors[0]?.message).toMatch(/\S/);
  });

  it("never echoes an entry that may carry a secret, in the entry or the message", () => {
    for (const secret of [
      "exa mple",
      "https://user:s3cr3t@example.com",
      "host:s3cr3ttoken",
      "abc123token",
    ]) {
      const [error] = classifyDomain([secret]).errors;
      expect(error?.entry).toBeNull();
      expect(error?.index).toBe(0);
      expect(error?.message).not.toContain("s3cr3t");
      expect(error?.message).not.toContain(secret);
    }
  });

  it("returns every bad entry at once, indexed into the canonical list", () => {
    const result = classifyDomain([
      "  API.Example.com ",
      "",
      "*.example.com",
      "api.example.com", // duplicate after canonicalization: dropped
      "exa mple",
      "ok.example.com",
      "10.0.0.1",
    ]);
    expect(result.entries).toEqual([
      "api.example.com",
      "*.example.com",
      "exa mple",
      "ok.example.com",
      "10.0.0.1",
    ]);
    expect(result.errors.map((e) => [e.code, e.index])).toEqual([
      ["wildcard_not_allowed", 1],
      ["invalid_host", 2],
      ["ip_not_allowed", 4],
    ]);
  });

  it("refuses what the cell accepts and the box does not (a trailing dot)", () => {
    const [error] = classifyDomain(["example.com."]).errors;
    expect(error).toMatchObject({
      code: "invalid_host",
      entry: "example.com.",
      index: 0,
    });
    expect(error?.message).toMatch(/Invalid egress allowlist entry/);
  });

  it("accepts exact hosts, :443 included", () => {
    expect(
      classifyDomain(["api.example.com", "pkg.example.com:443"]).errors,
    ).toEqual([]);
  });

  it("ip_port → one level_unsupported_in_cell, set-level", () => {
    const result = classifyEgressEntries({
      level: "ip_port",
      entries: ["10.0.0.1:5432"],
      registries: null,
    });
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "level_unsupported_in_cell",
        entry: null,
        index: null,
      }),
    ]);
  });

  it("classifies entries under null and none too (nothing a cell cannot use is stored)", () => {
    for (const level of [null, "none"] as const) {
      const { errors } = classifyEgressEntries({
        level,
        entries: ["*.example.com"],
        registries: null,
      });
      expect(errors.map((e) => e.code)).toEqual(["wildcard_not_allowed"]);
    }
  });
});

describe("classifyEgressEntries: the cap counts the rendered list (dedupe-aware)", () => {
  const ownBudget = CELL_EGRESS_MAX_ENTRIES - PLATFORM_HOSTS; // 98

  it(`${ownBudget} distinct repo hosts fit; budget.used is the compiled count`, () => {
    const result = classifyDomain(hosts(ownBudget));
    expect(result.errors).toEqual([]);
    expect(result.budget).toEqual({ used: 100, max: CELL_EGRESS_MAX_ENTRIES });
  });

  it(`${ownBudget + 1} distinct non-platform hosts → too_many_entries`, () => {
    const result = classifyDomain(hosts(ownBudget + 1));
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "too_many_entries",
        entry: null,
        index: null,
      }),
    ]);
    expect(result.errors[0]?.message).toMatch(/101 rendered entries/);
    expect(result.budget).toEqual({ used: 101, max: CELL_EGRESS_MAX_ENTRIES });
  });

  it("101 hosts → too_many_entries", () => {
    expect(classifyDomain(hosts(101)).errors.map((e) => e.code)).toEqual([
      "too_many_entries",
    ]);
  });

  it("duplicates, :443 forms and platform hosts do not count twice", () => {
    const list = [
      ...hosts(ownBudget),
      ...hosts(ownBudget).map((h) => h.toUpperCase()),
      ...hosts(10).map((h) => `${h}:443`),
      "api.anthropic.com",
      BROKER,
    ];
    const result = classifyDomain(list);
    expect(result.errors).toEqual([]);
    expect(result.budget.used).toBe(CELL_EGRESS_MAX_ENTRIES);
  });

  it(`registries count: ${ownBudget - REGISTRIES_HOSTS} fit, one more is refused`, () => {
    const fit = ownBudget - REGISTRIES_HOSTS; // 81
    expect(classifyDomain(hosts(fit), true).errors).toEqual([]);
    expect(classifyDomain(hosts(fit), true).budget.used).toBe(100);
    expect(
      classifyDomain(hosts(fit + 1), true).errors.map((e) => e.code),
    ).toEqual(["too_many_entries"]);
    expect(
      classifyDomain([...hosts(fit), "registry.npmjs.org"], true).errors,
    ).toEqual([]);
  });

  it("registries are not counted under none (the level ignores them)", () => {
    const result = classifyEgressEntries({
      level: "none",
      entries: hosts(ownBudget),
      registries: true,
      brokerHost: BROKER,
    });
    expect(result.errors).toEqual([]);
    expect(result.budget.used).toBe(100);
  });
});

describe("classifyEgressEntries: parity with the box and the cell", () => {
  const PROBES = [
    ...Object.values(CATALOG).flatMap((b) => b.allow ?? []),
    BROKER,
    "api.example.com",
    "pkg.example.com:443",
    "example.com.",
    "*.example.com",
    "*.amazonaws.com",
    "example.com:8443",
    "example.com:0",
    "10.0.0.1",
    "10.0.0.1:443",
    "::1",
    "[::1]:443",
    "exa mple",
    "*.co.uk",
    "*.github.io",
    "https://example.com",
    "user@example.com",
    "localhost",
    "-bad.example.com",
    "example.com:",
    "xn--bcher-kva.example",
  ];

  it.each(PROBES)("%s", (entry) => {
    const accepted = classifyDomain([entry]).errors.length === 0;
    const row = { egressPolicy: "domain", egressAllowlist: [entry] };
    let boxOk = true;
    try {
      buildEgressPolicyShape(row, { systemHosts: [] });
    } catch {
      boxOk = false;
    }
    const cellOk = [false, true].map(
      (registries) =>
        planCellEgressForRepo({
          repoFullName: "acme/widgets",
          row: { ...row, cellEgressRegistries: registries },
          brokerHost: BROKER,
        }).ok,
    );
    if (accepted) {
      expect(boxOk).toBe(true);
      expect(cellOk).toEqual([true, true]);
    } else {
      expect(boxOk && cellOk.every(Boolean)).toBe(false);
    }
  });
});

describe("detectMultiTenantUploadHost", () => {
  it.each([
    "storage.googleapis.com",
    "storage.googleapis.com:443",
    "my-bucket.storage.googleapis.com",
    "s3.amazonaws.com",
    "s3.us-east-1.amazonaws.com",
    "s3-us-west-2.amazonaws.com",
    "my-bucket.s3.amazonaws.com",
    "my-bucket.s3.eu-central-1.amazonaws.com",
    "s3.dualstack.us-east-1.amazonaws.com",
    "s3-accelerate.amazonaws.com",
    "*.amazonaws.com",
    "*.s3.amazonaws.com",
    "S3.AMAZONAWS.COM.",
  ])("%s is multi-tenant", (entry) => {
    expect(detectMultiTenantUploadHost(entry)).toBe(true);
  });

  it.each([
    "api.example.com",
    "googleapis.com",
    "oauth2.googleapis.com",
    "sts.amazonaws.com",
    "ec2.us-east-1.amazonaws.com",
    "s3.example.com",
    "*.co.uk",
    "exa mple",
  ])("%s is not", (entry) => {
    expect(detectMultiTenantUploadHost(entry)).toBe(false);
  });
});

describe("egressWarnings", () => {
  const codes = (w: EgressWarning[]) => w.map((x) => [x.code, x.entry]);

  it("multi_tenant_upload_host per entry, then domain_governs_box", () => {
    expect(
      codes(
        egressWarnings({
          level: "domain",
          entries: [
            "storage.googleapis.com",
            "api.example.com",
            "s3.us-east-1.amazonaws.com",
          ],
          registries: false,
        }),
      ),
    ).toEqual([
      ["multi_tenant_upload_host", "storage.googleapis.com"],
      ["multi_tenant_upload_host", "s3.us-east-1.amazonaws.com"],
      ["domain_governs_box", null],
    ]);
  });

  it("no_policy_box_open when the level is null", () => {
    expect(
      codes(egressWarnings({ level: null, entries: [], registries: null })),
    ).toEqual([["no_policy_box_open", null]]);
  });

  it("registries_ignored when registries is on under none", () => {
    expect(
      codes(egressWarnings({ level: "none", entries: [], registries: true })),
    ).toEqual([["registries_ignored", null]]);
    expect(
      egressWarnings({ level: "none", entries: [], registries: false }),
    ).toEqual([]);
  });

  it("cell_refuses_wildcard / cell_refuses_port for a legacy-stored domain list", () => {
    expect(
      codes(
        egressWarnings({
          level: "domain",
          entries: ["*.example.com", "example.com:8443", "ok.example.com"],
          registries: null,
        }),
      ),
    ).toEqual([
      ["domain_governs_box", null],
      ["cell_refuses_wildcard", "*.example.com"],
      ["cell_refuses_port", "example.com:8443"],
    ]);
    // A cell does not read the list at other levels.
    expect(
      codes(
        egressWarnings({
          level: null,
          entries: ["*.example.com"],
          registries: null,
        }),
      ),
    ).toEqual([["no_policy_box_open", null]]);
  });

  it("every warning code is reachable", () => {
    const seen = new Set<string>(
      [
        egressWarnings({
          level: "domain",
          entries: ["storage.googleapis.com", "*.x.example", "x.example:8443"],
          registries: null,
        }),
        egressWarnings({ level: null, entries: [], registries: null }),
        egressWarnings({ level: "none", entries: [], registries: true }),
      ]
        .flat()
        .map((w) => w.code),
    );
    expect([...seen].sort()).toEqual([...EGRESS_WARNING_CODES].sort());
  });
});
