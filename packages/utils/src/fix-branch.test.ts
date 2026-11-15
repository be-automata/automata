import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FIX_BRANCH_PREFIX,
  FIX_FINGERPRINT_RE,
  fixBranchName,
} from "./fix-branch";

const ISSUES = [1, 9, 10, 12, 99999, 2147483647, Number.MAX_SAFE_INTEGER];
const FINGERPRINTS = [
  "00000000",
  "ffffffff",
  "deadbeef",
  "0123abcd",
  "0123456789abcdef".repeat(4),
];
const ATTEMPTS = [1, 2, 9, 10, 99999];

function allNames(): string[] {
  const names: string[] = [];
  for (const issueNumber of ISSUES) {
    for (const fingerprint of FINGERPRINTS) {
      for (const attemptNo of ATTEMPTS) {
        names.push(fixBranchName({ issueNumber, fingerprint, attemptNo }));
      }
    }
  }
  return names;
}

describe("fixBranchName (AC1: byte-identical to the pre-move builder)", () => {
  it("keeps the prefix and the fingerprint pattern", () => {
    expect(FIX_BRANCH_PREFIX).toBe("automata/fix-");
    expect(FIX_FINGERPRINT_RE.source).toBe("^[0-9a-f]{8,}$");
  });

  it("builds the documented shape", () => {
    expect(
      fixBranchName({
        issueNumber: 42,
        fingerprint: "0123456789abcdef",
        attemptNo: 2,
      }),
    ).toBe("automata/fix-42-01234567-a2");
  });

  it("reproduces the 175-name baseline from main", () => {
    const names = allNames();
    expect(names).toHaveLength(175);
    expect(names[0]).toBe("automata/fix-1-00000000-a1");
    expect(names.at(-1)).toBe("automata/fix-9007199254740991-01234567-a99999");
    for (const name of names) {
      expect(name.startsWith(FIX_BRANCH_PREFIX)).toBe(true);
    }
    expect(createHash("sha256").update(names.join("\n")).digest("hex")).toBe(
      "f4cc7c43183ea8fd60096fd24d920c604dd481d09450f8597279aaf4983f8524",
    );
  });
});

describe("fixBranchName (AC2: same checks, same messages)", () => {
  const fp = "0123456789abcdef";

  it.each([0, -1, 1.5, Number.NaN])("rejects issue number %s", (bad) => {
    expect(() =>
      fixBranchName({ issueNumber: bad, fingerprint: fp, attemptNo: 1 }),
    ).toThrow(`fix run issue number must be a positive integer, got ${bad}`);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects attempt number %s", (bad) => {
    expect(() =>
      fixBranchName({ issueNumber: 1, fingerprint: fp, attemptNo: bad }),
    ).toThrow(`fix run attempt number must be a positive integer, got ${bad}`);
  });

  it.each(["../x", "DEADBEEF", "abc"])("rejects fingerprint %s", (bad) => {
    expect(() =>
      fixBranchName({ issueNumber: 1, fingerprint: bad, attemptNo: 1 }),
    ).toThrow("fix run fingerprint must be lowercase hex (>= 8 chars)");
  });

  it("reports the first bad field: issue, then attempt, then fingerprint", () => {
    expect(() =>
      fixBranchName({ issueNumber: 0, fingerprint: "x", attemptNo: 0 }),
    ).toThrow("fix run issue number must be a positive integer, got 0");
    expect(() =>
      fixBranchName({ issueNumber: 1, fingerprint: "x", attemptNo: 0 }),
    ).toThrow("fix run attempt number must be a positive integer, got 0");
  });
});
