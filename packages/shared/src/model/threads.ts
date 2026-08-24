import { DB } from "../db";
import type { TerminalCause } from "./terminal-cause";
import * as schema from "../db/schema";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { publishBroadcastUserMessage } from "../broadcast-server";
import { AGENT_VERSION } from "@terragon/agent/versions";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import {
  Thread,
  ThreadInsert,
  ThreadInsertRaw,
  ThreadChat,
  ThreadChatInsert,
  ThreadChatInfoFull,
  ThreadStatus,
  ThreadVisibility,
  ThreadSource,
  ThreadInfoFull,
  ThreadInfo,
  ThreadChatInsertRaw,
} from "../db/types";
import { BroadcastMessageThreadData } from "@terragon/types/broadcast";
import type { SandboxProvider } from "@terragon/types/sandbox";
import { sanitizeForJson } from "../utils/sanitize-json";
import { toUTC, validateTimezone } from "../utils/timezone";
import { getUser } from "./user";
import { AIAgent } from "@terragon/agent/types";

/**
 * Tenant fence for owner-scoped thread access (WI-5 / ADR-001).
 *
 * Threads are **private-to-creator within an org**: the ownership predicate is
 * `and(userId, organizationId)`. That preserves today's per-user task list (a
 * co-member does NOT see your threads) while adding the tenant boundary (another
 * org never sees them). `organizationId` is optional during the nullable
 * backfill phase — when omitted the query stays user-only (legacy behavior); the
 * `forTenant` accessor (model/tenant.ts) always supplies it, so accessor-path
 * reads and writes are always org-fenced. drizzle's `and()` ignores `undefined`.
 */
function threadOrgFence(organizationId?: string | null) {
  return organizationId
    ? eq(schema.thread.organizationId, organizationId)
    : undefined;
}
function threadChatOrgFence(organizationId?: string | null) {
  return organizationId
    ? eq(schema.threadChat.organizationId, organizationId)
    : undefined;
}

type GetThreadsArgs = {
  db: DB;
  userIdOrNull: string | null;
  organizationId?: string | null;
  limit?: number;
  offset?: number;
  includeUser?: boolean;
  where?: Partial<{
    status: ThreadStatus[];
    archived: boolean;
    automationId: string;
    githubRepoFullName: string;
    githubPRNumber: number;
    errorMessage?: boolean;
    sourceType?: ThreadSource;
    agent?: AIAgent;
  }>;
};

async function getThreadsInner({
  db,
  userIdOrNull,
  organizationId,
  limit = 20,
  offset = 0,
  includeUser,
  where,
}: GetThreadsArgs): Promise<
  {
    thread: ThreadInfo;
    user: { id: string; name: string; email: string } | null;
  }[]
> {
  const whereConditions = [];
  if (userIdOrNull) {
    whereConditions.push(eq(schema.thread.userId, userIdOrNull));
  }
  const orgCondition = threadOrgFence(organizationId);
  if (orgCondition) {
    whereConditions.push(orgCondition);
  }
  if (where?.archived !== undefined) {
    whereConditions.push(eq(schema.thread.archived, where.archived));
  }
  if (where?.status?.length) {
    whereConditions.push(inArray(schema.thread.status, where.status));
  }
  if (where?.automationId !== undefined) {
    whereConditions.push(eq(schema.thread.automationId, where.automationId));
  }
  if (where?.githubRepoFullName !== undefined) {
    whereConditions.push(
      eq(schema.thread.githubRepoFullName, where.githubRepoFullName),
    );
    if (where?.githubPRNumber !== undefined) {
      whereConditions.push(
        eq(schema.thread.githubPRNumber, where.githubPRNumber),
      );
    }
  }
  if (where?.errorMessage !== undefined && where.errorMessage) {
    whereConditions.push(isNotNull(schema.thread.errorMessage));
  }
  if (where?.sourceType !== undefined) {
    whereConditions.push(eq(schema.thread.sourceType, where.sourceType));
  }
  if (where?.agent !== undefined) {
    whereConditions.push(eq(schema.thread.agent, where.agent));
  }
  const threadChatSubQuery = db
    .select({
      threadChats: sql<
        Pick<ThreadChat, "id" | "agent" | "status" | "errorMessage">[]
      >`jsonb_agg(jsonb_build_object(
          'id', ${schema.threadChat.id},
          'agent', ${schema.threadChat.agent},
          'status', ${schema.threadChat.status},
          'errorMessage', ${schema.threadChat.errorMessage}
        ))
      `.as("threadChats"),
    })
    .from(schema.threadChat)
    .where(
      and(
        eq(schema.threadChat.userId, userIdOrNull ?? schema.thread.userId),
        eq(schema.threadChat.threadId, schema.thread.id),
      ),
    )
    .as("threadChatsAggregated");
  const query = db
    .select({
      id: schema.thread.id,
      userId: schema.thread.userId,
      organizationId: schema.thread.organizationId,
      shadow: schema.thread.shadow,
      name: schema.thread.name,
      githubRepoFullName: schema.thread.githubRepoFullName,
      githubPRNumber: schema.thread.githubPRNumber,
      githubIssueNumber: schema.thread.githubIssueNumber,
      codesandboxId: schema.thread.codesandboxId,
      credentialBrokerMode: schema.thread.credentialBrokerMode,
      activeRunExternalId: schema.thread.activeRunExternalId,
      terminalCause: schema.thread.terminalCause,
      reviewedSha: schema.thread.reviewedSha,
      supersededByThreadId: schema.thread.supersededByThreadId,
      sandboxProvider: schema.thread.sandboxProvider,
      sandboxSize: schema.thread.sandboxSize,
      sandboxStatus: schema.thread.sandboxStatus,
      bootingSubstatus: schema.thread.bootingSubstatus,
      createdAt: schema.thread.createdAt,
      updatedAt: schema.thread.updatedAt,
      repoBaseBranchName: schema.thread.repoBaseBranchName,
      branchName: schema.thread.branchName,
      archived: schema.thread.archived,
      automationId: schema.thread.automationId,
      parentThreadId: schema.thread.parentThreadId,
      parentToolId: schema.thread.parentToolId,
      draftMessage: schema.thread.draftMessage,
      disableGitCheckpointing: schema.thread.disableGitCheckpointing,
      skipSetup: schema.thread.skipSetup,
      sourceType: schema.thread.sourceType,
      sourceMetadata: schema.thread.sourceMetadata,
      trustContext: schema.thread.trustContext,
      version: schema.thread.version,
      gitDiffStats: schema.thread.gitDiffStats,

      ...(includeUser
        ? {
            user: {
              id: schema.user.id,
              name: schema.user.name,
              email: schema.user.email,
            },
          }
        : {}),

      // Legacy thread chat columns
      legacyThreadChat: {
        agent: schema.thread.agent,
        status: schema.thread.status,
        errorMessage: schema.thread.errorMessage,
      },
      // Additional columns
      authorName: schema.user.name,
      authorImage: schema.user.image,
      prStatus: schema.githubPR.status,
      prChecksStatus: schema.githubPR.checksStatus,
      visibility: schema.threadVisibility.visibility,
      isUnread: sql<boolean>`NOT COALESCE(${schema.threadReadStatus.isRead}, true)`,
      threadChats: threadChatSubQuery.threadChats,
    })
    .from(schema.thread)
    .limit(limit)
    .offset(offset)
    .orderBy(desc(schema.thread.updatedAt))
    .leftJoin(
      schema.threadVisibility,
      eq(schema.threadVisibility.threadId, schema.thread.id),
    )
    .leftJoin(
      schema.githubPR,
      and(
        eq(schema.githubPR.repoFullName, schema.thread.githubRepoFullName),
        eq(schema.githubPR.number, schema.thread.githubPRNumber),
      ),
    )
    .leftJoin(schema.user, eq(schema.user.id, schema.thread.userId))
    .leftJoin(
      schema.threadReadStatus,
      and(
        eq(
          schema.threadReadStatus.userId,
          userIdOrNull ?? schema.thread.userId,
        ),
        eq(schema.threadReadStatus.threadId, schema.thread.id),
      ),
    )
    .leftJoinLateral(threadChatSubQuery, sql`true`)
    .where(and(...whereConditions));

  const threads = await query;
  if (threads.length === 0) {
    return [];
  }
  return threads.map((thread) => {
    const {
      user = null,
      legacyThreadChat,
      threadChats,
      ...threadWithoutChats
    } = thread;
    if (threadChats?.length) {
      return {
        user,
        thread: { ...threadWithoutChats, threadChats },
      };
    }
    return {
      user,
      thread: {
        ...threadWithoutChats,
        threadChats: [
          {
            id: LEGACY_THREAD_CHAT_ID,
            ...legacyThreadChat,
          },
        ],
      },
    };
  });
}

