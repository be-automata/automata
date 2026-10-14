import { encryptValue } from "@terragon/utils/encryption";
import { describe, expect, it } from "vitest";

import {
  decodeSlackOAuthState,
  encodeSlackOAuthState,
} from "./slack-oauth-state";

const KEY = "a".repeat(64);
const STATE = {
  userId: "user-1",
  organizationId: "org-1",
  type: "openid" as const,
};

describe("slack oauth state", () => {
  it("round-trips, and is URL-safe without encoding", () => {
    for (let i = 0; i < 20; i++) {
      const encoded = encodeSlackOAuthState(STATE, KEY, 1000);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeSlackOAuthState(encoded, KEY)).toEqual({
        ...STATE,
        timestamp: 1000,
      });
    }
  });

  it("still decodes a legacy base64 state whose + came back as a space", () => {
    // Retry until the ciphertext contains a "+", the character that broke.
    let legacy = "";
    while (!legacy.includes("+")) {
      legacy = encryptValue(JSON.stringify({ ...STATE, timestamp: 1000 }), KEY);
    }
    expect(decodeSlackOAuthState(legacy, KEY)?.userId).toBe("user-1");
    expect(decodeSlackOAuthState(legacy.replace(/\+/g, " "), KEY)?.userId).toBe(
      "user-1",
    );
  });

  it("reads a pre-org state as the platform app", () => {
    const legacy = encryptValue(
      JSON.stringify({ userId: "user-1", type: "openid", timestamp: 1 }),
      KEY,
    );
    expect(decodeSlackOAuthState(legacy, KEY)?.organizationId).toBeNull();
  });

  it("returns null instead of throwing on a wrong key or garbage", () => {
    const encoded = encodeSlackOAuthState(STATE, KEY);
    expect(decodeSlackOAuthState(encoded, "b".repeat(64))).toBeNull();
    expect(decodeSlackOAuthState("not-a-state", KEY)).toBeNull();
    expect(decodeSlackOAuthState("", KEY)).toBeNull();
  });
});
