import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lte,
  max,
  ne,
  or,
} from "drizzle-orm";

import type { DB } from "@terragon/shared/db";
import {
  auditFindings,
  auditFixAttempts,
  auditRuns,
  selfHealBreaker,
  selfHealBreakerEvent,
} from "@terragon/shared/db/schema";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";
import {
  closeBreakerAfterProbe,
  getBreakerState,
  moveExpiredToHalfOpen,
  probeAttemptIdOf,
  releaseHalfOpenProbe,
  tripBreaker,
  type BreakerCapture,
  type BreakerLogger,
  type BreakerRow,
  type BreakerScopeKind,
  type BreakerTransition,
} from "@terragon/shared/model/self-heal-breaker";

import { getPostHogServer } from "@/lib/posthog-server";

import {
  BREAKER_EXCLUDED_REASONS,
  GATE_REFUND_SIGNALS,
  isGateRefundCause,
} from "./fix-outcome-classify";
import { errorText } from "./audit-shared";

/**
 * The automatic stops of the self-heal loop (BRK-01 remainder, RESILIENCE
 * 3.2-3.3). The loop is low-volume (a few fix attempts a week per repo), so
 * the loop breakers trip on CONSECUTIVE counts and strong signals instead of
 * waiting for a rate over a volume that never comes:
 *
 * - loop_fix (per repo): 3 consecutive counted failures, ≥ 50% of the last 6
 *   attempts in 14 days (min 4), 2 guard rejections in the last 10, 3
 *   consecutive CI failures across different findings, ≥ 2 reopen/regressed
 *   events in 30 days, 2 consecutive expired PRs, ≥ 3 gh_403/gh_422 on the
 *   repo's writes in 1 h; draft_unsupported pauses the repo at once.
 *   Refunded (infra) attempts never count as failures, but 3 consecutive
 *   refunded GATE outcomes (ci_infra / ci_stuck / check_error events, no
 *   decided attempt in between) trip it: the refunds stay refunds, the
 *   breaker just stops the paid re-runs (R2).
 * - loop_audit (per repo): 3 consecutive unparseable/incomplete/over-cap
 *   audits, or churn (≥ 50% of the issues filed in 14 days closed as absent
 *   within 2 audits). While open the writer behaves as dry-run.
 * - hatchet_dispatch / exec_plane ('*' per org): consecutive and rate rules
 *   over the plane events the reconcile and the dispatch record.
 *
 * Cost, spend, credential 401 and quota are never inputs (operator decision).
 *
 * The evaluators are pure; runLoopBreakerEvaluation reads the ledger on the
 * tick and applies trips/half-open moves through the shared CAS helpers.
 * Breakers only narrow: a manual switch always wins, and toggling the mode
 * never resets a breaker (only the attributed admin reset does).
 */

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const LOOP_LOOKBACK_MS = 30 * DAY_MS;
const RATE_WINDOW_MS = 14 * DAY_MS;
const GH_ERROR_WINDOW_MS = HOUR_MS;
const HATCHET_RATE_WINDOW_MS = 10 * MIN_MS;
const HATCHET_LOOKBACK_MS = DAY_MS;

export const LOOP_BREAKER_LIMIT = 20;
const ATTEMPT_SCAN_LIMIT = 20;
const EVENT_SCAN_LIMIT = 200;
const RUN_SCAN_LIMIT = 50;
const PLANE_SCAN_LIMIT = 50;
const MIN_ITEM_BUDGET_MS = 1_000;

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export type LoopFixAttemptResult =
  /** Counted against the finding: the fix or its gate failed. */
  | "failure"
  /** The draft opened with the finding check and the guard passed. */
  | "success"
  /** Infra refund: never counts, never breaks a consecutive run. */
  | "refunded"
  /** Counted against the finding, but excluded from every breaker. */
  | "excluded"
  /** Still in flight. */
  | "pending";

export interface LoopFixAttemptSignal {
  id: string;
  findingId: string;
  createdAt: Date;
  result: LoopFixAttemptResult;
  outcome: string | null;
}

export interface AttemptRowLike {
  id: string;
  findingId: string;
  createdAt: Date;
  phase: string;
  infraRefunded: boolean;
  outcome: string | null;
  terminalCause: string | null;
  prNumber: number | null;
  guardStatus: string | null;
  checkStatus: string | null;
}

