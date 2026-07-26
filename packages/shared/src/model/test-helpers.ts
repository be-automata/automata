import { DB } from "../db";
import { nanoid } from "nanoid/non-secure";
import * as schema from "../db/schema";
import { getUserFlags } from "../model/user-flags";
import { createThread, updateThread, updateThreadChat } from "./threads";
import {
  AccessTier,
  AutomationInsert,
  GitHubPR,
  ThreadChatInsert,
  ThreadInsert,
} from "../db/types";
import { FeatureFlagName } from "./feature-flags-definitions";
import { getGithubPR, upsertGithubPR } from "./github";
import { setUserFeatureFlagOverride, upsertFeatureFlag } from "./feature-flags";
import { createAutomation } from "./automations";
import {
  createOrganization,
  addOrganizationMember,
} from "./organizations";

export async function createTestUser({
  db,
  email,
  name = "Test User Name",
  accessTier = "core",
  skipBillingFeatureFlag = false,
}: {
  db: DB;
  email?: string;
  name?: string;
  initClaudeTokens?: boolean;
  skipBillingFeatureFlag?: boolean;
  accessTier?: AccessTier;
}) {
  const userId = nanoid();
  email = email ?? `test-${userId}@terragon.com`;
  const insertUserResult = await db
    .insert(schema.user)
    .values({
      id: userId,
      email,
      name,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  if (insertUserResult.length === 0) {
    throw new Error("Failed to create test user");
  }
  const user = insertUserResult[0]!;
  await getUserFlags({ db, userId: user.id });

  const accountId = Math.floor(Math.random() * 10000000).toString();
  const insertAccountResult = await db
    .insert(schema.account)
    .values({
      id: accountId,
      accountId,
      providerId: "github",
      userId: user.id,
      accessToken: "123",
      refreshToken: "123",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  if (insertAccountResult.length === 0) {
    throw new Error("Failed to create test account");
  }
  const githubAccount = insertAccountResult[0]!;

  // Setup access tier for the user
  await db.insert(schema.subscription).values({
    id: nanoid(),
    plan: accessTier,
    status: "active",
    periodStart: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30),
    periodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    referenceId: user.id,
  });

  // Create a session for the user
  const sessionId = nanoid();
  const token = nanoid();
  const insertSessionResult = await db
    .insert(schema.session)
    .values({
      id: sessionId,
      userId: user.id,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      createdAt: new Date(),
      updatedAt: new Date(),
      token,
    })
    .returning();
  if (insertSessionResult.length === 0) {
    throw new Error("Failed to create test session");
  }
  const session = insertSessionResult[0]!;
  return { user, githubAccount, session };
}

/**
 * Helper function to create test threads with common defaults
 * Reduces boilerplate in tests that create multiple threads
 */
export async function createTestThread({
  db,
  userId,
  overrides,
  chatOverrides,
  enableThreadChatCreation = false,
}: {
  db: DB;
  userId: string;
  overrides?: Partial<ThreadInsert>;
  chatOverrides?: Omit<ThreadChatInsert, "threadChatId">;
  enableThreadChatCreation?: boolean;
}): Promise<{ threadId: string; threadChatId: string }> {
  const threadName = overrides?.name ?? `Test Thread`;
  const githubRepoFullName =
    overrides?.githubRepoFullName ?? `terragon/test-repo`;
  const repoBaseBranchName = overrides?.repoBaseBranchName ?? "main";
  const sandboxProvider = overrides?.sandboxProvider ?? "e2b";
  const parentThreadId = overrides?.parentThreadId ?? undefined;
  const parentToolId = overrides?.parentToolId ?? undefined;
  const { threadId, threadChatId } = await createThread({
    db,
    userId,
    threadValues: {
      githubRepoFullName,
      repoBaseBranchName,
      name: threadName,
      sandboxProvider,
      parentThreadId,
      parentToolId,
    },
    initialChatValues: {
      agent: "claudeCode",
    },
    enableThreadChatCreation,
  });
  if (overrides) {
    await updateThread({
      db,
      userId,
      threadId,
      updates: overrides,
    });
  }
  if (chatOverrides) {
    await updateThreadChat({
      db,
      userId,
      threadId,
      threadChatId,
      updates: chatOverrides,
    });
  }
  return { threadId, threadChatId };
}

export async function createTestGitHubPR({
  db,
  overrides,
}: {
  db: DB;
  overrides?: Partial<GitHubPR>;
}) {
  const prNumber = overrides?.number ?? Math.floor(Math.random() * 10000000);
  const repoFullName = overrides?.repoFullName ?? "terragon/test-repo";
  await upsertGithubPR({
    db,
    repoFullName,
    number: prNumber,
    updates: {
      status: overrides?.status ?? "open",
    },
  });
  const githubPR = await getGithubPR({
    db,
    repoFullName,
    prNumber,
  });
  return githubPR!;
}

export async function setFeatureFlagOverrideForTest({
  db,
  userId,
  name,
  value,
}: {
  db: DB;
  userId: string;
  name: FeatureFlagName;
  value: boolean;
}) {
  await upsertFeatureFlag({ db, name, updates: {} });
  await setUserFeatureFlagOverride({
    db,
    userId,
    name,
    value,
  });
}

export async function createTestAutomation({
  db,
  userId,
  accessTier = "core",
  values,
}: {
  db: DB;
  userId: string;
  accessTier?: AccessTier;
  values?: Partial<Omit<AutomationInsert, "userId">>;
}) {
  const automation = await createAutomation({
    db,
    userId,
    accessTier,
    automation: {
      name: "Test Automation",
      triggerType: "schedule",
      repoFullName: "terragon/test-repo",
      branchName: "main",
      ...values,
      triggerConfig: {
        cron: "0 9 * * *",
        timezone: "UTC",
        ...values?.triggerConfig,
      },
      action: {
        type: "user_message",
        config: {
          message: {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Test" }],
          },
        },
        ...values?.action,
      },
    },
  });
  return automation;
}

export async function createTestOrganization({
  db,
  userId,
  name = "Test Org",
  role = "owner",
}: {
  db: DB;
  userId: string;
  name?: string;
  role?: "owner" | "admin" | "member";
}) {
  const organization = await createOrganization({
    db,
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${nanoid(8)}`,
  });
  const member = await addOrganizationMember({
    db,
    organizationId: organization.id,
    userId,
    role,
  });
  return { organization, member };
}
