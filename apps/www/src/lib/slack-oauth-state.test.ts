import { encryptValue } from "@terragon/utils/encryption";
import { describe, expect, it } from "vitest";

import {
  decodeSlackOAuthState,
  encodeSlackOAuthState,
  isRequestedSlackTeam,
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
        teamId: null,
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

  it("carries the requested workspace", () => {
    const encoded = encodeSlackOAuthState(
      { ...STATE, teamId: "T09BANGR01" },
      KEY,
    );
    expect(decodeSlackOAuthState(encoded, KEY)?.teamId).toBe("T09BANGR01");
  });

  it("reads a state minted before the workspace check as any workspace", () => {
    const legacy = encryptValue(
      JSON.stringify({ ...STATE, timestamp: 1 }),
      KEY,
    );
    expect(decodeSlackOAuthState(legacy, KEY)?.teamId).toBeNull();
  });
});

describe("isRequestedSlackTeam", () => {
  it("refuses a token for a workspace other than the one asked for", () => {
    // Slack swaps the hint for the app's home workspace when the app is not
    // distributed; that token must not be saved as the requested workspace.
    expect(isRequestedSlackTeam({ teamId: "T09BANGR01" }, "T0AUTOMATA1")).toBe(
      false,
    );
    expect(isRequestedSlackTeam({ teamId: "T09BANGR01" }, undefined)).toBe(
      false,
    );
  });

  it("accepts the requested workspace, or any when none was named", () => {
    expect(isRequestedSlackTeam({ teamId: "T09BANGR01" }, "T09BANGR01")).toBe(
      true,
    );
    expect(isRequestedSlackTeam({ teamId: null }, "T0AUTOMATA1")).toBe(true);
  });
});
