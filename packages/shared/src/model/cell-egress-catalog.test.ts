import { describe, expect, it } from "vitest";

import {
  CELL_EGRESS_MAX_ENTRIES,
  CELL_EGRESS_MODEL_HOST,
  CELL_EGRESS_PLATFORM_BUNDLE,
  CellEgressError,
  cellEgressKey,
  compileCellEgress,
  toOpenSandboxNetworkPolicy,
  type CellEgressCatalog,
} from "./cell-egress";
import {
  CELL_EGRESS_CATALOG,
  CELL_EGRESS_REGISTRIES_BUNDLE,
  CellEgressLevelUnsupportedError,
  cellEgressForRepo,
  planCellEgressForRepo,
  repoCellEgressBundle,
  type CellEgressRepoFields,
} from "./cell-egress-catalog";

const BROKER = "app.example.test";
const REPO = "Acme/Widgets";

function row(over: Partial<CellEgressRepoFields> = {}): CellEgressRepoFields {
  return {
    egressPolicy: null,
    egressAllowlist: null,
    cellEgressRegistries: null,
    ...over,
  };
}

function compileFor(r: CellEgressRepoFields | undefined) {
  const { refs, catalog } = cellEgressForRepo({ repoFullName: REPO, row: r });
  return compileCellEgress(refs, { brokerHost: BROKER, catalog });
}

const keys = (set: ReturnType<typeof compileFor>) =>
  set.entries.map(cellEgressKey);

describe("CELL_EGRESS_CATALOG", () => {
  it("every key is its bundle's id and none overrides the platform", () => {
    for (const [key, bundle] of Object.entries(CELL_EGRESS_CATALOG)) {
      expect(bundle.id).toBe(key);
      expect(key).not.toBe(CELL_EGRESS_PLATFORM_BUNDLE);
    }
  });

  it("the registries bundle is exact hosts only and renders under the cap with the platform set", () => {
    const set = compileCellEgress([CELL_EGRESS_REGISTRIES_BUNDLE], {
      brokerHost: BROKER,
      catalog: CELL_EGRESS_CATALOG,
    });
    expect(set.entries.some((e) => e.wildcard)).toBe(false);
    expect(set.bundles).toEqual([
      CELL_EGRESS_PLATFORM_BUNDLE,
      CELL_EGRESS_REGISTRIES_BUNDLE,
    ]);
    const policy = toOpenSandboxNetworkPolicy(set);
    // One allow per host plus the trailing :80 deny.
    expect(policy.egress.length - 1).toBeLessThanOrEqual(
      CELL_EGRESS_MAX_ENTRIES,
    );
    for (const host of [
      "registry.npmjs.org",
      "pypi.org",
      "files.pythonhosted.org",
      "pub.dev",
      "repo.maven.apache.org",
      "plugins.gradle.org",
      "crates.io",
      "proxy.golang.org",
    ]) {
      expect(keys(set)).toContain(host);
    }
  });
});

describe("repoCellEgressBundle", () => {
  it("is content-addressed: order-insensitive, stable, and a new id for new entries", () => {
    const a = repoCellEgressBundle(REPO, ["b.example.com", "a.example.com"]);
    const b = repoCellEgressBundle("acme/widgets", [
      "a.example.com",
      "b.example.com",
    ]);
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^repo\/acme__widgets@[0-9a-f]{16}$/);
    expect(repoCellEgressBundle(REPO, ["c.example.com"]).id).not.toBe(a.id);
  });
});

