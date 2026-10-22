import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";

import { deferWebhookWork } from "./defer-webhook-work";
import { WebhookSkip } from "./webhook-skip";

describe("deferWebhookWork", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await mockWaitUntil();
  });

  // protects=a deferred failure's log names the delivery and carries no
  //   credential material (a git or HTTP error can echo a token);
  // fails_when=the delivery id is dropped, or a token in the error text
  //   reaches the log line verbatim;
  // no_claim=redaction of token shapes redactSecrets does not know.
  it("logs a failure with the delivery id and redacts tokens", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const token = `ghs_${"a".repeat(36)}`;
    deferWebhookWork({
      deliveryId: "delivery-1",
      eventName: "pull_request.closed",
      label: "self-heal fix PR lifecycle",
      work: async () => {
        throw new Error(`push failed: https://x-access-token:${token}@host`);
      },
    });
    await waitUntilResolved();

    expect(consoleError).toHaveBeenCalledTimes(1);
    const [message, fields] = consoleError.mock.calls[0]!;
    expect(message).toContain("deferred work failed");
    expect(fields).toMatchObject({
      deliveryId: "delivery-1",
      eventName: "pull_request.closed",
      label: "self-heal fix PR lifecycle",
    });
    expect(JSON.stringify(fields)).not.toContain(token);
    expect((fields as { error: string }).error).toContain("<redacted>");
  });

  // protects=WI-8 for deferred work: a WebhookSkip is a logged skip naming
  //   the delivery and category, never an error;
  // fails_when=a skip is logged through console.error, or loses the delivery
  //   id or category;
  // no_claim=the HTTP response, which deferred work cannot change.
  it("logs a WebhookSkip as a skip, not an error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    deferWebhookWork({
      deliveryId: "delivery-2",
      eventName: "issues.opened",
      label: "issue automations",
      work: async () => {
        throw new WebhookSkip("unmapped_installation", "No org bound");
      },
    });
    await waitUntilResolved();

    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(
      "[github webhook] deferred work skipped",
      expect.objectContaining({
        deliveryId: "delivery-2",
        category: "unmapped_installation",
      }),
    );
  });
});
