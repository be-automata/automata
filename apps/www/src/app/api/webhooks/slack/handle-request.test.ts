import crypto from "crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleSlackRequest } from "./handle-request";
import { handleAppMentionEvent } from "./handlers";
import { PLATFORM_SLACK_ROUTE } from "./route-fence";

vi.mock("./handlers", () => ({
  handleAppMentionEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/wait-until", () => ({
  waitUntil: (promise: Promise<unknown>) => promise,
}));

const SECRET = "signing-secret";

function slackRequest(body: string, secret: string | null): NextRequest {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "x-slack-request-timestamp": timestamp,
  };
  if (secret) {
    headers["x-slack-signature"] = `v0=${crypto
      .createHmac("sha256", secret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
  }
  return new NextRequest("https://example.com/api/webhooks/slack", {
    method: "POST",
    body,
    headers,
  });
}

const MENTION = JSON.stringify({
  type: "event_callback",
  event: { type: "app_mention", user: "U1", team: "T1", text: "hi" },
});

describe("handleSlackRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed without a signing secret, even for an unsigned request", async () => {
    const response = await handleSlackRequest({
      req: slackRequest(MENTION, null),
      signingSecret: null,
      route: PLATFORM_SLACK_ROUTE,
    });
    expect(response.status).toBe(401);
    expect(handleAppMentionEvent).not.toHaveBeenCalled();
  });

  it("rejects a request signed with another app's secret", async () => {
    const response = await handleSlackRequest({
      req: slackRequest(MENTION, "another-app"),
      signingSecret: SECRET,
      route: PLATFORM_SLACK_ROUTE,
    });
    expect(response.status).toBe(401);
    expect(handleAppMentionEvent).not.toHaveBeenCalled();
  });

  it("hands a verified mention to the handler with the request's route", async () => {
    const route = { kind: "organization" as const, organizationId: "org-1" };
    const response = await handleSlackRequest({
      req: slackRequest(MENTION, SECRET),
      signingSecret: SECRET,
      route,
    });
    expect(response.status).toBe(200);
    expect(handleAppMentionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "app_mention", team: "T1" }),
      route,
    );
  });

  it("answers Slack's URL verification challenge once verified", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "c1" });
    const response = await handleSlackRequest({
      req: slackRequest(body, SECRET),
      signingSecret: SECRET,
      route: PLATFORM_SLACK_ROUTE,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("c1");
  });
});