/** counted = closed and not refunded (ci_failed, guard_rejected, sha_mismatch, run_failed, …). */
export function attemptSignalOf(row: AttemptRowLike): LoopFixAttemptSignal {
  const base = {
    id: row.id,
    findingId: row.findingId,
    createdAt: row.createdAt,
    outcome: row.outcome,
  };
  // 09-14: a person merged the fix PR; the lifecycle closes the attempt.
  if (row.outcome === "merged") return { ...base, result: "success" };
  if (row.phase === "closed") {
    if (row.infraRefunded) return { ...base, result: "refunded" };
    if (
      row.terminalCause !== null &&
      BREAKER_EXCLUDED_REASONS.has(row.terminalCause)
    ) {
      return { ...base, result: "excluded" };
    }
    return { ...base, result: "failure" };
  }
  const draftOpened =
    row.prNumber !== null &&
    row.guardStatus === "passed" &&
    row.checkStatus === "passed";
  if (draftOpened || row.phase === "ready") {
    return { ...base, result: "success" };
  }
  return { ...base, result: "pending" };
}

export interface LoopBreakerEvent {
  outcome: "success" | "failure" | "timeout" | "ignored" | "trip";
  signal: string | null;
  createdAt: Date;
}

export type BreakerDecision<R extends string> =
  | { trip: false }
  | {
      trip: true;
      reason: R;
      evidence: Record<string, unknown>;
      cooldownMs?: "paused_manual";
    };

const NO_TRIP = { trip: false } as const;

// ---------------------------------------------------------------------------
// loop_fix
// ---------------------------------------------------------------------------

export type LoopFixTripReason =
  | "draft_unsupported"
  | "guard_rejections"
  | "ci_failures"
  | "consecutive_failures"
  | "gate_refunds"
  | "failure_rate"
  | "regressions"
  | "pr_expired"
  | "gh_errors";

const REGRESSION_SIGNALS = new Set(["reopened", "regressed"]);
const PR_LIFECYCLE_SIGNALS = new Set(["pr_expired", "pr_merged", "pr_closed"]);
const GH_ERROR_SIGNALS = new Set(["gh_403", "gh_422"]);

function within(createdAt: Date, now: Date, windowMs: number): boolean {
  return createdAt.getTime() >= now.getTime() - windowMs;
}

function ids(attempts: LoopFixAttemptSignal[]): string[] {
  return attempts.slice(0, 3).map((a) => a.id);
}

/**
 * Pure. `attempts` and `events` newest first, already limited to the window
 * after the last trip. First matching rule wins.
 */
export function evaluateLoopFix({
  attempts,
  events,
  now,
}: {
  attempts: LoopFixAttemptSignal[];
  events: LoopBreakerEvent[];
  now: Date;
}): BreakerDecision<LoopFixTripReason> {
  const unsupported = events.find((e) => e.signal === "draft_unsupported");
  if (unsupported) {
    return {
      trip: true,
      reason: "draft_unsupported",
      evidence: { signal: "draft_unsupported" },
      cooldownMs: "paused_manual",
    };
  }

  const decided = attempts.filter(
    (a) => a.result === "failure" || a.result === "success",
  );

  const lastTen = decided.slice(0, 10);
  const rejected = lastTen.filter(
    (a) => a.result === "failure" && a.outcome === "guard_rejected",
  );
  if (rejected.length >= 2) {
    return {
      trip: true,
      reason: "guard_rejections",
      evidence: {
        guardRejections: rejected.length,
        window: lastTen.length,
        attemptIds: ids(rejected),
      },
    };
  }

  const lastThree = decided.slice(0, 3);
  const threeFailures =
    lastThree.length === 3 && lastThree.every((a) => a.result === "failure");
  if (
    threeFailures &&
    lastThree.every((a) => a.outcome === "ci_failed") &&
    new Set(lastThree.map((a) => a.findingId)).size === 3
  ) {
    return {
      trip: true,
      reason: "ci_failures",
      evidence: { ciFailures: 3, attemptIds: ids(lastThree) },
    };
  }
  if (threeFailures) {
    return {
      trip: true,
      reason: "consecutive_failures",
      evidence: { consecutive: 3, attemptIds: ids(lastThree) },
    };
  }

  // R2: refunded gate outcomes are events; a decided attempt breaks the run.
  const gateTimeline = [
    ...events
      .filter((e) => e.signal !== null && GATE_REFUND_SIGNALS.has(e.signal))
      .map((e) => ({ refund: true, signal: e.signal, at: e.createdAt })),
    ...decided.map((a) => ({ refund: false, signal: null, at: a.createdAt })),
  ]
    .sort((x, y) => y.at.getTime() - x.at.getTime())
    .slice(0, 3);
  if (gateTimeline.length === 3 && gateTimeline.every((g) => g.refund)) {
    return {
      trip: true,
      reason: "gate_refunds",
      evidence: {
        consecutiveRefunds: 3,
        signals: gateTimeline.map((g) => g.signal),
      },
    };
  }

  const recent = decided
    .filter((a) => within(a.createdAt, now, RATE_WINDOW_MS))
    .slice(0, 6);
  const recentFailures = recent.filter((a) => a.result === "failure");
  if (recent.length >= 4 && recentFailures.length / recent.length >= 0.5) {
    return {
      trip: true,
      reason: "failure_rate",
      evidence: {
        failures: recentFailures.length,
        attempts: recent.length,
        attemptIds: ids(recentFailures),
      },
    };
  }

  const regressions = events.filter(
    (e) =>
      e.signal !== null &&
      REGRESSION_SIGNALS.has(e.signal) &&
      within(e.createdAt, now, LOOP_LOOKBACK_MS),
  );
  if (regressions.length >= 2) {
    return {
      trip: true,
      reason: "regressions",
      evidence: { regressions: regressions.length },
    };
  }

  const lifecycle = events
    .filter((e) => e.signal !== null && PR_LIFECYCLE_SIGNALS.has(e.signal))
    .slice(0, 2);
  if (
    lifecycle.length === 2 &&
    lifecycle.every((e) => e.signal === "pr_expired")
  ) {
    return {
      trip: true,
      reason: "pr_expired",
      evidence: { consecutiveExpired: 2 },
    };
  }

  const ghErrors = events.filter(
    (e) =>
      e.signal !== null &&
      GH_ERROR_SIGNALS.has(e.signal) &&
      within(e.createdAt, now, GH_ERROR_WINDOW_MS),
  );
  if (ghErrors.length >= 3) {
    return {
      trip: true,
      reason: "gh_errors",
      evidence: { ghErrors: ghErrors.length },
    };
  }

  return NO_TRIP;
}

