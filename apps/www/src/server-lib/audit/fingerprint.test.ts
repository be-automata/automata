import { describe, expect, it } from "vitest";

import { fingerprintFinding, normalizeSubject } from "./fingerprint";

const BASE = {
  repoFullName: "Acme/Widgets",
  audit: "security-audit",
  section: "sensitive-files",
  rule: "files.sensitive-committed",
  subject: "src/a.ts",
  key: undefined as string | undefined,
};

describe("fingerprintFinding", () => {
  it("matches the pinned golden for a canonical input", () => {
    expect(fingerprintFinding(BASE)).toBe(GOLDEN);
  });

  it("survives rewording, severity, ordering and line shifts", () => {
    const a = normalizeSubject("./src/a.ts:12", "path");
    const b = normalizeSubject("src/a.ts", "path");
    expect(a).toBe(b);
    expect(fingerprintFinding({ ...BASE, subject: a! })).toBe(
      fingerprintFinding({ ...BASE, subject: b! }),
    );
  });

  it("ignores repo case", () => {
    expect(fingerprintFinding({ ...BASE, repoFullName: "acme/widgets" })).toBe(
      fingerprintFinding(BASE),
    );
  });

  it.each([
    ["repo", { repoFullName: "acme/other" }],
    ["audit", { audit: "other-audit" }],
    ["section", { section: "supply-chain" }],
    ["rule", { rule: "secret.hardcoded" }],
    ["subject", { subject: "src/b.ts" }],
    ["key", { key: "x" }],
  ])("differs when %s differs", (_name, patch) => {
    expect(fingerprintFinding({ ...BASE, ...patch })).not.toBe(
      fingerprintFinding(BASE),
    );
  });
});

describe("normalizeSubject", () => {
  it.each(["/etc/passwd", "../x", "a/../x", ".git/config", "", "   "])(
    "rejects %j",
    (raw) => {
      expect(normalizeSubject(raw, "path")).toBeNull();
    },
  );

  it("rejects over-long subjects", () => {
    expect(normalizeSubject("a".repeat(301), "path")).toBeNull();
  });

  it("normalises separators, prefixes and line suffixes", () => {
    expect(normalizeSubject("src\\a.ts", "path")).toBe("src/a.ts");
    expect(normalizeSubject("./src//a.ts:12:3", "path")).toBe("src/a.ts");
    expect(normalizeSubject("src/a.ts#L40", "path")).toBe("src/a.ts");
  });

  it("normalises npm subjects", () => {
    expect(normalizeSubject("npm:@scope/Pkg@1.2.3", "npm")).toBe(
      "npm:@scope/pkg",
    );
    expect(normalizeSubject("npm:lodash@4.17.0", "npm")).toBe("npm:lodash");
    expect(normalizeSubject("lodash", "npm")).toBe("npm:lodash");
    expect(normalizeSubject("npm:", "npm")).toBeNull();
  });
});

const GOLDEN = "b208fa3e0da9a061";
