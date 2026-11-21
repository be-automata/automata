import { RPCHandler } from "@orpc/server/fetch";

import {
  mapInputValidationError,
  withApiVersion,
} from "@/server/orpc/api-version";
import { cliRouter } from "@/server/orpc/cli-router";

const handler = new RPCHandler(cliRouter, {
  clientInterceptors: [mapInputValidationError],
});

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "X-Daemon-Token, Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

async function handleRequest(request: Request) {
  const { response } = await handler.handle(request, {
    prefix: "/api/cli",
    // Token-only: `allowSession` is never set on this mount (wildcard CORS).
    context: { headers: request.headers },
  });

  const res = response ?? new Response("Not found", { status: 404 });
  const headers = corsHeaders();
  Object.entries(headers).forEach(([k, v]) => res.headers.set(k, v));
  return withApiVersion(res);
}

export const HEAD = handleRequest;
export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;

export async function OPTIONS() {
  return withApiVersion(
    new Response(null, { status: 204, headers: corsHeaders() }),
  );
}
