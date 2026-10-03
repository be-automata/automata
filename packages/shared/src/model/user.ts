import { eq, and, sql, desc } from "drizzle-orm";
import { DB } from "../db";
import * as schema from "../db/schema";
import { publishBroadcastUserMessage } from "../broadcast-server";
import { UserInfoServerSide, UserSettings } from "../db/types";
import {
  decryptTokenWithBackwardsCompatibility,
  encryptToken,
} from "@terragon/utils/encryption";

export interface RefreshedGitHubUserToken {
  accessToken: string;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

/**
 * Exchanges a (plaintext) GitHub refresh token for a new token pair. Injected so
 * this package never holds the OAuth client secret.
 */
/**
 * The access token had expired and renewing it failed. Distinct from "no GitHub
 * account / no token" so callers can surface real refresh failures without
 * logging every email/password user.
 */
export class GitHubTokenRefreshError extends Error {
  constructor(cause: string) {
    super(`GitHub access token expired; refresh failed: ${cause}`);
    this.name = "GitHubTokenRefreshError";
  }
}

export type GitHubUserTokenRefresher = (
  refreshToken: string,
) => Promise<RefreshedGitHubUserToken>;

function isExpired(at: Date | null): boolean {
  return at !== null && at.getTime() <= Date.now();
}

async function getGitHubAccountRow({ db, userId }: { db: DB; userId: string }) {
  const githubAccounts = await db
    .select()
    .from(schema.account)
    .where(
      and(
        eq(schema.account.userId, userId),
        eq(schema.account.providerId, "github"),
      ),
    )
    .execute();
  return githubAccounts[0];
}

export async function getGitHubUserAccessTokenOrThrow({
  db,
  userId,
  encryptionKey,
  refresh,
}: {
  db: DB;
  userId: string;
  encryptionKey: string;
  // When provided, an expired access token is renewed with the stored refresh
  // token instead of being rejected.
  refresh?: GitHubUserTokenRefresher;
}) {
  const githubAccount = await getGitHubAccountRow({ db, userId });
  if (!githubAccount) {
    throw new Error("No GitHub account found");
  }

  if (!githubAccount.accessToken) {
    throw new Error("No GitHub access token found");
  }

  // GitHub App user tokens expire (8h). An expired token is NOT a usable
  // credential: passing it to the API yields "Bad credentials", and callers that
  // prefer a user token over the App installation token (getOctokitForBackground,
  // getGitHubTokenForBackground) would pick the dead one and break background
  // work. Refresh it if we can, otherwise treat it as absent so those callers
  // fall back. A NULL expiry means the provider issues non-expiring tokens —
  // those stay valid.
  if (isExpired(githubAccount.accessTokenExpiresAt)) {
    if (!refresh) {
      throw new Error("GitHub access token expired");
    }
    return refreshGitHubUserAccessTokenOrThrow({
      db,
      account: githubAccount,
      encryptionKey,
      refresh,
    });
  }

  // Decrypt the token if it's encrypted, otherwise return as-is (backwards compatibility)
  return decryptTokenWithBackwardsCompatibility(
    githubAccount.accessToken,
    encryptionKey,
  );
}

async function refreshGitHubUserAccessTokenOrThrow({
  db,
  account,
  encryptionKey,
  refresh,
}: {
  db: DB;
  account: typeof schema.account.$inferSelect;
  encryptionKey: string;
  refresh: GitHubUserTokenRefresher;
}): Promise<string> {
  const storedRefreshToken = account.refreshToken;
  if (!storedRefreshToken || isExpired(account.refreshTokenExpiresAt)) {
    throw new Error("GitHub access token expired");
  }

  // GitHub rotates refresh tokens: the one we send is dead once it is used. If a
  // concurrent request already rotated it, our exchange fails or our write
  // loses the compare-and-swap below. Either way the winner's token is in the
  // row, so re-read it before giving up.
  const readWinnerOrThrow = async (cause: string): Promise<string> => {
    const current = await getGitHubAccountRow({ db, userId: account.userId });
    if (
      current?.accessToken &&
      current.accessToken !== account.accessToken &&
      !isExpired(current.accessTokenExpiresAt)
    ) {
      return decryptTokenWithBackwardsCompatibility(
        current.accessToken,
        encryptionKey,
      );
    }
    throw new GitHubTokenRefreshError(cause);
  };

  let refreshed: RefreshedGitHubUserToken;
  try {
    refreshed = await refresh(
      decryptTokenWithBackwardsCompatibility(storedRefreshToken, encryptionKey),
    );
  } catch (error) {
    return readWinnerOrThrow(
      error instanceof Error ? error.message : String(error),
    );
  }

  const updated = await db
    .update(schema.account)
    .set({
      accessToken: encryptToken(refreshed.accessToken, encryptionKey),
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      // GitHub returns a new refresh token on every exchange; keep the old one
      // only if a provider ever omits it.
      refreshToken: refreshed.refreshToken
        ? encryptToken(refreshed.refreshToken, encryptionKey)
        : storedRefreshToken,
      refreshTokenExpiresAt: refreshed.refreshToken
        ? refreshed.refreshTokenExpiresAt
        : account.refreshTokenExpiresAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.account.id, account.id),
        eq(schema.account.refreshToken, storedRefreshToken),
      ),
    )
    .returning({ id: schema.account.id });
  if (updated.length === 0) {
    // Someone rewrote the row (re-link or a racing refresh). Prefer what is
    // stored; the token we were just issued is still a valid fallback.
    try {
      return await readWinnerOrThrow("refresh token rotated concurrently");
    } catch {
      return refreshed.accessToken;
    }
  }
  return refreshed.accessToken;
}