// ---------------------------------------------------------------------------
// loop_audit
// ---------------------------------------------------------------------------

export type LoopAuditTripReason = "consecutive_bad_audits" | "churn";
export type AuditRunResult = "good" | "bad" | "skip";

export interface LoopAuditRunSignal {
  id: string;
  createdAt: Date;
  result: AuditRunResult;
}

export interface LoopAuditFindingSignal {
  /** When the issue was filed (the finding row was created). */
  createdAt: Date;
  /** When the finding was closed as absent, or null when it was not. */
  closedAsAbsentAt: Date | null;
}

/**
 * unparseable or incomplete (missing sections, schema drops, over cap) → bad;
 * complete → good; unfinished or an infra end (error, preflight) → skip.
 */
export function auditRunSignalOf(run: {
  status: string;
  outcome: string | null;
  complete: boolean | null;
}): AuditRunResult {
  if (run.status !== "done" && run.status !== "failed") return "skip";
  if (run.outcome === "unparseable") return "bad";
  if (run.complete === false) return "bad";
  if (run.complete === true) return "good";
  return "skip";
}

const CHURN_MIN_ISSUES = 2;
const CHURN_MAX_AUDITS = 2;

/** Pure. `runs` newest first. */
export function evaluateLoopAudit({
  runs,
  findings,
  now,
}: {
  runs: LoopAuditRunSignal[];
  findings: LoopAuditFindingSignal[];
  now: Date;
}): BreakerDecision<LoopAuditTripReason> {
  const decided = runs.filter((r) => r.result !== "skip");
  const lastThree = decided.slice(0, 3);
  if (lastThree.length === 3 && lastThree.every((r) => r.result === "bad")) {
    return {
      trip: true,
      reason: "consecutive_bad_audits",
      evidence: { consecutive: 3, runIds: lastThree.map((r) => r.id) },
    };
  }

  const filed = findings.filter((f) =>
    within(f.createdAt, now, RATE_WINDOW_MS),
  );
  if (filed.length < CHURN_MIN_ISSUES) return NO_TRIP;
  const churned = filed.filter((f) => {
    const closedAt = f.closedAsAbsentAt;
    if (closedAt === null) return false;
    const between = decided.filter(
      (r) => r.createdAt > f.createdAt && r.createdAt <= closedAt,
    ).length;
    return between <= CHURN_MAX_AUDITS;
  });
  if (churned.length / filed.length >= 0.5) {
    return {
      trip: true,
      reason: "churn",
      evidence: { churned: churned.length, filed: filed.length },
    };
  }
  return NO_TRIP;
}

// ---------------------------------------------------------------------------
// hatchet_dispatch / exec_plane
// ---------------------------------------------------------------------------

export interface PlaneEvent {
  outcome: "success" | "failure" | "timeout";
  signal: string;
  createdAt: Date;
}

export type PlaneTripReason =
  | "consecutive_failures"
  | "error_rate"
  | "consecutive_infra"
  | "infra_rate";

function failed(e: PlaneEvent): boolean {
  return e.outcome === "failure" || e.outcome === "timeout";
}