export async function getThreads({
  db,
  userId,
  organizationId,
  limit = 20,
  offset = 0,
  archived,
  githubRepoFullName,
  automationId,
  githubPRNumber,
}: {
  db: DB;
  userId: string;
  organizationId?: string | null;
  limit?: number;
  offset?: number;
  archived?: boolean;
  githubRepoFullName?: string;
  automationId?: string;
  githubPRNumber?: number;
}): Promise<ThreadInfo[]> {
  const threads = await getThreadsInner({
    db,
    userIdOrNull: userId,
    organizationId,
    limit,
    offset,
    where: {
      archived,
      githubRepoFullName,
      automationId,
      githubPRNumber,
    },
    includeUser: false,
  });
  return threads.map(({ thread }) => thread);
}

export async function getThreadsForAdmin({
  db,
  limit = 20,
  offset = 0,
  status,
  archived,
  githubRepoFullName,
  errorMessage,
  sourceType,
  agent,
}: {
  db: DB;
  limit?: number;
  offset?: number;
  status?: ThreadStatus[];
  archived?: boolean;
  errorMessage?: boolean;
  githubRepoFullName?: string;
  sourceType?: ThreadSource;
  agent?: AIAgent;
}): Promise<
  {
    thread: ThreadInfo;
    user: { id: string; name: string; email: string } | null;
  }[]
> {
  return await getThreadsInner({
    db,
    userIdOrNull: null,
    limit,
    offset,
    where: {
      status,
      archived,
      githubRepoFullName,
      errorMessage,
      sourceType,
      agent,
    },
    includeUser: true,
  });
}

export async function getThreadCountsForAdmin({
  db,
  updatedSince,
}: {
  db: DB;
  updatedSince?: Date;
}) {
  const [byStatus, byErrorMessage, byAgent, bySource] = await Promise.all([
    db
      .select({
        status: schema.thread.status,
        count: count(),
      })
      .from(schema.thread)
      .where(
        updatedSince ? gte(schema.thread.updatedAt, updatedSince) : undefined,
      )
      .groupBy(schema.thread.status),
    db
      .select({
        errorMessage: schema.thread.errorMessage,
        count: count(),
      })
      .from(schema.thread)
      .where(
        and(
          isNotNull(schema.thread.errorMessage),
          updatedSince ? gte(schema.thread.updatedAt, updatedSince) : undefined,
        ),
      )
      .groupBy(schema.thread.errorMessage),
    db
      .select({
        agent: schema.thread.agent,
        count: count(),
      })
      .from(schema.thread)
      .where(
        updatedSince ? gte(schema.thread.updatedAt, updatedSince) : undefined,
      )
      .groupBy(schema.thread.agent),
    db
      .select({
        source: schema.thread.sourceType,
        count: count(),
      })
      .from(schema.thread)
      .groupBy(schema.thread.sourceType),
  ]);
  return {
    byStatus,
    byErrorMessage,
    byAgent,
    bySource,
  };
}

export type ThreadMinimal = NonNullable<
  Awaited<ReturnType<typeof getThreadMinimal>>
>;

export async function getThreadMinimal({
  db,
  userId,
  threadId,
  organizationId,
}: {
  db: DB;
  userId: string;
  threadId: string;
  organizationId?: string | null;
}) {
  // Omit certain columns
  const {
    // Skip large columns
    gitDiff,
    draftMessage,

    // Skip thread chat columns
    agent,
    agentVersion,
    status,
    sessionId,
    errorMessage,
    errorMessageInfo,
    scheduleAt,
    reattemptQueueAt,
    contextLength,
    permissionMode,
    messages,
    queuedMessages,

    // Select the rest of the columns
    ...minimalThreadColumns
  } = getTableColumns(schema.thread);
  const result = await db
    .select(minimalThreadColumns)
    .from(schema.thread)
    .where(
      and(
        eq(schema.thread.id, threadId),
        eq(schema.thread.userId, userId),
        threadOrgFence(organizationId),
      ),
    );
  if (result.length === 0) {
    return null;
  }
  return result[0]!;
}

export async function getThreadWithPermissions({
  db,
  threadId,
  userId,
  organizationId,
  getHasRepoPermissions,
  allowAdmin = false,
}: {
  db: DB;
  threadId: string;
  userId: string;
  organizationId?: string | null;
  getHasRepoPermissions?: (repoFullName: string) => Promise<boolean>;
  allowAdmin?: boolean;
}): Promise<ThreadInfoFull | undefined> {
  const threadResultArr = await db
    .select({
      userId: schema.thread.userId,
      githubRepoFullName: schema.thread.githubRepoFullName,
      visibility: sql<ThreadVisibility>`COALESCE(${schema.threadVisibility.visibility}, ${schema.userSettings.defaultThreadVisibility}, 'private')`,
    })
    .from(schema.thread)
    .leftJoin(
      schema.threadVisibility,
      eq(schema.threadVisibility.threadId, schema.thread.id),
    )
    .leftJoin(
      schema.userSettings,
      eq(schema.userSettings.userId, schema.thread.userId),
    )
    .where(eq(schema.thread.id, threadId));
  if (threadResultArr.length === 0) {
    return undefined;
  }
  const threadResult = threadResultArr[0]!;
  const ownerUserId = threadResult.userId;
  // Thread owners can view their own threads. The tenant fence applies here: an
  // owner viewing their own thread is scoped to their active org. Shared paths
  // below (link/repo/admin) read as the OWNER and are governed by visibility
  // rules, not the requester's org fence.
  if (ownerUserId === userId) {
    const thread = await getThread({ db, threadId, userId, organizationId });
    if (!thread) {
      return undefined;
    }
    return {
      ...thread,
      visibility: threadResult.visibility,
    };
  }

  const user = await getUser({ db, userId });
  if (!user) {
    return undefined;
  }

  // Admins can view all threads if allowAdmin is true
  if (allowAdmin) {
    if (user.role === "admin") {
      const thread = await getThread({ db, threadId, userId: ownerUserId });
      if (!thread) {
        return undefined;
      }
      return {
        ...thread,
        visibility: threadResult.visibility,
      };
    }
  }

  switch (threadResult.visibility) {
    case "private": {
      return undefined;
    }
    case "link": {
      const thread = await getThread({ db, threadId, userId: ownerUserId });
      if (!thread) {
        return undefined;
      }
      return {
        ...thread,
        visibility: threadResult.visibility,
      };
    }
    case "repo": {
      if (await getHasRepoPermissions?.(threadResult.githubRepoFullName)) {
        const thread = await getThread({ db, threadId, userId: ownerUserId });
        if (!thread) {
          return undefined;
        }
        return {
          ...thread,
          visibility: threadResult.visibility,
        };
      }
      return undefined;
    }
    default: {
      const _exhaustiveCheck: never = threadResult.visibility;
      throw new Error(`Invalid visibility: ${_exhaustiveCheck}`);
    }
  }
}

