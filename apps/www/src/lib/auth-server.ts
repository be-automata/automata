import { auth } from "./auth";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import {
  User,
  Session,
  UserSettings,
  UserFlags,
  UserCredentials,
} from "@terragon/shared";
import { getUserSettings } from "@terragon/shared/model/user";
import { getUserFlags } from "@terragon/shared/model/user-flags";
import { getMembership } from "@terragon/shared/model/organizations";
import { ORG_ADMIN_ROLES } from "@/lib/org-admin-roles";
import { cache } from "react";
import { env } from "@terragon/env/apps-www";
import { getFeatureFlagsForUser } from "@terragon/shared/model/feature-flags";
import { UserCookies } from "@/lib/cookies";
import { getUserCookies } from "./cookies-server";
import { redirect } from "next/navigation";
import {
  ServerActionOptions,
  wrapServerActionInternal,
  UserFacingError,
  ServerActionResult,
} from "./server-actions";
import { getUserCredentials } from "@/server-lib/user-credentials";
import {
  DaemonTokenContext,
  daemonTokenContextFromApiKey,
} from "./daemon-token-context";

export const getSessionOrNull = cache(
  async (): Promise<{
    session: Session;
    user: User;
  } | null> => {
    const session = await auth.api.getSession({
      headers: await headers(),
    });
    return session ?? null;
  },
);

export async function getUserIdOrNull(): Promise<User["id"] | null> {
  const session = await getSessionOrNull();
  return session?.user.id ?? null;
}

/**
 * Tenant context for the request: the user plus their active organization (from
 * `session.activeOrganizationId`, set by the Better Auth organization plugin).
 *
 * This is the guard-layer seam that threads `organizationId` alongside `userId`
 * down to the tenant-scoped model layer (WI-5 / ADR-001). `organizationId` is
 * nullable during the backfill phase — a session may not have an active org yet.
 * The threads path passes both to `forTenant` (@terragon/shared) once an active
 * org is present.
 */
export type TenantContext = {
  userId: string;
  organizationId: string | null;
};

export async function getTenantContextOrNull(): Promise<TenantContext | null> {
  const session = await getSessionOrNull();
  if (!session) {
    return null;
  }
  return {
    userId: session.user.id,
    organizationId: session.session.activeOrganizationId ?? null,
  };
}

/**
 * The session's active org, only while `userId` is still a member of it —
 * with that membership's role, so a caller can gate on it without a second
 * read. Null without an active org or once the membership is gone.
 */
export async function getActiveOrganizationMembershipOrNull(
  userId: string,
): Promise<{ organizationId: string; role: string } | null> {
  const tenant = await getTenantContextOrNull();
  const organizationId = tenant?.organizationId;
  if (!organizationId) {
    return null;
  }
  const membership = await getMembership({ db, organizationId, userId });
  return membership ? { organizationId, role: membership.role } : null;
}

/** The org-switch race a page-scoped org action refuses. */
export const ACTIVE_ORGANIZATION_CHANGED_MESSAGE =
  "Your active organization changed in another tab. Reload the page and try again.";

export interface ExpectedActiveMembershipOptions {
  /**
   * The org the page showed when the user clicked: an id, null for "no org",
   * or undefined when the page did not know yet — undefined skips the check.
   */
  expectedOrganizationId: string | null | undefined;
  /**
   * Refuse a member who is not an owner/admin of the active org:
   * "Only organization owners and admins can <action>". Without an active
   * org there is no role to check.
   */
  requireAdmin?: { action: string };
  /**
   * Refuse a session without an active org:
   * "Select an organization before <action>". Omitted = null is returned.
   */
  requireOrganization?: { action: string };
}

/**
 * The guard for an action the page scoped to an org: the session's active
 * membership (getActiveOrganizationMembershipOrNull), refused when the session
 * moved off the org the page showed (another tab switched) or the role is not
 * enough. Throws UserFacingError; returns null only without an active org and
 * without `requireOrganization`.
 */
export async function requireExpectedActiveMembership(
  userId: string,
  {
    expectedOrganizationId,
    requireAdmin,
    requireOrganization,
  }: ExpectedActiveMembershipOptions,
): Promise<{ organizationId: string; role: string } | null> {
  const membership = await getActiveOrganizationMembershipOrNull(userId);
  if (
    expectedOrganizationId !== undefined &&
    (membership?.organizationId ?? null) !== expectedOrganizationId
  ) {
    throw new UserFacingError(ACTIVE_ORGANIZATION_CHANGED_MESSAGE);
  }
  if (!membership) {
    if (requireOrganization) {
      throw new UserFacingError(
        `Select an organization before ${requireOrganization.action}`,
      );
    }
    return null;
  }
  if (requireAdmin && !ORG_ADMIN_ROLES.has(membership.role)) {
    throw new UserFacingError(
      `Only organization owners and admins can ${requireAdmin.action}`,
    );
  }
  return membership;
}

export async function getUserIdOrRedirect(): Promise<User["id"]> {
  const userId = await getUserIdOrNull();
  if (!userId) {
    redirect("/");
  }
  return userId;
}

/**
 * Resolve the full tenant context ({ userId, organizationId }) from an
 * X-Daemon-Token API key. `organizationId` comes from the key's metadata (see
 * daemon-token-context.ts); it is null for personal keys. Downstream code can
 * read the org directly instead of inferring it from the user's active org.
 */
