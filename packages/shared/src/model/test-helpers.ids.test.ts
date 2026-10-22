import { describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";

import { createDb } from "../db";
import {
  createTestUser,
  randomTestGitHubAccountId,
  randomTestPRNumber,
} from "./test-helpers";

const db = createDb(env.DATABASE_URL!);

describe("test fixture ids (#452)", () => {
  // protects=fixture account ids stay unique across a whole suite run;
  // fails_when=the generator range is small enough that 20k draws collide
  // (the old 10^7 range collides with near certainty);
  // no_claim=does not prove the account primary key is independent; the
  // createTestUser test below does.
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

  // protects=createTestUser gives the account row a primary key independent of
  // its numeric GitHub accountId; fails_when=the row id is derived from (or
  // equal to) the random accountId again; no_claim=does not prove uniqueness
  // under load beyond the 20k generator test above.
  it("createTestUser keys the account row independently of accountId", async () => {
    const { githubAccount } = await createTestUser({ db });
    expect(githubAccount.id).not.toBe(githubAccount.accountId);
    expect(Number.isSafeInteger(Number(githubAccount.accountId))).toBe(true);
    expect(Number.isNaN(Number(githubAccount.id))).toBe(true);
  });
});
