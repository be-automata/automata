import { describe, expect, it } from "vitest";

import {
  CELL_EGRESS_MAX_ENTRIES,
  CellEgressError,
  cellEgressKey,
  compileCellEgress,
  toAgent37Network,
  toOpenSandboxNetworkPolicy,
  toProxyShape,
  type CellEgressCatalog,
  type CellEgressErrorCode,
  type CellEgressSet,
} from "./cell-egress";
import { BROKER, CATALOG } from "./__fixtures__/cell-egress";

function codeOf(fn: () => unknown): CellEgressErrorCode | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof CellEgressError ? e.code : undefined;
  }
  return undefined;
}

function compile(
  refs: string[],
  extra: {
    catalog?: CellEgressCatalog;
    narrowTo?: string[];
    brokerHost?: string;
  } = {},
): CellEgressSet {
  return compileCellEgress(refs, {
    brokerHost: extra.brokerHost ?? BROKER,
    catalog: extra.catalog ?? CATALOG,
    narrowTo: extra.narrowTo,
  });
}

describe("compileCellEgress", () => {
  it("AC1: no refs yields exactly the platform entries", () => {
    const set = compileCellEgress([], { brokerHost: BROKER });
    expect(set.entries.map(cellEgressKey)).toEqual([
      "api.anthropic.com",
      BROKER,
    ]);
    expect(set.bundles).toEqual(["automata/platform@1"]);
    expect(set.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AC1: digest is stable under ref reordering", () => {
    const a = compile(["test/npm@1", "test/wild@1"]);
    const b = compile(["test/wild@1", "test/npm@1"]);
    expect(a.digest).toBe(b.digest);
    expect(a.entries).toEqual(b.entries);
  });

  it("changes the digest when one bundle version changes", () => {
    const v1 = compile(["test/npm@1"]);
    const v2 = compile(["test/npm@2"], {
      catalog: {
        "test/npm@2": { id: "test/npm@2", allow: ["registry.npmjs.org"] },
      },
    });
    expect(v1.entries).toEqual(v2.entries);
    expect(v1.digest).not.toBe(v2.digest);
  });

  it("follows extends and visits a shared parent once", () => {
    const catalog: CellEgressCatalog = {
      "t/base@1": { id: "t/base@1", allow: ["base.example.com"] },
      "t/a@1": { id: "t/a@1", extends: ["t/base@1"], allow: ["a.example.com"] },
      "t/b@1": { id: "t/b@1", extends: ["t/base@1"], allow: ["b.example.com"] },
    };
    const set = compile(["t/a@1", "t/b@1"], { catalog });
    expect(set.bundles).toEqual([
      "automata/platform@1",
      "t/a@1",
      "t/b@1",
      "t/base@1",
    ]);
  });

  it("AC2: deny wins over an equal wildcard allow and drops the entry", () => {
    const catalog: CellEgressCatalog = {
      ...CATALOG,
      "test/deny@1": { id: "test/deny@1", deny: ["*.github.com"] },
    };
    const set = compile(["test/gh@1", "test/deny@1"], { catalog });
    expect(set.entries.map(cellEgressKey)).toEqual([
      "api.anthropic.com",
      BROKER,
    ]);
  });

  it("AC2: a deny inside an allowed wildcard is inexpressible", () => {
    const catalog: CellEgressCatalog = {
      ...CATALOG,
      "test/deny@1": { id: "test/deny@1", deny: ["admin.example.org"] },
    };
    expect(() => compile(["test/wild@1", "test/deny@1"], { catalog })).toThrow(
      "inexpressible: deny 'admin.example.org' inside allowed '*.example.org'",
    );
    expect(
      codeOf(() => compile(["test/wild@1", "test/deny@1"], { catalog })),
    ).toBe("inexpressible");
  });

  it("AC3: a template entry that is not already allowed widens", () => {
    expect(() =>
      compile(["test/npm@1"], { narrowTo: ["evil.example.com"] }),
    ).toThrow(
      "template widens: 'evil.example.com' is not allowed by its bundles",
    );
    expect(
      codeOf(() => compile(["test/npm@1"], { narrowTo: ["evil.example.com"] })),
    ).toBe("template_widens");
  });

  it("a template only narrows: platform plus the chosen entries", () => {
    const set = compile(["test/npm@1", "test/wild@1"], {
      narrowTo: ["registry.npmjs.org", "a.example.org"],
    });
    expect(set.entries.map(cellEgressKey)).toEqual([
      "a.example.org",
      "api.anthropic.com",
      BROKER,
      "registry.npmjs.org",
    ]);
  });

  it("AC3: more than 100 entries throws too_many_entries", () => {
    const allow = Array.from(
      { length: CELL_EGRESS_MAX_ENTRIES + 1 },
      (_, i) => `h${i}.example.com`,
    );
    const catalog: CellEgressCatalog = { "t/big@1": { id: "t/big@1", allow } };
    expect(codeOf(() => compile(["t/big@1"], { catalog }))).toBe(
      "too_many_entries",
    );
  });

  it("counts the rendered list: a wildcard also costs its apex", () => {
    const allow = Array.from({ length: 50 }, (_, i) => `*.w${i}.example.com`);
    const catalog: CellEgressCatalog = { "t/big@1": { id: "t/big@1", allow } };
    expect(codeOf(() => compile(["t/big@1"], { catalog }))).toBe(
      "too_many_entries",
    );
  });

  it.each<[string, string, CellEgressErrorCode]>([
    ["an IPv4 literal", "104.16.0.1", "ip_literal"],
    ["a wildcard over an IPv4 literal", "*.10.0.0.1", "ip_literal"],
    ["an out-of-range dotted number", "999.1.1.1", "ip_literal"],
    ["a five-label numeric host", "1.2.3.4.5", "ip_literal"],
    ["an IPv6 literal", "2001:db8::1", "ipv6"],
    ["a bracketed IPv6 literal", "[::1]", "ipv6"],
    [
      "a multi-colon entry that is not IPv6",
      "host.example.com:user:token",
      "ipv6",
    ],
    ["a :80 pin", "host.example.com:80", "port_not_443"],
    ["a non-numeric port", "host.example.com:web", "port_not_443"],
    ["a trailing colon with no port", "host.example.com:", "invalid_host"],
    ["a bare star", "*", "invalid_host"],
    ["a TLD wildcard", "*.com", "invalid_host"],
    [
      "a wildcard over a two-label public suffix",
      "*.co.uk",
      "public_suffix_wildcard",
    ],
    [
      "a wildcard over a private public suffix",
      "*.github.io",
      "public_suffix_wildcard",
    ],
    ["an empty string", "", "invalid_host"],
    ["a single label", "localhost", "invalid_host"],
    ["a star inside the name", "a.*.example.com", "invalid_host"],
    ["a double star", "**.example.com", "invalid_host"],
    ["an empty label", "a..example.com", "invalid_host"],
    ["a non-punycode IDN", "bücher.example", "invalid_host"],
    ["a Kelvin sign that lowercases to k", "Key.example.com", "invalid_host"],
    ["a URL", "https://registry.npmjs.org/", "invalid_host"],
  ])("rejects %s", (_name, entry, code) => {
    const catalog: CellEgressCatalog = {
      "t/bad@1": { id: "t/bad@1", allow: [entry] },
    };
    expect(codeOf(() => compile(["t/bad@1"], { catalog }))).toBe(code);
  });

  it("allows a wildcard over a registrable domain", () => {
    const catalog: CellEgressCatalog = {
      "t/ok@1": { id: "t/ok@1", allow: ["*.github.com", "*.example.com"] },
    };
    const keys = compile(["t/ok@1"], { catalog }).entries.map(cellEgressKey);
    expect(keys).toContain("*.github.com");
    expect(keys).toContain("*.example.com");
  });

  it("never echoes an entry that carries credentials", () => {
    const catalog: CellEgressCatalog = {
      "t/cred@1": {
        id: "t/cred@1",
        allow: ["user:s3cret-token@host.example.com"],
      },
    };
    let caught: unknown;
    try {
      compile(["t/cred@1"], { catalog });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CellEgressError);
    const err = caught as CellEgressError;
    expect(err.code).toBe("invalid_host");
    expect(err.message).not.toContain("s3cret-token");
    expect(err.entry).toBeUndefined();
  });

  it("accepts host:443 and stores it as the bare host", () => {
    const catalog: CellEgressCatalog = {
      "t/pin@1": { id: "t/pin@1", allow: ["Pinned.Example.com.:443"] },
    };
    const set = compile(["t/pin@1"], { catalog });
    expect(set.entries.map(cellEgressKey)).toContain("pinned.example.com");
  });

  it("refuses a broker host with a port or an IP", () => {
    expect(codeOf(() => compile([], { brokerHost: "localhost:3000" }))).toBe(
      "port_not_443",
    );
    expect(codeOf(() => compile([], { brokerHost: "10.0.0.5" }))).toBe(
      "ip_literal",
    );
  });

  it("raises unknown_bundle for a ref outside the catalog", () => {
    expect(codeOf(() => compile(["nope/x@1"]))).toBe("unknown_bundle");
  });

  it("raises extends_cycle on a loop", () => {
    const catalog: CellEgressCatalog = {
      "t/a@1": { id: "t/a@1", extends: ["t/b@1"] },
      "t/b@1": { id: "t/b@1", extends: ["t/a@1"] },
    };
    expect(codeOf(() => compile(["t/a@1"], { catalog }))).toBe("extends_cycle");
  });

  it("raises platform_override when the catalog redefines the platform", () => {
    const catalog: CellEgressCatalog = {
      "automata/platform@1": {
        id: "automata/platform@1",
        allow: ["other.example.com"],
      },
    };
    expect(codeOf(() => compile([], { catalog }))).toBe("platform_override");
  });

  it("raises bundle_id_mismatch when a catalog key and its bundle id differ", () => {
    const catalog: CellEgressCatalog = {
      "t/a@1": { id: "t/b@1", allow: ["a.example.com"] },
    };
    expect(codeOf(() => compile([], { catalog }))).toBe("bundle_id_mismatch");
  });

  it("does not echo a non-numeric port", () => {
    try {
      compile([], { narrowTo: ["host.example.com:hunter2"] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CellEgressError);
      const err = e as CellEgressError;
      expect(err.code).toBe("port_not_443");
      expect(err.entry).toBeUndefined();
      expect(err.message).not.toContain("hunter2");
      expect(JSON.stringify(err)).not.toContain("hunter2");
    }
  });

  it.each([
    ["a bare token", "abc123token", "invalid_host"],
    ["a numeric port on a non-domain host", "user:12345", "port_not_443"],
  ])("does not echo %s", (_label, raw, code) => {
    try {
      compile([], { narrowTo: [raw] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CellEgressError);
      const err = e as CellEgressError;
      expect(err.code).toBe(code);
      expect(err.entry).toBeUndefined();
      expect(err.message).not.toContain(raw);
    }
  });

  it("does not echo an all-hex multi-colon entry that is not an IPv6 address", () => {
    try {
      compile([], { narrowTo: ["deadbeef:cafe:0123abcd"] });
      expect.unreachable();
    } catch (e) {
      const err = e as CellEgressError;
      expect(err.code).toBe("ipv6");
      expect(err.entry).toBeUndefined();
      expect(err.message).not.toContain("deadbeef");
    }
  });

  it("still echoes a real IPv6 literal", () => {
    try {
      compile([], { narrowTo: ["[2001:db8::1]"] });
      expect.unreachable();
    } catch (e) {
      expect((e as CellEgressError).entry).toBe("[2001:db8::1]");
    }
  });

  it("does not echo a multi-colon entry that is not an IPv6 literal", () => {
    try {
      compile([], { narrowTo: ["host.example.com:user:s3cret"] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CellEgressError);
      const err = e as CellEgressError;
      expect(err.code).toBe("ipv6");
      expect(err.entry).toBeUndefined();
      expect(JSON.stringify(err) + err.message).not.toContain("s3cret");
    }
  });

  it("raises platform_denied when a deny covers a platform entry", () => {
    const catalog: CellEgressCatalog = {
      "t/deny@1": { id: "t/deny@1", deny: ["*.anthropic.com"] },
    };
    expect(codeOf(() => compile(["t/deny@1"], { catalog }))).toBe(
      "platform_denied",
    );
  });
});

describe("renderers", () => {
  const set = compile(["test/npm@1", "test/wild@1"]);

  it("AC4: toAgent37Network is an allowlist of the keys plus each wildcard apex", () => {
    const network = toAgent37Network(set);
    expect(network).not.toBe("allow-all");
    expect(network.allow).toEqual([
      "*.example.org",
      "example.org",
      "api.anthropic.com",
      BROKER,
      "registry.npmjs.org",
    ]);
    const keys = new Set(set.entries.map(cellEgressKey));
    for (const host of network.allow) {
      const apex = keys.has(`*.${host}`);
      expect(keys.has(host) || apex).toBe(true);
    }
  });

  it("AC4: toAgent37Network throws on an empty or over-cap set", () => {
    const empty: CellEgressSet = { entries: [], bundles: [], digest: "x" };
    expect(codeOf(() => toAgent37Network(empty))).toBe("empty_set");
    const big: CellEgressSet = {
      entries: Array.from({ length: CELL_EGRESS_MAX_ENTRIES + 1 }, (_, i) => ({
        name: `h${i}.example.com`,
        wildcard: false,
      })),
      bundles: [],
      digest: "x",
    };
    expect(codeOf(() => toAgent37Network(big))).toBe("too_many_entries");
  });

  it("toProxyShape pins :443, a wildcard also emits its apex", () => {
    const shape = toProxyShape({
      entries: [
        { name: "example.org", wildcard: true },
        { name: "registry.npmjs.org", wildcard: false },
      ],
      bundles: [],
      digest: "x",
    });
    expect(shape).toEqual({
      level: "domain",
      allowlist: [
        "*.example.org:443",
        "example.org:443",
        "registry.npmjs.org:443",
      ],
    });
  });

  it("toProxyShape throws on an empty set", () => {
    expect(
      codeOf(() => toProxyShape({ entries: [], bundles: [], digest: "x" })),
    ).toBe("empty_set");
  });

  it("toOpenSandboxNetworkPolicy: default deny, allow per name, trailing port-80 deny", () => {
    const policy = toOpenSandboxNetworkPolicy(set);
    expect(policy.defaultAction).toBe("deny");
    expect(policy.egress.slice(0, -1)).toEqual(
      toAgent37Network(set).allow.map((target) => ({
        action: "allow",
        target,
      })),
    );
    expect(policy.egress.at(-1)).toEqual({ action: "deny", ports: [80] });
  });

  it("toOpenSandboxNetworkPolicy throws on an empty or over-cap set", () => {
    const empty: CellEgressSet = { entries: [], bundles: [], digest: "x" };
    expect(codeOf(() => toOpenSandboxNetworkPolicy(empty))).toBe("empty_set");
    const big: CellEgressSet = {
      entries: Array.from({ length: CELL_EGRESS_MAX_ENTRIES + 1 }, (_, i) => ({
        name: `h${i}.example.com`,
        wildcard: false,
      })),
      bundles: [],
      digest: "x",
    };
    expect(codeOf(() => toOpenSandboxNetworkPolicy(big))).toBe(
      "too_many_entries",
    );
  });
});