export async function getDaemonTokenContext(
  request: Pick<Request, "headers">,
): Promise<DaemonTokenContext | null> {
  const token = request.headers.get("X-Daemon-Token");
  if (!token) {
    return null;
  }
  const { valid, error, key } = await auth.api.verifyApiKey({
    body: { key: token },
  });
  if (error || !valid) {
    console.log("Unauthorized", "error", error, "valid", valid);
    return null;
  }
  const context = daemonTokenContextFromApiKey(key);
  if (!context) {
    console.log("Unauthorized", "reason", "no userId on verified key");
    return null;
  }
  return context;
}

export async function getUserIdOrNullFromDaemonToken(
  request: Pick<Request, "headers">,
): Promise<string | null> {
  return (await getDaemonTokenContext(request))?.userId ?? null;
}

export async function getUserOrNull(): Promise<User | null> {
  const session = await getSessionOrNull();
  const user = session?.user ?? null;
  if (!user) {
    return null;
  }
  return user;
}

type UserInfo = {
  user: User;
  session: Session;
  userSettings: UserSettings;
  userFlags: UserFlags;
  userCredentials: UserCredentials;
  userFeatureFlags: Record<string, boolean>;
  userCookies: UserCookies;
  impersonation: {
    isImpersonating: boolean;
    impersonatedBy?: string;
  };
};

export const getUserInfoOrNull = cache(async (): Promise<UserInfo | null> => {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  if (!session) {
    return null;
  }
  const [
    userSettings,
    userFlags,
    userFeatureFlags,
    userCookies,
    userCredentials,
  ] = await Promise.all([
    getUserSettings({
      db,
      userId: session.user.id,
    }),
    getUserFlags({
      db,
      userId: session.user.id,
    }),
    getFeatureFlagsForUser({
      db,
      userId: session.user.id,
    }),
    getUserCookies(),
    getUserCredentials({
      userId: session.user.id,
      organizationId: session.session.activeOrganizationId ?? null,
    }),
  ]);
  return {
    ...session,
    userSettings,
    userFlags: getUserFlagsNormalized(userFlags),
    userFeatureFlags,
    userCookies,
    userCredentials,
    impersonation: {
      isImpersonating: !!session.session.impersonatedBy,
      impersonatedBy: session.session.impersonatedBy || undefined,
    },
  };
});

export async function getUserInfoOrRedirect(): Promise<UserInfo> {
  const userInfo = await getUserInfoOrNull();
  if (!userInfo) {
    redirect("/");
  }
  return userInfo;
}

async function getAdminUserOrNull(): Promise<User | null> {
  const user = await getUserOrNull();
  if (!user || user.role !== "admin") {
    return null;
  }
  return user;
}

export async function getAdminUserOrThrow(): Promise<User> {
  const user = await getAdminUserOrNull();
  if (!user) {
    throw new UserFacingError("Unauthorized");
  }
  return user;
}

function userOnly<T extends Array<any>, U>(
  callback: (userId: string, ...args: T) => Promise<U>,
) {
  const wrapped = async (...args: T): Promise<U> => {
    const userId = await getUserIdOrNull();
    if (!userId) {
      throw new UserFacingError("Unauthorized");
    }
    return await callback(userId, ...args);
  };
  // For testing purposes
  wrapped.userOnly = true;
  return wrapped;
}

export function userOnlyAction<T extends Array<any>, U>(
  callback: (userId: string, ...args: T) => Promise<U>,
  options: ServerActionOptions,
) {
  type UserOnlyAction = {
    (...args: T): Promise<ServerActionResult<U>>;
    userOnly?: boolean;
    wrappedServerAction?: boolean;
  };
  const userOnlyCallback = userOnly(callback);
  const userOnlyAction: UserOnlyAction = wrapServerActionInternal(
    userOnlyCallback,
    options,
  );
  userOnlyAction.userOnly = true;
  userOnlyAction.wrappedServerAction = true;
  return userOnlyAction;
}

export function adminOnly<T extends Array<any>, U>(
  callback: (adminUser: User, ...args: T) => Promise<U>,
) {
  const wrapped = async (...args: T): Promise<U> => {
    const adminUser = await getAdminUserOrThrow();
    return await callback(adminUser, ...args);
  };
  // For testing purposes
  wrapped.adminOnly = true;
  return wrapped;
}

export function adminOnlyAction<T extends Array<any>, U>(
  callback: (adminUser: User, ...args: T) => Promise<U>,
  options: ServerActionOptions,
) {
  type AdminOnlyAction = {
    (...args: T): Promise<ServerActionResult<U>>;
    adminOnly?: boolean;
    wrappedServerAction?: boolean;
  };
  const adminOnlyCallback = adminOnly(callback);
  const adminOnlyAction: AdminOnlyAction = wrapServerActionInternal(
    adminOnlyCallback,
    options,
  );
  adminOnlyAction.adminOnly = true;
  adminOnlyAction.wrappedServerAction = true;
  return adminOnlyAction;
}

export async function getCurrentUser(): Promise<User> {
  const user = await getUserOrNull();
  if (!user) {
    throw new Error("Unauthorized");
  }
  return user;
}

function getUserFlagsNormalized(userFlags: UserFlags) {
  return {
    ...userFlags,
    // In development, we want to show the debug tools by default.
    showDebugTools:
      userFlags.showDebugTools || process.env.NODE_ENV === "development",
    // Ensure isClaudeMaxSub is always defined
    isClaudeMaxSub: userFlags.isClaudeMaxSub ?? false,
    // Ensure isClaudeSub is always defined
    isClaudeSub: userFlags.isClaudeSub ?? false,
  };
}

export async function validInternalRequestOrThrow() {
  const requestHeaders = await headers();
  const secret = requestHeaders.get("X-Terragon-Secret");
  if (secret !== env.INTERNAL_SHARED_SECRET) {
    console.error("Unauthorized internal request");
    throw new Error("Unauthorized");
  }
}
