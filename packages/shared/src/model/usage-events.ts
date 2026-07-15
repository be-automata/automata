import type { DB } from "../db";
import type { UsageEventType, UsageSku } from "../db/types";
import * as schema from "../db/schema";
import { and, eq, gte, lte, sql, sum } from "drizzle-orm";
import { toUTC, validateTimezone } from "../utils/timezone";
import { BILLABLE_EVENT_TYPES } from "./credits";
import { publishBroadcastUserMessage } from "../broadcast-server";

export async function trackUsageEventBatched({
  db,
  userId,
  events,
}: {
  db: DB;
  userId: string;
  events: {
    eventType: UsageEventType;
    value: number;
    createdAt?: Date;
    tokenUsage?: {
      inputTokens?: number | null;
      cachedInputTokens?: number | null;
      cacheCreationInputTokens?: number | null;
      outputTokens?: number | null;
    };
    sku?: UsageSku | null;
  }[];
}) {
  await db.insert(schema.usageEvents).values(
    events.map((e) => ({
      userId,
      eventType: e.eventType,
      value: e.value.toString(),
      sku: e.sku ?? null,
      inputTokens: e.tokenUsage?.inputTokens ?? null,
      cachedInputTokens: e.tokenUsage?.cachedInputTokens ?? null,
      cacheCreationInputTokens: e.tokenUsage?.cacheCreationInputTokens ?? null,
      outputTokens: e.tokenUsage?.outputTokens ?? null,
      createdAt: e.createdAt ?? new Date(),
    })),
  );
  if (events.some((e) => BILLABLE_EVENT_TYPES.includes(e.eventType))) {
    await publishBroadcastUserMessage({
      type: "user",
      id: userId,
      data: {
        userCredits: true,
      },
    });
  }
}

export async function getUserUsageEvents({
  db,
  userId,
  eventType,
  startDate,
  endDate,
  organizationId,
}: {
  db: DB;
  userId: string;
  eventType?: UsageEventType;
  startDate?: Date;
  endDate?: Date;
  // Tenant fence (WI-5). Optional; the forTenant accessor supplies it. Inert
  // until the usage WRITE path stamps org from the thread context (billing
  // rollup wiring, later) — null = user-only, today's behavior.
  organizationId?: string | null;
}) {
  const conditions = [eq(schema.usageEvents.userId, userId)];
  if (organizationId) {
    conditions.push(eq(schema.usageEvents.organizationId, organizationId));
  }
  if (eventType) {
    conditions.push(eq(schema.usageEvents.eventType, eventType));
  }
  if (startDate) {
    conditions.push(gte(schema.usageEvents.createdAt, startDate));
  }
  if (endDate) {
    conditions.push(lte(schema.usageEvents.createdAt, endDate));
  }
  return db
    .select()
    .from(schema.usageEvents)
    .where(and(...conditions))
    .orderBy(schema.usageEvents.createdAt);
}

export async function getUserUsageEventsAggregated({
  db,
  userId,
  startDate,
  endDate,
  timezone = "UTC",
  organizationId,
}: {
  db: DB;
  userId: string;
  startDate: Date;
  endDate: Date;
  timezone?: string;
  // Tenant fence (WI-5). Optional; inert until usage writes stamp org.
  organizationId?: string | null;
}) {
  const validatedTimezone = validateTimezone(timezone);
  const dateExpression = sql<string>`DATE((${schema.usageEvents.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE '${sql.raw(validatedTimezone)}')`;
  const agg = await db
    .select({
      eventType: schema.usageEvents.eventType,
      value: sum(schema.usageEvents.value),
      date: dateExpression,
    })
    .from(schema.usageEvents)
    .groupBy(dateExpression, schema.usageEvents.eventType)
    .orderBy(dateExpression)
    .where(
      and(
        eq(schema.usageEvents.userId, userId),
        organizationId
          ? eq(schema.usageEvents.organizationId, organizationId)
          : undefined,
        gte(schema.usageEvents.createdAt, toUTC(startDate)),
        lte(schema.usageEvents.createdAt, toUTC(endDate)),
      ),
    );
  return agg;
}