export async function getThread({
  db,
  threadId,
  userId,
  organizationId,
}: {
  db: DB;
  threadId: string;
  userId: string;
  organizationId?: string | null;
}): Promise<ThreadInfoFull | undefined> {
  const parentThread = alias(schema.thread, "parentThread");
  const [threads, childThreads, threadChats] = await Promise.all([
    db
      .select({
        ...getTableColumns(schema.thread),
        authorName: schema.user.name,
        authorImage: schema.user.image,
        prStatus: schema.githubPR.status,
        prChecksStatus: schema.githubPR.checksStatus,
        visibility: schema.threadVisibility.visibility,
        parentThreadName: parentThread.name,
        isUnread: sql<boolean>`NOT COALESCE(${schema.threadReadStatus.isRead}, true)`,
      })
      .from(schema.thread)
      .leftJoin(
        schema.githubPR,
        and(
          eq(schema.githubPR.repoFullName, schema.thread.githubRepoFullName),
          eq(schema.githubPR.number, schema.thread.githubPRNumber),
        ),
      )
      .leftJoin(parentThread, eq(parentThread.id, schema.thread.parentThreadId))
      .leftJoin(
        schema.threadVisibility,
        eq(schema.threadVisibility.threadId, schema.thread.id),
      )
      .leftJoin(schema.user, eq(schema.user.id, schema.thread.userId))
      .leftJoin(
        schema.threadReadStatus,
        and(
          eq(schema.threadReadStatus.threadId, schema.thread.id),
          eq(schema.threadReadStatus.userId, userId),
        ),
      )
      .where(
        and(
          eq(schema.thread.id, threadId),
          eq(schema.thread.userId, userId),
          threadOrgFence(organizationId),
        ),
      ),
    db.query.thread.findMany({
      columns: {
        id: true,
        parentToolId: true,
      },
      where: eq(schema.thread.parentThreadId, threadId),
      orderBy: (thread) => [desc(thread.createdAt)],
    }),
    db
      .select({
        ...getTableColumns(schema.threadChat),
        isUnread: sql<boolean>`NOT COALESCE(${schema.threadChatReadStatus.isRead}, true)`,
      })
      .from(schema.threadChat)
      .leftJoin(
        schema.threadChatReadStatus,
        and(
          eq(schema.threadChatReadStatus.threadId, schema.threadChat.threadId),
          eq(schema.threadChatReadStatus.userId, userId),
          eq(schema.threadChatReadStatus.threadChatId, schema.threadChat.id),
        ),
      )
      .where(
        and(
          eq(schema.threadChat.threadId, threadId),
          eq(schema.threadChat.userId, userId),
        ),
      )
      .orderBy(asc(schema.threadChat.createdAt)),
  ]);
  if (threads.length === 0) {
    return undefined;
  }
  const thread = threads[0]!;
  return {
    id: thread.id,
    userId: thread.userId,
    organizationId: thread.organizationId,
    shadow: thread.shadow,
    name: thread.name,
    branchName: thread.branchName,
    repoBaseBranchName: thread.repoBaseBranchName,
    githubRepoFullName: thread.githubRepoFullName,
    automationId: thread.automationId,
    codesandboxId: thread.codesandboxId,
    credentialBrokerMode: thread.credentialBrokerMode,
    activeRunExternalId: thread.activeRunExternalId,
    terminalCause: thread.terminalCause,
    reviewedSha: thread.reviewedSha,
    supersededByThreadId: thread.supersededByThreadId,
    sandboxProvider: thread.sandboxProvider,
    sandboxSize: thread.sandboxSize,
    bootingSubstatus: thread.bootingSubstatus,
    archived: thread.archived,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    visibility: thread.visibility,
    prStatus: thread.prStatus,
    prChecksStatus: thread.prChecksStatus,
    authorName: thread.authorName,
    authorImage: thread.authorImage,
    githubPRNumber: thread.githubPRNumber,
    githubIssueNumber: thread.githubIssueNumber,
    sandboxStatus: thread.sandboxStatus,
    gitDiff: thread.gitDiff,
    gitDiffStats: thread.gitDiffStats,
    parentThreadName: thread.parentThreadName,
    parentThreadId: thread.parentThreadId,
    parentToolId: thread.parentToolId,
    draftMessage: thread.draftMessage,
    skipSetup: thread.skipSetup,
    disableGitCheckpointing: thread.disableGitCheckpointing,
    sourceType: thread.sourceType,
    sourceMetadata: thread.sourceMetadata,
    trustContext: thread.trustContext,
    version: thread.version,
    isUnread: thread.isUnread,
    threadChats: resolveThreadChatFull(thread, threadChats),
    childThreads,
  };
}

export async function getThreadChat({
  db,
  threadId,
  threadChatId,
  userId,
  organizationId,
}: {
  db: DB;
  threadId: string;
  threadChatId: string;
  userId: string;
  organizationId?: string | null;
}): Promise<ThreadChatInfoFull | undefined> {
  if (threadChatId === LEGACY_THREAD_CHAT_ID) {
    const threadResult = await db
      .select({
        ...getTableColumns(schema.thread),
        isUnread: sql<boolean>`NOT COALESCE(${schema.threadReadStatus.isRead}, true)`,
      })
      .from(schema.thread)
      .leftJoin(
        schema.threadReadStatus,
        and(
          eq(schema.threadReadStatus.threadId, schema.thread.id),
          eq(schema.threadReadStatus.userId, userId),
        ),
      )
      .where(
        and(
          eq(schema.thread.id, threadId),
          eq(schema.thread.userId, userId),
          threadOrgFence(organizationId),
        ),
      );
    if (threadResult.length === 0) {
      return undefined;
    }
    const thread = threadResult[0]!;
    return createLegacyThreadChatFull(thread);
  }
  const threadChatResult = await db
    .select({
      ...getTableColumns(schema.threadChat),
      isUnread: sql<boolean>`NOT COALESCE(${schema.threadChatReadStatus.isRead}, true)`,
    })
    .from(schema.threadChat)
    .leftJoin(
      schema.threadChatReadStatus,
      and(
        eq(schema.threadChatReadStatus.threadId, schema.threadChat.threadId),
        eq(schema.threadChatReadStatus.userId, userId),
        eq(schema.threadChatReadStatus.threadChatId, schema.threadChat.id),
      ),
    )
    .where(
      and(
        eq(schema.threadChat.id, threadChatId),
        eq(schema.threadChat.threadId, threadId),
        eq(schema.threadChat.userId, userId),
        threadChatOrgFence(organizationId),
      ),
    );
  if (threadChatResult.length === 0) {
    return undefined;
  }
  return threadChatResult[0]!;
}

type ThreadForThreadChatInfoFull = Pick<
  Thread,
  | "id"
  | "userId"
  | "organizationId"
  | "createdAt"
  | "updatedAt"
  | "agent"
  | "agentVersion"
  | "status"
  | "sessionId"
  | "errorMessage"
  | "errorMessageInfo"
  | "scheduleAt"
  | "reattemptQueueAt"
  | "contextLength"
  | "permissionMode"
  | "version"
  | "name"
  | "queuedMessages"
  | "messages"
> & {
  isUnread: boolean;
};

function resolveThreadChatFull(
  thread: ThreadForThreadChatInfoFull,
  chats: ThreadChatInfoFull[] | undefined,
): ThreadChatInfoFull[] {
  if (thread.version > 0 && chats && chats.length > 0) {
    return chats;
  }
  return [createLegacyThreadChatFull(thread)];
}

function createLegacyThreadChatFull(
  thread: ThreadForThreadChatInfoFull,
): ThreadChatInfoFull {
  return {
    id: LEGACY_THREAD_CHAT_ID,
    userId: thread.userId,
    organizationId: thread.organizationId,
    threadId: thread.id,
    title: thread.name ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    agent: thread.agent,
    agentVersion: thread.agentVersion,
    status: thread.status,
    sessionId: thread.sessionId,
    errorMessage: thread.errorMessage,
    errorMessageInfo: thread.errorMessageInfo,
    scheduleAt: thread.scheduleAt,
    reattemptQueueAt: thread.reattemptQueueAt,
    contextLength: thread.contextLength,
    permissionMode: thread.permissionMode ?? "allowAll",
    isUnread: thread.isUnread,
    messages: thread.messages ?? [],
    queuedMessages: thread.queuedMessages ?? [],
  };
}

