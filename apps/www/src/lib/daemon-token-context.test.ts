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
    });
  });

  it("resolves organizationId from key metadata", () => {
    expect(
      daemonTokenContextFromApiKey({
        userId: "user_1",
        metadata: { organizationId: "org_1" },
      }),
    ).toEqual({ userId: "user_1", organizationId: "org_1" });
  });

  it("treats a non-string organizationId as null", () => {
    expect(
      daemonTokenContextFromApiKey({
        userId: "user_1",
        metadata: { organizationId: 123 as unknown as string },
      }),
    ).toEqual({ userId: "user_1", organizationId: null });
  });

  it("treats an empty-string organizationId as null", () => {
    expect(
      daemonTokenContextFromApiKey({
        userId: "user_1",
        metadata: { organizationId: "" },
      }),
    ).toEqual({ userId: "user_1", organizationId: null });
  });
});