export async function getUser({ db, userId }: { db: DB; userId: string }) {
  const user = await db.query.user.findFirst({
    where: eq(schema.user.id, userId),
  });
  return user;
}

export async function getUserSettings({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<UserSettings> {
  let userSettings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
  });
  if (!userSettings) {
    // Use onConflictDoNothing to handle race condition when multiple
    // parallel calls try to create user settings simultaneously
    const result = await db
      .insert(schema.userSettings)
      .values({
        userId,
      })
      .onConflictDoNothing()
      .returning();
    // If the insert was skipped due to conflict, fetch the existing record
    if (result.length === 0) {
      userSettings = await db.query.userSettings.findFirst({
        where: eq(schema.userSettings.userId, userId),
      });
    } else {
      userSettings = result[0]!;
    }
  }
  return userSettings!;
}

export async function updateUserSettings({
  db,
  userId,
  updates,
}: {
  db: DB;
  userId: string;
  updates: Partial<typeof schema.userSettings.$inferSelect>;
}) {
  if ("userId" in updates || "id" in updates) {
    throw new Error("userId and id cannot be updated");
  }
  await db
    .insert(schema.userSettings)
    .values({
      userId,
      ...updates,
    })
    .onConflictDoUpdate({
      target: [schema.userSettings.userId],
      set: {
        ...updates,
      },
    });
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: {
      userSettings: true,
    },
  });
}

export async function getUserInfoServerSide({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<UserInfoServerSide> {
  let userInfoServerSide = await db.query.userInfoServerSide.findFirst({
    where: eq(schema.userInfoServerSide.userId, userId),
  });
  if (!userInfoServerSide) {
    const result = await db
      .insert(schema.userInfoServerSide)
      .values({
        userId,
      })
      .onConflictDoNothing()
      .returning();
    if (result.length === 0) {
      userInfoServerSide = await db.query.userInfoServerSide.findFirst({
        where: eq(schema.userInfoServerSide.userId, userId),
      });
    } else {
      userInfoServerSide = result[0]!;
    }
  }
  return userInfoServerSide!;
}

export async function updateUserInfoServerSide({
  db,
  userId,
  updates,
}: {
  db: DB;
  userId: string;
  updates: Partial<typeof schema.userInfoServerSide.$inferSelect>;
}) {
  await db
    .insert(schema.userInfoServerSide)
    .values({
      userId,
      ...updates,
    })
    .onConflictDoUpdate({
      target: [schema.userInfoServerSide.userId],
      set: {
        ...updates,
      },
    });
}
export async function isValidUserId({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}) {
  const user = await db.query.user.findFirst({
    where: eq(schema.user.id, userId),
    columns: {
      id: true,
    },
  });
  return !!user;
}

export async function getUserIdByGitHubAccountId({
  db,
  accountId,
}: {
  db: DB;
  accountId: string;
}) {
  const account = await db.query.account.findFirst({
    where: and(
      eq(schema.account.accountId, accountId),
      eq(schema.account.providerId, "github"),
    ),
    columns: {
      userId: true,
    },
  });
  return account?.userId;
}

export async function getGitHubAccountIdForUser({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}) {
  const account = await db.query.account.findFirst({
    where: and(
      eq(schema.account.userId, userId),
      eq(schema.account.providerId, "github"),
    ),
    columns: {
      accountId: true,
    },
  });
  return account?.accountId;
}

export async function getRecentUsersForAdmin({
  db,
  limit,
}: {
  db: DB;
  limit: number;
}) {
  // Get users with their most recent thread creation date
  return await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      createdAt: schema.user.createdAt,
      role: schema.user.role,
      mostRecentThreadDate:
        sql<Date>`MAX(${schema.thread.createdAt} AT TIME ZONE 'UTC')`.as(
          "most_recent_thread_date",
        ),
    })
    .from(schema.user)
    .leftJoin(schema.thread, eq(schema.user.id, schema.thread.userId))
    .groupBy(schema.user.id)
    .orderBy(
      desc(sql`CASE WHEN ${schema.user.role} = 'admin' THEN 1 ELSE 0 END`),
      desc(
        sql`COALESCE(MAX(${schema.thread.createdAt} AT TIME ZONE 'UTC'), '1970-01-01'::timestamp AT TIME ZONE 'UTC')`,
      ),
    )
    .limit(limit);
}

export async function updateUser({
  db,
  userId,
  updates,
}: {
  db: DB;
  userId: string;
  updates: Partial<
    Pick<
      typeof schema.user.$inferSelect,
      "stripeCustomerId" | "signupTrialPlan"
    >
  >;
}) {
  await db.update(schema.user).set(updates).where(eq(schema.user.id, userId));
}