function planeDecision(
  events: PlaneEvent[],
  consecutiveReason: PlaneTripReason,
  rateReason: PlaneTripReason,
  rateWindow: PlaneEvent[],
  minVolume: number,
): BreakerDecision<PlaneTripReason> {
  const lastThree = events.slice(0, 3);
  if (lastThree.length === 3 && lastThree.every(failed)) {
    return {
      trip: true,
      reason: consecutiveReason,
      evidence: {
        consecutive: 3,
        signals: lastThree.map((e) => e.signal),
      },
    };
  }
  const failures = rateWindow.filter(failed).length;
  if (rateWindow.length >= minVolume && failures / rateWindow.length >= 0.5) {
    return {
      trip: true,
      reason: rateReason,
      evidence: { failures, events: rateWindow.length },
    };
  }
  return NO_TRIP;
}

/**
 * Pure, newest first. hatchet_dispatch: 3 consecutive failures or ≥ 50% of
 * the last 10 dispatches in 10 min (min 5).
 */
export function evaluateHatchetDispatchBreaker(
  events: PlaneEvent[],
  now: Date,
): BreakerDecision<PlaneTripReason> {
  const window = events
    .filter((e) => within(e.createdAt, now, HATCHET_RATE_WINDOW_MS))
    .slice(0, 10);
  return planeDecision(events, "consecutive_failures", "error_rate", window, 5);
}

/**
 * Pure, newest first. exec_plane: 3 consecutive infra terminal causes or
 * ≥ 50% of the last 6 (min 3). Excluded reasons never contribute.
 */
export function evaluateExecPlaneBreaker(
  events: PlaneEvent[],
): BreakerDecision<PlaneTripReason> {
  const counted = events.filter((e) => !BREAKER_EXCLUDED_REASONS.has(e.signal));
  return planeDecision(
    counted,
    "consecutive_infra",
    "infra_rate",
    counted.slice(0, 6),
    3,
  );
}