export async function createThread({
  db,
  userId,
  threadValues,
  initialChatValues,
  enableThreadChatCreation,
}: {
  db: DB;
  userId: string;
  threadValues: Omit<ThreadInsert, "userId">;
  initialChatValues: Omit<ThreadChatInsert, "userId" | "threadId">;
  enableThreadChatCreation?: boolean;
}): Promise<{ threadId: string; threadChatId: string }> {
  const initialChatInsert: Omit<ThreadChatInsert, "userId" | "threadId"> = {
    ...initialChatValues,
    agentVersion: AGENT_VERSION,
  };
  const { threadId, threadChatId } = await db.transaction(async (tx) => {
    const threadInsert: ThreadInsertRaw = {
      userId,
      ...threadValues,
      ...(enableThreadChatCreation ? { version: 1 } : initialChatInsert),
    };
    const [threadInsertResult] = await tx
      .insert(schema.thread)
      .values(threadInsert)
      .returning();
    if (!threadInsertResult) {
      throw new Error("Failed to create thread");
    }
    const threadId = threadInsertResult.id;
    if (!enableThreadChatCreation) {
      return { threadId, threadChatId: LEGACY_THREAD_CHAT_ID };
    }
    const threadChatInsert: ThreadChatInsertRaw = {
      userId,
      threadId,
      // Inherit the thread's tenant (WI-5). threadValues carries organizationId
      // when created through the forTenant accessor; null in the legacy path.
      organizationId: threadValues.organizationId ?? null,
      ...initialChatValues,
    };
    const [threadChatInsertResult] = await tx
      .insert(schema.threadChat)
      .values(threadChatInsert)
      .returning();
    if (!threadChatInsertResult) {
      throw new Error("Failed to create thread chat");
    }
    const threadChatId = threadChatInsertResult.id;
    return { threadId, threadChatId };
  });
  const dataByThreadId: Record<string, BroadcastMessageThreadData> = {};
  dataByThreadId[threadId] = {
    isThreadCreated: true,
    threadAutomationId: threadValues.automationId ?? undefined,
  };
  if (threadValues.parentThreadId) {
    dataByThreadId[threadValues.parentThreadId] = {};
  }
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { threadId, threadChatId },
    dataByThreadId,
  });
  return { threadId, threadChatId };
}

export async function updateThreadChat({
  db,
  userId,
  threadId,
  threadChatId,
  updates,
  organizationId,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
  updates: Omit<ThreadChatInsert, "threadChatId" | "status">;
  organizationId?: string | null;
}) {
  await db.transaction(async (tx) => {
    const {
      appendMessages,
      appendQueuedMessages,
      replaceQueuedMessages,
      appendAndResetQueuedMessages,
      ...updatesWithoutAppends
    } = updates ?? {};
    if (threadChatId === LEGACY_THREAD_CHAT_ID) {
      const updateObject: Partial<ThreadInsertRaw> = {
        ...updatesWithoutAppends,
      };
      if (appendMessages && appendMessages.length > 0) {
        // Sanitize messages to remove null bytes and other invalid JSON characters
        const sanitizedMessages = sanitizeForJson(appendMessages);
        // @ts-expect-error
        updateObject.messages = sql`COALESCE(${schema.thread.messages}, '[]'::jsonb) || ${JSON.stringify(sanitizedMessages)}::jsonb`;
      }
      if (appendAndResetQueuedMessages) {
        updateObject.queuedMessages = [];
        // @ts-expect-error
        updateObject.messages = sql`COALESCE(${schema.thread.messages}, '[]'::jsonb) || COALESCE(${schema.thread.queuedMessages}, '[]'::jsonb)`;
      } else if (replaceQueuedMessages) {
        const sanitizedQueuedMessages = sanitizeForJson(replaceQueuedMessages);
        // @ts-expect-error
        updateObject.queuedMessages = sql`${JSON.stringify(sanitizedQueuedMessages)}::jsonb`;
      } else if (appendQueuedMessages && appendQueuedMessages.length > 0) {
        const sanitizedQueuedMessages = sanitizeForJson(appendQueuedMessages);
        // @ts-expect-error
        updateObject.queuedMessages = sql`COALESCE(${schema.thread.queuedMessages}, '[]'::jsonb) || ${JSON.stringify(sanitizedQueuedMessages)}::jsonb`;
      }
      for (const stringKey in updateObject) {
        const key = stringKey as keyof ThreadInsertRaw;
        if (schema.thread[key]?.columnType === "PgText") {
          updateObject[key] = sanitizeForJson(updateObject[key]) as any;
        }
      }
      const result = await tx
        .update(schema.thread)
        .set(updateObject)
        .where(
          and(
            eq(schema.thread.id, threadId),
            eq(schema.thread.userId, userId),
            threadOrgFence(organizationId),
          ),
        )
        .returning();
      if (result.length === 0) {
        throw new Error("Failed to update thread chat (legacy)");
      }
    } else {
      const updateObject: Partial<ThreadChatInsertRaw> = {
        ...updatesWithoutAppends,
      };
      if (appendMessages && appendMessages.length > 0) {
        // Sanitize messages to remove null bytes and other invalid JSON characters
        const sanitizedMessages = sanitizeForJson(appendMessages);
        // @ts-expect-error
        updateObject.messages = sql`COALESCE(${schema.threadChat.messages}, '[]'::jsonb) || ${JSON.stringify(sanitizedMessages)}::jsonb`;
      }
      if (appendAndResetQueuedMessages) {
        updateObject.queuedMessages = [];
        // @ts-expect-error
        updateObject.messages = sql`COALESCE(${schema.threadChat.messages}, '[]'::jsonb) || COALESCE(${schema.threadChat.queuedMessages}, '[]'::jsonb)`;
      } else if (replaceQueuedMessages) {
        const sanitizedQueuedMessages = sanitizeForJson(replaceQueuedMessages);
        // @ts-expect-error
        updateObject.queuedMessages = sql`${JSON.stringify(sanitizedQueuedMessages)}::jsonb`;
      } else if (appendQueuedMessages && appendQueuedMessages.length > 0) {
        const sanitizedQueuedMessages = sanitizeForJson(appendQueuedMessages);
        // @ts-expect-error
        updateObject.queuedMessages = sql`COALESCE(${schema.threadChat.queuedMessages}, '[]'::jsonb) || ${JSON.stringify(sanitizedQueuedMessages)}::jsonb`;
      }
      for (const stringKey in updateObject) {
        const key = stringKey as keyof ThreadChatInsertRaw;
        if (schema.threadChat[key]?.columnType === "PgText") {
          updateObject[key] = sanitizeForJson(updateObject[key]) as any;
        }
      }
      const result = await tx
        .update(schema.threadChat)
        .set(updateObject)
        .where(
          and(
            eq(schema.threadChat.id, threadChatId),
            eq(schema.threadChat.threadId, threadId),
            eq(schema.threadChat.userId, userId),
            threadChatOrgFence(organizationId),
          ),
        )
        .returning();
      if (result.length === 0) {
        throw new Error("Failed to update thread chat");
      }
    }
  });
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: {
      threadId,
      threadChatId,
      messagesUpdated: "appendMessages" in updates ? true : undefined,
      hasErrorMessage:
        "errorMessage" in updates ? !!updates.errorMessage : undefined,
    },
  });
  return null;
}

/**
 * Stamp the thread's ACTIVE remote run (#125/#127) — the C1 generation fence
 * compares terminal writes against this. A narrow, broadcast-free writer: the
 * stamp is bookkeeping for the fence, not a UI-visible thread update.
 */
export async function setThreadActiveRun({
  db,
  threadId,
  externalId,
}: {
  db: DB;
  threadId: string;
  externalId: string | null;
}): Promise<void> {
  await db
    .update(schema.thread)
    .set({ activeRunExternalId: externalId })
    .where(eq(schema.thread.id, threadId));
}

/**
 * The terminal `errorMessage` a superseded thread carries (#8 app-side and
 * #125 C1). Load-bearing for the generation fence below — ONE constant for the
 * writer and every reader; C4 (#129) widens this into typed terminal causes.
 */
