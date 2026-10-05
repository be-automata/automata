import { and, eq, gte, isNull, not } from "drizzle-orm";

import type { DB } from "@terragon/shared/db";
import {
  automations,
  hatchetRun,
  thread as threadTable,
} from "@terragon/shared/db/schema";
import type { ThreadStatus } from "@terragon/shared/db/types";
import {
  acquireSelfHealSlot,
  recordAdmissionDeferral,
  SELF_HEAL_SLOT_TERMINAL_STATUSES,
  type SelfHealSlotKind,
} from "@terragon/shared/model/self-heal-slot";
import { threadEffectiveStatusIn } from "@terragon/shared/model/threads";

import type { SelfHealLogMode } from "./decision-log";

/**
 * Review-first admission for every self-heal run (BULK-01, RES-11). The box
 * has one agent slot; a review queued behind a self-heal run can expire in the
 * engine's 30 min queue. So a self-heal run (audit or fix) is admitted only
 * when no review is in flight or queued anywhere on the platform, and then
 * only if it wins the single box slot. A deferred run takes nothing: no slot,
 * no claim, no attempt.
 */

/** Reviews older than this are not considered live (well past the 30 min queue). */
export const REVIEW_IN_FLIGHT_WINDOW_MS = 60 * 60 * 1000;

/** Effective statuses of a review that is waiting for, or using, the box. */
export const REVIEW_LIVE_STATUSES: ThreadStatus[] = [
  "queued",
  "queued-blocked",
  "queued-tasks-concurrency",
  "queued-sandbox-creation-rate-limit",
  "queued-agent-rate-limit",
  "booting",
  "working",
];

export type AdmissionDeferReason = "review_in_flight" | "slot_held";

export type AdmissionResult =
  | { admitted: true }
  | { admitted: false; reason: AdmissionDeferReason };

/** The thread row being read is not terminal (typed cause or effective status). */
function threadNotTerminal() {
  const terminal = threadEffectiveStatusIn(SELF_HEAL_SLOT_TERMINAL_STATUSES);
  return terminal
    ? and(isNull(threadTable.terminalCause), not(terminal))
    : isNull(threadTable.terminalCause);
}

/**
 * Is any review in flight or queued, platform-wide? Either a dispatched review
 * run (hatchet_run 'in_flight', recent, thread not terminal), or a PR-review
 * thread (its automation is pull_request-triggered) created recently whose
 * effective status is queued/booting/working — which also covers a review that
 * has not reached the engine yet and so has no hatchet_run row.
 */
export async function hasReviewInFlight({
  db,
  now = new Date(),
}: {
  db: DB;
  now?: Date;
}): Promise<boolean> {
  const since = new Date(now.getTime() - REVIEW_IN_FLIGHT_WINDOW_MS);
  const [dispatched, queued] = await Promise.all([
    db
      .select({ id: hatchetRun.id })
      .from(hatchetRun)
      .innerJoin(threadTable, eq(threadTable.id, hatchetRun.threadId))
      .where(
        and(
          eq(hatchetRun.status, "in_flight"),
          gte(hatchetRun.createdAt, since),
          threadNotTerminal(),
        ),
      )
      .limit(1),
    db
      .select({ id: threadTable.id })
      .from(threadTable)
      .innerJoin(automations, eq(automations.id, threadTable.automationId))
      .where(
        and(
          eq(automations.triggerType, "pull_request"),
          gte(threadTable.createdAt, since),
          threadEffectiveStatusIn(REVIEW_LIVE_STATUSES),
          threadNotTerminal(),
        ),
      )
      .limit(1),
  ]);
  return dispatched.length > 0 || queued.length > 0;
}

/** Optional ids for the deferral line; absent ones print as "-". */
export interface AdmissionLogContext {
  repoFullName?: string;
  runId?: string;
  fingerprint?: string;
  mode?: SelfHealLogMode;
}

export function formatAdmissionDeferredLine({
  organizationId,
  reason,
  context = {},
}: {
  organizationId: string;
  reason: AdmissionDeferReason;
  context?: AdmissionLogContext;
}): string {
  const fp = context.fingerprint ? context.fingerprint.slice(0, 8) : "-";
  return `[self-heal] v=1 org=${organizationId} repo=${context.repoFullName ?? "-"} run=${context.runId ?? "-"} fp=${fp} decision=dispatch reason=admission_deferred:${reason} mode=${context.mode ?? "-"}`;
}

/**
 * Admit one self-heal run: the review check first, then the slot CAS. Throws
 * on a database error — callers fail closed (treat it as deferred). A deferral
 * of a run with a known repo is also recorded for the admin metrics (R5);
 * that record is best effort and never changes the result.
 */
export async function admitSelfHealRun({
  db,
  organizationId,
  holderKind,
  now = new Date(),
  context,
  log = console.log,
  error = console.error,
  recordDeferral = recordAdmissionDeferral,
}: {
  db: DB;
  organizationId: string;
  holderKind: SelfHealSlotKind;
  now?: Date;
  context?: AdmissionLogContext;
  log?: (line: string) => void;
  error?: (message: string, fields: Record<string, unknown>) => void;
  recordDeferral?: typeof recordAdmissionDeferral;
}): Promise<AdmissionResult> {
  const defer = async (
    reason: AdmissionDeferReason,
  ): Promise<AdmissionResult> => {
    log(formatAdmissionDeferredLine({ organizationId, reason, context }));
    const repoFullName = context?.repoFullName;
    if (repoFullName) {
      try {
        await recordDeferral({
          db,
          organizationId,
          repoFullName,
          reason,
          now,
        });
      } catch (e) {
        error("[self-heal] admission deferral record failed", {
          reason,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { admitted: false, reason };
  };
  if (await hasReviewInFlight({ db, now })) return defer("review_in_flight");
  const slot = await acquireSelfHealSlot({
    db,
    organizationId,
    holderKind,
    now,
  });
  return slot.acquired ? { admitted: true } : defer("slot_held");
}
