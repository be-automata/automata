import { and, eq } from "drizzle-orm";

import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import { thread } from "@terragon/shared/db/schema";
import {
  verifyBearer,
  type BearerContext,
  type Refusal,
} from "@terragon/shared/model/cell-authority";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";

/**
 * Helpers shared by the remote-cell broker routes (git and gh, #606). Pure and
 * framework-light: route logic lives in the routes. Nothing here logs a bearer
 * or a token.
 */

export type CellBrokerOrigin = "https://github.com" | "https://api.github.com";

export function cellBrokerEnabled(): boolean {
  return env.CELL_BROKER_ENABLED;
}

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

export function refusalStatus(reason: Refusal): number {
  return REFUSAL_STATUS[reason];
}

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

// Mirrors packages/worker/src/agent-run/broker-common.ts (HOP_BY_HOP,
// REQUEST_OWNED): www must not import the worker. Keep the two in step.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "upgrade",
]);
const REQUEST_OWNED = new Set([...HOP_BY_HOP, "authorization", "host"]);
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
    if (lower === "set-cookie" || HOP_BY_HOP.has(lower)) return;
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
export function assertOrigin(url: URL, origin: CellBrokerOrigin): void {
  if (url.origin !== origin) {
    throw new Error(`upstream origin mismatch: expected ${origin}`);
  }
}
