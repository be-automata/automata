import { Server, routePartykitRequest, type Lobby } from "partyserver";
import { validateRequest } from "./auth";

// Cloudflare Workers entrypoint for the broadcast relay (control-plane pilot).
// Port of the PartyKit `BroadcastServer` (src/server.ts) onto partyserver, which
// is the Workers-native path (PartyKit is Workers + Durable Objects underneath).
//
// The www app talks to this at `/parties/main/<room>`, so the party name is
// "main" → Durable Object binding "Main" (see wrangler.jsonc). Stateless relay,
// hibernation on — same semantics as the PartyKit version.

interface Env {
  Main: DurableObjectNamespace;
  [key: string]: unknown;
}

function roomFromUrl(req: Request): string | null {
  // Path shape: /parties/:party/:room
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const i = parts.indexOf("parties");
  return i >= 0 && parts[i + 2] ? parts[i + 2] : null;
}

export class Main extends Server<Env> {
  static options = { hibernate: true };

  async onRequest(request: Request): Promise<Response> {
    if (request.method === "POST") {
      // Consume the body (otherwise the runtime throws an unhandled rejection),
      // then fan out to every connected client.
      const message = await request.json();
      this.broadcast(JSON.stringify(message));
      return new Response("OK");
    }
    return new Response("Method not allowed", { status: 405 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const res = await routePartykitRequest(request, env, {
      // HTTP requests (incl. www's POST broadcast) authenticate channel-less via
      // the shared secret — mirrors PartyKit `onBeforeRequest`.
      onBeforeRequest: async (req: Request, lobby: Lobby<Env>) => {
        try {
          await validateRequest(req, null, lobby.env as Record<string, unknown>);
          return req;
        } catch (e) {
          console.error(e);
          return new Response("Unauthorized", { status: 401 });
        }
      },
      // WebSocket connects authenticate against the room/channel via token/apiKey
      // — mirrors PartyKit `onBeforeConnect`.
      onBeforeConnect: async (req: Request, lobby: Lobby<Env>) => {
        try {
          await validateRequest(
            req,
            roomFromUrl(req),
            lobby.env as Record<string, unknown>,
          );
          return req;
        } catch (e) {
          console.error(e);
          return new Response("Unauthorized", { status: 401 });
        }
      },
    });
    return res ?? new Response("Not found", { status: 404 });
  },
};
