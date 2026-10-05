/**
 * Self-heal production metrics (R5, R6, CONTEXT benchmark item 6).
 *
 * ONE pure function over the exported ledger, so the admin view and the R6
 * benchmark scorer read the same numbers. It takes rows as the route reads
 * them (Date timestamps) or as the export serialises them (ISO strings), and
 * makes no I/O.
 *
 * Definitions (the runbook and the scorer quote this text):
 *
 * - prsOpened: attempts that opened a PR (pr_number is set).
 * - ready: attempts whose PR was marked ready for review (ready_at is set).
 * - merged: attempts whose PR was merged (pr_state merged or merged_at set).
 * - mergedByNonTrigger: merged PRs whose merged_by login is known and is not
 *   one of the trigger logins (the platform bot, and the GitHub login of the
 *   owner of the repo's audit-fix automation). Logins compare without case.
 *   A merge with an unknown merger is not counted.
 * - decided PRs: opened PRs whose pr_state is merged, closed or expired. A PR
 *   that is still a draft or ready has no outcome yet and is left out.
 * - mergeRate: mergedByNonTrigger / decided PRs.
 * - mergeRateBasis: "bot-and-owner" when the owner's login was known and
 *   excluded, "bot-only" when only the bot login was (the owner lookup failed
 *   or there is no audit-fix automation). Read a bot-only rate as an upper
 *   bound: the owner's own merges count as human merges there.
 * - humanEditRatio: among merged PRs whose human_commit_count is known, the
 *   share with at least one human commit after the gated head.
 * - reopenRate: among merged PRs whose 30-day regression window is complete
 *   (regression.windowComplete), the share whose finding was reopened.
 * - regressionRate30d: over the same set, the share that was reverted or got
 *   a non-bot follow-up commit touching the merged lines.
 * - meanAttemptsToClose: mean of the counted attempts (audit_findings.attempts,
 *   refunds excluded) over resolved findings with at least one attempt.
 * - expiredRate: decided PRs that expired unreviewed / decided PRs.
 * - refunded: attempts refunded for an infrastructure cause (infra_refunded).
 * - counted: finished attempts (phase closed) that were not refunded. Attempts
 *   still in flight are neither refunded nor counted.
 * - admissionDeferrals: self-heal runs for the repo that review-first
 *   admission deferred in the last 30 days (passed in by the caller).
 *
 * Every rate is null when its denominator is zero.
 */

/** A timestamp as read from the DB (Date) or from the JSON export (string). */
export type MetricsInstant = Date | string | null | undefined;

export interface MetricsAttempt {
  findingId: string;
  phase: string;
  prNumber: number | null;
  prState: string | null;
  readyAt?: MetricsInstant;
  mergedAt?: MetricsInstant;
  mergedBy: string | null;
  humanCommitCount: number | null;
  regression: unknown;
  infraRefunded: boolean;
}

export interface MetricsFinding {
  id: string;
  status: string;
  attempts: number;
}

export type MergeRateBasis = "bot-and-owner" | "bot-only";

export interface SelfHealMetrics {
  prsOpened: number;
  ready: number;
  merged: number;
  mergedByNonTrigger: number;
  mergeRate: number | null;
  humanEditRatio: number | null;
  reopenRate: number | null;
  regressionRate30d: number | null;
  meanAttemptsToClose: number | null;
  expiredRate: number | null;
  refunded: number;
  counted: number;
  admissionDeferrals: number;
  mergeRateBasis: MergeRateBasis;
}

const DECIDED_PR_STATES = new Set(["merged", "closed", "expired"]);

interface WindowSignals {
  reopened: boolean;
  regressed: boolean;
}

function present(value: MetricsInstant): boolean {
  return value !== null && value !== undefined && value !== "";
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function isMerged(attempt: MetricsAttempt): boolean {
  return attempt.prState === "merged" || present(attempt.mergedAt);
}

/** Signals of a COMPLETE 30-day window; null when absent, malformed or open. */
function completeWindowSignals(value: unknown): WindowSignals | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    record.windowComplete !== true ||
    typeof record.reverted !== "boolean" ||
    typeof record.reopened !== "boolean" ||
    !Array.isArray(record.followupShas)
  ) {
    return null;
  }
  return {
    reopened: record.reopened,
    regressed: record.reverted || record.followupShas.length > 0,
  };
}

export function computeSelfHealMetrics({
  attempts,
  findings,
  triggerLogins,
  admissionDeferrals,
}: {
  attempts: readonly MetricsAttempt[];
  findings: readonly MetricsFinding[];
  triggerLogins: readonly string[];
  admissionDeferrals: number;
}): SelfHealMetrics {
  const triggers = new Set(
    triggerLogins
      .map((login) => login.trim().toLowerCase())
      .filter((login) => login.length > 0),
  );

  const opened = attempts.filter((a) => a.prNumber !== null);
  const decided = opened.filter(
    (a) => a.prState !== null && DECIDED_PR_STATES.has(a.prState),
  );
  const merged = attempts.filter(isMerged);
  const mergedByNonTrigger = merged.filter(
    (a) =>
      a.mergedBy !== null &&
      a.mergedBy.trim() !== "" &&
      !triggers.has(a.mergedBy.trim().toLowerCase()),
  ).length;

  const knownEdits = merged.filter((a) => a.humanCommitCount !== null);
  const edited = knownEdits.filter((a) => (a.humanCommitCount ?? 0) > 0);

  const windows = merged
    .map((a) => completeWindowSignals(a.regression))
    .filter((w): w is WindowSignals => w !== null);

  const closedFindings = findings.filter(
    (f) => f.status === "resolved" && f.attempts > 0,
  );
  const attemptsToClose = closedFindings.reduce(
    (sum, f) => sum + f.attempts,
    0,
  );

  return {
    prsOpened: opened.length,
    ready: attempts.filter((a) => present(a.readyAt)).length,
    merged: merged.length,
    mergedByNonTrigger,
    mergeRate: ratio(mergedByNonTrigger, decided.length),
    humanEditRatio: ratio(edited.length, knownEdits.length),
    reopenRate: ratio(windows.filter((w) => w.reopened).length, windows.length),
    regressionRate30d: ratio(
      windows.filter((w) => w.regressed).length,
      windows.length,
    ),
    meanAttemptsToClose: ratio(attemptsToClose, closedFindings.length),
    expiredRate: ratio(
      decided.filter((a) => a.prState === "expired").length,
      decided.length,
    ),
    refunded: attempts.filter((a) => a.infraRefunded).length,
    counted: attempts.filter((a) => a.phase === "closed" && !a.infraRefunded)
      .length,
    admissionDeferrals,
    mergeRateBasis: triggers.size >= 2 ? "bot-and-owner" : "bot-only",
  };
}
