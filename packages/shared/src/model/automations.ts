import { DB } from "../db";
import * as schema from "../db/schema";
import {
  and,
  desc,
  eq,
  getTableColumns,
  lte,
  or,
  sql,
  count,
  ne,
} from "drizzle-orm";
import { AccessTier, Automation, AutomationInsert } from "../db/types";
import { publishBroadcastUserMessage } from "../broadcast-server";
import {
  AutomationTriggerConfig,
  AutomationTriggerType,
  ScheduleTriggerConfig,
} from "../automations";
import { getNextRunTime } from "../automations/cron";

/**
 * Tenant fence for owner-scoped automation access (WI-5). Optional during the
 * nullable phase; the forTenant accessor always supplies it. drizzle's and()
 * drops undefined.
 */
function automationOrgFence(organizationId?: string | null) {
  return organizationId
    ? eq(schema.automations.organizationId, organizationId)
    : undefined;
}

async function getAutomationNextRunAt({
  accessTier,
  triggerType,
  triggerConfig,
  afterDate,
}: {
  accessTier: AccessTier;
  triggerType: AutomationTriggerType;
  triggerConfig: AutomationTriggerConfig;
  afterDate?: Date;
}): Promise<Date | null> {
  if (triggerType !== "schedule") {
    return null;
  }
  const config = triggerConfig as ScheduleTriggerConfig;
  if (!config.cron || !config.timezone) {
    throw new Error("Invalid schedule trigger config");
  }
  return getNextRunTime({
    cron: config.cron,
    timezone: config.timezone,
    afterDate,
    options: {
      accessTier,
    },
  });
}

export async function createAutomation({
  db,
  userId,
  accessTier,
  automation,
  organizationId,
}: {
  db: DB;
  userId: string;
  accessTier: AccessTier;
  automation: Omit<AutomationInsert, "userId">;
  // Tenant to stamp on the new automation (WI-5). Its runs inherit this org.
  organizationId?: string | null;
}) {
  const nextRunAt = await getAutomationNextRunAt({
    accessTier,
    triggerType: automation.triggerType,
    triggerConfig: automation.triggerConfig,
  });
  const [result] = await db
    .insert(schema.automations)
    .values({
      ...automation,
      userId,
      organizationId: organizationId ?? automation.organizationId ?? null,
      nextRunAt,
    })
    .returning();
  if (!result) {
    throw new Error("Failed to create automation");
  }
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { automationId: result.id },
  });
  return result;
}

export async function updateAutomation({
  db,
  userId,
  accessTier,
  automationId,
  updates,
  organizationId,
}: {
  db: DB;
  userId: string;
  accessTier: AccessTier;
  automationId: string;
  updates: Partial<
    Omit<Automation, "id" | "userId" | "createdAt" | "updatedAt">
  >;
  organizationId?: string | null;
}) {
  // If trigger type or config is being updated, recalculate nextRunAt
  let nextRunAt: Date | null | undefined;
  if (updates.triggerType || updates.triggerConfig) {
    const current = await getAutomation({
      db,
      automationId,
      userId,
      organizationId,
    });
    if (current) {
      const triggerType = updates.triggerType || current.triggerType;
      const triggerConfig = updates.triggerConfig || current.triggerConfig;
      nextRunAt = await getAutomationNextRunAt({
        accessTier,
        triggerType,
        triggerConfig,
      });
    }
  }
  const finalUpdates =
    nextRunAt !== undefined ? { ...updates, nextRunAt } : updates;
  const [automation] = await db
    .update(schema.automations)
    .set(finalUpdates)
    .where(
      and(
        eq(schema.automations.id, automationId),
        eq(schema.automations.userId, userId),
        automationOrgFence(organizationId),
      ),
    )
    .returning();
  if (!automation) {
    throw new Error("Failed to update automation");
  }
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { automationId: automation.id },
  });
  return automation;
}

export async function getAutomation({
  db,
  userId,
  automationId,
  organizationId,
}: {
  db: DB;
  userId: string;
  automationId: string;
  organizationId?: string | null;
}) {
  const automation = await db.query.automations.findFirst({
    where: and(
      eq(schema.automations.id, automationId),
      eq(schema.automations.userId, userId),
      automationOrgFence(organizationId),
    ),
  });
  return automation;
}

export async function getAutomations({
  db,
  userId,
  limit = 100,
  offset = 0,
  organizationId,
}: {
  db: DB;
  userId: string;
  limit?: number;
  offset?: number;
  organizationId?: string | null;
}) {
  return await db.query.automations.findMany({
    limit,
    offset,
    where: and(
      eq(schema.automations.userId, userId),
      automationOrgFence(organizationId),
    ),
    orderBy: [
      desc(schema.automations.enabled),
      desc(schema.automations.updatedAt),
      desc(schema.automations.createdAt),
    ],
  });
}

export async function getAutomationCount({
  db,
  userId,
  organizationId,
}: {
  db: DB;
  userId: string;
  organizationId?: string | null;
}) {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.automations)
    .where(
      and(
        eq(schema.automations.userId, userId),
        eq(schema.automations.enabled, true),
        ne(schema.automations.triggerType, "manual"),
        automationOrgFence(organizationId),
      ),
    );
  return result[0]?.count ?? 0;
}

export async function deleteAutomation({
  db,
  userId,
  automationId,
  organizationId,
}: {
  db: DB;
  userId: string;
  automationId: string;
  organizationId?: string | null;
}) {
  const [deletedAutomation] = await db
    .delete(schema.automations)
    .where(
      and(
        eq(schema.automations.id, automationId),
        eq(schema.automations.userId, userId),
        automationOrgFence(organizationId),
      ),
    )
    .returning();
  if (!deletedAutomation) {
    throw new Error("Failed to delete automation");
  }
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { automationId },
  });
  return deletedAutomation;
}

