import { describe, it, expect } from "vitest";
import { daemonTokenContextFromApiKey } from "./daemon-token-context";

describe("daemonTokenContextFromApiKey", () => {
  it("returns null when the key is null", () => {
    expect(daemonTokenContextFromApiKey(null)).toBeNull();
  });

  it("returns null when the key has neither referenceId nor userId", () => {
    expect(
      daemonTokenContextFromApiKey({ metadata: { organizationId: "org_1" } }),
    ).toBeNull();
  });

  /**
   * better-auth >= 1.5 renamed the owner field `userId` -> `referenceId`, and
   * `referenceId` is what a real 1.6 `verifyApiKey` response actually carries —
   * so it is the PRIMARY production path, not a variant. The rest of this suite
   * predates the rename and exercises only the legacy fallback, which is how the
   * rename originally slipped through: every field on the structural type is
   * optional, so reading a renamed field still compiles and just yields
   * undefined. These cases pin the primary path and the precedence between them.
   */
  it("resolves userId from referenceId (better-auth >= 1.5, the real 1.6 shape)", () => {
    expect(daemonTokenContextFromApiKey({ referenceId: "user_1" })).toEqual({
      userId: "user_1",
      organizationId: null,
      threadChatId: null,
      threadId: null,
      apiKeyId: null,
      tokenType: null,
    });
  });

  it("reads the full context off a referenceId-shaped key, not just the owner", () => {
    expect(
      daemonTokenContextFromApiKey({
        id: "apikey_1",
        referenceId: "user_1",
        metadata: {
          organizationId: "org_1",
          threadChatId: "tc_1",
          threadId: "thr_1",
          tokenType: "daemon",
        },
      }),
    ).toEqual({
      userId: "user_1",
      organizationId: "org_1",
      threadChatId: "tc_1",
      threadId: "thr_1",
      apiKeyId: "apikey_1",
      tokenType: "daemon",
    });
  });

  it("prefers referenceId over a legacy userId when a key carries both", () => {
    expect(
      daemonTokenContextFromApiKey({
        referenceId: "user_new",
        userId: "user_legacy",
      })?.userId,
    ).toBe("user_new");
  });

  it("still falls back to userId so a mixed-version rollout cannot 401 the fleet", () => {
    expect(daemonTokenContextFromApiKey({ userId: "user_1" })?.userId).toBe(
      "user_1",
    );
  });

  it("resolves userId with a null organizationId when metadata is absent", () => {
    expect(daemonTokenContextFromApiKey({ userId: "user_1" })).toEqual({
      userId: "user_1",
      organizationId: null,
      threadChatId: null,
      threadId: null,
      apiKeyId: null,
      tokenType: null,
    });
  });

  it("resolves organizationId from key metadata", () => {
    expect(
      daemonTokenContextFromApiKey({
        userId: "user_1",
        metadata: { organizationId: "org_1" },
      }),
    ).toEqual({
      userId: "user_1",
      organizationId: "org_1",
      threadChatId: null,
      threadId: null,
      apiKeyId: null,
      tokenType: null,
    });
  });

  it("treats a non-string organizationId as null", () => {
    expect(
      daemonTokenContextFromApiKey({
        userId: "user_1",
        metadata: { organizationId: 123 as unknown as string },
      }),
    ).toEqual({
      userId: "user_1",
      organizationId: null,
      threadChatId: null,
      threadId: null,
      apiKeyId: null,
      tokenType: null,
    });
  });

  it("treats an empty-string organizationId as null", () => {
    expect(
      daemonTokenContextFromApiKey({
        userId: "user_1",
        metadata: { organizationId: "" },
      }),
    ).toEqual({
      userId: "user_1",
      organizationId: null,
      threadChatId: null,
      threadId: null,
      apiKeyId: null,
      tokenType: null,
    });
  });

  it("F1/F2: resolves apiKeyId, threadChatId, threadId and tokenType='daemon' from the key", () => {
    expect(
      daemonTokenContextFromApiKey({
        id: "apikey_1",
        userId: "user_1",
        metadata: {
          organizationId: "org_1",
          threadChatId: "tc_1",
          threadId: "t_1",
          tokenType: "daemon",
        },
      }),
    ).toEqual({
      userId: "user_1",
      apiKeyId: "apikey_1",
      organizationId: "org_1",
      threadChatId: "tc_1",
      threadId: "t_1",
      tokenType: "daemon",
    });
  });

  it("F1: an unknown tokenType is treated as null (not daemon-scoped)", () => {
    expect(
      daemonTokenContextFromApiKey({
        userId: "user_1",
        metadata: { tokenType: "something-else" },
      }),
    ).toEqual({
      userId: "user_1",
      organizationId: null,
      threadChatId: null,
      threadId: null,
      apiKeyId: null,
      tokenType: null,
    });
  });
});