export const THREAD_SUPERSEDED_ERROR = "superseded";

export type ThreadGenerationCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "not-found" | "superseded" | "stale-generation";
      activeRunExternalId: string | null;
    };

/**
 * The #125 C1 generation fence, as ONE decision shared by every daemon-facing
 * write (terminal, verdict, and C4's sweep). Refuses when the thread is
 * already terminal-superseded (a newer run owns the PR), or when the writer
 * names a run other than the thread's ACTIVE run (stamped at dispatch by
 * C2). A NULL stamp, or a writer that carries no run id, fails OPEN on the
 * stamp arm — legacy/in-process runs are never fenced out.
 */
export function decideThreadGeneration({
  thread,
  runExternalId,
}: {
  thread: {
    activeRunExternalId: string | null;
    status: ThreadStatus;
    errorMessage: string | null;
    /** Optional so pre-C4 readers (threadChat rows) still fence on errorMessage. */
    terminalCause?: string | null;
  };
  runExternalId: string | null;
}): ThreadGenerationCheck {
  const terminal =
    thread.terminalCause !== undefined
      ? thread.terminalCause !== null
      : // Pre-C4 shape (threadChat rows): the legacy sentinel is the only signal.
        thread.status === "complete" &&
        thread.errorMessage === THREAD_SUPERSEDED_ERROR;
  if (terminal) {
    return {
      ok: false,
      reason: "superseded",
      activeRunExternalId: thread.activeRunExternalId,
    };
  }
  if (
    runExternalId !== null &&
    thread.activeRunExternalId !== null &&
    thread.activeRunExternalId !== runExternalId
  ) {
    return {
      ok: false,
      reason: "stale-generation",
      activeRunExternalId: thread.activeRunExternalId,
    };
  }
  return { ok: true };
}

/** `decideThreadGeneration` over a fresh read of the thread row. */
export async function checkThreadGeneration({
  db,
  threadId,
  runExternalId,
}: {
  db: DB;
  threadId: string;
  runExternalId: string | null;
}): Promise<ThreadGenerationCheck> {
  const [row] = await db
    .select({
      activeRunExternalId: schema.thread.activeRunExternalId,
      status: schema.thread.status,
      errorMessage: schema.thread.errorMessage,
      terminalCause: schema.thread.terminalCause,
    })
    .from(schema.thread)
    .where(eq(schema.thread.id, threadId))
    .limit(1);
  if (!row) {
    return { ok: false, reason: "not-found", activeRunExternalId: null };
  }
  return decideThreadGeneration({ thread: row, runExternalId });
}

export async function updateThread({
  db,
  userId,
  threadId,
  updates,
  organizationId,
}: {
  db: DB;
  userId: string;
  threadId: string;
  updates: Partial<ThreadInsert>;
  organizationId?: string | null;
}) {
  const updatesObject: Partial<ThreadInsertRaw> = { ...updates };
  for (const stringKey in updatesObject) {
    const key = stringKey as keyof ThreadInsertRaw;
    if (schema.thread[key]?.columnType === "PgText") {
      updatesObject[key] = sanitizeForJson(updatesObject[key]) as any;
    }
  }
  const result = await db
    .update(schema.thread)
    .set(updatesObject)
    .where(
      and(
        eq(schema.thread.id, threadId),
        eq(schema.thread.userId, userId),
        threadOrgFence(organizationId),
      ),
    )
    .returning();
  if (result.length !== 0) {
    const updatedThread = result[0]!;
    // Publish standard thread update message
    await publishBroadcastUserMessage({
      type: "user",
      id: updatedThread.userId,
      data: {
        threadId: updatedThread.id,
        threadAutomationId: updatedThread.automationId ?? undefined,
        isThreadArchived: "archived" in updates ? updates.archived : undefined,
        threadName: updatedThread.name ?? undefined,
      },
    });
    return;
  }
  throw new Error("Failed to update thread");
}

/**
 * #114 concurrent-resume lease. A brokered Docker sandbox is non-resumable, so
 * a resume must recreate it — but two concurrent resumes must NOT both recreate
 * (that orphans a sandbox + its sidecar/network). This atomically clears the
 * thread's stale `codesandboxId` with a compare-and-set: only the caller that
 * still observes `expectedSandboxId` wins (`claimed: true`) and performs the
 * destroy-old + recreate; losers get `claimed: false` and must retry (a
 * brokered sandbox is never resumed in place, so a loser can neither reconnect
 * to nor destroy the winner's fresh sandbox — it retries once the winner has
 * published). Non-secret only — touches no token/bearer.
 */
export async function claimBrokeredSandboxRecreate({
  db,
  userId,
  threadId,
  expectedSandboxId,
}: {
  db: DB;
  userId: string;
  threadId: string;
  expectedSandboxId: string;
}): Promise<{ claimed: boolean }> {
  const updateResult = await db
    .update(schema.thread)
    .set({ codesandboxId: null })
    .where(
      and(
        eq(schema.thread.id, threadId),
        eq(schema.thread.userId, userId),
        eq(schema.thread.codesandboxId, expectedSandboxId),
      ),
    )
    .returning({ id: schema.thread.id });
  return { claimed: updateResult.length > 0 };
}

/**
 * #114 §7a: fetch the NON-secret broker context for the thread that owns a given
 * sandbox, keyed by `codesandboxId`. Used by the admin daemon-log view — which
 * has only a sandboxId, no thread/user context — to decide whether to thread a
 * broker-secret refresh through its `getSandboxOrNull` connect (and to mint the
 * fresh installation token as the sandbox OWNER, not the admin). No user fence:
 * this is an admin-only path. Returns null when no thread references the sandbox.
 */
export async function getThreadBrokerContextBySandboxId({
  db,
  sandboxId,
}: {
  db: DB;
  sandboxId: string;
}): Promise<{
  threadId: string;
  userId: string;
  githubRepoFullName: string;
  sandboxProvider: SandboxProvider;
  credentialBrokerMode: "brokered" | "legacy-direct" | null;
} | null> {
  const result = await db
    .select({
      // #114: the STABLE thread id, needed to re-derive the Daytona org-Secret
      // name on the admin secondary connect path (see resolveBrokerRefreshForConnect).
      threadId: schema.thread.id,
      userId: schema.thread.userId,
      githubRepoFullName: schema.thread.githubRepoFullName,
      sandboxProvider: schema.thread.sandboxProvider,
      credentialBrokerMode: schema.thread.credentialBrokerMode,
    })
    .from(schema.thread)
    .where(eq(schema.thread.codesandboxId, sandboxId))
    .limit(1);
  return result[0] ?? null;
}

/**
 * When we update thread statuses, we want to ensure that we're the ones who updated the thread status
 * from the current status to the new status.
 *
 * This is important because there can be race conditions where multiple callers attempt to update the thread status
 * at the same time. (eg. when we try to dequeue a queued thread)
 *
 */
export async function updateThreadChatStatusAtomic({
  db,
  userId,
  threadId,
  threadChatId,
  fromStatus,
  toStatus,
  reattemptQueueAt,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
  fromStatus: ThreadStatus;
  toStatus: ThreadStatus;
  reattemptQueueAt?: Date | null;
}): Promise<{ didUpdateStatus: boolean }> {
  const otherUpdates: Partial<ThreadChatInsert> = {};
  // Clear reattemptQueueAt when transitioning away from rate-limited status
  if (
    toStatus !== "queued-sandbox-creation-rate-limit" &&
    toStatus !== "queued-agent-rate-limit"
  ) {
    otherUpdates.reattemptQueueAt = null;
  } else if (typeof reattemptQueueAt !== "undefined") {
    otherUpdates.reattemptQueueAt = reattemptQueueAt;
  }
  let didUpdateStatus = false;
  if (threadChatId === LEGACY_THREAD_CHAT_ID) {
    // Use a update set where pattern to ensure that we're the ones who updated the thread status
    // from the current status to the new status.
    const updateResult = await db
      .update(schema.thread)
      .set({ ...otherUpdates, status: toStatus })
      .where(
        and(
          eq(schema.thread.id, threadId),
          eq(schema.thread.userId, userId),
          eq(schema.thread.status, fromStatus),
        ),
      )
      .returning();
    if (updateResult.length > 0) {
      didUpdateStatus = true;
    }
  } else {
    const updateResult = await db
      .update(schema.threadChat)
      .set({ ...otherUpdates, status: toStatus })
      .where(
        and(
          eq(schema.threadChat.id, threadChatId),
          eq(schema.threadChat.threadId, threadId),
          eq(schema.threadChat.userId, userId),
          eq(schema.threadChat.status, fromStatus),
        ),
      )
      .returning();
    if (updateResult.length > 0) {
      didUpdateStatus = true;
    }
  }

  if (didUpdateStatus) {
    await publishBroadcastUserMessage({
      type: "user",
      id: userId,
      data: {
        threadId,
        threadStatusUpdated: toStatus,
      },
    });
  }
  return { didUpdateStatus };
}

