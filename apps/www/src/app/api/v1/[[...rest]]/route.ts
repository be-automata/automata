import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { cliAPIContract } from "@terragon/cli-api-contract";

import { cliRouter } from "@/server/orpc/cli-router";
import {
  mapInputValidationError,
  withApiVersion,
} from "@/server/orpc/api-version";

/**
 * The REST face of the egress API (#728): `/api/v1/orgs/{org}/...`, served by
 * the same oRPC procedures as `/api/cli`. Only `egress` is mounted, so threads
 * are not exposed as REST. Unlike `/api/cli` this mount sends NO
 * `Access-Control-Allow-Origin`: a session cookie may authenticate here, so
 * no other origin may read a response.
 */
export const dynamic = "force-dynamic";

const handler = new OpenAPIHandler(
  { egress: cliRouter.egress },
  { clientInterceptors: [mapInputValidationError] },
);

const OPENAPI_PATH = "/api/v1/openapi.json";

let openApiDocument: Promise<object> | undefined;

/** Memoized per isolate: the document depends only on the contract. */
function getOpenApiDocument(): Promise<object> {
  openApiDocument ??= new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  }).generate(
    { egress: cliAPIContract.egress },
    {
      info: { title: "Automata API", version: "1" },
      // The handler serves the contract's `/v1/...` paths under `/api`.
      servers: [{ url: "/api" }],
      components: {
        securitySchemes: {
          apiKey: { type: "apiKey", in: "header", name: "X-Daemon-Token" },
          bearer: { type: "http", scheme: "bearer" },
        },
      },
      security: [{ apiKey: [] }, { bearer: [] }],
    },
  );
  // A failed generate is not kept: the next request tries again.
  openApiDocument.catch(() => {
    openApiDocument = undefined;
  });
  return openApiDocument;
}

async function handleRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === OPENAPI_PATH) {
    return withApiVersion(Response.json(await getOpenApiDocument()));
  }
  const { response } = await handler.handle(request, {
    prefix: "/api",
    // The session path exists on this mount only (spec §8 fix 6).
    context: { headers: request.headers, allowSession: true },
  });
  return withApiVersion(response ?? new Response("Not found", { status: 404 }));
}

export const HEAD = handleRequest;
export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
