import { describe, it, expect } from "vitest";
import {
  WebhookSkip,
  findWebhookSkip,
  isWebhookSkip,
  requireAppAccess,
} from "./webhook-skip";

describe("webhook-skip (WI-8)", () => {
  it("identifies a direct WebhookSkip", () => {
    const skip = new WebhookSkip("no_mapped_users", "no users");
    expect(isWebhookSkip(skip)).toBe(true);
    expect(findWebhookSkip(skip)).toBe(skip);
  });

  it("unwraps @octokit/webhooks' aggregate (.errors) wrapper", () => {
    const skip = new WebhookSkip("app_access_unavailable", "not installed");
    const aggregate = Object.assign(new Error("Handler error"), {
      errors: [new Error("other"), skip],
    });
    expect(isWebhookSkip(aggregate)).toBe(true);
    expect(findWebhookSkip(aggregate)?.category).toBe("app_access_unavailable");
  });

  it("unwraps a nested cause", () => {
    const skip = new WebhookSkip("unmapped_installation", "no org");
    const wrapped = Object.assign(new Error("wrap"), { cause: skip });
    expect(findWebhookSkip(wrapped)?.category).toBe("unmapped_installation");
  });

  it("does NOT match a genuine error (stays a 500)", () => {
    expect(isWebhookSkip(new Error("Database error"))).toBe(false);
    expect(findWebhookSkip(new Error("boom"))).toBeNull();
    expect(isWebhookSkip(undefined)).toBe(false);
  });

  it("requireAppAccess converts a failure into an app_access_unavailable skip", async () => {
    await expect(
      requireAppAccess(
        () => Promise.reject(new Error("Bad credentials")),
        { repoFullName: "o/r" },
      ),
    ).rejects.toSatisfy((e: unknown) => {
      const skip = findWebhookSkip(e);
      return (
        skip?.category === "app_access_unavailable" &&
        skip.detail?.repoFullName === "o/r"
      );
    });
  });

  it("requireAppAccess passes a success through", async () => {
    await expect(requireAppAccess(() => Promise.resolve(42), {})).resolves.toBe(
      42,
    );
  });
});
