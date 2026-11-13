import type { DB } from "@terragon/shared/db";
import { graphqlHasMutation } from "@terragon/utils/graphql-mutation";

import {
  assertOrigin,
  brokerError,
  decodePathSegments,
  extractCellBearer,
  forwardRequestHeaders,
  isUnsafeSegment,
  refusalResponse,
  resolveCellStep,
  responseHeadersForCell,
} from "./common";

/**
 * Remote-cell gh broker (#606): read-only GitHub REST and GraphQL for a cell's
 * stock `gh`. gh treats `GH_HOST=<www host>` as an Enterprise Server host and
 * calls `/api/v3/<path>` and `/api/graphql` with `Authorization: token <x>`.
 * Reads only: REST is GET/HEAD, GraphQL is a POST with no mutation. The
 * upstream URL is built from decoded, re-encoded segments on a fixed origin and
 * the read-only installation token is injected server-side.
 */

const REST_PREFIX = "/api/v3";
const MAX_GRAPHQL_BYTES = 1024 * 1024;

export type GhKind = "rest" | "graphql";

export interface GhBrokerDeps {
  db: DB;
  fetchImpl: typeof fetch;
  mintReadToken: (owner: string, repo: string) => Promise<{ token: string }>;
  enabled: () => boolean;
  /** Cap on a GraphQL request body. Defaults to 1 MiB. */
  maxGraphqlBytes?: number;
}

type Built =
  | { ok: true; url: URL; body?: Uint8Array }
  | { ok: false; response: Response };

function restTarget(request: Request, url: URL): Built {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return { ok: false, response: brokerError(403, "forbidden_method") };
  }
  const decoded = decodePathSegments(url.pathname, REST_PREFIX);
  if (!decoded.ok) {
    return { ok: false, response: brokerError(400, "bad_request") };
  }
  if (decoded.segments.some((segment) => isUnsafeSegment(segment, "gh"))) {
    return { ok: false, response: brokerError(403, "forbidden_path") };
  }
  const upstream = new URL("https://api.github.com");
  upstream.pathname = `/${decoded.segments.map(encodeURIComponent).join("/")}`;
  upstream.search = url.search;
  return { ok: true, url: upstream };
}

/** Read the request body, refusing anything over `maxBytes`. */
async function readBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.length;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(chunk.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function graphqlTarget(
  request: Request,
  maxBytes: number,
): Promise<Built> {
  if (request.method !== "POST") {
    return { ok: false, response: brokerError(403, "forbidden_method") };
  }
  const body = await readBody(request, maxBytes).catch(() => undefined);
  if (body === undefined) {
    return { ok: false, response: brokerError(400, "bad_request") };
  }
  if (body === null) {
    return { ok: false, response: brokerError(413, "payload_too_large") };
  }
  let query: unknown;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    query =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { query?: unknown }).query
        : undefined;
  } catch {
    return { ok: false, response: brokerError(400, "bad_request") };
  }
  if (typeof query !== "string") {
    return { ok: false, response: brokerError(400, "bad_request") };
  }
  if (graphqlHasMutation(query)) {
    return {
      ok: false,
      response: brokerError(403, "graphql_mutation_refused"),
    };
  }
  return { ok: true, url: new URL("https://api.github.com/graphql"), body };
}

export function createGhBrokerHandler(
  deps: GhBrokerDeps,
): (request: Request, kind: GhKind) => Promise<Response> {
  return async (request, kind) => {
    if (!deps.enabled()) return brokerError(404, "not_found");

    const bearer = extractCellBearer(request.headers);
    if (!bearer) return brokerError(401, "unauthenticated");
    const step = await resolveCellStep(deps.db, bearer);
    if (!step.ok) return refusalResponse(step.reason);

    const url = new URL(request.url);
    const target =
      kind === "rest"
        ? restTarget(request, url)
        : await graphqlTarget(
            request,
            deps.maxGraphqlBytes ?? MAX_GRAPHQL_BYTES,
          );
    if (!target.ok) return target.response;
    assertOrigin(target.url, "https://api.github.com");

    const [owner, repo] = step.repoFullName.split("/");
    if (!owner || !repo) return brokerError(502, "upstream_error");
    let token: string;
    try {
      token = (await deps.mintReadToken(owner, repo)).token;
    } catch {
      return brokerError(502, "upstream_error");
    }

    const headers = forwardRequestHeaders(request.headers);
    headers.set("authorization", `token ${token}`);
    let upstream: Response;
    try {
      upstream = await deps.fetchImpl(target.url.toString(), {
        method: request.method,
        headers,
        redirect: "manual",
        body: target.body,
      } as RequestInit);
    } catch {
      return brokerError(502, "upstream_error");
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      void upstream.body?.cancel().catch(() => undefined);
      return brokerError(502, "upstream_error");
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeadersForCell(upstream.headers, {
        rewriteLinkHost: url.host,
      }),
    });
  };
}