describe("cellEgressForRepo", () => {
  it("no row, a null policy and `none` all compile to the platform set only", () => {
    for (const r of [
      undefined,
      row(),
      row({ egressPolicy: "none", egressAllowlist: ["example.com"] }),
    ]) {
      const set = compileFor(r);
      expect(set.bundles).toEqual([CELL_EGRESS_PLATFORM_BUNDLE]);
      expect(keys(set)).toEqual([CELL_EGRESS_MODEL_HOST, BROKER].sort());
    }
  });

  it("`domain`: the operator entries become one per-run bundle and compile with the platform", () => {
    const r = row({
      egressPolicy: "domain",
      egressAllowlist: [" Example.COM "],
    });
    const { refs, level } = cellEgressForRepo({ repoFullName: REPO, row: r });
    expect(level).toBe("domain");
    expect(refs).toEqual([repoCellEgressBundle(REPO, ["example.com"]).id]);
    const set = compileFor(r);
    expect(keys(set)).toEqual(
      [BROKER, CELL_EGRESS_MODEL_HOST, "example.com"].sort(),
    );
    expect(set.bundles).toContain(refs[0]);
  });

  it("`domain` with an empty allowlist adds no repo bundle", () => {
    const r = row({ egressPolicy: "domain", egressAllowlist: [] });
    expect(cellEgressForRepo({ repoFullName: REPO, row: r }).refs).toEqual([]);
  });

  it("the registries opt-in adds the registries ref with no policy or a domain policy", () => {
    for (const r of [
      row({ cellEgressRegistries: true }),
      row({
        egressPolicy: "domain",
        egressAllowlist: ["example.com"],
        cellEgressRegistries: true,
      }),
    ]) {
      expect(cellEgressForRepo({ repoFullName: REPO, row: r }).refs).toContain(
        CELL_EGRESS_REGISTRIES_BUNDLE,
      );
      expect(keys(compileFor(r))).toContain("registry.npmjs.org");
    }
    expect(
      cellEgressForRepo({
        repoFullName: REPO,
        row: row({ cellEgressRegistries: false }),
      }).refs,
    ).toEqual([]);
  });

  it("`none` ignores the registries opt-in: a cell never reaches more than its box", () => {
    const r = row({ egressPolicy: "none", cellEgressRegistries: true });
    expect(cellEgressForRepo({ repoFullName: REPO, row: r }).refs).toEqual([]);
    expect(compileFor(r).bundles).toEqual([CELL_EGRESS_PLATFORM_BUNDLE]);
  });

  it("OD-1: `ip_port` is refused with the level", () => {
    const r = row({ egressPolicy: "ip_port", egressAllowlist: ["10.0.0.5"] });
    expect(() => cellEgressForRepo({ repoFullName: REPO, row: r })).toThrow(
      CellEgressLevelUnsupportedError,
    );
  });

  it("an invalid stored policy is `invalid_policy` and the entry is never echoed", () => {
    const r = row({
      egressPolicy: "domain",
      egressAllowlist: ["user:secret-token@host"],
    });
    let caught: unknown;
    try {
      cellEgressForRepo({ repoFullName: REPO, row: r });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CellEgressError);
    expect((caught as CellEgressError).code).toBe("invalid_policy");
    expect((caught as CellEgressError).message).not.toContain("secret-token");
  });

  it("a repo entry the cell cannot express (a non-443 port) refuses at compile", () => {
    const r = row({
      egressPolicy: "domain",
      egressAllowlist: ["example.com:8443"],
    });
    expect(() => compileFor(r)).toThrow(CellEgressError);
  });

  it("an allowlist over the cap refuses with too_many_entries", () => {
    const entries = Array.from(
      { length: CELL_EGRESS_MAX_ENTRIES - 1 },
      (_, i) => `h${i}.example.com`,
    );
    const r = row({ egressPolicy: "domain", egressAllowlist: entries });
    let code: string | undefined;
    try {
      compileFor(r);
    } catch (error) {
      code = error instanceof CellEgressError ? error.code : undefined;
    }
    expect(code).toBe("too_many_entries");
  });

  it("deny wins over a repo allow and a registries allow", () => {
    const r = row({
      egressPolicy: "domain",
      egressAllowlist: ["example.com", "keep.example.org"],
      cellEgressRegistries: true,
    });
    const { refs, catalog } = cellEgressForRepo({ repoFullName: REPO, row: r });
    const withDeny: CellEgressCatalog = {
      ...catalog,
      "test/deny@1": {
        id: "test/deny@1",
        deny: ["example.com", "registry.npmjs.org"],
      },
    };
    const set = compileCellEgress([...refs, "test/deny@1"], {
      brokerHost: BROKER,
      catalog: withDeny,
    });
    expect(keys(set)).not.toContain("example.com");
    expect(keys(set)).not.toContain("registry.npmjs.org");
    expect(keys(set)).toContain("keep.example.org");
    expect(keys(set)).toContain("pypi.org");
  });

  it("pins the registries policy the sandbox IT case creates (#705 OPENSANDBOX_IT)", () => {
    // opensandbox-cell.integration.test.ts uses this exact literal.
    const { refs, catalog } = cellEgressForRepo({
      repoFullName: REPO,
      row: row({ cellEgressRegistries: true }),
    });
    const set = compileCellEgress(refs, { brokerHost: "osbit.test", catalog });
    expect(toOpenSandboxNetworkPolicy(set)).toEqual({
      defaultAction: "deny",
      egress: [
        ...[
          "api.anthropic.com",
          "crates.io",
          "downloads.gradle.org",
          "files.pythonhosted.org",
          "index.crates.io",
          "osbit.test",
          "plugins-artifacts.gradle.org",
          "plugins.gradle.org",
          "proxy.golang.org",
          "pub.dartlang.org",
          "pub.dev",
          "pypi.org",
          "registry.npmjs.org",
          "registry.yarnpkg.com",
          "repo.maven.apache.org",
          "repo1.maven.org",
          "services.gradle.org",
          "static.crates.io",
          "sum.golang.org",
        ].map((target) => ({ action: "allow", target })),
        { action: "deny", ports: [80] },
      ],
    });
  });

  it("pins the OpenSandbox policy the sandbox IT case creates (#705 OPENSANDBOX_IT)", () => {
    // opensandbox-cell.integration.test.ts cannot import shared: its
    // "compiled repo set" case uses this exact literal.
    const { refs, catalog } = cellEgressForRepo({
      repoFullName: REPO,
      row: row({ egressPolicy: "domain", egressAllowlist: ["httpbin.org"] }),
    });
    const set = compileCellEgress(refs, { brokerHost: "osbit.test", catalog });
    expect(toOpenSandboxNetworkPolicy(set)).toEqual({
      defaultAction: "deny",
      egress: [
        { action: "allow", target: "api.anthropic.com" },
        { action: "allow", target: "httpbin.org" },
        { action: "allow", target: "osbit.test" },
        { action: "deny", ports: [80] },
      ],
    });
  });
});