export async function deleteThreadById({
  db,
  threadId,
  userId,
  organizationId,
}: {
  db: DB;
  threadId: string;
  userId: string;
  organizationId?: string | null;
}) {
  const result = await db
    .delete(schema.thread)
    .where(
      and(
        eq(schema.thread.id, threadId),
        eq(schema.thread.userId, userId), // Extra safety check
        threadOrgFence(organizationId),
      ),
    )
    .returning();

  if (result.length === 0) {
    throw new Error("Failed to delete thread");
  }

  // Publish realtime message to notify clients
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: {
      threadId: threadId,
      isThreadDeleted: true,
    },
  });

  return result[0]!;
}

/**
 * The non-terminal statuses a system reap (stall watchdog, supersede) may act on.
 * ONE definition shared by `getStalledThreads` and `markThreadsSuperseded` — a
 * future status added here reaches both sweeps, never one silently.
 */
/**
 * SQL predicate: the thread's EFFECTIVE status is one of `statuses`. A legacy
 * thread carries it on the thread row; a chat-mode thread
 * (enableThreadChatCreation) carries it on its threadChat row(s) while the
 * thread row keeps its creation value. Every reaper/sweep predicate on
 * "thread status" must use this, or chat-mode threads are invisible to it.
 */
export function threadEffectiveStatusIn(statuses: ThreadStatus[]) {
  return or(
    inArray(schema.thread.status, statuses),
    exists(db_select_chat_status(statuses)),
  );
}
function db_select_chat_status(statuses: ThreadStatus[]) {
  return sql`(select 1 from ${schema.threadChat} where ${schema.threadChat.threadId} = ${schema.thread.id} and ${schema.threadChat.status} in (${sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  )}))`;
}

/**
 * Thread-row columns a RESUME (new user message / boot of an ended thread)
 * must clear. `terminalCause` is write-once per run and read by the
 * generation fence as "this thread is terminal — refuse late writes"; a
 * thread that legitimately starts again must shed it, or the first typed
 * terminal would fence the thread forever (review on #138).
 */
export const THREAD_RESUME_UPDATES = { terminalCause: null } as const;

export const reapableThreadStatuses: ThreadStatus[] = [
  "booting",
  "stopping",
  "working",
  "working-done",
  "working-error",
  "checkpointing",
];

export async function getStalledThreads({
  db,
  cutoffSecs = 60 * 60, // Default to 1 hour
}: {
  db: DB;
  cutoffSecs?: number;
}) {
  const threads = await db.query.thread.findMany({
    where: and(
      inArray(schema.thread.status, reapableThreadStatuses),
      lte(schema.thread.updatedAt, new Date(Date.now() - cutoffSecs * 1000)),
    ),
    orderBy: (thread) => [desc(thread.updatedAt)],
  });
  return threads;
}

export async function stopStalledThreads({
  db,
  threadIds,
}: {
  db: DB;
  threadIds: string[];
}) {
  await db
    .update(schema.thread)
    .set({ status: "complete", errorMessage: "request-timeout" })
    .where(inArray(schema.thread.id, threadIds))
    .returning();
}

/**
 * Write ONE typed terminal to a set of threads (#125 C1/C4): status → complete,
 * `terminalCause` set. `errorMessage` carries the legacy `superseded` sentinel
 * ONLY for that cause (the pre-C4 contract the chat UI and old fence rows
 * read); every other cause leaves it NULL — the cause lives in ONE column.
 * Idempotent: only a reapable (non-terminal) thread transitions, so a retry,
 * a racing dispatch, or a second sweep tick never rewrites a terminal that a
 * thread legitimately reached. Broadcasts per moved thread so the UI reflects
 * it in realtime. Returns the ids actually moved.
 */
export async function markThreadsTerminal({
  db,
  threadIds,
  cause,
  supersededByThreadId,
}: {
  db: DB;
  threadIds: string[];
  cause: TerminalCause;
  /** #125 C5: the newer run's thread when `cause === "superseded"` (chip link). */
  supersededByThreadId?: string | null;
}): Promise<string[]> {
  if (threadIds.length === 0) return [];
  const terminal = {
    status: "complete" as const,
    errorMessage: cause === "superseded" ? THREAD_SUPERSEDED_ERROR : null,
  };
  // The EFFECTIVE status of a thread lives on the thread row for legacy
  // (LEGACY_THREAD_CHAT_ID) threads and on the threadChat row otherwise
  // (enableThreadChatCreation). Stamp whichever is live so every reader of the
  // effective status — getThreadChat's alias, the daemon-event fence — sees
  // the terminal. A non-live row (e.g. the never-started thread row of a
  // chat-mode thread) simply doesn't match. The typed cause is a thread-row
  // column (the run ledger's join key); for threads that moved via their chat
  // row it is stamped on the thread row in a follow-up write below.
  const [threadRows, chatRows] = await Promise.all([
    db
      .update(schema.thread)
      .set({
        ...terminal,
        terminalCause: cause,
        ...(supersededByThreadId ? { supersededByThreadId } : {}),
      })
      .where(
        and(
          inArray(schema.thread.id, threadIds),
          inArray(schema.thread.status, reapableThreadStatuses),
        ),
      )
      .returning({ id: schema.thread.id, userId: schema.thread.userId }),
    db
      .update(schema.threadChat)
      .set(terminal)
      .where(
        and(
          inArray(schema.threadChat.threadId, threadIds),
          inArray(schema.threadChat.status, reapableThreadStatuses),
        ),
      )
      .returning({
        id: schema.threadChat.threadId,
        userId: schema.threadChat.userId,
      }),
  ]);
  const updated = new Map<string, string>();
  for (const r of [...threadRows, ...chatRows]) updated.set(r.id, r.userId);

  // Chat-mode threads moved via their chat row only: the thread row (frozen at
  // its creation status, never reapable) still owns the typed cause, so stamp
  // it there too — exactly once (the WHERE keeps a retry from rewriting it).
  const movedViaThreadRow = new Set(threadRows.map((r) => r.id));
  const chatOnly = chatRows
    .map((r) => r.id)
    .filter((id) => !movedViaThreadRow.has(id));
  if (chatOnly.length > 0) {
    await db
      .update(schema.thread)
      .set({
        terminalCause: cause,
        ...(supersededByThreadId ? { supersededByThreadId } : {}),
      })
      .where(
        and(
          inArray(schema.thread.id, chatOnly),
          isNull(schema.thread.terminalCause),
        ),
      );
  }

  await Promise.all(
    [...updated].map(([threadId, userId]) =>
      publishBroadcastUserMessage({
        type: "user",
        id: userId,
        data: { threadId, threadStatusUpdated: "complete" },
      }),
    ),
  );
  return [...updated.keys()];
}

/** #8 app-side supersede: the prior review threads a newer dispatch replaces. Returns the count moved. */
export async function markThreadsSuperseded({
  db,
  threadIds,
}: {
  db: DB;
  threadIds: string[];
}): Promise<number> {
  return (await markThreadsTerminal({ db, threadIds, cause: "superseded" }))
    .length;
}

