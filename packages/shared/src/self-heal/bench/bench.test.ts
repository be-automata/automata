import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AUDIT_RULES, MAX_FINDINGS_PER_RUN } from "../audit-rules";
import {
  findManifestError,
  parseFixtureManifest,
  seedId,
  selectSeeds,
  type FixtureManifest,
} from "./fixture-manifest";
import { renderFixture, type RenderedFixture } from "./render-fixture";
import {
  BENCH_FAKE_MARKER,
  BENCH_GITIGNORE_PATTERNS,
  BENCH_SHARD_PLAN,
  SEED_CATALOG,
} from "./seed-catalog";

/** sha256 over the sorted file map: path NUL content NUL, repo then hidden. */
function fixtureDigest(fixture: RenderedFixture): string {
  const hash = createHash("sha256");
  for (const [label, files] of [
    ["repo", fixture.repoFiles],
    ["hidden", fixture.hiddenTests],
  ] as const) {
    hash.update(`${label}\u0000`);
    for (const path of Object.keys(files).sort()) {
      hash.update(`${path}\u0000${files[path]}\u0000`);
    }
  }
  return hash.digest("hex");
}

/** Pinned: any change to the catalog or the templates must update this. */
const GOLDEN_SHA256 =
  "baf63c7f0e677c7df7b98c2058fb603cab73f40981bd87e8d5499afb37101424";

const SCRIPT_RULES = AUDIT_RULES.filter((r) => r.checkKind === "script");

/** Real credential shapes; the fixture must never contain one. */
const REAL_TOKEN_SHAPES: readonly RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/,
  /gh[ousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /ASIA[0-9A-Z]{16}/,
  /-----BEGIN/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /sk_live_[A-Za-z0-9]{10,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /glpat-[A-Za-z0-9_-]{20,}/,
  /npm_[A-Za-z0-9]{36}/,
];

describe("seed catalog", () => {
  it("is a valid manifest", () => {
    expect(findManifestError(SEED_CATALOG)).toBeNull();
  });

  it("seeds 48 findings, 4 rubric-only and 8 decoys", () => {
    const byKind = (kind: string) =>
      SEED_CATALOG.seeds.filter((s) => s.kind === kind).length;
    expect(byKind("seeded")).toBe(48);
    expect(byKind("rubric")).toBe(4);
    expect(byKind("decoy")).toBe(8);
  });

  it("seeds every script rule at least 4 times", () => {
    for (const rule of SCRIPT_RULES) {
      const count = SEED_CATALOG.seeds.filter(
        (s) => s.kind === "seeded" && s.rule === rule.id,
      ).length;
      expect(count, rule.id).toBeGreaterThanOrEqual(4);
    }
  });

  it("uses sequential unique ids and only vocabulary rules", () => {
    const ids = SEED_CATALOG.seeds.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id, index) => {
      expect(id).toBe(seedId(index));
    });
    const ruleIds = new Set(AUDIT_RULES.map((r) => r.id));
    for (const seed of SEED_CATALOG.seeds) {
      expect(ruleIds.has(seed.rule), seed.id).toBe(true);
    }
  });

  it("names historically advised npm versions for every vulnerable dependency", () => {
    const deps = SEED_CATALOG.seeds.filter((s) => s.rule === "dep.vulnerable");
    for (const seed of deps) {
      expect(seed.params?.version, seed.id).toMatch(/^\d+\.\d+\.\d+$/);
      expect(seed.params?.advisory, seed.id).toMatch(/^CVE-\d{4}-\d+$/);
    }
    expect(
      Object.fromEntries(deps.map((s) => [s.subject, s.params?.version])),
    ).toMatchObject({
      "npm:lodash": "4.17.11",
      "npm:minimist": "1.2.0",
      "npm:node-fetch": "2.6.0",
      "npm:ansi-regex": "5.0.0",
    });
  });
});

