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

  /** Asserts the exact message (toThrow with a string only matches a substring). */
  const throwsExactly = (fn: () => unknown, message: string): void => {
    expect(fn).toThrow(
      new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    );
  };

  // -0 prints as "got 0"; 2 ** 53 + 1 is not representable, so 2 ** 53 + 2 is the next unsafe value.
  const NOT_SAFE_POSITIVE = [
    0,
    -0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1e21,
    2 ** 53,
    2 ** 53 + 2,
  ];

  it.each(NOT_SAFE_POSITIVE)("rejects issue number %s", (bad) => {
    throwsExactly(
      () => fixBranchName({ issueNumber: bad, fingerprint: fp, attemptNo: 1 }),
      `fix run issue number must be a positive integer, got ${bad}`,
    );
  });

  it.each(NOT_SAFE_POSITIVE)("rejects attempt number %s", (bad) => {
    throwsExactly(
      () => fixBranchName({ issueNumber: 1, fingerprint: fp, attemptNo: bad }),
      `fix run attempt number must be a positive integer, got ${bad}`,
    );
  });

  it.each(["../x", "DEADBEEF", "abc"])("rejects fingerprint %s", (bad) => {
    throwsExactly(
      () => fixBranchName({ issueNumber: 1, fingerprint: bad, attemptNo: 1 }),
      "fix run fingerprint must be lowercase hex (>= 8 chars)",
    );
  });

  it("reports the first bad field: issue, then attempt, then fingerprint", () => {
    throwsExactly(
      () => fixBranchName({ issueNumber: 0, fingerprint: "x", attemptNo: 0 }),
      "fix run issue number must be a positive integer, got 0",
    );
    throwsExactly(
      () => fixBranchName({ issueNumber: 1, fingerprint: "x", attemptNo: 0 }),
      "fix run attempt number must be a positive integer, got 0",
    );
  });
});
