import crypto from "crypto";
import { env } from "@terragon/env/apps-www";
import { NextRequest, NextResponse } from "next/server";
import { handleAppMentionEvent } from "./handlers";
import { waitUntil } from "@/lib/wait-until";

function verifySlackSignature(req: NextRequest, body: string) {
  if (!env.SLACK_SIGNING_SECRET) {
    throw new Error("SLACK_SIGNING_SECRET is not set");
  }
  const timestamp = req.headers.get("x-slack-request-timestamp")!;
  const slackSig = req.headers.get("x-slack-signature")!;
  if (!timestamp || !slackSig) {
    return false;
  }
  // Replay protection (5 minutes)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) {
    return false;
  }
  const basestring = `v0:${timestamp}:${body}`;
  const hmac = crypto
    .createHmac("sha256", env.SLACK_SIGNING_SECRET)
    .update(basestring)
    .digest("hex");
  const mySig = `v0=${hmac}`;
  // timingSafeEqual requires equal lengths
  const a = Buffer.from(mySig);
  const b = Buffer.from(slackSig);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Skip signature verification if no secret is configured (development)
  if (env.SLACK_SIGNING_SECRET && !verifySlackSignature(req, rawBody)) {
    console.error("[slack webhook] Invalid signature");
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
    if (action?.action_id === "retry_task_creation") {
      // Parse the stored retry data
      const retryData = JSON.parse(action.value);
      console.log(
        "[slack webhook] Retrying task creation with data:",
        retryData,
      );

      // Trigger the app mention handler again with the stored event data
      waitUntil(
        handleAppMentionEvent({
          type: "app_mention",
          user: retryData.user,
          text: retryData.text,
          ts: retryData.ts,
          channel: retryData.channel,
          thread_ts: retryData.thread_ts,
          team: retryData.team,
        }).catch((error) => {
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
      handleAppMentionEvent(payload.event).catch((error) => {
        console.error("[slack webhook] Error processing app mention:", error);
      }),
    );
  }

  return new Response("ok", { status: 200 });
}
