import { and, eq } from "drizzle-orm";

import type { DB } from "@terragon/shared/db";
import { thread } from "@terragon/shared/db/schema";
import {
  verifyBearer,
  type BearerContext,
  type Refusal,
} from "@terragon/shared/model/cell-authority";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";
import { HOP_BY_HOP, REQUEST_OWNED } from "@terragon/utils/broker-headers";

/**
 * Helpers shared by the remote-cell broker routes (git and gh, #606). Pure and
 * framework-light: route logic lives in the routes. Nothing here logs a bearer
 * or a token.
 */

/** Mints an installation token scoped to one repository. */
export type TokenMinter = (
  owner: string,
  repo: string,
) => Promise<{ token: string }>;
export function notFound(): Response {
  return brokerError(404, "not_found");
}

export function brokerError(
  status: number,
  code: string,
  headers?: HeadersInit,
): Response {
  return Response.json({ error: code }, { status, headers });
}

/**
 * The answer for a failed token mint. An installation that lacks a permission
 * the token needs is a 403 `missing_permission` naming that one permission and
 * the level needed (never the granted map or a token); any other failure is a
 * 502. Matched by name, not `instanceof`: MissingInstallationPermissionError
 * comes from a module that tests replace wholesale.
 */
export function mintFailureResponse(error: unknown): Response {
  if (
    error instanceof Error &&
    error.name === "MissingInstallationPermissionError"
  ) {
    const { permission, needed } = error as Error & {
      permission?: unknown;
      needed?: unknown;
    };
    return Response.json(
      { error: "missing_permission", permission, needed },
      { status: 403 },
    );
  }
  return brokerError(502, "upstream_error");
}

/**
 * 500 for a failure inside the broker (database or URL construction). Logs a
 * fixed string only: an error message could carry a URL or a token.
 */
export function internalError(where: string): Response {
  console.error(`cell-broker: internal_error (${where})`);
  return brokerError(500, "internal_error");
}

/** 401 for a git request with no credential, so git retries with its helper. */
export function gitAuthChallenge(): Response {
  return brokerError(401, "unauthenticated", {
    "www-authenticate": 'Basic realm="automata-cell"',
  });
}

const REFUSAL_STATUS: Record<Refusal, number> = {
  unknown_bearer: 401,
  expired: 401,
  revoked: 401,
  fenced: 409,
  step_done: 409,
  effect_in_progress: 409,
  effect_budget_exhausted: 429,
};

export function refusalResponse(reason: Refusal): Response {
  return brokerError(REFUSAL_STATUS[reason], reason);
}

const CREDENTIAL = /^\s*(bearer|token|basic)\s+(\S+)\s*$/i;

/**
 * The cell bearer from `Authorization`: `Bearer x`, `token x` (gh) or
 * `Basic base64(user:pass)` where the password is the bearer (git's credential
 * helper). Null when absent, malformed or empty.
 */
export function extractCellBearer(headers: Headers): string | null {
  const match = CREDENTIAL.exec(headers.get("authorization") ?? "");
  if (!match) return null;
  const scheme = (match[1] ?? "").toLowerCase();
  const value = match[2] ?? "";
  if (scheme !== "basic") return value.trim() || null;
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return decoded.slice(colon + 1).trim() || null;
}

/**
 * Verify the bearer, then bind it to the repository of the thread that owns
 * the step. The thread must belong to the bearer's organization; a missing
 * thread reads as an unknown bearer.
 */
export async function resolveCellStep(
  db: DB,
  token: string,
): Promise<
  | { ok: true; context: BearerContext; repoFullName: string }
  | { ok: false; reason: Refusal }
> {
  const verified = await verifyBearer({ db, token });
  if (!verified.ok) return verified;
  const { context } = verified;
  const rows = await db
    .select({ repo: thread.githubRepoFullName })
    .from(thread)
    .where(
      and(
        eq(thread.id, context.threadId),
        eq(thread.organizationId, context.organizationId),
      ),
    )
    .limit(1);
  const repo = rows[0]?.repo;
  if (!repo) return { ok: false, reason: "unknown_bearer" };
  return { ok: true, context, repoFullName: normalizeRepo(repo) };
}

/**
 * The decoded path segments after `prefix`. A trailing empty segment is
 * dropped; a malformed percent escape is not ok. No other filtering here.
 */
