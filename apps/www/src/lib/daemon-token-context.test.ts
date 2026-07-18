import { describe, it, expect } from "vitest";
import { daemonTokenContextFromApiKey } from "./daemon-token-context";

describe("daemonTokenContextFromApiKey", () => {
  it("returns null when the key is null", () => {
    expect(daemonTokenContextFromApiKey(null)).toBeNull();
  });

  it("returns null when the key has no userId", () => {
    expect(
      daemonTokenContextFromApiKey({ metadata: { organizationId: "org_1" } }),
    ).toBeNull();
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
