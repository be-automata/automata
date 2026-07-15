import { DB } from "../db";
import * as schema from "../db/schema";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  GitHubCheckRunInsert,
  GithubCheckRunStatus,
  GitHubPR,
} from "../db/types";
import { getThread } from "./threads";
import { LEGACY_THREAD_CHAT_ID } from "../utils/thread-utils";

export async function getThreadsForGithubPR({
  db,
  repoFullName,
  prNumber,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
}) {
  return await db.query.thread.findMany({
    where: and(
      eq(schema.thread.githubRepoFullName, repoFullName),
      eq(schema.thread.githubPRNumber, prNumber),
    ),
    columns: {
      id: true,
      userId: true,
      archived: true,
    },
  });
}

export async function upsertGithubPR({
  db,
  repoFullName,
  number,
  updates,
  threadId,
}: {
  db: DB;
  repoFullName: string;
  number: number;
  updates: Partial<Omit<GitHubPR, "id" | "repoFullName" | "number">>;
  threadId?: string;
}) {
  await db
    .insert(schema.githubPR)
    .values({
      repoFullName,
      number,
      threadId,
      ...updates,
    })
    .onConflictDoUpdate({
      target: [schema.githubPR.repoFullName, schema.githubPR.number],
      set: { ...updates }, // Don't update threadId on conflict
    });
}

export async function getGithubCheckRunForThreadChat({
  db,
  threadId,
  threadChatId,
  status,
}: {
  db: DB;
  threadId: string;
  threadChatId: string;
  status?: GithubCheckRunStatus;
}) {
  const whereConditions = [eq(schema.githubCheckRun.threadId, threadId)];
  if (threadChatId === LEGACY_THREAD_CHAT_ID) {
    whereConditions.push(isNull(schema.githubCheckRun.threadChatId));
  } else {
    whereConditions.push(eq(schema.githubCheckRun.threadChatId, threadChatId));
  }
  if (status) {
    whereConditions.push(eq(schema.githubCheckRun.status, status));
  }
  return await db.query.githubCheckRun.findFirst({
    where: and(...whereConditions),
  });
}

export async function upsertGithubCheckRun({
  db,
  threadId,
  threadChatId,
  checkRunId,
  updates,
}: {
  db: DB;
  threadId: string;
  threadChatId: string;
  checkRunId: number;
  updates: Partial<
    Omit<
      GitHubCheckRunInsert,
      "id" | "threadId" | "threadChatId" | "checkRunId"
    >
  >;
}) {
  if (threadChatId === LEGACY_THREAD_CHAT_ID) {
    await db.transaction(async (tx) => {
      const existing = await tx.query.githubCheckRun.findFirst({
        where: and(
          eq(schema.githubCheckRun.threadId, threadId),
          isNull(schema.githubCheckRun.threadChatId),
        ),
      });
      if (existing) {
        await tx
          .update(schema.githubCheckRun)
          .set({
            checkRunId,
            ...updates,
          })
          .where(eq(schema.githubCheckRun.id, existing.id));
      } else {
        await tx.insert(schema.githubCheckRun).values({
          threadId,
          threadChatId: null,
          checkRunId,
          ...updates,
        });
      }
    });
  } else {
    await db
      .insert(schema.githubCheckRun)
      .values({
        threadId,
        threadChatId,
        checkRunId,
        ...updates,
      })
      .onConflictDoUpdate({
        target: [
          schema.githubCheckRun.threadId,
          schema.githubCheckRun.threadChatId,
        ],
        set: {
          checkRunId,
          ...updates,
        },
      });
  }
}

export async function getGithubPR({
  db,
  repoFullName,
  prNumber,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
}) {
  return await db.query.githubPR.findFirst({
    where: and(
      eq(schema.githubPR.repoFullName, repoFullName),
      eq(schema.githubPR.number, prNumber),
    ),
  });
}

export async function getRecentGithubPRsForAdmin({
  db,
  limit,
}: {
  db: DB;
  limit: number;
}) {
  return await db.query.githubPR.findMany({
    orderBy: [desc(schema.githubPR.updatedAt)],
    limit,
  });
}

export async function getThreadForGithubPRAndUser({
  db,
  repoFullName,
  prNumber,
  userId,
  organizationId,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
  userId: string;
  // Tenant fence (WI-5). Optional during the nullable phase; the forTenant
  // accessor always supplies it.
  organizationId?: string | null;
}) {
  const threadOrNull = await db.query.thread.findFirst({
    where: and(
      eq(schema.thread.githubRepoFullName, repoFullName),
      eq(schema.thread.githubPRNumber, prNumber),
      eq(schema.thread.userId, userId),
      isNull(schema.thread.automationId),
      organizationId
        ? eq(schema.thread.organizationId, organizationId)
        : undefined,
    ),
    orderBy: [
      // Unarchived first
      asc(schema.thread.archived),
      // Then most recent first
      desc(schema.thread.updatedAt),
    ],
    columns: {
      id: true,
    },
  });
  if (!threadOrNull) {
    return null;
  }
  return await getThread({
    db,
    threadId: threadOrNull.id,
    userId,
    organizationId,
  });
}

export async function getGithubPRForAdmin({
  db,
  repoFullName,
  prNumber,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
}) {
  return await db.query.githubPR.findFirst({
    where: and(
      eq(schema.githubPR.repoFullName, repoFullName),
      eq(schema.githubPR.number, prNumber),
    ),
  });
}
