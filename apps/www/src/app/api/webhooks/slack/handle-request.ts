import { NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { waitUntil } from "@/lib/wait-until";

import { logBlockActionAttribution } from "./block-action-attribution";
import { handleAppMentionEvent } from "./handlers";
import type { SlackRequestRoute } from "./route-fence";
import { verifySlackSignature } from "./verify";

/**
 * One Slack request, for the app identified by `route`. Fails closed: without
 * a signing secret for that app nothing is parsed — an unconfigured app is
 * indistinguishable from a forged request.
 */
export async function handleSlackRequest({
  req,
  signingSecret,
  route,
}: {
  req: NextRequest;
  signingSecret: string | null;
  route: SlackRequestRoute;
}): Promise<Response> {
  const rawBody = await req.text();

  if (!signingSecret) {
    console.error(
      "[slack webhook] Rejected: no SLACK_SIGNING_SECRET for this Slack app",
      route,
    );
    return NextResponse.json(
      { success: false, error: "Slack is not configured" },
      { status: 401 },
    );
  }
  if (
    !verifySlackSignature({
      signingSecret,
      timestamp: req.headers.get("x-slack-request-timestamp"),
      signature: req.headers.get("x-slack-signature"),
      body: rawBody,
      nowSeconds: Math.floor(Date.now() / 1000),
    })
  ) {
    console.error("[slack webhook] Invalid signature", route);
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 },
    );
  }

  // Parse the payload - for interactive messages, it's form-encoded with a 'payload' field
  let payload;
  if (rawBody.startsWith("payload=")) {
    // Interactive message payload is URL-encoded
    const decodedPayload = decodeURIComponent(rawBody.substring(8));
    payload = JSON.parse(decodedPayload);
  } else {
    payload = JSON.parse(rawBody);
  }

  console.log(
    "[slack webhook] Received event type:",
    payload.type,
    payload.event?.type,
  );

  // Handle Slack URL verification challenge
  if (payload.type === "url_verification") {
    console.log("[slack webhook] Responding to URL verification challenge");
    return new Response(payload.challenge, { status: 200 });
  }

  // Handle interactive messages (button clicks)
  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    console.log("[slack webhook] Received block action:", action?.action_id);
    waitUntil(
      logBlockActionAttribution({ db, payload, route }).catch((error) => {
        console.error(
          "[slack webhook] Error attributing block action",
          error instanceof Error ? error.message : String(error),
        );
      }),
    );
    if (action?.action_id === "retry_task_creation") {
      // Parse the stored retry data
      const retryData = JSON.parse(action.value);
      console.log(
        "[slack webhook] Retrying task creation with data:",
        retryData,
      );

      // Trigger the app mention handler again with the stored event data
      waitUntil(
        handleAppMentionEvent(
          {
            type: "app_mention",
            user: retryData.user,
            text: retryData.text,
            ts: retryData.ts,
            channel: retryData.channel,
            thread_ts: retryData.thread_ts,
            team: retryData.team,
          },
          route,
        ).catch((error) => {
          console.error("[slack webhook] Error retrying task creation:", error);
        }),
      );
    }
  }

  // Handle app mentions
  if (payload.event?.type === "app_mention") {
    console.log(
      "[slack webhook] Processing app mention from user:",
      payload.event.user,
    );
    // Process asynchronously to return 200 immediately to Slack
    waitUntil(
      handleAppMentionEvent(payload.event, route).catch((error) => {
        console.error("[slack webhook] Error processing app mention:", error);
      }),
    );
  }

  return new Response("ok", { status: 200 });
}
