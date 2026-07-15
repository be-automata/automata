import {
  BroadcastChannelUser,
  BroadcastUserMessage,
  getBroadcastChannelStr,
} from "@terragon/types/broadcast";
import { env } from "@terragon/env/pkg-shared";
import { publicBroadcastUrl } from "@terragon/env/next-public";

export async function publishBroadcastUserMessage(
  message: BroadcastUserMessage,
) {
  // Skip publishing broadcast messages in tests
  if (process.env.NODE_ENV === "test") {
    return;
  }
  const partySocketUrl = publicBroadcastUrl();
  if (!partySocketUrl) {
    console.warn("Party socket URL not set");
    return;
  }
  const channel: BroadcastChannelUser = {
    type: "user",
    id: message.id,
  };
  // The realtime relay (PartyKit) is a SOFT dependency: it drives live UI
  // updates only. If it is down or unreachable, the fetch throws
  // (e.g. ECONNREFUSED) — that must never propagate into the caller's lifecycle
  // path (signup, thread creation, credits, automations…) and turn a successful,
  // already-persisted operation into a 500. Swallow transport/HTTP errors with a
  // structured warning instead.
  try {
    const response = await fetch(
      `${partySocketUrl}/parties/main/${getBroadcastChannelStr(channel)}`,
      {
        method: "POST",
        body: JSON.stringify(message),
        headers: {
          "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET!,
        },
      },
    );
    if (!response.ok) {
      console.warn("Broadcast publish returned non-OK status", {
        channelId: message.id,
        status: response.status,
      });
    }
  } catch (error) {
    console.warn("Broadcast publish failed (realtime relay unreachable)", {
      channelId: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
