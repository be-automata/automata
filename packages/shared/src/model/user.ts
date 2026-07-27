import { eq, and, sql, desc } from "drizzle-orm";
import { DB } from "../db";
import * as schema from "../db/schema";
import { publishBroadcastUserMessage } from "../broadcast-server";
import { UserInfoServerSide, UserSettings } from "../db/types";
import { decryptTokenWithBackwardsCompatibility } from "@terragon/utils/encryption";

export async function getGitHubUserAccessTokenOrThrow({
  db,
  userId,
  encryptionKey,
}: {
  db: DB;
  userId: string;
  encryptionKey: string;
}) {
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
  if (githubAccounts.length === 0) {
    throw new Error("No GitHub account found");
  }
  const githubAccount = githubAccounts[0]!;

  if (!githubAccount.accessToken) {
    throw new Error("No GitHub access token found");
  }

  // GitHub App user tokens expire (8h). An expired token is NOT a usable
  // credential: passing it to the API yields "Bad credentials", and callers that
  // prefer a user token over the App installation token (getOctokitForBackground,
  // getGitHubTokenForBackground) would pick the dead one and break background
  // work. Treat it as absent so those callers fall back. A NULL expiry means the
  // provider issues non-expiring tokens — those stay valid.
  if (
    githubAccount.accessTokenExpiresAt &&
    githubAccount.accessTokenExpiresAt.getTime() <= Date.now()
  ) {
    throw new Error("GitHub access token expired");
  }

  // Decrypt the token if it's encrypted, otherwise return as-is (backwards compatibility)
  return decryptTokenWithBackwardsCompatibility(
    githubAccount.accessToken,
    encryptionKey,
  );
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
