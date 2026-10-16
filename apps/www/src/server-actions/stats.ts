"use server";

import { getThreadsAndPRsStats } from "@terragon/shared/model/threads";
import {
  getOrgUsageStats,
  type MemberUsage,
  type OrgUsageStats,
} from "@terragon/shared/model/org-usage-stats";
import type { TriggerKind } from "@terragon/shared/model/run-state";
import { validateTimezone } from "@terragon/shared/utils/timezone";
import {
  getTenantContextOrNull,
  getUserInfoOrNull,
  userOnlyAction,
} from "@/lib/auth-server";
import { addDays, format, subDays, set as setDateValues } from "date-fns";
import { db } from "@/lib/db";
import { tz } from "@date-fns/tz";

export interface UsageStatsSummary {
  totalThreadsCreated: number;
  totalPRsMerged: number;
  completed: number;
  errored: number;
}

export interface RepoUsageRow {
  repoFullName: string;
  tasks: number;
  merged: number;
  errored: number;
  lastActivityAt: Date;
  /** Tasks per day, oldest first, aligned with the range. */
  daily: number[];
}

export interface UsageBreakdowns {
  /** False without an active org: only the viewer's own totals exist then. */
  orgScoped: boolean;
  byRepo: RepoUsageRow[];
  bySource: Record<TriggerKind, number>;
  byMember: MemberUsage[];
  funnel: OrgUsageStats["funnel"];
  notFinished: OrgUsageStats["notFinished"];
}

export interface DailyUsageStats {
  date: string;
  threadsCreated: number;
  prsMerged: number;
}

const defaultStats: Omit<DailyUsageStats, "date"> = {
  threadsCreated: 0,
  prsMerged: 0,
};

export const getUsageStats = userOnlyAction(
  async function getUsageStats(
    userId: string,
    {
      numDays,
      timezone,
      mineOnly = false,
    }: {
      numDays: number;
      timezone: string;
      mineOnly?: boolean;
    },
  ) {
    console.log("getUsageStats", { numDays, timezone, mineOnly });
    const userInfo = await getUserInfoOrNull();
    if (!userInfo) {
      throw new Error("Unauthorized");
    }
    if (numDays > 30) throw new Error("Max range is 30 days");
    if (numDays < 1) throw new Error("Min range is 1 day");
    const validatedTimezone = validateTimezone(timezone);
    const end = setDateValues(new Date(), {}, { in: tz(validatedTimezone) });
    const start = setDateValues(
      subDays(end, numDays - 1, {
        in: tz(validatedTimezone),
      }),
      { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 },
    );
    // Org-wide when the session has an active org (membership-checked);
    // otherwise only the viewer's own threads, as before.
    const tenant = await getTenantContextOrNull();
    const orgStats = tenant?.organizationId
      ? await getOrgUsageStats({
          db,
          organizationId: tenant.organizationId,
          userId: mineOnly ? userId : undefined,
          startDate: start,
          endDate: end,
          timezone: validatedTimezone,
        })
      : null;
    const threadsAndPRsData =
      orgStats ??
      (await getThreadsAndPRsStats({
        db,
        userId,
        startDate: start,
        endDate: end,
        timezone: validatedTimezone,
      }));

    // Transform threads and PRs data into daily stats
    const dailyStatsMap = new Map<string, DailyUsageStats>();

    // Generate all dates in the range
    let currentDate = new Date(start);
    const endTime = end.getTime();
    while (currentDate.getTime() <= endTime) {
      const dateKey = format(currentDate, "yyyy-MM-dd");
      if (!dailyStatsMap.has(dateKey)) {
        dailyStatsMap.set(dateKey, { ...defaultStats, date: dateKey });
      }
      currentDate = addDays(currentDate, 1);
    }
    let totalThreadsCreated = 0;
    let totalPRsMerged = 0;
    // Add threads and PRs data
    for (const data of threadsAndPRsData.threadsCreated) {
      if (!dailyStatsMap.has(data.date)) {
        continue;
      }
      const stats = dailyStatsMap.get(data.date)!;
      stats.threadsCreated = data.threadsCreated;
      totalThreadsCreated += data.threadsCreated;
    }
    for (const data of threadsAndPRsData.prsMerged) {
      if (!dailyStatsMap.has(data.date)) {
        continue;
      }
      const stats = dailyStatsMap.get(data.date)!;
      stats.prsMerged = data.prsMerged;
      totalPRsMerged += data.prsMerged;
    }

    // Convert map to sorted array (newest first)
    const dailyStats: DailyUsageStats[] = Array.from(
      dailyStatsMap.values(),
    ).sort((a, b) => b.date.localeCompare(a.date));
    const datesOldestFirst = [...dailyStats].reverse().map((d) => d.date);
    const breakdowns: UsageBreakdowns = {
      orgScoped: orgStats !== null,
      byRepo: (orgStats?.byRepo ?? []).map((repo) => ({
        repoFullName: repo.repoFullName,
        tasks: repo.tasks,
        merged: repo.merged,
        errored: repo.errored,
        lastActivityAt: repo.lastActivityAt,
        daily: datesOldestFirst.map((date) => repo.daily[date] ?? 0),
      })),
      bySource: orgStats?.bySource ?? {
        web: 0,
        automation: 0,
        slack: 0,
        github: 0,
        cli: 0,
      },
      byMember: mineOnly ? [] : (orgStats?.byMember ?? []),
      funnel: orgStats?.funnel ?? {
        started: totalThreadsCreated,
        completed: 0,
        openedPR: 0,
        merged: totalPRsMerged,
      },
      notFinished: orgStats?.notFinished ?? [],
    };
    return {
      dailyStats,
      summary: {
        totalThreadsCreated,
        totalPRsMerged,
        completed: orgStats?.funnel.completed ?? 0,
        errored: orgStats?.errored ?? 0,
      },
      breakdowns,
    };
  },
  { defaultErrorMessage: "Failed to get usage stats" },
);
