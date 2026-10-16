import { and, desc, gte, inArray, lte, sql } from "drizzle-orm";

import type { DB } from "../db";
import * as schema from "../db/schema";
import { displayRunTitle, runStateFor, type RunState } from "./run-state";
import {
  threadEffectiveErrorSql,
  threadEffectiveStatusSql,
} from "./thread-effective-status";

const HISTORY_LENGTH = 14;
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const SUCCESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** This many failures in a row marks an automation degraded. */
export const DEGRADED_AFTER_FAILURES = 3;

export type AutomationHealthKind =
  | "healthy"
  | "degraded"
  | "running"
  | "idle"
  | "paused";

export interface AutomationRun {
  threadId: string;
  title: string;
  state: RunState;
  createdAt: Date;
}

export interface AutomationHealth {
  automationId: string;
  health: AutomationHealthKind;
  /** Newest first, up to 14 runs. */
  history: AutomationRun[];
  lastRun: AutomationRun | null;
  /**
   * Share of the retained runs (the newest 14) from the last 7 days that
   * completed, among those that finished; null when none finished.
   */
  successRate7d: number | null;
  failuresInLast5: number;
}

/**
 * Health per automation in an organization, from the threads its runs created
 * (Factory-style "health, not just next run"; DESIGN.md Automations).
 */
export async function getAutomationHealth({
  db,
  automations,
  now = new Date(),
}: {
  db: DB;
  /** Automations the caller already fenced to the viewer's org (or user). */
  automations: { id: string; enabled: boolean }[];
  now?: Date;
}): Promise<Map<string, AutomationHealth>> {
  // Rank runs per automation so a busy automation cannot crowd a quiet one
  // out of the scan: each keeps its own newest HISTORY_LENGTH runs.
  const ranked = db
    .select({
      threadId: sql<string>`${schema.thread.id}`.as("thread_id"),
      name: sql<string | null>`${schema.thread.name}`.as("name"),
      automationId: sql<string>`${schema.thread.automationId}`.as(
        "automation_id",
      ),
      createdAt: sql<Date>`${schema.thread.createdAt}`
        .mapWith(schema.thread.createdAt)
        .as("created_at"),
      terminalCause: sql<string | null>`${schema.thread.terminalCause}`.as(
        "terminal_cause",
      ),
      status: threadEffectiveStatusSql().as("effective_status"),
      errorMessage: threadEffectiveErrorSql().as("effective_error"),
      rank: sql<number>`row_number() over (partition by ${schema.thread.automationId} order by ${schema.thread.createdAt} desc)`.as(
        "run_rank",
      ),
    })
    .from(schema.thread)
    .where(
      and(
        inArray(
          schema.thread.automationId,
          automations.map((a) => a.id),
        ),
        gte(schema.thread.createdAt, new Date(now.getTime() - LOOKBACK_MS)),
      ),
    )
    .as("ranked_runs");
  const runs =
    automations.length === 0
      ? []
      : await db
          .select()
          .from(ranked)
          .where(lte(ranked.rank, HISTORY_LENGTH))
          .orderBy(desc(ranked.createdAt));

  // Newest first, already capped at HISTORY_LENGTH per automation by the rank.
  const runsByAutomation = new Map<string, AutomationRun[]>();
  for (const run of runs) {
    const list = runsByAutomation.get(run.automationId) ?? [];
    list.push({
      threadId: run.threadId,
      title: displayRunTitle(run.name),
      createdAt: run.createdAt,
      state: runStateFor({
        status: run.status,
        hasError: run.errorMessage !== null,
        terminalCause: run.terminalCause,
      }),
    });
    runsByAutomation.set(run.automationId, list);
  }

  const since7d = now.getTime() - SUCCESS_WINDOW_MS;
  const result = new Map<string, AutomationHealth>();
  for (const automation of automations) {
    const history = runsByAutomation.get(automation.id) ?? [];
    const finished7d = history.filter(
      (run) =>
        run.createdAt.getTime() >= since7d &&
        (run.state.kind === "done" || run.state.kind === "needs-you"),
    );
    const done7d = finished7d.filter((run) => run.state.kind === "done");
    result.set(automation.id, {
      automationId: automation.id,
      health: healthFor(automation.enabled, history),
      history,
      lastRun: history[0] ?? null,
      successRate7d:
        finished7d.length === 0 ? null : done7d.length / finished7d.length,
      failuresInLast5: history
        .slice(0, 5)
        .filter((run) => run.state.kind === "needs-you").length,
    });
  }
  return result;
}

function healthFor(
  enabled: boolean,
  newestFirst: AutomationRun[],
): AutomationHealthKind {
  if (!enabled) {
    return "paused";
  }
  const lastRun = newestFirst[0];
  if (!lastRun) {
    return "idle";
  }
  if (lastRun.state.kind === "running" || lastRun.state.kind === "waiting") {
    return "running";
  }
  const firstSuccess = newestFirst.findIndex(
    (run) => run.state.kind !== "needs-you",
  );
  const consecutiveFailures =
    firstSuccess === -1 ? newestFirst.length : firstSuccess;
  return consecutiveFailures >= DEGRADED_AFTER_FAILURES
    ? "degraded"
    : "healthy";
}
