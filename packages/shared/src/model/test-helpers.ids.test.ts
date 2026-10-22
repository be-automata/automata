import { describe, expect, it } from "vitest";

import { randomTestGitHubAccountId, randomTestPRNumber } from "./test-helpers";

describe("test fixture ids (#452)", () => {
  // protects=fixture account ids stay unique across a whole suite run;
  // fails_when=the generator range is small enough that 20k draws collide
  // (the old 10^7 range collides with near certainty);
  // no_claim=does not prove the account primary key is non-random, see the
  // createTestUser test below.
  it("does not collide across 20,000 GitHub account ids", () => {
    const ids = Array.from({ length: 20_000 }, randomTestGitHubAccountId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // protects=accountId keeps the numeric form production parses with Number();
  // fails_when=a non-numeric or unsafe-integer id is generated;
  // no_claim=none beyond protects.
  it("generates account ids that parse to safe integers", () => {
    for (let i = 0; i < 1_000; i++) {
      const n = Number(randomTestGitHubAccountId());
      expect(Number.isSafeInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });

  // protects=test PR numbers fit the int4 column; fails_when=a number outside
  // 1..2^31-1 is generated; no_claim=does not prove uniqueness per repo.
  it("generates PR numbers inside the int4 range", () => {
    for (let i = 0; i < 1_000; i++) {
      const n = randomTestPRNumber();
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });
});
