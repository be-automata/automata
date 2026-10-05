import { eq } from "drizzle-orm";

import type { DB } from "@terragon/shared/db";
import { thread, threadChat } from "@terragon/shared/db/schema";
import type { ThreadStatus } from "@terragon/shared/db/types";
import {
  closeFixAttempt,
  extendFixDispatchLease,
  FIX_DISPATCH_LEASE_MS,
  FIX_THREAD_TERMINAL_STATUSES,
  listExpiredFixClaims,
  listStaleDispatchedAttempts,
  listTerminalUnreportedAttempts,
  refundFixAttempt,
  type FixAttemptThreadState,
} from "@terragon/shared/model/audit-fix-attempts";
import { recordBreakerEvent } from "@terragon/shared/model/self-heal-breaker";
import { releaseSelfHealSlot } from "@terragon/shared/model/self-heal-slot";
import type { TerminalCause } from "@terragon/shared/model/terminal-cause";
import { markThreadTerminal } from "@terragon/shared/model/threads";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";

import { hatchetConfig } from "@/agent/hatchet/dispatch";
import {
  listAgentRunsForThread,
  type AgentRunLookupHint,
  type AgentRunStatus,
} from "@/agent/hatchet/transport";
import { updateThreadChatWithTransition } from "@/agent/update-status";

import { classifyFixTerminal } from "./fix-outcome-classify";
import { errorText } from "./audit-shared";

/**
 * RECON-01 / RES-09 / RES-10 / KILL-01 / LEASE-01: never let infrastructure
 * burn a finding's attempts. Runs on the 10-minute self-heal tick, after the audit
 * sweep and BEFORE the fix dispatcher, bounded by the tick's deadline and
 * LIMIT 20 rows in total.
 *
 * 1. Expired claims that never bound a thread → refunded (claim_expired).
 * 2. Dispatched attempts past their dispatch lease whose thread never left
 *    queued/booting are read back from Hatchet (5 s, ≤ 3 pages):
 *    - no run at all → dispatch_lost: refunded, the zombie thread stopped,
 *      a hatchet_dispatch failure event;
 *    - a QUEUED/RUNNING run → lease extended 10 min, a success event;
 *    - only ended runs → the worker ran but the thread never moved: the
 *      thread is stopped and the attempt refunded with an exec_plane signal;
 *    - the lookup fails → NO change this tick (never guess NOT_FOUND).
 *    A thread already past boot just gets its lease extended; one parked on
 *    the agent's rate limit is a quota failure and is COUNTED.
 * 3. Terminal fix threads with no check report after a 10-minute grace are
 *    classified (fix-outcome-classify.ts): infra → refunded (+ exec_plane
 *    signal where the plane is at fault), Drain/kill → refunded as 'killed',
 *    credential 401/quota and agent failures → counted.
 *
 * Causes the dispatcher already assigned (thread_create_failed,
 * automation_cannot_run, invalid_snapshot, bind_lost) are closed attempts and
 * never reach these selectors, so they are not reclassified here.
 */

export const FIX_RECONCILE_LIMIT = 20;
export const FIX_RECONCILE_GRACE_MS = 600_000;
/** Hatchet read-back bounds, the same as the Drain route's. */
export const FIX_RECONCILE_LOOKUP_TIMEOUT_MS = 5_000;
export const FIX_RECONCILE_LOOKUP_MAX_PAGES = 3;
/** The breaker key for the installation-wide plane signals (as the dispatcher reads them). */
const PLANE_SCOPE_KEY = "*";

/** Never dispatched to the plane yet, or dispatched but not yet booted. */
const PRE_RUN_STATUSES = new Set<ThreadStatus>(["queued", "booting"]);
/** Waiting in a queue the platform drains on its own (not lost). */
const QUEUE_HOLD_STATUSES = new Set<ThreadStatus>([
  "queued-tasks-concurrency",
  "queued-sandbox-creation-rate-limit",
]);
/** Statuses a thread can be stopped from with the user.stop transition. */
const STOPPABLE_QUEUED_STATUSES = new Set<ThreadStatus>([
  "queued",
  "queued-tasks-concurrency",
  "queued-sandbox-creation-rate-limit",
  "queued-agent-rate-limit",
]);

