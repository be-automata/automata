import type { GateSource } from "./required-checks";

/**
 * The fix-attempt timeline for the admin view (SC6 evidence): each attempt's
 * path claim → dispatch → check → draft → CI → ready → merged/closed, from
 * ledger timestamps only. Pure.
 *
 * - claim: claimed_at (created_at when the claim time is absent)
 * - dispatch: created_at of the attempt's thread (the dispatch creates it);
 *   null when the thread is gone or was never created
 * - check: check_reported_at (the worker's finding check)
 * - draft: pr_opened_at
 * - ci: ci_evaluated_at once CI is decided (passed, failed or stuck)
 * - ready: ready_at
 * - merged: merged_at
 * - closed: updated_at of an attempt that finished without a merge
 *
 * gateSource is ci_results.gateSource: protection | all-checks |
 * finding-check-only, null while undecided.
 */

export const ATTEMPT_TIMELINE_LIMIT = 20;

type Instant = Date | null;

export interface TimelineAttemptRow {
  id: string;
  findingId: string;
  attemptNo: number;
  threadId: string | null;
  phase: string;
  prNumber: number | null;
  prState: string | null;
  claimedAt: Instant;
  checkReportedAt: Instant;
  prOpenedAt: Instant;
  ciStatus: string | null;
  ciResults: unknown;
  ciEvaluatedAt: Instant;
  readyAt: Instant;
  mergedAt: Instant;
  outcome: string | null;
  infraRefunded: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AttemptTimelineSteps {
  claim: string | null;
  dispatch: string | null;
  check: string | null;
  draft: string | null;
  ci: string | null;
  ready: string | null;
  merged: string | null;
  closed: string | null;
}

export interface AttemptTimelineEntry {
  attemptId: string;
  findingId: string;
  attemptNo: number;
  prNumber: number | null;
  prUrl: string | null;
  phase: string;
  prState: string | null;
  ciStatus: string | null;
  gateSource: GateSource | null;
  outcome: string | null;
  infraRefunded: boolean;
  steps: AttemptTimelineSteps;
}

const GATE_SOURCES: ReadonlySet<string> = new Set<GateSource>([
  "protection",
  "all-checks",
  "finding-check-only",
]);

const DECIDED_CI = new Set(["passed", "failed", "stuck"]);

export function gateSourceOf(ciResults: unknown): GateSource | null {
  if (typeof ciResults !== "object" || ciResults === null) return null;
  const source = (ciResults as { gateSource?: unknown }).gateSource;
  return typeof source === "string" && GATE_SOURCES.has(source)
    ? (source as GateSource)
    : null;
}

function iso(value: Instant | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * The newest `limit` attempts (rows arrive newest first) with their steps.
 * `threadCreatedAt` maps thread id → creation time.
 */
export function buildAttemptTimeline({
  attempts,
  repoFullName,
  threadCreatedAt,
  limit = ATTEMPT_TIMELINE_LIMIT,
}: {
  attempts: readonly TimelineAttemptRow[];
  repoFullName: string;
  threadCreatedAt: ReadonlyMap<string, Date>;
  limit?: number;
}): AttemptTimelineEntry[] {
  return attempts.slice(0, limit).map((a) => {
    const merged = a.mergedAt !== null;
    return {
      attemptId: a.id,
      findingId: a.findingId,
      attemptNo: a.attemptNo,
      prNumber: a.prNumber,
      prUrl:
        a.prNumber === null
          ? null
          : `https://github.com/${repoFullName}/pull/${a.prNumber}`,
      phase: a.phase,
      prState: a.prState,
      ciStatus: a.ciStatus,
      gateSource: gateSourceOf(a.ciResults),
      outcome: a.outcome,
      infraRefunded: a.infraRefunded,
      steps: {
        claim: iso(a.claimedAt ?? a.createdAt),
        dispatch: iso(
          a.threadId === null ? null : threadCreatedAt.get(a.threadId),
        ),
        check: iso(a.checkReportedAt),
        draft: iso(a.prOpenedAt),
        ci:
          a.ciStatus !== null && DECIDED_CI.has(a.ciStatus)
            ? iso(a.ciEvaluatedAt)
            : null,
        ready: iso(a.readyAt),
        merged: iso(a.mergedAt),
        closed: a.phase === "closed" && !merged ? iso(a.updatedAt) : null,
      },
    };
  });
}
