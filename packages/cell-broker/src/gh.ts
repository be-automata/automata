import type { DB } from "@terragon/shared/db";
import { graphqlHasMutation } from "@terragon/utils/graphql-mutation";

import {
  assertOrigin,
  authorizeCellRequest,
  brokerError,
  decodePathSegments,
  followAllowedRedirect,
  forwardRequestHeaders,
  hasUnsupportedContentEncoding,
  internalError,
  mintFailureResponse,
  isUnsafeSegment,
  passThrough,
  readCapped,
  type TokenMinter,
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
  mintReadToken: TokenMinter;
  enabled: () => boolean;
  /** Cap on a GraphQL request body. Defaults to 1 MiB. */
  maxGraphqlBytes?: number;
}

type Built =
  | { ok: true; url: URL; body?: Uint8Array }
  | { ok: false; response: Response };

/**
 * #727 OD-3: REST reads stay on the run's repository. `/rate_limit` and
 * `/meta` are what gh calls outside a repo. The token already bounds what
 * GitHub returns; this keeps a cell from reading other public repos.
 */
const REPO_FREE_REST_PATHS: ReadonlySet<string> = new Set([
  "rate_limit",
  "meta",
]);

/** `owner` and `repo` are the bearer's step repo, already lowercased. */
function restPathAllowed(
  segments: readonly string[],
  owner: string,
  repo: string,
): boolean {
  // A segment may hold an encoded slash (`feat%2Fx`); a dot component behind
  // one could climb out of the repo at an upstream that decodes `%2F`.
  if (segments.some((s) => s.split("/").some((p) => p === "." || p === ".."))) {
    return false;
  }
  const [first, segOwner, segRepo] = segments;
  if (segments.length === 1 && first !== undefined) {
    return REPO_FREE_REST_PATHS.has(first);
  }
  return (
    first === "repos" &&
    segOwner?.toLowerCase() === owner &&
    segRepo?.toLowerCase() === repo
  );
}

function restTarget(
  request: Request,
  url: URL,
  scope: { owner: string; repo: string },
): Built {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return { ok: false, response: brokerError(403, "forbidden_method") };
  }
  const decoded = decodePathSegments(url.pathname, REST_PREFIX);
  if (!decoded.ok) {
    return { ok: false, response: brokerError(400, "bad_request") };
  }
  if (
    decoded.segments.some((segment) => isUnsafeSegment(segment, "gh")) ||
    !restPathAllowed(decoded.segments, scope.owner, scope.repo)
  ) {
    return { ok: false, response: brokerError(403, "forbidden_path") };
  }
  const upstream = new URL("https://api.github.com");
  upstream.pathname = `/${decoded.segments.map(encodeURIComponent).join("/")}`;
  upstream.search = url.search;
  return { ok: true, url: upstream };
}

async function graphqlTarget(
  request: Request,
  maxBytes: number,
): Promise<Built> {
  if (request.method !== "POST") {
    return { ok: false, response: brokerError(403, "forbidden_method") };
  }
  if (hasUnsupportedContentEncoding(request.headers)) {
    return { ok: false, response: brokerError(415, "unsupported_encoding") };
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: brokerError(413, "payload_too_large") };
  }
  let body: Uint8Array | null;
  try {
    body = await readCapped(request.body, maxBytes);
  } catch {
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
    const auth = await authorizeCellRequest(deps, request, {
      onMissingBearer: () => brokerError(401, "unauthenticated"),
    });
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const target =
      kind === "rest"
        ? restTarget(request, url, auth)
        : await graphqlTarget(
            request,
            deps.maxGraphqlBytes ?? MAX_GRAPHQL_BYTES,
          );
    if (!target.ok) return target.response;
    try {
      assertOrigin(target.url, "https://api.github.com");
    } catch {
      return internalError("upstream_origin");
    }

    let token: string;
    try {
      token = (await deps.mintReadToken(auth.owner, auth.repo)).token;
    } catch (error) {
      return mintFailureResponse(error);
    }

    const headers = forwardRequestHeaders(request.headers);
    headers.set("authorization", `token ${token}`);
    let upstream: Response;
    try {
      upstream = await followAllowedRedirect({
        upstream: await deps.fetchImpl(target.url.toString(), {
          method: request.method,
          headers,
          redirect: "manual",
          body: target.body,
        } as RequestInit),
        request,
        token,
        fetchImpl: deps.fetchImpl,
      });
    } catch {
      return brokerError(502, "upstream_error");
    }
    return passThrough(upstream, {
      rewriteLinkHost: url.host,
      ...(kind === "rest"
        ? { linkRepo: { owner: auth.owner, repo: auth.repo } }
        : {}),
    });
  };
}
