import type {
  EgressOrgRef,
  EgressReadOnlyReason,
} from "@terragon/cli-api-contract";
import type { EgressAccessRefusal } from "@terragon/types/egress";
import type { RepoReviewSetting } from "@terragon/shared/db/types";
import {
  getMembership,
  getMembershipByOrganizationSlug,
  getOrganizationById,
} from "@terragon/shared/model/organizations";
import {
  getRepoReviewSetting,
  normalizeRepo,
} from "@terragon/shared/model/repo-review-settings";

import { publicAppUrl } from "@terragon/env/next-public";

import { auth } from "@/lib/auth";
import { verifyDaemonApiKey } from "@/lib/daemon-api-key";
import { DaemonAuthUnavailableError } from "@/lib/daemon-auth-unavailable";
import {
  daemonTokenContextFromApiKey,
  type DaemonTokenContext,
} from "@/lib/daemon-token-context";
import { db } from "@/lib/db";
import { checkRepoWriteAccess } from "@/lib/repo-write-access";
import { isRepoInOrganizationScope } from "@/server-lib/user-repos";

/**
 * Who is calling an egress procedure, and in which org (#728 §4.4).
 *
 * Every check answers with one fixed response, and none depends on whether a
 * later object exists. The caller's org is NEVER the session's active org:
 * `{org}` comes from the request path and is checked against the key's own
 * org (token) or the user's memberships (session).
 */

/** The request context of an egress procedure. */
export interface EgressRequestContext {
  headers: Headers;
  /**
   * True only on the `/api/v1` mount. `/api/cli` sends a wildcard CORS header,
   * so a cookie must never authenticate a request there (spec §8 fix 6).
   */
  allowSession?: boolean;
}

export interface EgressPrincipal {
  userId: string;
  authKind: "api_key" | "session";
  /** The apikey row id or the session row id; never a token value. */
  credentialId: string | null;
  /** The org stamped on a key at mint; null for a personal key and for a session. */
  keyOrganizationId: string | null;
}

export type EgressOrg = EgressOrgRef;

/** The error factories of the contract that the API-key check throws. */
export interface ApiKeyErrors {
  UNAUTHORIZED: () => Error;
  SERVICE_UNAVAILABLE: (options: {
    data: { reason: "auth_unavailable" };
  }) => Error;
}

/** The error factories of the contract that the checks below throw. */
export interface PrincipalErrors extends ApiKeyErrors {
  NOT_FOUND: (options: { message: string }) => Error;
  FORBIDDEN: (options: { data: { reason: EgressAccessRefusal } }) => Error;
}

/** The error factories of the contract that the write-access check throws. */
export interface WriteAccessErrors {
  FORBIDDEN: (options: { data: { reason: EgressAccessRefusal } }) => Error;
  SERVICE_UNAVAILABLE: (options: {
    data: { reason: "github_unavailable" };
  }) => Error;
}

/** Identical for every "not in this org" cause, so the body leaks nothing. */
export const REPO_NOT_FOUND_MESSAGE = "Repository not found";

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * The API key in the request: `X-Daemon-Token`, else `Authorization: Bearer`.
 * `undefined` when neither header is sent; `null` when one is sent but holds
 * no usable key (empty, another scheme, a malformed Bearer). A Bearer value
 * is always an API key, never a session (spec §8 fix 6), and a request that
 * sends either header never reaches the cookie: Better Auth's `bearer()`
 * plugin would otherwise read an `Authorization` header as a session.
 */
function apiKeyFromHeaders(headers: Headers): string | null | undefined {
  const direct = headers.get("X-Daemon-Token");
  if (direct?.trim()) return direct.trim();
  const authorization = headers.get("Authorization");
  if (authorization !== null) {
    return BEARER.exec(authorization.trim())?.[1] ?? null;
  }
  return direct === null ? undefined : null;
}

/**
 * The one API-key check of both mounts: verify the key, answer 503 when the
 * auth store fails (never a 401), and refuse an unknown key or a daemon-scoped
 * token (ADR-003 F1). Callers decide where the key is read from.
 */