export async function incrementAutomationRunCount({
  db,
  userId,
  automationId,
  accessTier,
  organizationId,
}: {
  db: DB;
  userId: string;
  automationId: string;
  accessTier: AccessTier;
  organizationId?: string | null;
}) {
  const current = await getAutomation({
    db,
    automationId,
    userId,
    organizationId,
  });
  if (!current) {
    throw new Error("Automation not found");
  }
  const now = new Date();
  const nextRunAt = await getAutomationNextRunAt({
    accessTier,
    triggerType: current.triggerType,
    triggerConfig: current.triggerConfig,
    afterDate: now,
  });
  const [automation] = await db
    .update(schema.automations)
    .set({
      lastRunAt: now,
      nextRunAt,
      runCount: sql`${schema.automations.runCount} + 1`,
    })
    .where(
      and(
        eq(schema.automations.id, automationId),
        eq(schema.automations.userId, userId),
        automationOrgFence(organizationId),
      ),
    )
    .returning();
  if (!automation) {
    throw new Error("Failed to mark automation as executed");
  }
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { automationId: automation.id },
  });
  return automation;
}

export async function getScheduledAutomations({ db }: { db: DB }) {
  return await db.query.automations.findMany({
    where: and(
      eq(schema.automations.enabled, true),
      eq(schema.automations.triggerType, "schedule"),
    ),
  });
}

export async function getScheduledAutomationsDueToRun({
  db,
  currentTime = new Date(),
}: {
  db: DB;
  currentTime?: Date;
}) {
  return await db.query.automations.findMany({
    where: and(
      eq(schema.automations.enabled, true),
      eq(schema.automations.triggerType, "schedule"),
      or(lte(schema.automations.nextRunAt, currentTime)),
    ),
    orderBy: [schema.automations.nextRunAt],
  });
}

export async function getAllAutomationsForAdmin({
  db,
  limit = 50,
  offset = 0,
  triggerType,
}: {
  db: DB;
  limit?: number;
  offset?: number;
  triggerType?: AutomationTriggerType;
}) {
  const where = [];
  if (triggerType) {
    where.push(eq(schema.automations.triggerType, triggerType));
  }
  const result = await db
    .select({
      automation: schema.automations,
      user: {
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
      },
    })
    .from(schema.automations)
    .leftJoin(schema.user, eq(schema.automations.userId, schema.user.id))
    .where(and(...where))
    .orderBy(desc(schema.automations.createdAt))
    .limit(limit)
    .offset(offset);
  return result.map((row) => ({
    ...row.automation,
    user: row.user,
  }));
}

export async function getPullRequestAutomationsForRepo({
  db,
  repoFullName,
}: {
  db: DB;
  repoFullName: string;
}) {
  return await db.query.automations.findMany({
    where: and(
      eq(schema.automations.enabled, true),
      eq(schema.automations.triggerType, "pull_request"),
      eq(schema.automations.repoFullName, repoFullName),
    ),
    orderBy: desc(schema.automations.createdAt),
  });
}

export async function getIssueAutomationsForRepo({
  db,
  repoFullName,
}: {
  db: DB;
  repoFullName: string;
}) {
  return await db.query.automations.findMany({
    where: and(
      eq(schema.automations.enabled, true),
      eq(schema.automations.triggerType, "issue"),
      eq(schema.automations.repoFullName, repoFullName),
    ),
    orderBy: desc(schema.automations.createdAt),
  });
}

export async function getGitHubMentionAutomationsForRepo({
  db,
  repoFullName,
}: {
  db: DB;
  repoFullName: string;
}) {
  return await db.query.automations.findMany({
    where: and(
      eq(schema.automations.enabled, true),
      eq(schema.automations.triggerType, "github_mention"),
      eq(schema.automations.repoFullName, repoFullName),
    ),
    orderBy: desc(schema.automations.createdAt),
  });
}

export async function getAutomationForAdmin({
  db,
  automationId,
}: {
  db: DB;
  automationId: string;
}) {
  const automationColumns = getTableColumns(schema.automations);
  const result = await db
    .select({
      ...automationColumns,
      user: {
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
      },
    })
    .from(schema.automations)
    .leftJoin(schema.user, eq(schema.automations.userId, schema.user.id))
    .where(eq(schema.automations.id, automationId))
    .limit(1);
  if (!result[0]) {
    throw new Error("Automation not found");
  }
  return result[0];
}

export async function getAutomationStatsForAdmin({ db }: { db: DB }) {
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const [[statsResult], triggerTypeStats] = await Promise.all([
    db
      .select({
        totalAutomations: sql<number>`COUNT(*)::int`,
        totalUniqueUsers: sql<number>`COUNT(DISTINCT ${schema.automations.userId})::int`,
        totalRunsLastWeek: sql<number>`COUNT(CASE WHEN ${schema.automations.lastRunAt} >= ${oneWeekAgo} THEN 1 END)::int`,
        uniqueUsersLastWeek: sql<number>`COUNT(DISTINCT CASE WHEN ${schema.automations.lastRunAt} >= ${oneWeekAgo} THEN ${schema.automations.userId} END)::int`,
      })
      .from(schema.automations),
    db
      .select({
        count: count(),
        triggerType: schema.automations.triggerType,
      })
      .from(schema.automations)
      .groupBy(schema.automations.triggerType),
  ]);
  return {
    totalAutomations: statsResult?.totalAutomations ?? 0,
    totalUniqueUsers: statsResult?.totalUniqueUsers ?? 0,
    totalRunsLastWeek: statsResult?.totalRunsLastWeek ?? 0,
    uniqueUsersLastWeek: statsResult?.uniqueUsersLastWeek ?? 0,
    triggerTypeStats,
  };
}