describe("findManifestError", () => {
  const base: FixtureManifest = {
    version: 1,
    seeds: [
      {
        id: "S01",
        rule: "dep.vulnerable",
        subject: "npm:lodash",
        kind: "seeded",
        check: "npm-audit-clean",
        hiddenTest: "hidden-tests/S01.test.mjs",
      },
    ],
  };
  const withSeed = (patch: Record<string, unknown>): FixtureManifest =>
    ({
      ...base,
      seeds: [{ ...base.seeds[0], ...patch }],
    }) as FixtureManifest;

  it("accepts a minimal manifest", () => {
    expect(findManifestError(base)).toBeNull();
  });

  it("rejects an unknown rule, a check mismatch and a kind mismatch", () => {
    expect(findManifestError(withSeed({ rule: "nope" }))).toMatch(/rule/);
    expect(findManifestError(withSeed({ check: "file-exists" }))).toMatch(
      /check/,
    );
    expect(findManifestError(withSeed({ kind: "rubric" }))).toMatch(/kind/);
  });

  it("rejects bad subjects, keys and hidden test paths", () => {
    expect(findManifestError(withSeed({ subject: "lodash" }))).toMatch(
      /subject/,
    );
    expect(
      findManifestError(
        withSeed({
          rule: "supply.lockfile-missing",
          check: "file-exists",
          subject: "../x",
        }),
      ),
    ).toMatch(/subject/);
    expect(findManifestError(withSeed({ key: "*.pem" }))).toMatch(/key/);
    expect(findManifestError(withSeed({ hiddenTest: "repo/x.mjs" }))).toMatch(
      /hiddenTest/,
    );
  });

  it("accepts a shard with increasing gaps and rejects unordered or padded ids", () => {
    const [first] = base.seeds;
    if (!first) throw new Error("base manifest has no seed");
    const second = {
      ...first,
      id: "S07",
      subject: "npm:minimist",
      hiddenTest: "hidden-tests/S07.test.mjs",
    };
    expect(
      findManifestError({ version: 1, seeds: [first, second] }),
    ).toBeNull();
    expect(findManifestError({ version: 1, seeds: [second, first] })).toMatch(
      /greater/,
    );
    expect(findManifestError(withSeed({ id: "S001" }))).toMatch(/written S01/);
    expect(findManifestError(withSeed({ id: "S00" }))).toMatch(/greater/);
  });

  it("rejects a subject the findings parser would rewrite", () => {
    expect(findManifestError(withSeed({ subject: "npm:Lodash" }))).toMatch(
      /subject/,
    );
    expect(
      findManifestError(
        withSeed({
          rule: "supply.lockfile-missing",
          check: "file-exists",
          subject: "./package-lock.json",
        }),
      ),
    ).toMatch(/subject/);
  });

  it("rejects a wrong version, a bad id and duplicate identities", () => {
    const [first] = base.seeds;
    if (!first) throw new Error("base manifest has no seed");
    expect(findManifestError({ ...base, version: 2 } as never)).toMatch(
      /version/,
    );
    expect(findManifestError(withSeed({ id: "X1" }))).toMatch(/id/);
    const dup: FixtureManifest = {
      version: 1,
      seeds: [
        first,
        {
          ...first,
          id: "S02",
          hiddenTest: "hidden-tests/S02.test.mjs",
        },
      ],
    };
    expect(findManifestError(dup)).toMatch(/duplicate/);
  });
});

describe("parseFixtureManifest", () => {
  it("round-trips the catalog through JSON", () => {
    expect(
      parseFixtureManifest(JSON.parse(JSON.stringify(SEED_CATALOG))),
    ).toEqual(SEED_CATALOG);
  });

  it("rejects a malformed or invalid manifest", () => {
    expect(() => parseFixtureManifest([])).toThrow(/object/);
    expect(() => parseFixtureManifest({ version: 1 })).toThrow(/seeds/);
    expect(() =>
      parseFixtureManifest({ version: 1, seeds: [{ id: 1 }] }),
    ).toThrow(/id/);
    expect(() =>
      parseFixtureManifest({
        version: 2,
        seeds: JSON.parse(JSON.stringify(SEED_CATALOG.seeds)),
      }),
    ).toThrow(/version/);
  });
});

