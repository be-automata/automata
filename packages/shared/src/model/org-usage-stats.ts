import { and, eq, gte, lte, sql } from "drizzle-orm";

import type { DB } from "../db";
import * as schema from "../db/schema";
import type { ThreadSource } from "../db/types";
import { toUTC, validateTimezone } from "../utils/timezone";
import { runStateFor, triggerKindFor, type TriggerKind } from "./run-state";
import {
  threadEffectiveErrorSql,
  threadEffectiveStatusSql,
} from "./thread-effective-status";
import { describeTerminalCause, isTerminalCause } from "./terminal-cause";

export interface RepoUsage {
  repoFullName: string;
  tasks: number;
  merged: number;
  errored: number;
  lastActivityAt: Date;
  /** Tasks created per day, keyed `yyyy-MM-dd` in the requested timezone. */
  daily: Record<string, number>;
}

export interface MemberUsage {
  userId: string;
  name: string | null;
  tasks: number;
  merged: number;
  topSource: TriggerKind;
}

export interface OrgUsageStats {
  threadsCreated: { date: string; threadsCreated: number }[];
  prsMerged: { date: string; prsMerged: number }[];
  byRepo: RepoUsage[];
  bySource: Record<TriggerKind, number>;
  byMember: MemberUsage[];
  funnel: {
    started: number;
    completed: number;
    openedPR: number;
    merged: number;
  };
  errored: number;
  notFinished: { label: string; count: number }[];
}

export const EMPTY_SOURCES = (): Record<TriggerKind, number> => ({
  web: 0,
  automation: 0,
  slack: 0,
  github: 0,
  cli: 0,
});

/**
 * Usage for one organization over a date range, optionally only one member's
 * threads. Counts only (no titles), so membership in the org is the only gate
 * the caller needs. Effective status reads the newest thread chat first
 * (chat-mode threads keep status there, see thread-effective-status.ts).
 */
