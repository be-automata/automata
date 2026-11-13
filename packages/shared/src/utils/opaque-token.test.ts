import { describe, expect, it } from "vitest";

import {
  hashOpaqueToken,
  mintOpaqueToken,
  opaqueTokenMatches,
} from "./opaque-token";

describe("opaque token", () => {
  // Pinned: the values the pre-#599 hashSelfHealToken / cell-authority
  // hashToken produced (sha256 hex, utf8). "" and "abc" are the FIPS 180-2
  // vectors; the third is a token-shaped string. A change here means every
  // stored hash stops matching.
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "q2xWJ0bGZ5pB3vZ8c1Yk2mR6nT9uL4hE7aD0sF3gH5j",
      "2c62589c0b30d06ebecdd421077f68d50880ff9f688ddf86915b04bf9f3891c8",
    ],
  ])("hashes %j to its pinned sha256 hex", (token, hash) => {
    expect(hashOpaqueToken(token)).toBe(hash);
  });

  it("mints 43 base64url characters, distinct per call", () => {
    const tokens = new Set(Array.from({ length: 50 }, mintOpaqueToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
    }
  });

  it("matches the right token only", () => {
    const token = mintOpaqueToken();
    const stored = hashOpaqueToken(token);
    expect(opaqueTokenMatches(token, stored)).toBe(true);
    expect(opaqueTokenMatches(mintOpaqueToken(), stored)).toBe(false);
    expect(opaqueTokenMatches("", stored)).toBe(false);
  });

  it("returns false, without throwing, for a stored hash of another length", () => {
    const token = mintOpaqueToken();
    const stored = hashOpaqueToken(token);
    for (const other of [
      stored.slice(0, 32),
      `${stored}00`,
      "",
      // 64 characters, 65 bytes: the length check is on bytes.
      `${"a".repeat(63)}é`,
    ]) {
      expect(() => opaqueTokenMatches(token, other)).not.toThrow();
      expect(opaqueTokenMatches(token, other)).toBe(false);
    }
  });
});