describe("renderFixture", () => {
  const fixture = renderFixture(SEED_CATALOG);

  it("is deterministic", () => {
    expect(renderFixture(SEED_CATALOG)).toEqual(fixture);
    expect(fixtureDigest(renderFixture(SEED_CATALOG))).toBe(
      fixtureDigest(fixture),
    );
  });

  it("matches the pinned golden digest", () => {
    expect(fixtureDigest(fixture)).toBe(GOLDEN_SHA256);
  });

  it("renders every seed's hidden test outside the repo", () => {
    for (const seed of SEED_CATALOG.seeds) {
      expect(fixture.hiddenTests[seed.hiddenTest], seed.id).toBeDefined();
    }
    for (const path of Object.keys(fixture.repoFiles)) {
      expect(path.startsWith("hidden-tests/"), path).toBe(false);
      expect(path.includes("hidden-tests"), path).toBe(false);
    }
    for (const path of Object.keys(fixture.hiddenTests)) {
      expect(path.startsWith("hidden-tests/"), path).toBe(true);
    }
  });

  it("renders the subject of every path-subject seed it creates", () => {
    const created = SEED_CATALOG.seeds.filter((s) =>
      [
        "ci.action-unpinned",
        "ci.workflow-permissions-missing",
        "files.gitignore-missing-pattern",
        "files.sensitive-committed",
        "secret.hardcoded",
      ].includes(s.rule),
    );
    for (const seed of created) {
      expect(fixture.repoFiles[seed.subject], seed.id).toBeDefined();
    }
  });

  it("leaves every file-exists subject absent", () => {
    const absent = SEED_CATALOG.seeds.filter((s) => s.check === "file-exists");
    for (const seed of absent) {
      expect(fixture.repoFiles[seed.subject], seed.id).toBeUndefined();
    }
  });

  it("renders the seeded state each script check would fail on", () => {
    for (const seed of SEED_CATALOG.seeds) {
      const text = fixture.repoFiles[seed.subject] ?? "";
      if (seed.rule === "ci.action-unpinned") {
        const line = text
          .split("\n")
          .find((l) => l.includes(`uses: ${seed.key}@`));
        expect(line, seed.id).toBeDefined();
        const pinned = /@[0-9a-f]{40}\b/.test(line ?? "");
        expect(pinned, seed.id).toBe(seed.kind === "decoy");
      }
      if (seed.rule === "ci.workflow-permissions-missing") {
        expect(/^permissions\s*:/m.test(text), seed.id).toBe(
          seed.kind === "decoy",
        );
      }
      if (seed.rule === "files.gitignore-missing-pattern") {
        const lines = (fixture.repoFiles[".gitignore"] ?? "")
          .split("\n")
          .map((l) => l.trim());
        expect(lines.includes(seed.key ?? ""), seed.id).toBe(false);
      }
      if (seed.rule === "dep.vulnerable") {
        const pkg = JSON.parse(fixture.repoFiles["package.json"] ?? "{}") as {
          dependencies?: Record<string, string>;
        };
        expect(pkg.dependencies?.[seed.subject.slice(4)], seed.id).toBe(
          seed.params?.version,
        );
      }
    }
  });

  it("contains no real token shape and marks every fake sensitive file", () => {
    const all = { ...fixture.repoFiles, ...fixture.hiddenTests };
    for (const [path, text] of Object.entries(all)) {
      for (const shape of REAL_TOKEN_SHAPES) {
        expect(shape.test(text), `${path} ${shape}`).toBe(false);
      }
    }
    const fakes = SEED_CATALOG.seeds.filter(
      (s) =>
        s.rule === "files.sensitive-committed" || s.rule === "secret.hardcoded",
    );
    for (const seed of fakes) {
      expect(fixture.repoFiles[seed.subject], seed.id).toContain(
        BENCH_FAKE_MARKER,
      );
    }
    expect(BENCH_FAKE_MARKER).toBe("BENCHMARK FAKE — not a secret");
  });

  it("scopes the fake .npmrc auth away from the public registry", () => {
    // An auth line or a default registry here would break every `npm audit`
    // the dependency seeds rely on (worker check and verify-fixes alike).
    const npmrcs = Object.entries(fixture.repoFiles).filter(
      ([path]) => path === ".npmrc" || path.endsWith("/.npmrc"),
    );
    expect(npmrcs.length).toBeGreaterThan(0);
    for (const [path, text] of npmrcs) {
      expect(text, path).not.toMatch(/registry\.npmjs\.org/i);
      expect(text, path).not.toMatch(/^\s*registry\s*=/m);
      for (const line of text.split("\n").filter((l) => /_auth/i.test(l))) {
        expect(line, path).toMatch(/^\/\/[a-z0-9.-]+\.invalid\//);
      }
    }
  });

  it("ships no lockfile at the root (the operator generates it once)", () => {
    expect(fixture.repoFiles["package-lock.json"]).toBeUndefined();
    expect(fixture.repoFiles["pnpm-lock.yaml"]).toBeUndefined();
  });
});

describe("selectSeeds", () => {
  it("selects ids and inclusive ranges in manifest order", () => {
    const shard = selectSeeds(SEED_CATALOG, "S49-S50, S03,S01");
    expect(shard.seeds.map((s) => s.id)).toEqual(["S01", "S03", "S49", "S50"]);
    expect(findManifestError(shard)).toBeNull();
    expect(selectSeeds(SEED_CATALOG, "S01-S60")).toEqual(SEED_CATALOG);
  });

  it("rejects malformed items, empty ranges and unknown ids", () => {
    expect(() => selectSeeds(SEED_CATALOG, "S1")).toThrow(/item/);
    expect(() => selectSeeds(SEED_CATALOG, "S01,,S02")).toThrow(/item/);
    expect(() => selectSeeds(SEED_CATALOG, "S05-S02")).toThrow(/empty/);
    expect(() => selectSeeds(SEED_CATALOG, "S59-S61")).toThrow(/S61/);
  });
});

describe("shard plan", () => {
  /** The per-run issue budget: MAX_FINDINGS_PER_RUN and maxOpenIssues (20). */
  const SHARD_LIMIT = Math.min(MAX_FINDINGS_PER_RUN, 20);
  const shards = BENCH_SHARD_PLAN.map((spec) =>
    selectSeeds(SEED_CATALOG, spec),
  );
  const dirOf = (path: string) =>
    path.slice(0, Math.max(0, path.lastIndexOf("/")));

  it("keeps every shard's non-decoy seeds within the per-run caps", () => {
    for (const [index, shard] of shards.entries()) {
      const findings = shard.seeds.filter((s) => s.kind !== "decoy").length;
      expect(findings, BENCH_SHARD_PLAN[index]).toBeLessThanOrEqual(
        SHARD_LIMIT,
      );
      expect(findManifestError(shard), BENCH_SHARD_PLAN[index]).toBeNull();
    }
  });

  it("is the plan the runbook's generate commands use", () => {
    const runbook = readFileSync(
      new URL("../../../../../deploy/PILOT-RUNBOOK.md", import.meta.url),
      "utf8",
    );
    const used = [...runbook.matchAll(/generate-fixture\.ts --seeds (\S+)/g)];
    expect(used.map((m) => m[1])).toEqual([...BENCH_SHARD_PLAN]);
  });

  it("covers each seeded seed and decoy once and every rubric seed per shard", () => {
    for (const seed of SEED_CATALOG.seeds) {
      const holders = shards.filter((shard) =>
        shard.seeds.some((s) => s.id === seed.id),
      ).length;
      expect(holders, seed.id).toBe(seed.kind === "rubric" ? shards.length : 1);
    }
  });

  it("renders only the state each shard seeds", () => {
    for (const [index, shard] of shards.entries()) {
      const at = BENCH_SHARD_PLAN[index];
      const files = renderFixture(shard).repoFiles;
      const ofRule = (rule: string) =>
        shard.seeds.filter((s) => s.rule === rule && s.kind !== "decoy");
      const lockfileDirs = ofRule("supply.lockfile-missing").map((s) =>
        dirOf(s.subject),
      );
      const policyDirs = ofRule("ci.security-policy-missing").map((s) =>
        dirOf(s.subject),
      );
      for (const [path, text] of Object.entries(files)) {
        if (/^packages\/[^/]+\/package\.json$/.test(path)) {
          expect(lockfileDirs, `${at} ${path}`).toContain(dirOf(path));
        }
        if (path.endsWith("README.md") && text.includes("(SECURITY.md)")) {
          expect(policyDirs, `${at} ${path}`).toContain(dirOf(path));
        }
        if (
          path.startsWith(".github/workflows/") &&
          path !== ".github/workflows/ci.yml"
        ) {
          expect(
            shard.seeds.some((s) => s.subject === path),
            `${at} ${path}`,
          ).toBe(true);
        }
      }
      expect(files["SECURITY.md"] !== undefined, at).toBe(
        !policyDirs.includes(""),
      );
      const gitignore = (files[".gitignore"] ?? "").split("\n");
      const missing = ofRule("files.gitignore-missing-pattern").map(
        (s) => s.key,
      );
      for (const pattern of BENCH_GITIGNORE_PATTERNS) {
        expect(gitignore.includes(pattern), `${at} ${pattern}`).toBe(
          !missing.includes(pattern),
        );
      }
      expect(Object.keys(renderFixture(shard).hiddenTests)).toHaveLength(
        shard.seeds.length,
      );
    }
  });
});