export function decodePathSegments(
  pathname: string,
  prefix: string,
): { ok: true; segments: string[] } | { ok: false } {
  if (!pathname.startsWith(prefix)) return { ok: false };
  const rest = pathname.slice(prefix.length);
  if (rest !== "" && !rest.startsWith("/")) return { ok: false };
  const raw = rest.split("/").slice(1);
  if (raw[raw.length - 1] === "") raw.pop();
  try {
    return { ok: true, segments: raw.map((s) => decodeURIComponent(s)) };
  } catch {
    return { ok: false };
  }
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** True when a decoded path segment must be refused (403). */
export function isUnsafeSegment(seg: string, mode: "git" | "gh"): boolean {
  if (seg === "." || seg === ".." || seg.includes("\\")) return true;
  if (CONTROL_CHARS.test(seg)) return true;
  if (mode === "git") {
    return seg === "" || seg.includes("/") || seg.includes("%");
  }
  return false;
}

// The cell's own envelope and edge headers never go upstream.
const REQUEST_DENIED = new Set([
  "cookie",
  "expect",
  "te",
  "proxy-authorization",
  "x-real-ip",
  "true-client-ip",
]);
const REQUEST_DENIED_PREFIXES = ["cf-", "x-forwarded-"];

/**
 * The request headers to send upstream: everything but the denylist.
 * `content-encoding` is kept (upload-pack bodies are gzipped); the route
 * decides the 415 for receive-pack.
 */
export function forwardRequestHeaders(incoming: Headers): Headers {
  const out = new Headers();
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === "content-encoding") {
      out.set(name, value);
      return;
    }
    if (REQUEST_OWNED.has(lower) || REQUEST_DENIED.has(lower)) return;
    if (REQUEST_DENIED_PREFIXES.some((p) => lower.startsWith(p))) return;
    out.set(name, value);
  });
  return out;
}

/**
 * The upstream response headers to hand back to the cell. Framing headers and
 * cookies are dropped, no CORS header is ever added. With `rewriteLinkHost`,
 * `Link` URLs on api.github.com point at this broker so `gh --paginate` stays
 * on it.
 */
export function responseHeadersForCell(
  upstream: Headers,
  opts?: { rewriteLinkHost?: string },
): Headers {
  const out = new Headers();
  upstream.forEach((value, name) => {
    const lower = name.toLowerCase();
    // GitHub's own auth challenge must not reach the cell's credential helper.
    if (lower === "set-cookie" || lower === "www-authenticate") return;
    if (HOP_BY_HOP.has(lower)) return;
    if (lower === "link" && opts?.rewriteLinkHost) {
      out.set(
        name,
        value.replaceAll(
          "https://api.github.com/",
          `https://${opts.rewriteLinkHost}/api/v3/`,
        ),
      );
      return;
    }
    out.set(name, value);
  });
  return out;
}