/** One thread, one typed cause. True when this call performed the transition. */
export async function markThreadTerminal({
  db,
  threadId,
  cause,
  supersededByThreadId,
}: {
  db: DB;
  threadId: string;
  cause: TerminalCause;
  supersededByThreadId?: string | null;
}): Promise<boolean> {
  return (
    (
      await markThreadsTerminal({
        db,
        threadIds: [threadId],
        cause,
        supersededByThreadId,
      })
    ).length > 0
  );
}

/**
 * Review threads that were dispatched to the remote plane but never got a
 * Hatchet run recorded (#125 C4 rule ii — the non-transactional-enqueue gap).
 * Deliberately NARROW, because dispatch records a `hatchet_run` row ONLY for
 * review runs (org + PR + a `pull_request` automation): a mention or a
 * deep-research run on the remote plane never has a row and must never be
 * swept. And only threads still in `booting` — a thread that ever reached
 * `working` had a daemon, so the run was visible; its age is measured from
 * creation because a review thread is created and dispatched in one step.
 */
export async function findOrphanRemoteThreads({
  db,
  olderThanMs,
  now = new Date(),
  remoteProviderOnly = true,
}: {
  db: DB;
  olderThanMs: number;
  now?: Date;
  /**
   * Restrict to threads pinned to `sandboxProvider = "hatchet-remote"`. Pass
   * FALSE when the deployment dispatches EVERY thread remotely
   * (`HATCHET_ENABLED` — the same gate as `hatchetDispatchEnabled`): there the
   * provider column keeps its local default ("docker" in production) and a
   * provider filter would make the rule silently match nothing.
   */
  remoteProviderOnly?: boolean;
}): Promise<{ id: string; createdAt: Date }[]> {
  return db
    .select({ id: schema.thread.id, createdAt: schema.thread.createdAt })
    .from(schema.thread)
    .innerJoin(
      schema.automations,
      eq(schema.automations.id, schema.thread.automationId),
    )
    .leftJoin(
      schema.hatchetRun,
      eq(schema.hatchetRun.threadId, schema.thread.id),
    )
    .where(
      and(
        remoteProviderOnly
          ? eq(schema.thread.sandboxProvider, "hatchet-remote")
          : undefined,
        threadEffectiveStatusIn(["booting"]),
        isNotNull(schema.thread.organizationId),
        isNotNull(schema.thread.githubPRNumber),
        eq(schema.automations.triggerType, "pull_request"),
        isNull(schema.hatchetRun.id),
        lt(schema.thread.createdAt, new Date(now.getTime() - olderThanMs)),
      ),
    );
}

export async function hasOtherUnarchivedThreadsWithSamePR({
  db,
  threadId,
  githubRepoFullName,
  githubPRNumber,
}: {
  db: DB;
  threadId: string;
  githubRepoFullName: string;
  githubPRNumber: number;
}): Promise<boolean> {
  const otherThreads = await db
    .select({ id: schema.thread.id })
    .from(schema.thread)
    .where(
      and(
        eq(schema.thread.githubRepoFullName, githubRepoFullName),
        eq(schema.thread.githubPRNumber, githubPRNumber),
        eq(schema.thread.archived, false),
        ne(schema.thread.id, threadId),
      ),
    )
    .limit(1);

  return otherThreads.length > 0;
}

