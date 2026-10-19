import crypto from "crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { logBlockActionAttribution } from "./block-action-attribution";
import { handleSlackRequest } from "./handle-request";
import { handleAppMentionEvent } from "./handlers";
import { PLATFORM_SLACK_ROUTE } from "./route-fence";

vi.mock("./handlers", () => ({
  handleAppMentionEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./block-action-attribution", () => ({
  logBlockActionAttribution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({ db: {} }));

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

function blockActionsBody(action: Record<string, unknown>): string {
  return `payload=${encodeURIComponent(
    JSON.stringify({
      type: "block_actions",
      user: { id: "U1" },
      team: { id: "T1" },
      actions: [action],
    }),
  )}`;
}

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

  it("attributes a signed block action once and still acks 200 ok", async () => {
    const response = await handleSlackRequest({
      req: slackRequest(blockActionsBody({ action_id: "other" }), SECRET),
      signingSecret: SECRET,
      route: PLATFORM_SLACK_ROUTE,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(logBlockActionAttribution).toHaveBeenCalledTimes(1);
    expect(logBlockActionAttribution).toHaveBeenCalledWith(
      expect.objectContaining({ route: PLATFORM_SLACK_ROUTE }),
    );
    expect(handleAppMentionEvent).not.toHaveBeenCalled();
  });

  it("still re-runs the mention handler for retry_task_creation (EW5)", async () => {
    const value = {
      user: "U1",
      text: "do it",
      ts: "1.2",
      channel: "C1",
      thread_ts: "1.1",
      team: "T1",
    };
    const response = await handleSlackRequest({
      req: slackRequest(
        blockActionsBody({
          action_id: "retry_task_creation",
          value: JSON.stringify(value),
        }),
        SECRET,
      ),
      signingSecret: SECRET,
      route: PLATFORM_SLACK_ROUTE,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(handleAppMentionEvent).toHaveBeenCalledTimes(1);
    expect(handleAppMentionEvent).toHaveBeenCalledWith(
      { type: "app_mention", ...value },
      PLATFORM_SLACK_ROUTE,
    );
  });

  it("does not attribute app mentions or unsigned block actions", async () => {
    await handleSlackRequest({
      req: slackRequest(MENTION, SECRET),
      signingSecret: SECRET,
      route: PLATFORM_SLACK_ROUTE,
    });
    const bad = await handleSlackRequest({
      req: slackRequest(blockActionsBody({ action_id: "x" }), "another-app"),
      signingSecret: SECRET,
      route: PLATFORM_SLACK_ROUTE,
    });
    expect(bad.status).toBe(401);
    expect(logBlockActionAttribution).not.toHaveBeenCalled();
  });
});
