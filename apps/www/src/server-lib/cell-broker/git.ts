import type { DB } from "@terragon/shared/db";

import {
  assertOrigin,
  brokerError,
  decodePathSegments,
  extractCellBearer,
  forwardRequestHeaders,
  gitAuthChallenge,
  isUnsafeSegment,
  refusalResponse,
  resolveCellStep,
  responseHeadersForCell,
} from "./common";

/**
 * Remote-cell git broker (#606): a smart-HTTP proxy that lets a cell clone and
 * fetch (and, in phase E, push) without holding a GitHub credential. The
 * upstream URL is built from the STEP's repository, never from the request
 * path, and the installation token is injected server-side.
 */

const ROUTE_PREFIX = "/api/cell/git";
const UPLOAD_PACK = "git-upload-pack";
const RECEIVE_PACK = "git-receive-pack";

export interface GitBrokerDeps {
  db: DB;
  fetchImpl: typeof fetch;
  mintReadToken: (owner: string, repo: string) => Promise<{ token: string }>;
  mintWriteToken: (owner: string, repo: string) => Promise<{ token: string }>;
  sideEffectsEnabled: () => boolean;
  enabled: () => boolean;
}

type Leg = "upload-pack" | "receive-pack-advert" | "receive-pack-post";

/** The allowlisted git smart-HTTP call this request is, or null. */
function classifyLeg(
  method: string,
  endpoint: string,
  search: URLSearchParams,
): Leg | null {
  if (method === "GET" && endpoint === "info/refs") {
    const keys = [...search.keys()];
    const service = search.getAll("service");
    if (keys.length !== 1 || service.length !== 1) return null;
    if (service[0] === UPLOAD_PACK) return "upload-pack";
    if (service[0] === RECEIVE_PACK) return "receive-pack-advert";
    return null;
  }
  if (method === "POST" && [...search.keys()].length === 0) {
    if (endpoint === UPLOAD_PACK) return "upload-pack";
    if (endpoint === RECEIVE_PACK) return "receive-pack-post";
  }
  return null;
}

export function createGitBrokerHandler(
  deps: GitBrokerDeps,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!deps.enabled()) return brokerError(404, "not_found");

    const bearer = extractCellBearer(request.headers);
    if (!bearer) return gitAuthChallenge();
    const step = await resolveCellStep(deps.db, bearer);
    if (!step.ok) return refusalResponse(step.reason);

    const url = new URL(request.url);
    const decoded = decodePathSegments(url.pathname, ROUTE_PREFIX);
    if (!decoded.ok) return brokerError(400, "bad_request");
    const [owner, repoGit, ...endpointParts] = decoded.segments;
    if (!owner || !repoGit || endpointParts.length === 0) {
      return brokerError(403, "forbidden_path");
    }
    if (
      decoded.segments.some((segment) => isUnsafeSegment(segment, "git")) ||
      !repoGit.endsWith(".git")
    ) {
      return brokerError(403, "forbidden_path");
    }
    const requestRepo = `${owner}/${repoGit.slice(0, -".git".length)}`;
    if (requestRepo.toLowerCase() !== step.repoFullName) {
      return brokerError(403, "forbidden_path");
    }

    const endpoint = endpointParts.join("/");
    const leg = classifyLeg(request.method, endpoint, url.searchParams);
    if (!leg) return brokerError(403, "forbidden_path");

    const isPush = leg !== "upload-pack";
    if (isPush && !deps.sideEffectsEnabled()) {
      return brokerError(503, "side_effects_disabled");
    }
    if (leg === "receive-pack-post") {
      return brokerError(501, "push_not_implemented");
    }

    // The upstream URL comes from the step's repo and the allowlisted endpoint.
    const [stepOwner, stepRepo] = step.repoFullName.split("/");
    if (!stepOwner || !stepRepo) return brokerError(502, "upstream_error");
    const upstreamUrl = new URL("https://github.com");
    upstreamUrl.pathname = `/${encodeURIComponent(stepOwner)}/${encodeURIComponent(stepRepo)}.git/${endpoint}`;
    if (endpoint === "info/refs") {
      upstreamUrl.searchParams.set(
        "service",
        leg === "upload-pack" ? UPLOAD_PACK : RECEIVE_PACK,
      );
    }
    assertOrigin(upstreamUrl, "https://github.com");

    let token: string;
    try {
      const minted = isPush
        ? await deps.mintWriteToken(stepOwner, stepRepo)
        : await deps.mintReadToken(stepOwner, stepRepo);
      token = minted.token;
    } catch {
      return brokerError(502, "upstream_error");
    }

    const headers = forwardRequestHeaders(request.headers);
    headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
    const hasBody = request.method === "POST";
    let upstream: Response;
    try {
      upstream = await deps.fetchImpl(upstreamUrl.toString(), {
        method: request.method,
        headers,
        redirect: "manual",
        body: hasBody ? request.body : undefined,
        // Node requires duplex for a streaming request body.
        ...(hasBody ? { duplex: "half" } : {}),
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
      headers: responseHeadersForCell(upstream.headers),
    });
  };
}
