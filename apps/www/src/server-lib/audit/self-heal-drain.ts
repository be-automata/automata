import { and, desc, eq, exists, inArray, or, sql } from "drizzle-orm";

import type { DB } from "@terragon/shared/db";
import { thread as threadTable, threadChat } from "@terragon/shared/db/schema";
import type { ThreadStatus } from "@terragon/shared/db/types";
import {
  finishAuditRun,
  getAuditRunByThread,
} from "@terragon/shared/model/audit-findings";
import { getLatestHatchetRunForThread } from "@terragon/shared/model/hatchet-run";
import {
  ORG_DEFAULT_REPO_SENTINEL,
  upsertRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";
import { recordSelfHealAdminAction } from "@terragon/shared/model/self-heal-admin-log";
import { markThreadTerminal } from "@terragon/shared/model/threads";

import type {
  AgentRunLookupHint,
  AgentRunStatus,
} from "@/agent/hatchet/transport";

import { SELF_HEAL_SKILL_NAMES } from "../review/review-skill";
import { errorText } from "./audit-shared";

/**
 * KILL-01 Drain: one admin action that pulls the org kill switch and cancels
 * every in-flight self-heal run of the org through the Hatchet cancel path.
 *
 * Order matters: the kill switch is set FIRST, so a run that outlives a failed
 * cancel still finishes as 'killed' with no GitHub call (the resolver checks
 * the switch before anything else). Run state is read from the windowed
 * collection route; a thread whose lookup fails is reported in `lookupFailed`
 * and left alone, never cancelled blindly. Idempotent: a second Drain with
 * nothing in flight cancels nothing and still succeeds.
 */

/** Threads drained per action; the rest are caught by the next Drain. */
export const DRAIN_THREAD_LIMIT = 20;

/** Thread statuses where a run may still be alive (everything not terminal). */
const LIVE_THREAD_STATUSES: ThreadStatus[] = [
  "queued",
  "queued-tasks-concurrency",
  "queued-sandbox-creation-rate-limit",
  "queued-agent-rate-limit",
  "booting",
  "working",
  "stopping",
  "checkpointing",
];

export interface DrainResult {
  killSwitchSet: boolean;
  /** Thread ids whose live runs were cancelled. */
  cancelled: string[];
  /** Thread ids whose run lookup failed; their runs were NOT cancelled. */
  lookupFailed: string[];
  /** Thread ids whose lookup succeeded but whose cancel call failed. */
  cancelFailed: string[];
  nothingInFlight: boolean;
}

export interface DrainDeps {
  listRuns: (
    hint: AgentRunLookupHint,
  ) => Promise<Array<{ externalId: string; status: AgentRunStatus }>>;
  cancel: (externalIds: string[]) => Promise<void>;
  now: () => Date;
  log: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Close the books on a thread whose runs the engine just cancelled. The
 * cancelled run never posts its terminal, so without this the thread stays
 * 'working' and its audit run 'dispatched' forever (observed live: 22+ min,
 * no sweep closes them).
 *
 * Thread: the shared typed-terminal writer (`markThreadTerminal`, the one the
 * supersede/C4 sweep and run-terminal route use) stamps thread AND threadChat
 * in one transaction; it only moves a still-reapable thread, so it is
 * idempotent. Cause is 'user-cancelled' (an admin cancel). Audit run: finished
 * done/killed, unless it already reached a terminal state.
 * Best-effort per thread: a failure here is logged, never fails the Drain.
 */
async function closeCancelledThread({
  db,
  organizationId,
  threadId,
  log,
}: {
  db: DB;
  organizationId: string;
  threadId: string;
  log: DrainDeps["log"];
}): Promise<void> {
  try {
    await markThreadTerminal({ db, threadId, cause: "user-cancelled" });
    const run = await getAuditRunByThread({ db, organizationId, threadId });
    if (run && run.status !== "done" && run.status !== "failed") {
      await finishAuditRun({
        db,
        organizationId,
        id: run.id,
        status: "done",
        outcome: "killed",
      });
    }
    log("[self-heal-drain] thread closed after cancel", {
      threadId,
      reason: "stopped by self-heal drain",
    });
  } catch (error) {
    log("[self-heal-drain] closing cancelled thread failed", {
      threadId,
      error: errorText(error),
    });
  }
}

async function selectInFlightThreads({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<Array<{ id: string; createdAt: Date }>> {
  return db
    .select({ id: threadTable.id, createdAt: threadTable.createdAt })
    .from(threadTable)
    .where(
      and(
        eq(threadTable.organizationId, organizationId),
        sql`${threadTable.sourceMetadata}->>'type' = 'automation-skill'`,
        inArray(
          sql`${threadTable.sourceMetadata}->>'skillName'`,
          // Readonly tuple to mutable list for drizzle.
          [...SELF_HEAL_SKILL_NAMES],
        ),
        // Effective status: the thread row for legacy (v0) threads, the chat
        // rows for chat-mode threads.
        or(
          and(
            eq(threadTable.version, 0),
            inArray(threadTable.status, LIVE_THREAD_STATUSES),
          ),
          and(
            sql`${threadTable.version} > 0`,
            exists(
              db
                .select({ one: sql`1` })
                .from(threadChat)
                .where(
                  and(
                    eq(threadChat.threadId, threadTable.id),
                    inArray(threadChat.status, LIVE_THREAD_STATUSES),
                  ),
                ),
            ),
          ),
        ),
      ),
    )
    .orderBy(desc(threadTable.createdAt))
    .limit(DRAIN_THREAD_LIMIT);
}

export async function drainSelfHeal({
  db,
  organizationId,
  actorUserId,
  deps,
}: {
  db: DB;
  organizationId: string;
  actorUserId: string;
  deps: DrainDeps;
}): Promise<DrainResult> {
  const { listRuns, cancel, log } = deps;

  await upsertRepoReviewSetting({
    db,
    organizationId,
    repoFullName: ORG_DEFAULT_REPO_SENTINEL,
    patch: { selfHealKillSwitch: true },
    updatedByUserId: actorUserId,
  });
  log("[self-heal-drain] kill switch set", { organizationId, actorUserId });

  const threads = await selectInFlightThreads({ db, organizationId });
  log("[self-heal-drain] in-flight self-heal threads", {
    organizationId,
    count: threads.length,
  });

  const cancelled: string[] = [];
  const lookupFailed: string[] = [];
  const cancelFailed: string[] = [];

  for (const t of threads) {
    let live: string[];
    try {
      const latest = await getLatestHatchetRunForThread({
        db,
        threadId: t.id,
      });
      const runs = await listRuns({
        createdAt: latest?.createdAt ?? t.createdAt,
        threadId: t.id,
      });
      live = runs
        .filter((r) => r.status === "QUEUED" || r.status === "RUNNING")
        .map((r) => r.externalId);
    } catch (error) {
      lookupFailed.push(t.id);
      log("[self-heal-drain] run lookup failed; thread left uncancelled", {
        threadId: t.id,
        error: errorText(error),
      });
      continue;
    }
    if (live.length === 0) {
      log("[self-heal-drain] no live run for thread", { threadId: t.id });
      continue;
    }
    try {
      await cancel(live);
      cancelled.push(t.id);
      log("[self-heal-drain] cancelled runs", {
        threadId: t.id,
        runs: live.length,
      });
      await closeCancelledThread({
        db,
        organizationId,
        threadId: t.id,
        log,
      });
    } catch (error) {
      cancelFailed.push(t.id);
      log("[self-heal-drain] cancel failed", {
        threadId: t.id,
        error: errorText(error),
      });
    }
  }

  await recordSelfHealAdminAction({
    db,
    organizationId,
    actorUserId,
    action: "drain",
    target: {
      killSwitchSet: true,
      cancelled,
      lookupFailed,
      cancelFailed,
      at: deps.now().toISOString(),
    },
  });

  return {
    killSwitchSet: true,
    cancelled,
    lookupFailed,
    cancelFailed,
    nothingInFlight: threads.length === 0,
  };
}