export async function verifyApiKeyOrRefuse(
  apiKey: string,
  errors: ApiKeyErrors,
): Promise<DaemonTokenContext> {
  let tenant: DaemonTokenContext | null = null;
  try {
    const key = await verifyDaemonApiKey(apiKey);
    tenant = key ? daemonTokenContextFromApiKey(key) : null;
  } catch (error) {
    if (error instanceof DaemonAuthUnavailableError) {
      throw errors.SERVICE_UNAVAILABLE({
        data: { reason: "auth_unavailable" },
      });
    }
    throw error;
  }
  if (!tenant || tenant.tokenType === "daemon") throw errors.UNAUTHORIZED();
  return tenant;
}

async function principalFromApiKey(
  token: string,
  errors: PrincipalErrors,
): Promise<EgressPrincipal> {
  const tenant = await verifyApiKeyOrRefuse(token, errors);
  return {
    userId: tenant.userId,
    authKind: "api_key",
    credentialId: tenant.apiKeyId,
    keyOrganizationId: tenant.organizationId,
  };
}

async function principalFromSession(
  headers: Headers,
  errors: PrincipalErrors,
): Promise<EgressPrincipal> {
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers });
  } catch (error) {
    // The session store failed: retryable, never a 500. Only the error's name
    // is logged: a failed-query message can carry the session token.
    console.error("Egress session lookup failed", {
      error: error instanceof Error ? error.name : typeof error,
    });
    throw errors.SERVICE_UNAVAILABLE({ data: { reason: "auth_unavailable" } });
  }
  if (!session) throw errors.UNAUTHORIZED();
  return {
    userId: session.user.id,
    authKind: "session",
    credentialId: session.session.id,
    keyOrganizationId: null,
  };
}

/**
 * Step 1, the credential. A credential header that is present but unknown or
 * unusable is a 401 with no fallback to the cookie. No credential header: the
 * session, on the `/api/v1` mount only.
 */
export async function resolveEgressPrincipal(
  context: EgressRequestContext,
  errors: PrincipalErrors,
): Promise<EgressPrincipal> {
  const token = apiKeyFromHeaders(context.headers);
  if (token) return principalFromApiKey(token, errors);
  if (token === null || !context.allowSession) throw errors.UNAUTHORIZED();
  return principalFromSession(context.headers, errors);
}

async function orgOrRefuse(
  organizationId: string,
  errors: PrincipalErrors,
): Promise<EgressOrg> {
  const org = await getOrganizationById({ db, organizationId });
  if (!org) throw errors.FORBIDDEN({ data: { reason: "org_forbidden" } });
  return { id: org.id, slug: org.slug };
}

async function orgForApiKey(
  principal: EgressPrincipal,
  orgParam: string,
  errors: PrincipalErrors,
): Promise<EgressOrg> {
  if (!principal.keyOrganizationId) {
    throw errors.FORBIDDEN({ data: { reason: "org_required" } });
  }
  const organizationId = principal.keyOrganizationId;
  // Both reads depend on the key only; the decisions below keep their order.
  const [row, membership] = await Promise.all([
    getOrganizationById({ db, organizationId }),
    getMembership({ db, organizationId, userId: principal.userId }),
  ]);
  // Decided from the key's own org only, so it says nothing about other orgs.
  if (!row) throw errors.FORBIDDEN({ data: { reason: "org_forbidden" } });
  if (orgParam !== row.id && orgParam !== row.slug) {
    throw errors.FORBIDDEN({ data: { reason: "org_mismatch" } });
  }
  // A key keeps its org after its user leaves it: check the live membership.
  if (!membership) {
    throw errors.FORBIDDEN({ data: { reason: "org_forbidden" } });
  }
  return { id: row.id, slug: row.slug };
}

async function orgForSession(
  principal: EgressPrincipal,
  orgParam: string,
  errors: PrincipalErrors,
): Promise<EgressOrg> {
  const membership =
    (await getMembership({
      db,
      organizationId: orgParam,
      userId: principal.userId,
    })) ??
    (await getMembershipByOrganizationSlug({
      db,
      slug: orgParam,
      userId: principal.userId,
    }));
  // Identical for an unknown org and a non-member.
  if (!membership) {
    throw errors.FORBIDDEN({ data: { reason: "org_forbidden" } });
  }
  return orgOrRefuse(membership.organizationId, errors);
}

