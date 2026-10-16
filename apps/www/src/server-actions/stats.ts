"use server";

import { getThreadsAndPRsStats } from "@terragon/shared/model/threads";
import {
  getOrgUsageStats,
  type OrgUsageStats,
  type RepoUsage,
} from "@terragon/shared/model/org-usage-stats";
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
}

export type RepoUsageRow = Omit<RepoUsage, "daily"> & {
  /** Tasks per day, oldest first, aligned with the range. */
  daily: number[];
};

/** Org-wide breakdowns; null without an active org (own totals only). */
export type UsageBreakdowns = Omit<
  OrgUsageStats,
  "byRepo" | "threadsCreated" | "prsMerged"
> & {
  byRepo: RepoUsageRow[];
};

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
    const breakdowns: UsageBreakdowns | null = orgStats
      ? {
          bySource: orgStats.bySource,
          funnel: orgStats.funnel,
          errored: orgStats.errored,
          notFinished: orgStats.notFinished,
          byRepo: orgStats.byRepo.map((repo) => ({
            ...repo,
            daily: datesOldestFirst.map((date) => repo.daily[date] ?? 0),
          })),
          byMember: mineOnly ? [] : orgStats.byMember,
        }
      : null;
    return {
      dailyStats,
      summary: { totalThreadsCreated, totalPRsMerged },
      breakdowns,
    };
  },
  { defaultErrorMessage: "Failed to get usage stats" },
);
