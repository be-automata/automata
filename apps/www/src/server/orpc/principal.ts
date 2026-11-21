import type { EgressAccessRefusal } from "@terragon/types/egress";
import {
  getMembership,
  getMembershipByOrganizationSlug,
  getOrganizationById,
} from "@terragon/shared/model/organizations";
import {
  getRepoReviewSetting,
  normalizeRepo,
} from "@terragon/shared/model/repo-review-settings";

import { auth } from "@/lib/auth";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { DaemonAuthUnavailableError } from "@/lib/daemon-auth-unavailable";
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

export interface EgressOrg {
  id: string;
  slug: string;
}

/** The error factories of the contract that the checks below throw. */
export interface PrincipalErrors {
  UNAUTHORIZED: () => Error;
  NOT_FOUND: (options: { message: string }) => Error;
  FORBIDDEN: (options: { data: { reason: EgressAccessRefusal } }) => Error;
  SERVICE_UNAVAILABLE: (options: {
    data: { reason: "auth_unavailable" };
  }) => Error;
}

/** Identical for every "not in this org" cause, so the body leaks nothing. */
export const REPO_NOT_FOUND_MESSAGE = "Repository not found";

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * The API key in the request: `X-Daemon-Token`, else `Authorization: Bearer`.
 * A Bearer value is always an API key, never a session (spec §8 fix 6).
 */
function apiKeyFromHeaders(headers: Headers): string | null {
  const direct = headers.get("X-Daemon-Token")?.trim();
  if (direct) return direct;
  const bearer = BEARER.exec(headers.get("Authorization")?.trim() ?? "");
  return bearer?.[1] ?? null;
}

async function principalFromApiKey(
  token: string,
  errors: PrincipalErrors,
): Promise<EgressPrincipal> {
  let tenant: Awaited<ReturnType<typeof getDaemonTokenContext>>;
  try {
    // One verifier: the Bearer form is fed to the same `X-Daemon-Token` reader.
    tenant = await getDaemonTokenContext({
      headers: new Headers({ "X-Daemon-Token": token }),
    });
  } catch (error) {
    if (error instanceof DaemonAuthUnavailableError) {
      throw errors.SERVICE_UNAVAILABLE({
        data: { reason: "auth_unavailable" },
      });
    }
    throw error;
  }
  // ADR-003 F1: a daemon-scoped token never grants API access.
  if (!tenant || tenant.tokenType === "daemon") {
    throw errors.UNAUTHORIZED();
  }
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
  const session = await auth.api.getSession({ headers });
  if (!session) throw errors.UNAUTHORIZED();
  return {
    userId: session.user.id,
    authKind: "session",
    credentialId: session.session.id,
    keyOrganizationId: null,
  };
}

/**
 * Step 1, the credential. A token that is present but unknown is a 401 with no
 * fallback to the cookie. No token: the session, on the `/api/v1` mount only.
 */
export async function resolveEgressPrincipal(
  context: EgressRequestContext,
  errors: PrincipalErrors,
): Promise<EgressPrincipal> {
  const token = apiKeyFromHeaders(context.headers);
  if (token) return principalFromApiKey(token, errors);
  if (!context.allowSession) throw errors.UNAUTHORIZED();
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
  // Decided from the key's own org only, so it says nothing about other orgs.
  const org = await orgOrRefuse(principal.keyOrganizationId, errors);
  if (orgParam !== org.id && orgParam !== org.slug) {
    throw errors.FORBIDDEN({ data: { reason: "org_mismatch" } });
  }
  // A key keeps its org after its user leaves it: check the live membership.
  const membership = await getMembership({
    db,
    organizationId: org.id,
    userId: principal.userId,
  });
  if (!membership) {
    throw errors.FORBIDDEN({ data: { reason: "org_forbidden" } });
  }
  return org;
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
}): Promise<string> {
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
  return repoFullName;
}

export interface ReadEditAccess {
  canEdit: boolean;
  readOnlyReason: "not_repo_admin" | "permission_unverified" | null;
}

/**
 * Step 5 for reads: whether the caller could edit, never an error. A failed
 * admin lookup is not a failure of the read (spec §8 fix 7): `canEdit` is
 * false with `permission_unverified`.
 */
export async function readEditAccess({
  userId,
  org,
  repoFullName,
}: {
  userId: string;
  org: EgressOrg;
  repoFullName: string;
}): Promise<ReadEditAccess> {
  const access = await checkRepoWriteAccess({
    db,
    userId,
    organizationId: org.id,
    repoFullName,
  });
  if (access === "allowed") return { canEdit: true, readOnlyReason: null };
  const readOnlyReason =
    access === "lookup_failed" ? "permission_unverified" : "not_repo_admin";
  return { canEdit: false, readOnlyReason };
}