/** Throws when a built upstream URL is not on the expected fixed origin. */
export function assertOrigin(url: URL, origin: string): void {
  if (url.origin !== origin) {
    throw new Error(`upstream origin mismatch: expected ${origin}`);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Stop reading a stream and drop the rest. A failed cancel changes nothing. */
export function discard(
  source: { cancel(): Promise<void> } | null | undefined,
): void {
  if (!source) return;
  void (async () => {
    try {
      await source.cancel();
    } catch {
      // Nothing is left to read either way.
    }
  })();
}

/** A redirect GitHub could send; other 3xx (a 304, say) are ordinary answers. */
export function isRedirect(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/**
 * Any 3xx. `passThrough` forwards a 304 (an ordinary answer to a conditional
 * read); a push treats every 3xx as an upstream error, since a redirect is
 * never followed and a 304 cannot answer a receive-pack POST.
 */
export function isAny3xx(status: number): boolean {
  return status >= 300 && status < 400;
}

/** True for a request body encoding the broker cannot read (not identity). */
export function hasUnsupportedContentEncoding(headers: Headers): boolean {
  const encoding = headers.get("content-encoding");
  return !!encoding && encoding.trim().toLowerCase() !== "identity";
}

const REDIRECT_HOSTS = new Set([
  "codeload.github.com",
  "objects.githubusercontent.com",
  "github-cloud.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "api.github.com",
]);

function isAllowedRedirectHost(hostname: string): boolean {
  // Leading-dot suffixes: "evilactions.githubusercontent.com" does not match.
  return (
    REDIRECT_HOSTS.has(hostname) ||
    hostname.endsWith(".blob.core.windows.net") ||
    hostname.endsWith(".actions.githubusercontent.com")
  );
}

/**
 * Follow ONE redirect of a read, only to an allowlisted https host (release
 * assets and archives live on codeload and the objects hosts; a renamed repo
 * redirects back to api.github.com). GET and HEAD only. A hop to api.github.com
 * carries the token; a hop anywhere else carries NO credential and only the
 * cell's Accept and Range. Anything else (another host, a non-https or odd-port
 * Location, a non-read method) is returned unchanged, so `passThrough` turns it
 * into a 502; so is a second redirect, since the followed response is not
 * followed again.
 */
export async function followAllowedRedirect({
  upstream,
  request,
  token,
  fetchImpl,
}: {
  upstream: Response;
  request: Request;
  token: string;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  if (!isRedirect(upstream.status)) return upstream;
  if (request.method !== "GET" && request.method !== "HEAD") return upstream;
  const location = upstream.headers.get("location");
  let target: URL;
  try {
    target = new URL(location ?? "", "https://api.github.com/");
  } catch {
    return upstream;
  }
  if (
    !location ||
    target.protocol !== "https:" ||
    target.port !== "" ||
    !isAllowedRedirectHost(target.hostname)
  ) {
    return upstream;
  }
  discard(upstream.body);
  let headers: Headers;
  if (target.hostname === "api.github.com") {
    headers = forwardRequestHeaders(request.headers);
    headers.set("authorization", `token ${token}`);
  } else {
    headers = new Headers();
    for (const name of ["accept", "range"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
  }
  return fetchImpl(target.toString(), {
    method: request.method,
    headers,
    redirect: "manual",
  } as RequestInit);
}

/**
 * Hand GitHub's answer back to the cell, streamed. A redirect is never
 * followed or forwarded: it is a 502.
 */
export function passThrough(
  upstream: Response,
  opts?: { rewriteLinkHost?: string },
): Response {
  if (isRedirect(upstream.status)) {
    discard(upstream.body);
    return brokerError(502, "upstream_error");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeadersForCell(upstream.headers, opts),
  });
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Read a stream fully. Null when it is over `maxBytes` (the stream is
 * cancelled); a read error propagates. A null stream is an empty body.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return concatBytes(...chunks);
    total += chunk.value.length;
    if (total > maxBytes) {
      discard(reader);
      return null;
    }
    chunks.push(chunk.value);
  }
}

export interface CellAuthDeps {
  db: DB;
  enabled: () => boolean;
}

export type CellAuthorization =
  | {
      ok: true;
      bearer: string;
      context: BearerContext;
      /** The step's repository, normalized (`owner/repo`, lowercase). */
      repoFullName: string;
      owner: string;
      repo: string;
    }
  | { ok: false; response: Response };

/**
 * The gate every broker request passes first: the switch (404), the cell
 * bearer (`onMissingBearer` decides the answer), the bearer's step, and the
 * step's repository.
 */
export async function authorizeCellRequest(
  deps: CellAuthDeps,
  request: Request,
  opts: { onMissingBearer: () => Response },
): Promise<CellAuthorization> {
  if (!deps.enabled()) return { ok: false, response: notFound() };
  const bearer = extractCellBearer(request.headers);
  if (!bearer) return { ok: false, response: opts.onMissingBearer() };
  let step: Awaited<ReturnType<typeof resolveCellStep>>;
  try {
    step = await resolveCellStep(deps.db, bearer);
  } catch {
    return { ok: false, response: internalError("resolve_step") };
  }
  if (!step.ok) return { ok: false, response: refusalResponse(step.reason) };
  const [owner, repo] = step.repoFullName.split("/");
  if (!owner || !repo) {
    return { ok: false, response: brokerError(502, "upstream_error") };
  }
  return {
    ok: true,
    bearer,
    context: step.context,
    repoFullName: step.repoFullName,
    owner,
    repo,
  };
}

/** Mints a one-repo write token; `allowWorkflows` is the org opt-in (#609). */
export type WriteTokenMinter = (
  owner: string,
  repo: string,
  opts: { allowWorkflows: boolean },
) => Promise<{ token: string }>;