export interface FixReconcileDeps {
  listRuns: (
    hint: AgentRunLookupHint,
  ) => Promise<Array<{ externalId: string; status: AgentRunStatus }>>;
  stopThread: (input: {
    db: DB;
    threadId: string;
    cause: TerminalCause;
  }) => Promise<void>;
  log: (message: string, fields?: Record<string, unknown>) => void;
  /** Wall clock for the deadline checks; defaults to the real clock. */
  clock?: () => Date;
}

export interface FixReconcileResult {
  /** Dispatches Hatchet never saw: refunded, thread stopped. */
  lost: number;
  /** Leases pushed forward (live run, or a thread past boot / queue-held). */
  extended: number;
  /** Infra refunds (expired claims, dead runs, infra terminals). */
  refunded: number;
  /** Attempts closed as counted (credential, agent failure). */
  counted: number;
  /** Drain / kill-switch cancels refunded as 'killed'. */
  killed: number;
  /** Hatchet lookups that failed; left unchanged this tick. */
  lookupFailed: number;
}

/**
 * Stop a fix thread nobody will finish. Booting/working threads go through the
 * shared typed-terminal writer; a still-queued thread (not reapable there) is
 * walked through the user.stop transition so a queue drain cannot start it
 * later on a refunded attempt.
 */
export async function stopFixThread({
  db,
  threadId,
  cause,
}: {
  db: DB;
  threadId: string;
  cause: TerminalCause;
}): Promise<void> {
  if (await markThreadTerminal({ db, threadId, cause })) return;
  const [row] = await db
    .select({
      userId: thread.userId,
      version: thread.version,
      status: thread.status,
    })
    .from(thread)
    .where(eq(thread.id, threadId))
    .limit(1);
  if (!row) return;
  const chats =
    row.version > 0
      ? await db
          .select({ id: threadChat.id, status: threadChat.status })
          .from(threadChat)
          .where(eq(threadChat.threadId, threadId))
      : [{ id: LEGACY_THREAD_CHAT_ID, status: row.status }];
  for (const chat of chats) {
    if (!STOPPABLE_QUEUED_STATUSES.has(chat.status)) continue;
    await updateThreadChatWithTransition({
      userId: row.userId,
      threadId,
      threadChatId: chat.id,
      eventType: "user.stop",
    });
  }
}

export function defaultFixReconcileDeps(): FixReconcileDeps {
  return {
    listRuns: (hint) =>
      listAgentRunsForThread(hint, hatchetConfig(), {
        signal: AbortSignal.timeout(FIX_RECONCILE_LOOKUP_TIMEOUT_MS),
        maxPages: FIX_RECONCILE_LOOKUP_MAX_PAGES,
      }),
    stopThread: stopFixThread,
    log: (message, fields) => console.log(message, fields ?? {}),
  };
}

function isTerminalThread(state: NonNullable<FixAttemptThreadState["thread"]>) {
  return (
    state.terminalCause !== null ||
    FIX_THREAD_TERMINAL_STATUSES.includes(state.status)
  );
}

