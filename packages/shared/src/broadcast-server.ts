import {
  BroadcastChannelUser,
  BroadcastUserMessage,
  getBroadcastChannelStr,
} from "@terragon/types/broadcast";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { env } from "@terragon/env/pkg-shared";
import { publicBroadcastUrl } from "@terragon/env/next-public";

type BroadcastFetcher = { fetch: (input: Request) => Promise<Response> };

/**
 * Resolve the native BROADCAST service binding + shared secret from the Workers
 * runtime (via OpenNext's getCloudflareContext). On Workers a Worker cannot
 * reliably fetch a sibling Worker's public workers.dev URL on the same account —
 * the request 404s at the edge — so the www worker must reach the broadcast
 * (partyserver) worker through this binding instead of publicBroadcastUrl().
 *
 * Outside the Workers/OpenNext runtime (self-host, node, vitest) getCloudflareContext
 * throws ("context not available") → caught here → undefined → the caller falls
 * back to the URL fetch. Mirrors apps/www/src/lib/r2-binding.ts.
 */
function getBroadcastBinding():
  | { fetcher: BroadcastFetcher; secret?: string }
  | undefined {
  try {
    const ctx = getCloudflareContext();
    const cfEnv = ctx?.env as Record<string, unknown> | undefined;
    const fetcher = cfEnv?.BROADCAST as BroadcastFetcher | undefined;
    if (!fetcher || typeof fetcher.fetch !== "function") {
      return undefined;
    }
    return {
      fetcher,
      secret: cfEnv?.INTERNAL_SHARED_SECRET as string | undefined,
    };
  } catch {
    return undefined;
  }
}

export async function publishBroadcastUserMessage(
  message: BroadcastUserMessage,
) {
  // Skip publishing broadcast messages in tests
  if (process.env.NODE_ENV === "test") {
    return;
  }
  const channel: BroadcastChannelUser = {
    type: "user",
    id: message.id,
  };
  const path = `/parties/main/${getBroadcastChannelStr(channel)}`;
  const body = JSON.stringify(message);

  // The realtime relay (PartyKit) is a SOFT dependency: it drives live UI
  // updates only. If it is down or unreachable, the fetch throws
  // (e.g. ECONNREFUSED) — that must never propagate into the caller's lifecycle
  // path (signup, thread creation, credits, automations…) and turn a successful,
  // already-persisted operation into a 500. Swallow transport/HTTP errors with a
  // structured warning instead.
  try {
    const binding = getBroadcastBinding();
    let response: Response;
    if (binding) {
      // Workers: reach the broadcast worker via the service binding. The request
      // host is arbitrary — the binding routes to the target worker, which sees
      // the path (routePartykitRequest maps /parties/main/<room>).
      response = await binding.fetcher.fetch(
        new Request(`https://broadcast${path}`, {
          method: "POST",
          body,
          headers: {
            "X-Terragon-Secret": binding.secret ?? env.INTERNAL_SHARED_SECRET!,
          },
        }),
      );
    } else {
      // Off-Workers (self-host, node): fall back to the public relay URL.
      const partySocketUrl = publicBroadcastUrl();
      if (!partySocketUrl) {
        console.warn("Party socket URL not set");
        return;
      }
      response = await fetch(`${partySocketUrl}${path}`, {
        method: "POST",
        body,
        headers: {
          "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET!,
        },
      });
    }
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