export async function getQueuedThreadCounts({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<{
  queuedTotal: number;
  queuedTasksConcurrency: number;
  queuedAgentRateLimit: number;
  queuedSandboxCreationRateLimit: number;
}> {
  const statuses = [
    "queued-tasks-concurrency",
    "queued-agent-rate-limit",
    "queued-sandbox-creation-rate-limit",
  ] as const;
  const [threads, threadChats] = await Promise.all([
    db.query.thread.findMany({
      where: and(
        eq(schema.thread.userId, userId),
        inArray(schema.thread.status, statuses),
      ),
      orderBy: (thread) => [thread.createdAt],
      columns: { id: true, status: true },
    }),
    db.query.threadChat.findMany({
      where: and(
        eq(schema.threadChat.userId, userId),
        inArray(schema.threadChat.status, statuses),
      ),
      orderBy: (threadChat) => [threadChat.createdAt],
      columns: { id: true, threadId: true, status: true },
    }),
  ]);
  const threadIdAndStatus = [
    ...threads.map((thread) => ({
      threadId: thread.id,
      status: thread.status,
    })),
    ...threadChats.map((threadChat) => ({
      threadId: threadChat.threadId,
      status: threadChat.status,
    })),
  ];
  const counts = {
    queuedTotal: 0,
    queuedTasksConcurrency: 0,
    queuedAgentRateLimit: 0,
    queuedSandboxCreationRateLimit: 0,
  };
  const seenThreadIds = new Set<string>();
  for (const queued of threadIdAndStatus) {
    if (seenThreadIds.has(queued.threadId)) {
      continue;
    }
    seenThreadIds.add(queued.threadId);
    counts.queuedTotal++;
    if (queued.status === "queued-tasks-concurrency") {
      counts.queuedTasksConcurrency++;
    } else if (queued.status === "queued-agent-rate-limit") {
      counts.queuedAgentRateLimit++;
    } else if (queued.status === "queued-sandbox-creation-rate-limit") {
      counts.queuedSandboxCreationRateLimit++;
    }
  }
  return counts;
}

type ThreadChatAndStatus = {
  threadId: string;
  threadChatId: string;
  status: ThreadStatus;
};

export async function getEligibleQueuedThreadChats({
  db,
  userId,
  concurrencyLimitReached,
  sandboxCreationRateLimitReached,
}: {
  db: DB;
  userId: string;
  concurrencyLimitReached: boolean;
  sandboxCreationRateLimitReached: boolean;
}): Promise<ThreadChatAndStatus[]> {
  return await db.transaction(async (tx) => {
    const threadStatusConditions = [
      and(
        eq(schema.thread.status, "queued-agent-rate-limit"),
        lte(schema.thread.reattemptQueueAt, new Date()),
      ),
    ];
    const threadChatStatusConditions = [
      and(
        eq(schema.threadChat.status, "queued-agent-rate-limit"),
        lte(schema.threadChat.reattemptQueueAt, new Date()),
      ),
    ];
    if (!sandboxCreationRateLimitReached) {
      threadStatusConditions.push(
        eq(schema.thread.status, "queued-sandbox-creation-rate-limit"),
      );
      threadChatStatusConditions.push(
        eq(schema.threadChat.status, "queued-sandbox-creation-rate-limit"),
      );
    }
    if (!concurrencyLimitReached) {
      threadStatusConditions.push(
        eq(schema.thread.status, "queued-tasks-concurrency"),
      );
      threadChatStatusConditions.push(
        eq(schema.threadChat.status, "queued-tasks-concurrency"),
      );
    }
    const [threads, threadChats] = await Promise.all([
      tx.query.thread.findMany({
        where: and(
          eq(schema.thread.userId, userId),
          or(...threadStatusConditions),
        ),
        columns: {
          id: true,
          status: true,
        },
        orderBy: (thread, { asc }) => asc(thread.createdAt),
      }),
      tx.query.threadChat.findMany({
        where: and(
          eq(schema.threadChat.userId, userId),
          or(...threadChatStatusConditions),
        ),
        columns: {
          id: true,
          threadId: true,
          status: true,
        },
        orderBy: (threadChat, { asc }) => asc(threadChat.createdAt),
      }),
    ]);
    const result: ThreadChatAndStatus[] = [];
    for (const thread of threads) {
      result.push({
        threadId: thread.id,
        threadChatId: LEGACY_THREAD_CHAT_ID,
        status: thread.status,
      });
    }
    for (const threadChat of threadChats) {
      result.push({
        threadId: threadChat.threadId,
        threadChatId: threadChat.id,
        status: threadChat.status,
      });
    }
    return result;
  });
}

export async function atomicDequeueThreadChats({
  db,
  userId,
  eligibleThreadChats,
}: {
  db: DB;
  userId: string;
  eligibleThreadChats: ThreadChatAndStatus[];
}): Promise<
  | {
      threadId: string;
      threadChatId: string;
      oldStatus: ThreadStatus;
    }
  | undefined
> {
  if (eligibleThreadChats.length === 0) {
    return undefined;
  }
  for (const threadChat of eligibleThreadChats) {
    const oldStatus = threadChat.status;
    const { didUpdateStatus } = await updateThreadChatStatusAtomic({
      db,
      userId,
      threadId: threadChat.threadId,
      threadChatId: threadChat.threadChatId,
      fromStatus: threadChat.status,
      toStatus: "queued",
    });
    if (didUpdateStatus) {
      return {
        threadId: threadChat.threadId,
        threadChatId: threadChat.threadChatId,
        oldStatus,
      };
    }
  }
  return undefined;
}

export const activeThreadStatuses = ["booting", "working"] as ThreadStatus[];

export async function getActiveThreadCount({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}) {
  const result = await db
    .selectDistinct({ id: schema.thread.id })
    .from(schema.thread)
    .leftJoin(
      schema.threadChat,
      eq(schema.thread.id, schema.threadChat.threadId),
    )
    .where(
      and(
        eq(schema.thread.userId, userId),
        or(
          inArray(schema.thread.status, activeThreadStatuses),
          inArray(schema.threadChat.status, activeThreadStatuses),
        ),
      ),
    );
  return result.length;
}

export async function getUserIdsWithThreadsReadyToProcess({ db }: { db: DB }) {
  const now = new Date();
  const statuses = [
    "queued-sandbox-creation-rate-limit",
    "queued-agent-rate-limit",
  ] as const;
  const [threads, threadChats] = await Promise.all([
    db
      .selectDistinct({
        userId: schema.thread.userId,
      })
      .from(schema.thread)
      .where(
        and(
          inArray(schema.thread.status, statuses),
          or(
            isNull(schema.thread.reattemptQueueAt),
            lte(schema.thread.reattemptQueueAt, now),
          ),
        ),
      ),
    db
      .selectDistinct({
        userId: schema.threadChat.userId,
      })
      .from(schema.threadChat)
      .where(
        and(
          inArray(schema.threadChat.status, statuses),
          or(
            isNull(schema.threadChat.reattemptQueueAt),
            lte(schema.threadChat.reattemptQueueAt, now),
          ),
        ),
      ),
  ]);
  return Array.from(
    new Set([
      ...threads.map((thread) => thread.userId),
      ...threadChats.map((threadChat) => threadChat.userId),
    ]),
  );
}

export async function getUserIdsWithThreadsStuckInQueue({ db }: { db: DB }) {
  // Find users who have threads in "queued-tasks-concurrency" but no active threads
  // This indicates they might be stuck in the queue
  const [usersWithQueuedThreads, usersWithQueuedThreadChats] =
    await Promise.all([
      db
        .selectDistinct({
          userId: schema.thread.userId,
        })
        .from(schema.thread)
        .where(eq(schema.thread.status, "queued-tasks-concurrency")),
      db
        .selectDistinct({
          userId: schema.threadChat.userId,
        })
        .from(schema.threadChat)
        .where(eq(schema.threadChat.status, "queued-tasks-concurrency")),
    ]);
  if (
    usersWithQueuedThreads.length === 0 &&
    usersWithQueuedThreadChats.length === 0
  ) {
    return [];
  }

  const userIds = Array.from(
    new Set([
      ...usersWithQueuedThreads.map((user) => user.userId),
      ...usersWithQueuedThreadChats.map((user) => user.userId),
    ]),
  );
  // Check which of these users have active threads
  const [usersWithActiveThreads, usersWithActiveThreadChats] =
    await Promise.all([
      db
        .selectDistinct({
          userId: schema.thread.userId,
        })
        .from(schema.thread)
        .where(
          and(
            inArray(schema.thread.userId, userIds),
            inArray(schema.thread.status, activeThreadStatuses),
          ),
        ),
      db
        .selectDistinct({
          userId: schema.threadChat.userId,
        })
        .from(schema.threadChat)
        .where(
          and(
            inArray(schema.threadChat.userId, userIds),
            inArray(schema.threadChat.status, activeThreadStatuses),
          ),
        ),
    ]);
  const activeUserIds = Array.from(
    new Set([
      ...usersWithActiveThreads.map((user) => user.userId),
      ...usersWithActiveThreadChats.map((user) => user.userId),
    ]),
  );
  // Return users who have queued threads but no active threads
  return userIds.filter((userId) => !activeUserIds.includes(userId));
}

export async function getThreadsAndPRsStats({
  db,
  userId,
  startDate,
  endDate,
  timezone = "UTC",
}: {
  db: DB;
  userId: string;
  startDate: Date;
  endDate: Date;
  timezone?: string;
}) {
  const validatedTimezone = validateTimezone(timezone);
  const dateExpressionThreadCreated = sql<string>`DATE((${schema.thread.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE '${sql.raw(validatedTimezone)}')`;
  const dateExpressionPRUpdated = sql<string>`DATE((${schema.githubPR.updatedAt} AT TIME ZONE 'UTC') AT TIME ZONE '${sql.raw(validatedTimezone)}')`;
  const [threadsCreated, prsMerged] = await Promise.all([
    db
      .select({
        date: dateExpressionThreadCreated,
        threadsCreated: sql<number>`COUNT(*)::int`,
      })
      .from(schema.thread)
      .where(
        and(
          eq(schema.thread.userId, userId),
          gte(schema.thread.createdAt, toUTC(startDate)),
          lte(schema.thread.createdAt, toUTC(endDate)),
        ),
      )
      .groupBy(dateExpressionThreadCreated),
    db
      .select({
        date: dateExpressionPRUpdated,
        prsMerged: sql<number>`COUNT(*)::int`,
      })
      .from(schema.githubPR)
      .leftJoin(
        schema.thread,
        and(
          eq(schema.thread.githubPRNumber, schema.githubPR.number),
          eq(schema.thread.githubRepoFullName, schema.githubPR.repoFullName),
        ),
      )
      .where(
        and(
          eq(schema.thread.userId, userId),
          eq(schema.githubPR.status, "merged"),
          gte(schema.githubPR.updatedAt, toUTC(startDate)),
          lte(schema.githubPR.updatedAt, toUTC(endDate)),
        ),
      )
      .groupBy(dateExpressionPRUpdated),
  ]);
  return { threadsCreated, prsMerged };
}

type ScheduledThreadChat = {
  userId: string;
  scheduleAt: Date;
  threadId: string;
  threadChatId: string;
};

export async function getScheduledThreadChatsDueToRun({
  db,
  currentTime = new Date(),
}: {
  db: DB;
  currentTime?: Date;
}): Promise<ScheduledThreadChat[]> {
  return await db.transaction(async (tx) => {
    const [threads, threadChats] = await Promise.all([
      tx.query.thread.findMany({
        where: and(
          eq(schema.thread.status, "scheduled"),
          lte(schema.thread.scheduleAt, currentTime),
        ),
        orderBy: (thread) => [thread.scheduleAt],
        columns: {
          id: true,
          userId: true,
          status: true,
          scheduleAt: true,
        },
      }),
      tx.query.threadChat.findMany({
        where: and(
          eq(schema.threadChat.status, "scheduled"),
          lte(schema.threadChat.scheduleAt, currentTime),
        ),
        orderBy: (threadChat) => [threadChat.scheduleAt],
        columns: {
          id: true,
          threadId: true,
          userId: true,
          status: true,
          scheduleAt: true,
        },
      }),
    ]);

    const dueToRun: ScheduledThreadChat[] = [];
    for (const thread of threads) {
      dueToRun.push({
        userId: thread.userId,
        scheduleAt: thread.scheduleAt!,
        threadId: thread.id,
        threadChatId: LEGACY_THREAD_CHAT_ID,
      });
    }
    for (const threadChat of threadChats) {
      dueToRun.push({
        userId: threadChat.userId,
        scheduleAt: threadChat.scheduleAt!,
        threadId: threadChat.threadId,
        threadChatId: threadChat.id,
      });
    }
    return dueToRun;
  });
}