export async function runFixDispatchReconcile({
  db,
  now,
  deadlineAt,
  limit = FIX_RECONCILE_LIMIT,
  graceMs = FIX_RECONCILE_GRACE_MS,
  deps = defaultFixReconcileDeps(),
}: {
  db: DB;
  now: Date;
  deadlineAt: Date;
  limit?: number;
  graceMs?: number;
  deps?: FixReconcileDeps;
}): Promise<FixReconcileResult> {
  const { listRuns, stopThread, log } = deps;
  const clock = deps.clock ?? (() => new Date());
  const result: FixReconcileResult = {
    lost: 0,
    extended: 0,
    refunded: 0,
    counted: 0,
    killed: 0,
    lookupFailed: 0,
  };
  let budget = limit;
  const pastDeadline = () => clock().getTime() >= deadlineAt.getTime();

  const planeEvent = (
    organizationId: string,
    scopeKind: "exec_plane" | "hatchet_dispatch",
    outcome: "success" | "failure",
    signal: string,
  ) =>
    recordBreakerEvent({
      db,
      organizationId,
      scopeKind,
      scopeKey: PLANE_SCOPE_KEY,
      outcome,
      signal,
      now,
    });

  /** Run one row; a failure is logged and never stops the tick. */
  const guarded = async (
    attemptId: string,
    work: () => Promise<void>,
  ): Promise<void> => {
    try {
      await work();
    } catch (error) {
      log("[self-heal-reconcile] row failed", {
        attemptId,
        error: errorText(error),
      });
    }
  };

  // 1. LEASE-01: claims that never bound a thread.
  if (budget > 0 && !pastDeadline()) {
    const claims = await listExpiredFixClaims({ db, now, limit: budget });
    budget -= claims.length;
    for (const claim of claims) {
      if (pastDeadline()) return result;
      await guarded(claim.id, async () => {
        const refunded = await refundFixAttempt({
          db,
          organizationId: claim.organizationId,
          attemptId: claim.id,
          cause: "claim_expired",
          now,
        });
        if (refunded) {
          result.refunded++;
          log("[self-heal-reconcile] expired claim refunded", {
            attemptId: claim.id,
            org: claim.organizationId,
          });
        }
      });
    }
  }

  // 2. RES-09: dispatched attempts past their lease.
  if (budget > 0 && !pastDeadline()) {
    const stale = await listStaleDispatchedAttempts({
      db,
      now,
      limit: budget,
    });
    budget -= stale.length;
    for (const row of stale) {
      if (pastDeadline()) return result;
      await guarded(row.attempt.id, () =>
        reconcileStaleDispatch({
          db,
          now,
          row,
          deps: { listRuns, stopThread, log },
          planeEvent,
          result,
        }),
      );
    }
  }

  // 3. RES-10 / KILL-01: terminal fix threads that never reported.
  if (budget > 0 && !pastDeadline()) {
    const terminal = await listTerminalUnreportedAttempts({
      db,
      now,
      graceMs,
      limit: budget,
    });
    for (const row of terminal) {
      if (pastDeadline()) return result;
      await guarded(row.attempt.id, () =>
        reconcileTerminal({ db, now, row, log, planeEvent, result }),
      );
    }
  }

  return result;
}

type PlaneEvent = (
  organizationId: string,
  scopeKind: "exec_plane" | "hatchet_dispatch",
  outcome: "success" | "failure",
  signal: string,
) => Promise<void>;