/** Step 3, the org: `{org}` as an id or slug, never the session's active org. */
export function resolveEgressOrg(
  principal: EgressPrincipal,
  orgParam: string,
  errors: PrincipalErrors,
): Promise<EgressOrg> {
  return principal.authKind === "api_key"
    ? orgForApiKey(principal, orgParam, errors)
    : orgForSession(principal, orgParam, errors);
}

/**
 * Step 4, the repo is in the org: the org already has a settings row for it,
 * or the repo's owner is in the org's repo scope (the same rule the task
 * creation path enforces). One `NOT_FOUND`, byte-identical for every cause.
 */
export async function assertRepoInOrg({
  org,
  owner,
  repo,
  errors,
}: {
  org: EgressOrg;
  owner: string;
  repo: string;
  errors: PrincipalErrors;
}): Promise<RepoInOrg> {
  const repoFullName = normalizeRepo(`${owner}/${repo}`);
  const row = await getRepoReviewSetting({
    db,
    organizationId: org.id,
    repoFullName,
  });
  const inScope =
    row !== undefined ||
    (await isRepoInOrganizationScope({
      organizationId: org.id,
      repoFullName,
    }));
  if (!inScope) throw errors.NOT_FOUND({ message: REPO_NOT_FOUND_MESSAGE });
  return { repoFullName, row };
}

/** The repo's normalized name and its settings row, when the org has one. */
export interface RepoInOrg {
  repoFullName: string;
  row: RepoReviewSetting | undefined;
}

export interface ReadEditAccess {
  canEdit: boolean;
  readOnlyReason: EgressReadOnlyReason | null;
}

/**
 * Step 5 for reads: whether the caller could edit, never an error. A failed
 * admin lookup is not a failure of the read (spec §8 fix 7): `canEdit` is
 * false with `permission_unverified`.
 */
export async function readEditAccess({
  userId,
  organizationId,
  repoFullName,
}: {
  userId: string;
  organizationId: string;
  repoFullName: string;
}): Promise<ReadEditAccess> {
  const access = await checkRepoWriteAccess({
    db,
    userId,
    organizationId,
    repoFullName,
  });
  if (access === "allowed") return { canEdit: true, readOnlyReason: null };
  const readOnlyReason =
    access === "lookup_failed" ? "permission_unverified" : "not_repo_admin";
  return { canEdit: false, readOnlyReason };
}

/** The public app origin, or null when the URL cannot be parsed. */
function appOrigin(): string | null {
  try {
    return new URL(publicAppUrl()).origin;
  } catch {
    return null;
  }
}

/**
 * Step 2: a session-authenticated write must come from this app's own origin
 * (a cookie is sent by any site, so this is the CSRF guard). An API key is
 * exempt: it is never sent by a browser on its own. Refused with 403
 * `origin_mismatch` (spec section 8 fix 5).
 */
export async function assertSessionWriteOrigin(
  principal: EgressPrincipal,
  headers: Headers,
  errors: Pick<PrincipalErrors, "FORBIDDEN">,
): Promise<void> {
  if (principal.authKind !== "session") return;
  const origin = headers.get("Origin");
  // Spec §8 fix 5: the app's own public origin, plus Better Auth's own
  // trusted-origin rule (one source of truth for the configured list).
  const trusted =
    origin !== null &&
    (origin === appOrigin() ||
      (await auth.$context).isTrustedOrigin(origin, {
        allowRelativePaths: false,
      }));
  if (!trusted) {
    throw errors.FORBIDDEN({ data: { reason: "origin_mismatch" } });
  }
}

/**
 * Step 5 for writes (`update`, `dryRun` included): the caller must be an org
 * admin or a GitHub admin of the repo (OD-7). A lookup that cannot answer is
 * a retryable 503, never an allow.
 */
export async function assertRepoWriteAccess({
  userId,
  organizationId,
  repoFullName,
  errors,
}: {
  userId: string;
  organizationId: string;
  repoFullName: string;
  errors: WriteAccessErrors;
}): Promise<void> {
  const access = await checkRepoWriteAccess({
    db,
    userId,
    organizationId,
    repoFullName,
  });
  if (access === "allowed") return;
  if (access === "lookup_failed") {
    throw errors.SERVICE_UNAVAILABLE({
      data: { reason: "github_unavailable" },
    });
  }
  throw errors.FORBIDDEN({ data: { reason: "not_repo_admin" } });
}
