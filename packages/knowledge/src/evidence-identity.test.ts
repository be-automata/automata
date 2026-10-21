import { describe, expect, it } from "vitest";

import { checkPage } from "./claims";
import {
  classifyEvidence,
  PROSE_EXTENSIONS,
  type EvidenceClass,
  type EvidenceScheme,
} from "./evidence-class";
import { limitsPageOf, useLimitsCorpus } from "./test-fixtures";

describe("classifyEvidence", () => {
  it.each<[EvidenceScheme, string, EvidenceClass]>([
    ["doc", "pricing", "prose"],
    ["ticket", "SUP-12", "prose"],
    ["repo", "README.md", "prose"],
    ["repo", "docs/guide.MDX", "prose"],
    ["repo", "notes.txt", "prose"],
    ["repo", "a.rst", "prose"],
    ["repo", "b.adoc", "prose"],
    ["repo", "c.asciidoc", "prose"],
    ["repo", "d.markdown", "prose"],
    ["repo", "ratelimit.py", "exact"],
    ["repo", "config.yaml", "exact"],
    ["repo", "x.yml", "exact"],
    ["repo", "a.json", "exact"],
    ["repo", "a.toml", "exact"],
    ["repo", "billing.ts", "exact"],
    ["repo", "run.sh", "exact"],
    ["repo", "Makefile", "exact"],
    ["repo", "dir.md/file", "exact"],
    ["repo", ".env", "exact"],
    ["repo", "weird.unknownext", "exact"],
  ])("%s://%s is %s", (scheme, target, want) => {
    expect(classifyEvidence(scheme, target)).toBe(want);
  });

  it("lists exactly the prose extensions", () => {
    expect([...PROSE_EXTENSIONS]).toEqual([
      "md",
      "mdx",
      "markdown",
      "txt",
      "rst",
      "adoc",
      "asciidoc",
    ]);
  });
});

describe("limits corpus", () => {
  it("starts with every claim fresh", () => {
    const { root, sc } = useLimitsCorpus();
    const report = checkPage(root, limitsPageOf(root), sc);
    expect(
      Object.fromEntries(report.claims.map((c) => [c.id, c.status])),
    ).toEqual({ "api-rate": "fresh", burst: "fresh", "readme-rate": "fresh" });
  });
});