async function reconcileStaleDispatch({
  db,
  now,
  row,
  deps,
  planeEvent,
  result,
}: {
  db: DB;
  now: Date;
  row: FixAttemptThreadState;
  deps: Omit<FixReconcileDeps, "clock">;
  planeEvent: PlaneEvent;
  result: FixReconcileResult;
}): Promise<void> {
  const { attempt } = row;
  const org = attempt.organizationId;
  const extend = async (reason: string) => {
    const extended = await extendFixDispatchLease({
      db,
      organizationId: org,
      attemptId: attempt.id,
      until: new Date(now.getTime() + FIX_DISPATCH_LEASE_MS),
    });
    if (extended) {
      result.extended++;
      deps.log("[self-heal-reconcile] dispatch lease extended", {
        attemptId: attempt.id,
        org,
        reason,
      });
    }
  };

  if (!row.thread) {
    if (
      await refundFixAttempt({
        db,
        organizationId: org,
        attemptId: attempt.id,
        cause: "thread_missing",
        now,
      })
    ) {
      result.refunded++;
    }
    return;
  }
  const t = row.thread;
  // A terminal thread is the terminal pass's (after its grace).
  if (isTerminalThread(t)) return;

  if (t.status === "queued-agent-rate-limit") {
    // Quota: counted, never a refund nor a plane signal (operator decision).
    await deps.stopThread({ db, threadId: t.id, cause: "timeout" });
    if (
      await closeFixAttempt({
        db,
        organizationId: org,
        attemptId: attempt.id,
        outcome: "run_failed",
        counted: true,
        terminalCause: "credential",
        now,
      })
    ) {
      result.counted++;
      await releaseSelfHealSlot({ db, threadId: t.id });
    }
    return;
  }
  if (QUEUE_HOLD_STATUSES.has(t.status)) return extend("queue_hold");
  if (!PRE_RUN_STATUSES.has(t.status)) return extend("past_boot");

  let runs: Array<{ externalId: string; status: AgentRunStatus }>;
  try {
    runs = await deps.listRuns({ createdAt: t.createdAt, threadId: t.id });
  } catch (error) {
    // T-09-07-2: a failed lookup is never read as NOT_FOUND.
    result.lookupFailed++;
    deps.log("[self-heal-reconcile] hatchet lookup failed; unchanged", {
      attemptId: attempt.id,
      threadId: t.id,
      error: errorText(error),
    });
    return;
  }

  if (runs.some((r) => r.status === "QUEUED" || r.status === "RUNNING")) {
    await planeEvent(org, "hatchet_dispatch", "success", "dispatch_visible");
    return extend("run_live");
  }

  if (runs.length === 0) {
    // T-09-07-4: stop the zombie and record why.
    await deps.stopThread({ db, threadId: t.id, cause: "plane-offline" });
    if (
      await refundFixAttempt({
        db,
        organizationId: org,
        attemptId: attempt.id,
        cause: "dispatch_lost",
        now,
      })
    ) {
      result.lost++;
      await planeEvent(org, "hatchet_dispatch", "failure", "dispatch_lost");
      await releaseSelfHealSlot({ db, threadId: t.id });
      deps.log("[self-heal-reconcile] dispatch lost; refunded", {
        attemptId: attempt.id,
        threadId: t.id,
        org,
      });
    }
    return;
  }

  // The engine ran it, but the thread never left boot: the worker died.
  await deps.stopThread({ db, threadId: t.id, cause: "daemon-failed" });
  if (
    await refundFixAttempt({
      db,
      organizationId: org,
      attemptId: attempt.id,
      cause: "daemon_failed",
      now,
    })
  ) {
    result.refunded++;
    await planeEvent(org, "hatchet_dispatch", "success", "dispatch_visible");
    await planeEvent(org, "exec_plane", "failure", "daemon_failed");
    await releaseSelfHealSlot({ db, threadId: t.id });
  }
}

async function reconcileTerminal({
  db,
  now,
  row,
  log,
  planeEvent,
  result,
}: {
  db: DB;
  now: Date;
  row: FixAttemptThreadState;
  log: FixReconcileDeps["log"];
  planeEvent: PlaneEvent;
  result: FixReconcileResult;
}): Promise<void> {
  const { attempt } = row;
  const t = row.thread;
  if (!t) return;
  const org = attempt.organizationId;
  const verdict = classifyFixTerminal({
    terminalCause: t.terminalCause,
    errorMessage: t.errorMessage,
    status: t.status,
    hasCheckReport: attempt.checkReportedAt !== null,
    killed: false,
  });

  const applied =
    verdict.class === "infra"
      ? await refundFixAttempt({
          db,
          organizationId: org,
          attemptId: attempt.id,
          cause: verdict.reason,
          outcome: verdict.outcome,
          now,
        })
      : await closeFixAttempt({
          db,
          organizationId: org,
          attemptId: attempt.id,
          outcome: verdict.outcome,
          counted: true,
          terminalCause: verdict.reason,
          now,
        });
  if (!applied) return;

  if (verdict.class === "counted") result.counted++;
  else if (verdict.outcome === "killed") result.killed++;
  else result.refunded++;
  if (verdict.execPlaneSignal) {
    await planeEvent(org, "exec_plane", "failure", verdict.reason);
  }
  await releaseSelfHealSlot({ db, threadId: t.id });
  log("[self-heal-reconcile] terminal fix run classified", {
    attemptId: attempt.id,
    threadId: t.id,
    org,
    class: verdict.class,
    reason: verdict.reason,
    outcome: verdict.outcome,
  });
}
