import { and, desc, gte, inArray, sql } from "drizzle-orm";

import type { DB } from "../db";
import * as schema from "../db/schema";
import type { ThreadStatus } from "../db/types";
import { runStateFor, type RunState } from "./run-state";

const HISTORY_LENGTH = 14;
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const SUCCESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_SCAN_LIMIT = 2000;
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
  state: RunState;
  createdAt: Date;
}

export interface AutomationHealth {
  automationId: string;
  health: AutomationHealthKind;
  /** Newest last, up to 14 runs. */
  history: AutomationRun[];
  lastRun: AutomationRun | null;
  /** Share of finished runs in the last 7 days that completed; null when none finished. */
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
  const runs =
    automations.length === 0
      ? []
      : await db
          .select({
            threadId: schema.thread.id,
            automationId: schema.thread.automationId,
            createdAt: schema.thread.createdAt,
            terminalCause: schema.thread.terminalCause,
            status: sql<ThreadStatus>`COALESCE((select ${schema.threadChat.status} from ${schema.threadChat} where ${schema.threadChat.threadId} = ${schema.thread.id} order by ${schema.threadChat.updatedAt} desc limit 1), ${schema.thread.status})`,
            errorMessage: sql<
              string | null
            >`COALESCE((select ${schema.threadChat.errorMessage} from ${schema.threadChat} where ${schema.threadChat.threadId} = ${schema.thread.id} order by ${schema.threadChat.updatedAt} desc limit 1), ${schema.thread.errorMessage})`,
          })
          .from(schema.thread)
          .where(
            and(
              inArray(
                schema.thread.automationId,
                automations.map((a) => a.id),
              ),
              gte(
                schema.thread.createdAt,
                new Date(now.getTime() - LOOKBACK_MS),
              ),
            ),
          )
          .orderBy(desc(schema.thread.createdAt))
          .limit(RUN_SCAN_LIMIT);

  const runsByAutomation = new Map<
    string,
    (AutomationRun & { createdAt: Date })[]
  >();
  for (const run of runs) {
    // The inArray filter above guarantees the id.
    const automationId = run.automationId!;
    const list = runsByAutomation.get(automationId) ?? [];
    if (list.length >= HISTORY_LENGTH) {
      continue;
    }
    list.push({
      threadId: run.threadId,
      createdAt: run.createdAt,
      state: runStateFor({
        status: run.status,
        hasError: run.errorMessage !== null && run.status !== "working",
        terminalCause: run.terminalCause,
      }),
    });
    runsByAutomation.set(automationId, list);
  }

  const since7d = now.getTime() - SUCCESS_WINDOW_MS;
  const result = new Map<string, AutomationHealth>();
  for (const automation of automations) {
    const newestFirst = runsByAutomation.get(automation.id) ?? [];
    const finished7d = newestFirst.filter(
      (run) =>
        run.createdAt.getTime() >= since7d &&
        (run.state.kind === "done" || run.state.kind === "needs-you"),
    );
    const done7d = finished7d.filter((run) => run.state.kind === "done");
    const failuresInLast5 = newestFirst
      .slice(0, 5)
      .filter((run) => run.state.kind === "needs-you").length;
    const leadingFailures = newestFirst.findIndex(
      (run) => run.state.kind !== "needs-you",
    );
    const consecutiveFailures =
      leadingFailures === -1 ? newestFirst.length : leadingFailures;
    const lastRun = newestFirst[0] ?? null;
    const health: AutomationHealthKind = !automation.enabled
      ? "paused"
      : lastRun &&
          (lastRun.state.kind === "running" || lastRun.state.kind === "waiting")
        ? "running"
        : consecutiveFailures >= DEGRADED_AFTER_FAILURES
          ? "degraded"
          : lastRun
            ? "healthy"
            : "idle";
    result.set(automation.id, {
      automationId: automation.id,
      health,
      history: [...newestFirst].reverse(),
      lastRun,
      successRate7d:
        finished7d.length === 0 ? null : done7d.length / finished7d.length,
      failuresInLast5,
    });
  }
  return result;
}