export async function getOrgUsageStats({
  db,
  organizationId,
  userId,
  startDate,
  endDate,
  timezone = "UTC",
}: {
  db: DB;
  organizationId: string;
  userId?: string;
  startDate: Date;
  endDate: Date;
  timezone?: string;
}): Promise<OrgUsageStats> {
  const zone = validateTimezone(timezone);
  const createdDay = sql<string>`to_char(DATE((${schema.thread.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE '${sql.raw(zone)}'), 'YYYY-MM-DD')`;
  const mergedDay = sql<string>`to_char(DATE((${schema.githubPR.updatedAt} AT TIME ZONE 'UTC') AT TIME ZONE '${sql.raw(zone)}'), 'YYYY-MM-DD')`;
  const threadFence = and(
    eq(schema.thread.organizationId, organizationId),
    eq(schema.thread.shadow, false),
    userId ? eq(schema.thread.userId, userId) : undefined,
  );

  const [threads, merges] = await Promise.all([
    db
      .select({
        userId: schema.thread.userId,
        userName: schema.user.name,
        repoFullName: schema.thread.githubRepoFullName,
        day: createdDay,
        updatedAt: schema.thread.updatedAt,
        sourceType: schema.thread.sourceType,
        automationId: schema.thread.automationId,
        prNumber: schema.thread.githubPRNumber,
        prStatus: schema.githubPR.status,
        terminalCause: schema.thread.terminalCause,
        status: threadEffectiveStatusSql(),
        errorMessage: threadEffectiveErrorSql(),
      })
      .from(schema.thread)
      .leftJoin(schema.user, eq(schema.user.id, schema.thread.userId))
      .leftJoin(
        schema.githubPR,
        and(
          eq(schema.githubPR.number, schema.thread.githubPRNumber),
          eq(schema.githubPR.repoFullName, schema.thread.githubRepoFullName),
        ),
      )
      .where(
        and(
          threadFence,
          gte(schema.thread.createdAt, toUTC(startDate)),
          lte(schema.thread.createdAt, toUTC(endDate)),
        ),
      ),
    // One row per merged PR: review and mention threads share a PR, so a plain
    // join would count it once per thread. The earliest thread owns it.
    db
      .selectDistinctOn(
        [schema.githubPR.repoFullName, schema.githubPR.number],
        {
          day: mergedDay,
          repoFullName: schema.githubPR.repoFullName,
          userId: schema.thread.userId,
        },
      )
      .from(schema.githubPR)
      .innerJoin(
        schema.thread,
        and(
          eq(schema.thread.githubPRNumber, schema.githubPR.number),
          eq(schema.thread.githubRepoFullName, schema.githubPR.repoFullName),
        ),
      )
      .where(
        and(
          threadFence,
          eq(schema.githubPR.status, "merged"),
          gte(schema.githubPR.updatedAt, toUTC(startDate)),
          lte(schema.githubPR.updatedAt, toUTC(endDate)),
        ),
      )
      .orderBy(
        schema.githubPR.repoFullName,
        schema.githubPR.number,
        schema.thread.createdAt,
      ),
  ]);

  const createdByDay = new Map<string, number>();
  const repos = new Map<string, RepoUsage>();
  const members = new Map<
    string,
    MemberUsage & { sources: Record<TriggerKind, number> }
  >();
  const bySource = EMPTY_SOURCES();
  const causes = new Map<string, number>();
  let completed = 0;
  let openedPR = 0;
  let errored = 0;
  const mergedPRs = new Set<string>();

  for (const row of threads) {
    createdByDay.set(row.day, (createdByDay.get(row.day) ?? 0) + 1);
    const trigger = triggerKindFor({
      sourceType: (row.sourceType as ThreadSource | null) ?? null,
      automationId: row.automationId,
    });
    bySource[trigger]++;

    const repo = repos.get(row.repoFullName) ?? {
      repoFullName: row.repoFullName,
      tasks: 0,
      merged: 0,
      errored: 0,
      lastActivityAt: row.updatedAt,
      daily: {},
    };
    repo.tasks++;
    repo.daily[row.day] = (repo.daily[row.day] ?? 0) + 1;
    if (row.updatedAt > repo.lastActivityAt) {
      repo.lastActivityAt = row.updatedAt;
    }
    repos.set(row.repoFullName, repo);

    const member = members.get(row.userId) ?? {
      userId: row.userId,
      name: row.userName ?? null,
      tasks: 0,
      merged: 0,
      topSource: trigger,
      sources: EMPTY_SOURCES(),
    };
    member.tasks++;
    member.sources[trigger]++;
    members.set(row.userId, member);

    if (row.prNumber !== null) {
      openedPR++;
    }
    if (row.prNumber !== null && row.prStatus === "merged") {
      mergedPRs.add(`${row.repoFullName}#${row.prNumber}`);
    }
    const state = runStateFor({
      status: row.status,
      hasError: row.errorMessage !== null,
      terminalCause: row.terminalCause,
    });
    if (state.kind === "done") {
      completed++;
    } else if (state.kind === "needs-you" || state.kind === "unverified") {
      if (state.kind === "needs-you") {
        errored++;
        repo.errored++;
      }
      const label =
        row.terminalCause && isTerminalCause(row.terminalCause)
          ? describeTerminalCause(row.terminalCause).label
          : state.kind === "needs-you"
            ? "Agent error"
            : null;
      if (label) {
        causes.set(label, (causes.get(label) ?? 0) + 1);
      }
    }
  }

  const mergedByDay = new Map<string, number>();
  for (const merge of merges) {
    mergedByDay.set(merge.day, (mergedByDay.get(merge.day) ?? 0) + 1);
    const repo = repos.get(merge.repoFullName);
    if (repo) {
      repo.merged++;
    }
    const member = members.get(merge.userId);
    if (member) {
      member.merged++;
    }
  }

  return {
    threadsCreated: [...createdByDay].map(([date, threadsCreated]) => ({
      date,
      threadsCreated,
    })),
    prsMerged: [...mergedByDay].map(([date, prsMerged]) => ({
      date,
      prsMerged,
    })),
    byRepo: [...repos.values()].sort((a, b) => b.tasks - a.tasks),
    bySource,
    byMember: [...members.values()]
      .map(({ sources, ...member }) => ({
        ...member,
        topSource: (Object.entries(sources) as [TriggerKind, number][]).sort(
          (a, b) => b[1] - a[1],
        )[0]![0],
      }))
      .sort((a, b) => b.tasks - a.tasks),
    funnel: {
      started: threads.length,
      completed,
      openedPR,
      // Merged PRs of the threads started in range, so it never exceeds started.
      merged: mergedPRs.size,
    },
    errored,
    notFinished: [...causes]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
  };
}