describe("planCellEgressForRepo", () => {
  const plan = (r: CellEgressRepoFields | undefined) =>
    planCellEgressForRepo({ repoFullName: REPO, row: r, brokerHost: BROKER });

  it("ok: the compiled set and its refs", () => {
    const r = row({ egressPolicy: "domain", egressAllowlist: ["example.com"] });
    const result = plan(r);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.level).toBe("domain");
    expect(result.set.digest).toBe(compileFor(r).digest);
  });

  it.each<[string, CellEgressRepoFields, string, string | undefined]>([
    [
      "ip_port",
      row({ egressPolicy: "ip_port", egressAllowlist: ["10.0.0.5"] }),
      "egress_level_unsupported",
      undefined,
    ],
    [
      "a wildcard",
      row({ egressPolicy: "domain", egressAllowlist: ["*.example.com"] }),
      "egress_compile_failed",
      "egress_wildcard",
    ],
    [
      "a non-443 port",
      row({ egressPolicy: "domain", egressAllowlist: ["example.com:8443"] }),
      "egress_compile_failed",
      "port_not_443",
    ],
    [
      "an invalid stored policy",
      row({ egressPolicy: "bogus" }),
      "egress_compile_failed",
      "invalid_policy",
    ],
  ])("refuses %s", (_name, r, code, reason) => {
    expect(plan(r)).toEqual(
      reason === undefined ? { ok: false, code } : { ok: false, code, reason },
    );
  });
});
