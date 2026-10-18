import { describe, expect, it } from "vitest";

import {
  InvalidOpKeyPartError,
  opKey,
  opKeyMatchesCommit,
  parseOpKey,
  WORKING_REV,
} from "./op-key.ts";

const SHA_A = "007a8a0bbf458c93734580a569d9f56cd34ab8dd";
const SHA_B = "460cdd27e59f8d965d85996ea1c27e498e069e9a";

describe("opKey", () => {
  it("names op, page, claim and the 12-char source revision", () => {
    expect(opKey("update", "pilot-ops-faq", "a001", SHA_A)).toBe(
      "update:pilot-ops-faq/a001@007a8a0bbf45",
    );
  });

  it("defaults the revision to working", () => {
    expect(opKey("review", "faq", "p1")).toBe(`review:faq/p1@${WORKING_REV}`);
  });

  it("differs across source revisions for the same claim (no approval replay across merges)", () => {
    expect(opKey("update", "faq", "a001", SHA_A)).not.toBe(
      opKey("update", "faq", "a001", SHA_B),
    );
  });

  it("differs across pages for the same claim id", () => {
    expect(opKey("update", "faq", "a001", SHA_A)).not.toBe(
      opKey("update", "runbook", "a001", SHA_A),
    );
  });

  it.each([
    ["op", ["Update", "faq", "a1", SHA_A]],
    ["page", ["update", "fa/q", "a1", SHA_A]],
    ["page", ["update", "faq,x", "a1", SHA_A]],
    ["page", ["update", "fa q", "a1", SHA_A]],
    ["claimId", ["update", "faq", "a@1", SHA_A]],
    ["claimId", ["update", "faq", "a:1", SHA_A]],
    ["sourceRev", ["update", "faq", "a1", "abc"]],
    ["sourceRev", ["update", "faq", "a1", "zz7a8a0bbf458c93"]],
  ] as const)("rejects an invalid %s", (part, [op, page, claim, rev]) => {
    expect(() => opKey(op, page, claim, rev)).toThrow(InvalidOpKeyPartError);
    try {
      opKey(op, page, claim, rev);
    } catch (e) {
      expect(e instanceof InvalidOpKeyPartError && e.part).toBe(part);
    }
  });
});

describe("parseOpKey", () => {
  it("round-trips every key opKey produces", () => {
    const cases: [string, string, string, string | undefined][] = [
      ["update", "pilot-ops-faq", "a001", SHA_A],
      ["repin", "faq", "p153", SHA_B],
      ["review", "faq", "4ab2-c3", undefined],
      ["reverify", "billing_faq", "trial-length", SHA_A.toUpperCase()],
    ];
    for (const [op, page, claimId, rev] of cases) {
      const parts = parseOpKey(opKey(op, page, claimId, rev));
      expect(parts).toEqual({
        op,
        page,
        claimId,
        sourceRev: rev ? rev.slice(0, 12).toLowerCase() : WORKING_REV,
      });
    }
  });

  it("returns null for strings that are not op keys", () => {
    for (const s of [
      "seed:pilot-ops-faq",
      "repin:none",
      "update:a001",
      "update:faq/a001@short",
      "",
      "update:faq/a/b@007a8a0bbf45",
    ]) {
      expect(parseOpKey(s)).toBeNull();
    }
  });
});

describe("opKeyMatchesCommit", () => {
  it("binds a key to the full source commit it was derived from", () => {
    const parts = parseOpKey(opKey("update", "faq", "a001", SHA_A));
    expect(parts && opKeyMatchesCommit(parts, SHA_A)).toBe(true);
    expect(parts && opKeyMatchesCommit(parts, SHA_B)).toBe(false);
  });

  it("never matches a working-tree key", () => {
    const parts = parseOpKey(opKey("update", "faq", "a001"));
    expect(parts && opKeyMatchesCommit(parts, SHA_A)).toBe(false);
  });
});