/** The first decided event at or after `since` (oldest first) decides a half-open plane breaker. */
export function planeProbeVerdict(
  events: PlaneEvent[],
  since: Date,
): "close" | "reopen" | null {
  const after = events
    .filter(
      (e) => e.createdAt >= since && !BREAKER_EXCLUDED_REASONS.has(e.signal),
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const first = after[0];
  if (!first) return null;
  return first.outcome === "success" ? "close" : "reopen";
}

// ---------------------------------------------------------------------------
// The tick runner
// ---------------------------------------------------------------------------

export interface LoopBreakerDeps {
  log: BreakerLogger;
  error: (message: string, fields: Record<string, unknown>) => void;
  capture: BreakerCapture;
}

export interface LoopBreakerResult {
  repos: number;
  orgs: number;
  transitions: number;
}

export function defaultLoopBreakerDeps(): LoopBreakerDeps {
  return {
    log: (message, fields) => console.log(message, fields),
    error: (message, fields) => console.error(message, fields),
    capture: (event, properties) =>
      getPostHogServer().capture({
        distinctId: "self-heal-breaker",
        event,
        properties,
      }),
  };
}

interface RepoScope {
  organizationId: string;
  repoKey: string;
}

function laterOf(a: Date, b: Date | null): Date {
  return b !== null && b > a ? b : a;
}

/**
 * A breaker the tick must move: half_open (a probe to resolve) or open past
 * its cooldown. Open breakers still cooling down and paused_manual ones need
 * nothing and must not take the LIMIT's slots.
 */
function movingBreaker(now: Date) {
  return or(
    eq(selfHealBreaker.state, "half_open"),
    and(eq(selfHealBreaker.state, "open"), lte(selfHealBreaker.openUntil, now)),
  );
}

/** Cross-org by design: the repos with self-heal activity in 30 days, moving breakers first. */
async function listLoopScopes(
  db: DB,
  now: Date,
  limit: number,
): Promise<RepoScope[]> {
  const since = new Date(now.getTime() - LOOP_LOOKBACK_MS);
  const [moving, attempts, runs, events] = await Promise.all([
    db
      .select({
        organizationId: selfHealBreaker.organizationId,
        repoKey: selfHealBreaker.scopeKey,
      })
      .from(selfHealBreaker)
      .where(
        and(
          inArray(selfHealBreaker.scopeKind, ["loop_fix", "loop_audit"]),
          movingBreaker(now),
        ),
      )
      .orderBy(asc(selfHealBreaker.updatedAt))
      .limit(limit),
    db
      .select({
        organizationId: auditFixAttempts.organizationId,
        repoKey: auditFixAttempts.repoFullName,
        last: max(auditFixAttempts.createdAt),
      })
      .from(auditFixAttempts)
      .where(gte(auditFixAttempts.createdAt, since))
      .groupBy(auditFixAttempts.organizationId, auditFixAttempts.repoFullName)
      .orderBy(desc(max(auditFixAttempts.createdAt)))
      .limit(limit),
    db
      .select({
        organizationId: auditRuns.organizationId,
        repoKey: auditRuns.repoFullName,
        last: max(auditRuns.createdAt),
      })
      .from(auditRuns)
      .where(gte(auditRuns.createdAt, since))
      .groupBy(auditRuns.organizationId, auditRuns.repoFullName)
      .orderBy(desc(max(auditRuns.createdAt)))
      .limit(limit),
    db
      .select({
        organizationId: selfHealBreakerEvent.organizationId,
        repoKey: selfHealBreakerEvent.scopeKey,
        last: max(selfHealBreakerEvent.createdAt),
      })
      .from(selfHealBreakerEvent)
      .where(
        and(
          inArray(selfHealBreakerEvent.scopeKind, ["loop_fix", "loop_audit"]),
          gte(selfHealBreakerEvent.createdAt, since),
        ),
      )
      .groupBy(
        selfHealBreakerEvent.organizationId,
        selfHealBreakerEvent.scopeKey,
      )
      .orderBy(desc(max(selfHealBreakerEvent.createdAt)))
      .limit(limit),
  ]);
  const recent = [...attempts, ...runs, ...events].sort(
    (a, b) => (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0),
  );
  const seen = new Set<string>();
  const out: RepoScope[] = [];
  for (const row of [...moving, ...recent]) {
    const repoKey = normalizeRepo(row.repoKey);
    const key = `${row.organizationId}\u0000${repoKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ organizationId: row.organizationId, repoKey });
    if (out.length >= limit) break;
  }
  return out;
}

/** Cross-org by design: orgs with plane signals in 30 days or a moving plane breaker. */
async function listPlaneOrgs(
  db: DB,
  now: Date,
  repos: RepoScope[],
  limit: number,
): Promise<string[]> {
  const since = new Date(now.getTime() - LOOP_LOOKBACK_MS);
  const [moving, events] = await Promise.all([
    db
      .select({ organizationId: selfHealBreaker.organizationId })
      .from(selfHealBreaker)
      .where(
        and(
          inArray(selfHealBreaker.scopeKind, [
            "hatchet_dispatch",
            "exec_plane",
          ]),
          movingBreaker(now),
        ),
      )
      .limit(limit),
    db
      .select({
        organizationId: selfHealBreakerEvent.organizationId,
        last: max(selfHealBreakerEvent.createdAt),
      })
      .from(selfHealBreakerEvent)
      .where(
        and(
          inArray(selfHealBreakerEvent.scopeKind, [
            "hatchet_dispatch",
            "exec_plane",
          ]),
          gte(selfHealBreakerEvent.createdAt, since),
        ),
      )
      .groupBy(selfHealBreakerEvent.organizationId)
      .orderBy(desc(max(selfHealBreakerEvent.createdAt)))
      .limit(limit),
  ]);
  const orgs = [
    ...moving.map((r) => r.organizationId),
    ...events.map((r) => r.organizationId),
    ...repos.map((r) => r.organizationId),
  ];
  return [...new Set(orgs)].slice(0, limit);
}

async function loopEvents(
  db: DB,
  organizationId: string,
  scopeKind: BreakerScopeKind,
  scopeKey: string,
  since: Date,
): Promise<LoopBreakerEvent[]> {
  return db
    .select({
      outcome: selfHealBreakerEvent.outcome,
      signal: selfHealBreakerEvent.signal,
      createdAt: selfHealBreakerEvent.createdAt,
    })
    .from(selfHealBreakerEvent)
    .where(
      and(
        eq(selfHealBreakerEvent.organizationId, organizationId),
        eq(selfHealBreakerEvent.scopeKind, scopeKind),
        eq(selfHealBreakerEvent.scopeKey, scopeKey),
        ne(selfHealBreakerEvent.outcome, "trip"),
        gt(selfHealBreakerEvent.createdAt, since),
      ),
    )
    .orderBy(
      desc(selfHealBreakerEvent.createdAt),
      desc(selfHealBreakerEvent.id),
    )
    .limit(EVENT_SCAN_LIMIT);
}

const ATTEMPT_COLUMNS = {
  id: auditFixAttempts.id,
  findingId: auditFixAttempts.findingId,
  createdAt: auditFixAttempts.createdAt,
  phase: auditFixAttempts.phase,
  infraRefunded: auditFixAttempts.infraRefunded,
  outcome: auditFixAttempts.outcome,
  terminalCause: auditFixAttempts.terminalCause,
  prNumber: auditFixAttempts.prNumber,
  guardStatus: auditFixAttempts.guardStatus,
  checkStatus: auditFixAttempts.checkStatus,
};

class Evaluation {
  transitions = 0;

  constructor(
    private readonly db: DB,
    private readonly now: Date,
    private readonly deps: LoopBreakerDeps,
  ) {}

  private count(
    transition: BreakerTransition | null,
  ): BreakerTransition | null {
    if (transition) this.transitions += 1;
    return transition;
  }

  private observers() {
    return { logger: this.deps.log, capture: this.deps.capture };
  }

  private trip(
    organizationId: string,
    scopeKind: BreakerScopeKind,
    scopeKey: string,
    reason: string,
    evidence: Record<string, unknown>,
    cooldownMs?: "paused_manual",
  ) {
    return tripBreaker({
      db: this.db,
      organizationId,
      scopeKind,
      scopeKey,
      reason,
      evidence,
      ...(cooldownMs ? { cooldownMs } : {}),
      now: this.now,
      ...this.observers(),
    });
  }

  private close(
    organizationId: string,
    scopeKind: BreakerScopeKind,
    scopeKey: string,
  ) {
    return closeBreakerAfterProbe({
      db: this.db,
      organizationId,
      scopeKind,
      scopeKey,
      now: this.now,
      ...this.observers(),
    });
  }

  /** open → half_open when due; returns the row as it now stands. */
  private async current(
    organizationId: string,
    scopeKind: BreakerScopeKind,
    scopeKey: string,
  ): Promise<BreakerRow> {
    const row = await getBreakerState({
      db: this.db,
      organizationId,
      scopeKind,
      scopeKey,
    });
    if (row.state !== "open") return row;
    const moved = this.count(
      await moveExpiredToHalfOpen({
        db: this.db,
        organizationId,
        scopeKind,
        scopeKey,
        now: this.now,
        ...this.observers(),
      }),
    );
    return moved
      ? getBreakerState({ db: this.db, organizationId, scopeKind, scopeKey })
      : row;
  }

  async loopFix({ organizationId, repoKey }: RepoScope): Promise<void> {
    const row = await this.current(organizationId, "loop_fix", repoKey);
    if (row.state === "half_open") {
      await this.resolveFixProbe(row);
      return;
    }
    if (row.state !== "closed") return;

    const since = laterOf(
      new Date(this.now.getTime() - LOOP_LOOKBACK_MS),
      row.openedAt,
    );
    const [attemptRows, events] = await Promise.all([
      this.db
        .select(ATTEMPT_COLUMNS)
        .from(auditFixAttempts)
        .where(
          and(
            eq(auditFixAttempts.organizationId, organizationId),
            eq(auditFixAttempts.repoFullName, repoKey),
            gt(auditFixAttempts.createdAt, since),
          ),
        )
        .orderBy(desc(auditFixAttempts.createdAt))
        .limit(ATTEMPT_SCAN_LIMIT),
      loopEvents(this.db, organizationId, "loop_fix", repoKey, since),
    ]);
    const decision = evaluateLoopFix({
      attempts: attemptRows.map(attemptSignalOf),
      events,
      now: this.now,
    });
    if (!decision.trip) return;
    this.count(
      await this.trip(
        organizationId,
        "loop_fix",
        repoKey,
        decision.reason,
        decision.evidence,
        decision.cooldownMs,
      ),
    );
  }

  /**
   * RES-15: the probe attempt decides. Draft opened with check + guard passed
   * → closed; counted failure or a gate refund (R2) → re-opened with the next
   * cooldown; any other refund or excluded → the probe is given back; in
   * flight → wait.
   */
  private async resolveFixProbe(row: BreakerRow): Promise<void> {
    const attemptId = probeAttemptIdOf(row);
    if (attemptId === null || row.halfOpenProbesLeft > 0) return;
    const [attemptRow] = await this.db
      .select(ATTEMPT_COLUMNS)
      .from(auditFixAttempts)
      .where(
        and(
          eq(auditFixAttempts.id, attemptId),
          eq(auditFixAttempts.organizationId, row.organizationId),
        ),
      )
      .limit(1);
    const signal = attemptRow ? attemptSignalOf(attemptRow).result : "refunded";
    // R2: a probe refunded by the GATE is the loop failing again, not infra.
    const result =
      signal === "refunded" &&
      attemptRow !== undefined &&
      isGateRefundCause(attemptRow.terminalCause)
        ? "failure"
        : signal;
    this.deps.log("[self-heal:breaker] probe", {
      org: row.organizationId,
      scopeKind: "loop_fix",
      scopeKey: row.scopeKey,
      probeId: attemptId,
      outcome: result,
    });
    if (result === "success") {
      this.count(
        await this.close(row.organizationId, "loop_fix", row.scopeKey),
      );
    } else if (result === "failure") {
      this.count(
        await this.trip(
          row.organizationId,
          "loop_fix",
          row.scopeKey,
          "probe_failed",
          {
            attemptIds: [attemptId],
          },
        ),
      );
    } else if (result === "refunded" || result === "excluded") {
      await releaseHalfOpenProbe({
        db: this.db,
        organizationId: row.organizationId,
        scopeKind: "loop_fix",
        scopeKey: row.scopeKey,
        now: this.now,
      });
    }
  }

  async loopAudit({ organizationId, repoKey }: RepoScope): Promise<void> {
    const row = await this.current(organizationId, "loop_audit", repoKey);
    if (row.state !== "closed" && row.state !== "half_open") return;

    const since =
      row.state === "half_open" && row.openUntil !== null
        ? row.openUntil
        : laterOf(
            new Date(this.now.getTime() - LOOP_LOOKBACK_MS),
            row.openedAt,
          );
    const readRuns = () =>
      this.db
        .select({
          id: auditRuns.id,
          createdAt: auditRuns.createdAt,
          status: auditRuns.status,
          outcome: auditRuns.outcome,
          complete: auditRuns.complete,
        })
        .from(auditRuns)
        .where(
          and(
            eq(auditRuns.organizationId, organizationId),
            eq(auditRuns.repoFullName, repoKey),
            gt(auditRuns.createdAt, since),
          ),
        )
        .orderBy(desc(auditRuns.createdAt))
        .limit(RUN_SCAN_LIMIT);
    const filedSince = laterOf(
      new Date(this.now.getTime() - RATE_WINDOW_MS),
      row.openedAt,
    );
    const readFindings = () =>
      this.db
        .select({
          createdAt: auditFindings.createdAt,
          updatedAt: auditFindings.updatedAt,
          status: auditFindings.status,
          attempts: auditFindings.attempts,
          prNumber: auditFindings.prNumber,
          lastDecisionReason: auditFindings.lastDecisionReason,
        })
        .from(auditFindings)
        .where(
          and(
            eq(auditFindings.organizationId, organizationId),
            eq(auditFindings.repoFullName, repoKey),
            isNotNull(auditFindings.issueNumber),
            gt(auditFindings.createdAt, filedSince),
          ),
        )
        .limit(RUN_SCAN_LIMIT);
    // A closed breaker needs both reads (independent); a half-open one only the runs.
    const [runRows, findingRows] =
      row.state === "half_open"
        ? [await readRuns(), null]
        : await Promise.all([readRuns(), readFindings()]);
    const runs: LoopAuditRunSignal[] = runRows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      result: auditRunSignalOf(r),
    }));

    if (row.state === "half_open") {
      // The dry-run audit after the cooldown decides (the writer stays dry-run meanwhile).
      const first = [...runs].reverse().find((r) => r.result !== "skip");
      if (!first) return;
      this.count(
        first.result === "good"
          ? await this.close(organizationId, "loop_audit", repoKey)
          : await this.trip(
              organizationId,
              "loop_audit",
              repoKey,
              "probe_failed",
              {
                runIds: [first.id],
              },
            ),
      );
      return;
    }

    const findings: LoopAuditFindingSignal[] = (findingRows ?? []).map((f) => {
      const absentClose =
        (f.status === "resolved" && f.attempts === 0 && f.prNumber === null) ||
        (f.status === "needs_human" &&
          f.lastDecisionReason === "rubric_absent");
      return {
        createdAt: f.createdAt,
        closedAsAbsentAt: absentClose ? f.updatedAt : null,
      };
    });
    const decision = evaluateLoopAudit({ runs, findings, now: this.now });
    if (!decision.trip) return;
    this.count(
      await this.trip(
        organizationId,
        "loop_audit",
        repoKey,
        decision.reason,
        decision.evidence,
      ),
    );
  }

  private async planeEvents(
    organizationId: string,
    scopeKind: "hatchet_dispatch" | "exec_plane",
    since: Date,
  ): Promise<PlaneEvent[]> {
    const rows = await this.db
      .select({
        outcome: selfHealBreakerEvent.outcome,
        signal: selfHealBreakerEvent.signal,
        createdAt: selfHealBreakerEvent.createdAt,
      })
      .from(selfHealBreakerEvent)
      .where(
        and(
          eq(selfHealBreakerEvent.organizationId, organizationId),
          eq(selfHealBreakerEvent.scopeKind, scopeKind),
          eq(selfHealBreakerEvent.scopeKey, "*"),
          inArray(selfHealBreakerEvent.outcome, [
            "success",
            "failure",
            "timeout",
          ]),
          gt(selfHealBreakerEvent.createdAt, since),
        ),
      )
      .orderBy(
        desc(selfHealBreakerEvent.createdAt),
        desc(selfHealBreakerEvent.id),
      )
      .limit(PLANE_SCAN_LIMIT);
    const events: PlaneEvent[] = rows.flatMap((r) =>
      r.outcome === "success" ||
      r.outcome === "failure" ||
      r.outcome === "timeout"
        ? [
            {
              outcome: r.outcome,
              signal: r.signal ?? "",
              createdAt: r.createdAt,
            },
          ]
        : [],
    );
    if (scopeKind !== "exec_plane") return events;
    // The reconcile records only exec_plane failures: a run that reached its
    // finding check is the plane's success.
    const reported = await this.db
      .select({ at: auditFixAttempts.checkReportedAt })
      .from(auditFixAttempts)
      .where(
        and(
          eq(auditFixAttempts.organizationId, organizationId),
          gt(auditFixAttempts.checkReportedAt, since),
        ),
      )
      .orderBy(desc(auditFixAttempts.checkReportedAt))
      .limit(PLANE_SCAN_LIMIT);
    const successes: PlaneEvent[] = reported.flatMap((r) =>
      r.at
        ? [
            {
              outcome: "success" as const,
              signal: "check_reported",
              createdAt: r.at,
            },
          ]
        : [],
    );
    return [...events, ...successes]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, PLANE_SCAN_LIMIT);
  }

  async plane(organizationId: string): Promise<void> {
    for (const scopeKind of ["hatchet_dispatch", "exec_plane"] as const) {
      const row = await this.current(organizationId, scopeKind, "*");
      if (row.state === "half_open") {
        if (row.openUntil === null) continue;
        const verdict = planeProbeVerdict(
          await this.planeEvents(organizationId, scopeKind, row.openUntil),
          row.openUntil,
        );
        if (verdict === "close") {
          this.count(await this.close(organizationId, scopeKind, "*"));
        } else if (verdict === "reopen") {
          this.count(
            await this.trip(organizationId, scopeKind, "*", "probe_failed", {}),
          );
        }
        continue;
      }
      if (row.state !== "closed") continue;
      const lookback =
        scopeKind === "hatchet_dispatch"
          ? HATCHET_LOOKBACK_MS
          : LOOP_LOOKBACK_MS;
      const since = laterOf(
        new Date(this.now.getTime() - lookback),
        row.openedAt,
      );
      const events = await this.planeEvents(organizationId, scopeKind, since);
      const decision =
        scopeKind === "hatchet_dispatch"
          ? evaluateHatchetDispatchBreaker(events, this.now)
          : evaluateExecPlaneBreaker(events);
      if (!decision.trip) continue;
      this.count(
        await this.trip(
          organizationId,
          scopeKind,
          "*",
          decision.reason,
          decision.evidence,
        ),
      );
    }
  }
}

/**
 * The tick evaluation (after the stuck-draft sweep, before the dispatcher):
 * up to 20 repos with self-heal activity in the last 30 days (moving breakers
 * first) and their orgs' plane breakers. Moves expired opens to half_open,
 * resolves half-open probes and trips through the shared CAS helpers. One
 * repo or org failing never stops the others; never throws.
 */
export async function runLoopBreakerEvaluation({
  db,
  now,
  deadlineAt,
  limit = LOOP_BREAKER_LIMIT,
  deps = defaultLoopBreakerDeps(),
}: {
  db: DB;
  now: Date;
  deadlineAt: Date;
  limit?: number;
  deps?: LoopBreakerDeps;
}): Promise<LoopBreakerResult> {
  const result: LoopBreakerResult = { repos: 0, orgs: 0, transitions: 0 };
  const evaluation = new Evaluation(db, now, deps);
  const pastDeadline = () =>
    deadlineAt.getTime() - Date.now() < MIN_ITEM_BUDGET_MS;
  try {
    const repos = await listLoopScopes(db, now, limit);
    for (const scope of repos) {
      if (pastDeadline()) break;
      try {
        // Disjoint breaker rows (loop_fix vs loop_audit) and read sets.
        await Promise.all([
          evaluation.loopFix(scope),
          evaluation.loopAudit(scope),
        ]);
      } catch (error) {
        deps.error("[self-heal:breaker] repo evaluation failed", {
          org: scope.organizationId,
          repo: scope.repoKey,
          error: errorText(error),
        });
      }
      result.repos += 1;
    }
    const orgs = await listPlaneOrgs(db, now, repos, limit);
    for (const organizationId of orgs) {
      if (pastDeadline()) break;
      try {
        await evaluation.plane(organizationId);
      } catch (error) {
        deps.error("[self-heal:breaker] plane evaluation failed", {
          org: organizationId,
          error: errorText(error),
        });
      }
      result.orgs += 1;
    }
  } catch (error) {
    deps.error("[self-heal:breaker] evaluation failed", {
      error: errorText(error),
    });
  }
  result.transitions = evaluation.transitions;
  return result;
}
