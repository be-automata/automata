/**
 * #373 (epic #193 ticket 5): growth-trigger evaluator — the PURE half.
 *
 * WHY. Each growth trigger is a measurable signal with a threshold and the ONE
 * infrastructure move it authorizes (raise the cap, add a box, split a client, start the
 * per-run sandbox path, revisit the supersede default). Before this ticket none of them
 * was instrumented: the box's only alarms were the #215 watchdog, which exits and pages
 * nobody, and journal lines nobody reads. This module turns fixture-able inputs (engine
 * run rows, /proc samples, the previous dedupe state) into verdicts, transitions and the
 * exact bytes that get POSTed and snapshotted.
 *
 * WHY PURE. Every input arrives as a value and the clock is a `nowMs` argument: no I/O,
 * no timers, no `process.env`. The driver (engine REST reader, /proc reads, webhook POST,
 * snapshot write) lives elsewhere and is injected there, so every threshold here is
 * unit-tested against fixture series instead of against a live box (AC 2).
 *
 * FAILS TO UNKNOWN. An unreadable input is a verdict of its own — `unknown` — and the
 * dedupe machine treats it as a no-op: nothing fires, nothing clears, state unchanged
 * (AC 3, V5). A blind evaluator must never announce that a condition went away.
 */

/** One UTC day, milliseconds. */
export const DAY_MS = 86_400_000;
/** The run-signal window: the last 7 COMPLETE UTC days; today's partial day is excluded (V6). */
const GROWTH_WINDOW_DAYS = 7;
/** Queue-wait daily p90 must exceed this on every one of the 7 days. */
const QUEUE_WAIT_P90_THRESHOLD_S = 600;
/** The p90 is nearest-rank at this percentile. */
const QUEUE_WAIT_PERCENTILE = 0.9;
/** One client's share of ATTRIBUTED run time must exceed this (Q-1). */
const CLIENT_SHARE_THRESHOLD = 0.4;
/**
 * ...and only when at least this many distinct orgs HOLD run time in the window (Q-1,
 * owner decision): on a two-org box one client is always ≥ 50% of the time, so the split
 * signal is only meaningful from three.
 */
const CLIENT_SHARE_MIN_ORGS = 3;
/**
 * Attribution gate: above this fraction of UNATTRIBUTED run time (rows without `orgId`)
 * the per-org figures describe too little of the box to act on, so `client_share` and the
 * scale composite's clients arm read `unknown` instead of over/under.
 */
const ATTRIBUTION_MAX_UNATTRIBUTED_FRACTION = 0.05;
/** Scale-composite arm: distinct clients must exceed this. */
const SCALE_CLIENTS_THRESHOLD = 5;
/** Scale-composite arm: the 7-day average of distinct PRs per UTC day must exceed this (Q-2). */
const SCALE_PRS_PER_DAY_THRESHOLD = 100;
/** Scale composite fires when at least this many of its three arms hold ("any two"). */
const SCALE_COMPOSITE_MIN_ARMS = 2;
/** CANCELLED run time over all run time must exceed this (#372 AC 9). */
const SUPERSEDE_WASTE_THRESHOLD = 0.2;
/** A trigger that stays over re-fires at most once per this window. */
export const GROWTH_REFIRE_MS = DAY_MS;

export type GrowthTriggerId =
  | "queue_wait_p90"
  | "ram_swap"
  | "client_share"
  | "scale_composite"
  | "supersede_waste";

/** Snapshot and evaluation order. */
export const GROWTH_TRIGGER_IDS: readonly GrowthTriggerId[] = [
  "queue_wait_p90",
  "ram_swap",
  "client_share",
  "scale_composite",
  "supersede_waste",
];

/**
 * From the #373 signal table: the one move each trigger authorizes. client_share omits the
 * table's manual-fire clause, which no code path implements.
 */
export const AUTHORIZED_MOVES: Readonly<Record<GrowthTriggerId, string>> = {
  queue_wait_p90: "Raise the cap, then resize CX43 (cap 6) / CX53 (cap 8)",
  ram_swap: "Add a second shared box on the same tenant",
  client_share: "Split that client to its own box (tickets 6/7)",
  scale_composite: "Start the per-run sandbox path",
  supersede_waste: "Revisit the default policy",
};

type GrowthVerdict = "over" | "under" | "unknown";

export interface TriggerEvaluation {
  trigger: GrowthTriggerId;
  verdict: GrowthVerdict;
  /**
   * The observed value; null when the input was unreadable. An `unknown` verdict from the
   * attribution gate still carries the value it observed, so the snapshot reports it.
   */
  value: number | null;
  threshold: number;
  /** Why the verdict is `unknown`; absent otherwise. */
  reason?: string;
  /** One-line human description of the observation, used for the webhook `text`. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Engine run rows
// ---------------------------------------------------------------------------

/** One run task from the engine's collection route, reduced to what the signals read. */
export interface RunRow {
  /**
   * The engine's run id (`metadata.id`, else `taskExternalId`): the key the reader dedupes
   * pages by, since offset paging over a live collection can return a row twice. Null when
   * the engine row carries neither.
   */
  id: string | null;
  status: string;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  orgId: string | null;
  repoFullName: string | null;
  prNumber: number | null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  // The engine's Go zero time (`0001-01-01T00:00:00Z`) parses to a large negative
  // number; it means "unset", not "the year 1".
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * `additionalMetadata.prNumber`. www writes it as a decimal string (`"42"`); a NUMERIC
 * value is accepted too when it is a positive safe integer, and is then the same PR as its
 * decimal string (both key `repo#42`), so a writer that forgets to stringify is not a
 * different PR. Anything else (a fraction, 0, a negative, NaN, a non-numeric string) is
 * null: the row carries no PR.
 */
function parsePrNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Raw engine row → RunRow, or null when it is not a run task or cannot be placed in time.
 *
 * Only `actionId`s ending `:run` are run tasks (`agent-run:run`, `agent-run-newest:run`,
 * …); `:on-failure-task` rows and anything else are ignored — counting them would double
 * the time of every failed run. A row without a parseable `createdAt` cannot be assigned
 * to a UTC day and is dropped. `additionalMetadata` values are strings as written by www
 * (`prNumber: "42"`); a missing or malformed field becomes null, never a throw — rows
 * dispatched before OD-0 have no `orgId` and are the `unattributed` bucket.
 */
export function parseRunRow(raw: unknown): RunRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const actionId = typeof r.actionId === "string" ? r.actionId : null;
  if (!actionId?.endsWith(":run")) return null;
  const createdAtMs = parseTimestampMs(r.createdAt);
  if (createdAtMs === null) return null;
  const metaRaw = r.additionalMetadata;
  const meta =
    typeof metaRaw === "object" && metaRaw !== null && !Array.isArray(metaRaw)
      ? (metaRaw as Record<string, unknown>)
      : {};
  const engineMetaRaw = r.metadata;
  const engineMeta =
    typeof engineMetaRaw === "object" &&
    engineMetaRaw !== null &&
    !Array.isArray(engineMetaRaw)
      ? (engineMetaRaw as Record<string, unknown>)
      : {};
  return {
    id: nonEmptyString(engineMeta.id) ?? nonEmptyString(r.taskExternalId),
    status: typeof r.status === "string" ? r.status : "",
    createdAtMs,
    startedAtMs: parseTimestampMs(r.startedAt),
    finishedAtMs: parseTimestampMs(r.finishedAt),
    orgId: nonEmptyString(meta.orgId),
    repoFullName: nonEmptyString(meta.repoFullName),
    prNumber: parsePrNumber(meta.prNumber),
  };
}

// ---------------------------------------------------------------------------
// The 7-complete-day window (V6)
// ---------------------------------------------------------------------------

interface GrowthWindow {
  /** Inclusive: 00:00 UTC seven days before today. Also the reader's `since`. */
  startMs: number;
  /** Exclusive: 00:00 UTC today — the partial day is never counted. */
  endMs: number;
  /** The seven day starts, oldest first. */
  dayStartsMs: number[];
}

/**
 * The window every run signal reads. Today's partial day is excluded so a quiet morning
 * cannot break the queue-wait streak and a busy one cannot inflate PRs/day.
 */
export function growthWindow(nowMs: number): GrowthWindow {
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const startMs = todayStart - GROWTH_WINDOW_DAYS * DAY_MS;
  const dayStartsMs = Array.from(
    { length: GROWTH_WINDOW_DAYS },
    (_, i) => startMs + i * DAY_MS,
  );
  return { startMs, endMs: todayStart, dayStartsMs };
}

/** Rows are bucketed by their `createdAt` UTC day, the same field the reader's `since` filters. */
function dayIndex(window: GrowthWindow, ms: number): number | null {
  if (ms < window.startMs || ms >= window.endMs) return null;
  return Math.floor((ms - window.startMs) / DAY_MS);
}

/** Run time = finishedAt − startedAt (V4: the engine has no `duration`); null when either is missing. */
function runTimeMs(row: RunRow): number | null {
  if (row.startedAtMs === null || row.finishedAtMs === null) return null;
  const d = row.finishedAtMs - row.startedAtMs;
  return d >= 0 ? d : null;
}

/**
 * Execution intervals [startedAt, finishedAt) of one key's runs (a PR, or an org), as two
 * sorted arrays so "how many were executing at t" is two binary searches instead of a
 * scan. A run that has not finished is executing until +∞; a run that never started, or
 * whose finishedAt precedes its startedAt, never executed.
 */
interface ExecutionIndex {
  starts: number[];
  ends: number[];
}

function executionInterval(row: RunRow): [number, number] | null {
  if (row.startedAtMs === null) return null;
  const end = row.finishedAtMs ?? Number.POSITIVE_INFINITY;
  return end >= row.startedAtMs ? [row.startedAtMs, end] : null;
}

function buildExecutionIndexes(
  rows: readonly RunRow[],
  keyOf: (row: RunRow) => string | null,
): Map<string, ExecutionIndex> {
  const out = new Map<string, ExecutionIndex>();
  for (const row of rows) {
    const key = keyOf(row);
    const interval = executionInterval(row);
    if (key === null || interval === null) continue;
    const index = out.get(key) ?? { starts: [], ends: [] };
    index.starts.push(interval[0]);
    index.ends.push(interval[1]);
    out.set(key, index);
  }
  for (const index of out.values()) {
    index.starts.sort((a, b) => a - b);
    index.ends.sort((a, b) => a - b);
  }
  return out;
}

/** Count of values ≤ t in an ascending array. */
function countAtOrBefore(sorted: readonly number[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? Number.POSITIVE_INFINITY) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Runs of `index` executing at `t` (startedAt ≤ t < finishedAt), OTHER than `self`: every
 * interval with end ≤ t also has start ≤ t, so the difference of the two counts is the
 * number of intervals that contain t.
 */
function executingAt(
  index: ExecutionIndex | undefined,
  t: number,
  self: RunRow,
): number {
  if (index === undefined) return 0;
  const count =
    countAtOrBefore(index.starts, t) - countAtOrBefore(index.ends, t);
  const own = executionInterval(self);
  const selfExecuting = own !== null && own[0] <= t && t < own[1];
  return count - (selfExecuting ? 1 : 0);
}

function prKey(row: RunRow): string | null {
  return row.repoFullName !== null && row.prNumber !== null
    ? `${row.repoFullName.toLowerCase()}#${row.prNumber}`
    : null;
}

/** Nearest-rank percentile: the value at rank ceil(p·n) of the sorted series. Null on empty. */
export function nearestRankPercentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Run signals: queue wait, client share, scale composite, supersede waste
// ---------------------------------------------------------------------------

export type RunsReading =
  | { kind: "rows"; rows: readonly RunRow[] }
  | { kind: "unreadable"; reason: string };

interface RunWindowStats {
  windowDays: number;
  /** Per-day nearest-rank p90 queue wait in seconds, oldest first; null for a day with no counted run (started, or ended without starting under any terminal status). */
  queueWaitDailyP90S: Array<number | null>;
  /**
   * Waits left out of the p90 because they were held by POLICY, not capacity: at the
   * run's createdAt another run of the same PR was executing, or its org was already at
   * `perOrgMaxRuns` executing runs.
   */
  policyHeldRuns: number;
  /** Distinct `orgId`s in the window. `u:<userId>` personal scopes count: each is its own tenant. */
  clients: number;
  /** Run time of rows without `orgId` — never counted as an org (OD-0). */
  unattributed: { seconds: number; fraction: number };
  /** The org with the largest share of attributed run time, when any. */
  topClient: { orgId: string; share: number } | null;
  /** distinct (repoFullName, prNumber) per day summed over the window ÷ 7 (Q-2). */
  prsPerDay: number;
  /** Reported, never fires (Q-2). Null when no row carries a PR. */
  busiestDay: { date: string; prs: number } | null;
}

interface RunSignalsInput {
  runs: RunsReading;
  nowMs: number;
  /**
   * The window the runs were READ for. The driver computes it once at tick start and
   * passes it here: a tick that crosses 00:00 UTC between the read and the evaluation
   * would otherwise evaluate a window shifted by a day, whose newest day the read never
   * fetched — an empty day that breaks the queue-wait streak and clears a firing trigger.
   * Defaults to growthWindow(nowMs).
   */
  window?: GrowthWindow;
  /** `WORKER_ENTERPRISE_QUESTIONNAIRE=1`: the composite's manual arm. */
  questionnaire: boolean;
  /**
   * The engine's per-org concurrency cap (`WORKER_PER_ORG_MAX_RUNS`). When set, a wait
   * that began while its org already had this many runs executing is policy-held and
   * left out of the p90. Absent (or not a positive integer): that exclusion is off; the
   * same-PR exclusion needs no input and always applies.
   */
  perOrgMaxRuns?: number;
}

export interface RunSignalsResult {
  queueWait: TriggerEvaluation;
  clientShare: TriggerEvaluation;
  scaleComposite: TriggerEvaluation;
  supersedeWaste: TriggerEvaluation;
  /** Null when the engine was unreadable this tick. */
  stats: RunWindowStats | null;
}

/**
 * An evaluation that was computed but cannot be trusted this tick (the attribution
 * gate): keeps the observed value for the snapshot, unlike unknownEvaluation, which is
 * for an input that could not be read at all.
 */
function asUnknown(
  evaluation: TriggerEvaluation,
  reason: string,
): TriggerEvaluation {
  return {
    ...evaluation,
    verdict: "unknown",
    reason,
    summary: `${evaluation.summary} — unknown: ${reason}`,
  };
}

function unknownEvaluation(
  trigger: GrowthTriggerId,
  threshold: number,
  reason: string,
): TriggerEvaluation {
  return {
    trigger,
    verdict: "unknown",
    value: null,
    threshold,
    reason,
    summary: `${trigger} unknown: ${reason}`,
  };
}

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

type RunTriggerKey = Exclude<keyof RunSignalsResult, "stats">;

/** The four engine-backed triggers: their id and threshold, readable or not. */
const RUN_THRESHOLDS = {
  queueWait: {
    trigger: "queue_wait_p90",
    threshold: QUEUE_WAIT_P90_THRESHOLD_S,
  },
  clientShare: { trigger: "client_share", threshold: CLIENT_SHARE_THRESHOLD },
  scaleComposite: {
    trigger: "scale_composite",
    threshold: SCALE_COMPOSITE_MIN_ARMS,
  },
  supersedeWaste: {
    trigger: "supersede_waste",
    threshold: SUPERSEDE_WASTE_THRESHOLD,
  },
} as const satisfies Record<
  RunTriggerKey,
  { trigger: GrowthTriggerId; threshold: number }
>;

/**
 * A readable run trigger's evaluation. The verdict compares the UNROUNDED `raw` (over
 * when `raw > threshold`, unless `over` says otherwise); only the reported value is
 * rounded, so a reading just past a threshold cannot be rounded back onto it. `summary`
 * receives that rounded value.
 */
function thresholdEvaluation(
  key: RunTriggerKey,
  raw: number,
  summary: (value: number) => string,
  over: boolean = raw > RUN_THRESHOLDS[key].threshold,
): TriggerEvaluation {
  const { trigger, threshold } = RUN_THRESHOLDS[key];
  const value = round(raw);
  return {
    trigger,
    verdict: over ? "over" : "under",
    value,
    threshold,
    summary: summary(value),
  };
}

/**
 * Evaluate the four engine-backed triggers over the last 7 complete UTC days.
 *
 * QUEUE WAIT. Each day's p90 of `startedAt − createdAt` over its STARTED run tasks, plus
 * `finishedAt − createdAt` for a run that ENDED without starting, under any terminal status
 * (newest-wins supersede, a scheduling timeout): those are the longest waits, and dropping them would hide a backlog
 * exactly when there is one. A row still QUEUED is excluded (V7). ENGINE QUEUE ONLY: a run
 * deferred by the #371 headroom check or parked on a #205 box slot is already RUNNING on
 * the engine, so that wait is invisible here and counts as run time — a quiet trigger is
 * not proof the box keeps up (follow-up: a worker-recorded admission time). POLICY-HELD
 * waits are left out (counted in `policyHeldRuns`): a run created while another run of
 * the same (repo, PR) was executing waits on the per-PR serialization, and one created
 * while its org already had `perOrgMaxRuns` runs executing waits on the per-org cap —
 * neither wait says the box lacks capacity, and a busy PR or tenant would otherwise fire
 * a resize the box does not need. The trigger
 * is "> 10 min for 7 consecutive days", so its value is the streak's WEAKEST day, with an
 * empty day counting as 0: a day with no run tasks breaks the streak by definition.
 *
 * CLIENT SHARE. Org run time ÷ ATTRIBUTED run time; unattributed time is reported, never
 * an org (OD-0). One org at 100% is not a split signal — it is a single-tenant box — so the
 * trigger cannot fire below CLIENT_SHARE_MIN_ORGS distinct orgs (Q-1). While more than
 * ATTRIBUTION_MAX_UNATTRIBUTED_FRACTION of run time is unattributed the verdict is
 * `unknown` (the share is still reported): the hidden time could belong to any org.
 *
 * SCALE COMPOSITE. Arms: clients > 5, PRs/day > 100 (7-day average, Q-2), questionnaire.
 * The clients arm is unknown under the same attribution gate. Value = arms held among the
 * KNOWN arms; over at ≥ SCALE_COMPOSITE_MIN_ARMS held; unknown when the unknown arms could
 * still reach it; under otherwise. No single arm justifies the per-run sandbox path.
 *
 * SUPERSEDE WASTE. CANCELLED run time ÷ all run time. Same engine-side blind spot as queue
 * wait: a run deferred by #371 or parked on a #205 box slot is RUNNING on the engine, so
 * if it is superseded while waiting its wait counts as waste although no agent compute ran
 * — on a busy box the ratio can read a capacity backlog as waste (follow-up #409).
 */
export function evaluateRunSignals(input: RunSignalsInput): RunSignalsResult {
  if (input.runs.kind === "unreadable") {
    const reason = input.runs.reason;
    const unknown = (key: RunTriggerKey): TriggerEvaluation =>
      unknownEvaluation(
        RUN_THRESHOLDS[key].trigger,
        RUN_THRESHOLDS[key].threshold,
        reason,
      );
    return {
      queueWait: unknown("queueWait"),
      clientShare: unknown("clientShare"),
      scaleComposite: unknown("scaleComposite"),
      supersedeWaste: unknown("supersedeWaste"),
      stats: null,
    };
  }

  const window = input.window ?? growthWindow(input.nowMs);
  const orgCap =
    input.perOrgMaxRuns !== undefined &&
    Number.isSafeInteger(input.perOrgMaxRuns) &&
    input.perOrgMaxRuns >= 1
      ? input.perOrgMaxRuns
      : null;
  // Built over EVERY row read, in the window or not: a run created before the window can
  // still be executing when a windowed run is created.
  const prExecutions = buildExecutionIndexes(input.runs.rows, prKey);
  const orgExecutions =
    orgCap === null
      ? null
      : buildExecutionIndexes(input.runs.rows, (r) => r.orgId);
  const isPolicyHeld = (row: RunRow): boolean => {
    const pr = prKey(row);
    if (
      pr !== null &&
      executingAt(prExecutions.get(pr), row.createdAtMs, row) > 0
    ) {
      return true;
    }
    return (
      orgCap !== null &&
      orgExecutions !== null &&
      row.orgId !== null &&
      executingAt(orgExecutions.get(row.orgId), row.createdAtMs, row) >= orgCap
    );
  };
  let policyHeldRuns = 0;
  const waitsByDay: number[][] = window.dayStartsMs.map(() => []);
  const prsByDay: Array<Set<string>> = window.dayStartsMs.map(() => new Set());
  const orgs = new Set<string>();
  const orgTimeMs = new Map<string, number>();
  let attributedMs = 0;
  let unattributedMs = 0;
  let cancelledMs = 0;

  for (const row of input.runs.rows) {
    const day = dayIndex(window, row.createdAtMs);
    if (day === null) continue;
    // Clamped at 0: a sub-second clock skew between engine writers is "started at once".
    // Ended without ever starting (supersede, or a scheduling timeout — whatever terminal
    // status the engine gives it): its whole life was queue wait.
    const waitEndMs = row.startedAtMs ?? row.finishedAtMs;
    if (waitEndMs !== null) {
      if (isPolicyHeld(row)) {
        policyHeldRuns += 1;
      } else {
        waitsByDay[day]?.push(Math.max(0, waitEndMs - row.createdAtMs));
      }
    }
    const pr = prKey(row);
    if (pr !== null) prsByDay[day]?.add(pr);
    if (row.orgId !== null) orgs.add(row.orgId);
    const t = runTimeMs(row);
    if (t === null) continue;
    if (row.orgId === null) {
      unattributedMs += t;
    } else {
      attributedMs += t;
      // Only positive time makes an org a holder of box time (a run that started and
      // ended in the same instant shares none), so the Q-1 minimum-orgs guard counts holders.
      if (t > 0) {
        orgTimeMs.set(row.orgId, (orgTimeMs.get(row.orgId) ?? 0) + t);
      }
    }
    if (row.status === "CANCELLED") cancelledMs += t;
  }

  // Queue wait.
  const dailyP90Ms = waitsByDay.map((w) =>
    nearestRankPercentile(w, QUEUE_WAIT_PERCENTILE),
  );
  const queueWaitDailyP90S = dailyP90Ms.map((v) =>
    v === null ? null : round(v / 1000),
  );
  const weakestDayRawS = Math.min(...dailyP90Ms.map((v) => (v ?? 0) / 1000));
  const emptyDays = queueWaitDailyP90S.filter((v) => v === null).length;
  const queueWait = thresholdEvaluation(
    "queueWait",
    weakestDayRawS,
    (weakestDayS) =>
      `queue-wait p90: weakest of the last ${GROWTH_WINDOW_DAYS} UTC days ${weakestDayS}s ` +
      `(threshold > ${QUEUE_WAIT_P90_THRESHOLD_S}s every day` +
      (emptyDays > 0 ? `; ${emptyDays} day(s) with no counted run` : "") +
      (policyHeldRuns > 0
        ? `; ${policyHeldRuns} policy-held wait(s) excluded (same PR executing, or org at its per-org cap)`
        : "") +
      "; engine queue only, in-worker admission and box-slot waits not counted)",
  );

  // Client share. An exact tie on run time goes to the lexicographically lower orgId, so
  // the top org — which keys client_share's per-org hold — does not depend on row order.
  let topOrg: { orgId: string; ms: number } | null = null;
  for (const [orgId, ms] of orgTimeMs) {
    if (
      topOrg === null ||
      ms > topOrg.ms ||
      (ms === topOrg.ms && orgId < topOrg.orgId)
    ) {
      topOrg = { orgId, ms };
    }
  }
  const maxShareRaw =
    topOrg !== null && attributedMs > 0 ? topOrg.ms / attributedMs : 0;
  const topClient: RunWindowStats["topClient"] =
    topOrg === null || attributedMs <= 0
      ? null
      : { orgId: topOrg.orgId, share: round(maxShareRaw) };
  const totalMs = attributedMs + unattributedMs;
  const unattributedFractionRaw = totalMs > 0 ? unattributedMs / totalMs : 0;
  // Two decimals, so a gate tripped at 5.04 % never reads as "5 %" in the reason.
  const unattributedPct = round(unattributedFractionRaw * 100, 2);
  const attributionIncomplete =
    unattributedFractionRaw > ATTRIBUTION_MAX_UNATTRIBUTED_FRACTION;
  // A FIXED phrase: the reason keys the once-per-streak unknown log, so a live figure here
  // would re-log every tick of the warm-up. The figure is in the summary and the snapshot.
  const attributionReason = `attribution incomplete (more than ${ATTRIBUTION_MAX_UNATTRIBUTED_FRACTION * 100}% of run time unattributed)`;
  const clientShareEvaluation = thresholdEvaluation(
    "clientShare",
    maxShareRaw,
    (maxShare) =>
      (topClient === null
        ? `client share: no attributed run time in the last ${GROWTH_WINDOW_DAYS} UTC days`
        : `client share: ${topClient.orgId} holds ${round(maxShare * 100, 1)}% of attributed run time ` +
          `across ${orgTimeMs.size} org(s) with run time (threshold > ${CLIENT_SHARE_THRESHOLD * 100}% with ≥ ${CLIENT_SHARE_MIN_ORGS} orgs)`) +
      `; ${unattributedPct}% of run time unattributed`,
    // Orgs that HOLD run time: an org whose only runs ended before starting shares no box
    // time, so it cannot make a single-tenant box look shared (Q-1). The composite's
    // clients arm still counts every org that dispatched.
    orgTimeMs.size >= CLIENT_SHARE_MIN_ORGS &&
      maxShareRaw > CLIENT_SHARE_THRESHOLD,
  );
  const clientShare = attributionIncomplete
    ? asUnknown(clientShareEvaluation, attributionReason)
    : clientShareEvaluation;

  // Scale composite.
  const prCounts = prsByDay.map((s) => s.size);
  const prsPerDayRaw = prCounts.reduce((a, b) => a + b, 0) / GROWTH_WINDOW_DAYS;
  const prsPerDay = round(prsPerDayRaw);
  let busiestDay: RunWindowStats["busiestDay"] = null;
  let busiestPrs = 0;
  for (const [i, prs] of prCounts.entries()) {
    const dayStart = window.dayStartsMs[i];
    if (dayStart !== undefined && prs > busiestPrs) {
      busiestPrs = prs;
      busiestDay = { date: isoDay(dayStart), prs };
    }
  }
  // Tagged orgs are a LOWER bound on clients (unattributed time can only add more), so the
  // clients arm is held whenever the tagged count already clears it; only a not-yet-held
  // arm is unknown under the attribution gate.
  const clientsArm = orgs.size > SCALE_CLIENTS_THRESHOLD;
  const clientsArmUnknown = attributionIncomplete && !clientsArm;
  const prsArm = prsPerDayRaw > SCALE_PRS_PER_DAY_THRESHOLD;
  const armsHeld = [clientsArm, prsArm, input.questionnaire].filter(
    Boolean,
  ).length;
  const unknownArmCount = clientsArmUnknown ? 1 : 0;
  const compositeEvaluation = thresholdEvaluation(
    "scaleComposite",
    armsHeld,
    () =>
      `scale composite: ${armsHeld} of 3 arms (clients ${orgs.size} > ${SCALE_CLIENTS_THRESHOLD}: ${clientsArmUnknown ? "unknown" : clientsArm}; ` +
      `PRs/day ${prsPerDay} > ${SCALE_PRS_PER_DAY_THRESHOLD}: ${prsArm}; ` +
      `questionnaire: ${input.questionnaire}; fires on ≥ ${SCALE_COMPOSITE_MIN_ARMS})`,
    armsHeld >= SCALE_COMPOSITE_MIN_ARMS,
  );
  const compositeUndecided =
    armsHeld < SCALE_COMPOSITE_MIN_ARMS &&
    armsHeld + unknownArmCount >= SCALE_COMPOSITE_MIN_ARMS;
  const scaleComposite = compositeUndecided
    ? asUnknown(
        compositeEvaluation,
        `arm(s) clients unknown: ${attributionReason}`,
      )
    : compositeEvaluation;

  // Supersede waste.
  const wasteRaw = totalMs > 0 ? cancelledMs / totalMs : 0;
  const supersedeWaste = thresholdEvaluation(
    "supersedeWaste",
    wasteRaw,
    (waste) =>
      `supersede waste: ${round(waste * 100, 1)}% of run time was CANCELLED ` +
      `(threshold > ${SUPERSEDE_WASTE_THRESHOLD * 100}%; includes in-worker admission and box-slot wait)`,
  );

  return {
    queueWait,
    clientShare,
    scaleComposite,
    supersedeWaste,
    stats: {
      windowDays: GROWTH_WINDOW_DAYS,
      queueWaitDailyP90S,
      policyHeldRuns,
      clients: orgs.size,
      unattributed: {
        seconds: round(unattributedMs / 1000),
        fraction: totalMs > 0 ? round(unattributedMs / totalMs) : 0,
      },
      topClient,
      prsPerDay,
      busiestDay,
    },
  };
}

// ---------------------------------------------------------------------------
// RAM / swap
// ---------------------------------------------------------------------------

/** One /proc sample. Bytes for memory; pswpin is the kernel's cumulative page counter. */
export interface MemSample {
  atMs: number;
  memTotal: number;
  memAvailable: number;
  /** Null when /proc/vmstat had no `pswpin`; a null sample breaks the swap streak. */
  pswpin: number | null;
}

/**
 * MemTotal and MemAvailable from `/proc/meminfo`, in bytes, or null when either is
 * missing, malformed or MemTotal is 0. Deliberately NOT `headroom.ts` `parseMeminfo`:
 * that one throws (an admission check must not pass blind) and reads other fields; this
 * one feeds an alert that must degrade to `unknown`, never take the tick down.
 */
export function parseMemTotalAvailable(
  meminfoText: string,
): { memTotal: number; memAvailable: number } | null {
  const total = /^MemTotal:\s+(\d+)\s+kB\s*$/m.exec(meminfoText)?.[1];
  const avail = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(meminfoText)?.[1];
  if (total === undefined || avail === undefined) return null;
  const memTotal = Number(total) * 1024;
  const memAvailable = Number(avail) * 1024;
  if (!Number.isFinite(memTotal) || memTotal <= 0) return null;
  if (!Number.isFinite(memAvailable)) return null;
  return { memTotal, memAvailable };
}

/** The cumulative `pswpin` counter from `/proc/vmstat`, or null when missing or malformed. */
export function parsePswpin(vmstatText: string): number | null {
  const m = /^pswpin\s+(\d+)\s*$/m.exec(vmstatText)?.[1];
  if (m === undefined) return null;
  const n = Number(m);
  return Number.isSafeInteger(n) ? n : null;
}

/** (MemTotal − MemAvailable) / MemTotal. */
function ramUtilisation(sample: MemSample): number {
  return (sample.memTotal - sample.memAvailable) / sample.memTotal;
}

/**
 * Keep only the samples a sustained-window decision can still need: every sample newer
 * than `nowMs − sustainMs`, plus the newest one at or before that cutoff. Lossless for
 * both arms: a streak qualifies iff the sample at the cutoff and every later one hold,
 * so anything older than that boundary sample can never change the answer. Bounds the
 * driver's memory to ~sustain/interval + 1 samples.
 */
export function pruneMemSamples(
  samples: readonly MemSample[],
  nowMs: number,
  sustainMs: number,
): MemSample[] {
  const cutoff = nowMs - sustainMs;
  const sorted = [...samples].sort((a, b) => a.atMs - b.atMs);
  let boundary = -1;
  sorted.forEach((s, i) => {
    if (s.atMs <= cutoff) boundary = i;
  });
  return sorted.slice(Math.max(0, boundary));
}

interface RamSwapInput {
  samples: readonly MemSample[];
  nowMs: number;
  /** `WORKER_GROWTH_TRIGGER_RAM_FRACTION`, 0 < x < 1. */
  ramFraction: number;
  /** `WORKER_GROWTH_TRIGGER_SUSTAIN_S` × 1000. */
  sustainMs: number;
  /** Set when THIS tick's /proc read failed: the verdict is `unknown`, whatever history says. */
  unreadableReason?: string;
}

/**
 * Over when EITHER arm holds for the sustain window:
 *  - RAM: the contiguous over-threshold streak ending at the newest sample started at a
 *    sample at least `sustainMs` old — a single spike is a build, not a box that is full;
 *  - swap: `pswpin` strictly increased across every consecutive pair over a streak whose
 *    base sample is at least `sustainMs` old — the box is paging IN continuously, which a
 *    one-off swap-out of cold pages never does.
 * Samples are contiguous in the list; a tick with no sample (a failed read) does not
 * break a streak, it only makes that tick `unknown`.
 *
 * WARMING UP. Until some retained sample is at least `sustainMs` old the samples cannot
 * span the window, so neither "sustained over" nor "not sustained" is knowable: the
 * verdict is `unknown` ("warming up"). Calling it `under` would clear a `ram_swap` that a
 * restart restored as firing from the snapshot on the first fresh sample.
 */
export function evaluateRamSwap(input: RamSwapInput): TriggerEvaluation {
  if (input.unreadableReason !== undefined) {
    return unknownEvaluation(
      "ram_swap",
      input.ramFraction,
      input.unreadableReason,
    );
  }
  const sorted = [...input.samples].sort((a, b) => a.atMs - b.atMs);
  const latest = sorted[sorted.length - 1];
  if (latest === undefined) {
    return unknownEvaluation("ram_swap", input.ramFraction, "no samples");
  }
  const cutoff = input.nowMs - input.sustainMs;
  // `sorted` is non-empty here (it has a `latest`), so the fallback never applies.
  if ((sorted[0] ?? latest).atMs > cutoff) {
    return unknownEvaluation("ram_swap", input.ramFraction, "warming up");
  }

  let ramStreakStart: MemSample | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i];
    if (s === undefined || ramUtilisation(s) <= input.ramFraction) break;
    ramStreakStart = s;
  }
  const ramSustained = ramStreakStart !== null && ramStreakStart.atMs <= cutoff;

  let swapBase: MemSample = latest;
  for (let i = sorted.length - 1; i >= 1; i--) {
    const cur = sorted[i];
    const prev = sorted[i - 1];
    if (cur === undefined || prev === undefined) break;
    if (cur.pswpin === null || prev.pswpin === null) break;
    if (cur.pswpin <= prev.pswpin) break;
    swapBase = prev;
  }
  const swapSustained = swapBase !== latest && swapBase.atMs <= cutoff;

  const util = round(ramUtilisation(latest));
  const sustainS = Math.round(input.sustainMs / 1000);
  return {
    trigger: "ram_swap",
    verdict: ramSustained || swapSustained ? "over" : "under",
    value: util,
    threshold: input.ramFraction,
    summary:
      `box RAM ${round(util * 100, 1)}% used (threshold > ${round(input.ramFraction * 100, 1)}% ` +
      `sustained ≥ ${sustainS}s: ${ramSustained}; pswpin rising ≥ ${sustainS}s: ${swapSustained})`,
  };
}

// ---------------------------------------------------------------------------
// Dedupe state machine
// ---------------------------------------------------------------------------

export interface TriggerDedupeState {
  firing: boolean;
  lastFiredAtMs: number | null;
  /**
   * client_share only: orgId → when a fire last named that org as the top client. The
   * 24 h hold is PER ORG: an org is announced at most once per GROWTH_REFIRE_MS, so two
   * orgs trading the top spot are announced once each, not on every swap. Pruned of
   * entries that no longer hold anything (older than the window, or in the future) on
   * every fire and on seed. Absent for every other trigger, and for a client_share that
   * never fired.
   */
  orgLastFiredAtMs?: Readonly<Record<string, number>>;
}

export const INITIAL_DEDUPE_STATE: TriggerDedupeState = {
  firing: false,
  lastFiredAtMs: null,
};

type DedupeAction = "none" | "fire" | "clear";

interface DedupeTransition {
  action: DedupeAction;
  /** The state to commit — but only after the action's POST succeeded (V2). */
  next: TriggerDedupeState;
}

interface DecideTransitionOptions {
  /**
   * client_share only: the org that currently holds the largest share. When set, the hold
   * is that org's own (`orgLastFiredAtMs`), not the trigger's, and a fire records it.
   */
  topOrgId?: string;
}

/**
 * Whether a fire at `last` still holds an `over` at `nowMs`. A `last` AFTER `nowMs` (a
 * clock that stepped back, or a snapshot written by a box with a fast clock) holds
 * nothing: otherwise the hold would last until the clock caught up, however long that is.
 */
function heldBy(last: number | null | undefined, nowMs: number): boolean {
  return (
    last !== null &&
    last !== undefined &&
    last <= nowMs &&
    nowMs - last < GROWTH_REFIRE_MS
  );
}

/** The org fires that still hold at `nowMs`; null when none does. */
function liveOrgFires(
  fires: Readonly<Record<string, number>> | undefined,
  nowMs: number,
): Record<string, number> | null {
  if (fires === undefined) return null;
  const live = Object.entries(fires).filter(([, at]) => heldBy(at, nowMs));
  return live.length > 0 ? Object.fromEntries(live) : null;
}

/**
 * Pure transition. `fire` when over and the last fire is ≥ GROWTH_REFIRE_MS old or there
 * was none — whether or not the trigger is still `firing`, so a condition that flaps (fire
 * → clear → over again) is announced at most once per window (AC 4), and one that stays
 * over is re-announced once a day, not every tick. `clear` once when it drops under while
 * firing, never held by the window; `unknown` is always a no-op. A `lastFiredAtMs` AFTER
 * `nowMs` holds nothing (see heldBy).
 *
 * client_share (`options.topOrgId` set): the hold is per org. An `over` fires iff THAT org
 * was not announced in the last GROWTH_REFIRE_MS, so a different client is announced as
 * its own split, and two clients trading the top spot are announced once each per window
 * instead of on every swap.
 *
 * The transition is a PROPOSAL. A failed webhook must not be recorded as delivered (V2) —
 * otherwise a sink outage at the moment of the fire would silence the trigger for 24 h —
 * so the caller applies `next` via `commitTransition(state, t, delivered)` after the POST.
 */
export function decideTransition(
  state: TriggerDedupeState,
  verdict: GrowthVerdict,
  nowMs: number,
  options: DecideTransitionOptions = {},
): DedupeTransition {
  if (verdict === "over") {
    const orgId = options.topOrgId;
    if (orgId === undefined) {
      return heldBy(state.lastFiredAtMs, nowMs)
        ? { action: "none", next: state }
        : {
            action: "fire",
            next: { ...state, firing: true, lastFiredAtMs: nowMs },
          };
    }
    if (heldBy(state.orgLastFiredAtMs?.[orgId], nowMs)) {
      return { action: "none", next: state };
    }
    return {
      action: "fire",
      next: {
        firing: true,
        lastFiredAtMs: nowMs,
        orgLastFiredAtMs: {
          ...liveOrgFires(state.orgLastFiredAtMs, nowMs),
          [orgId]: nowMs,
        },
      },
    };
  }
  if (verdict === "under" && state.firing) {
    return { action: "clear", next: { ...state, firing: false } };
  }
  return { action: "none", next: state };
}

/**
 * client_share: the orgs whose announcement still holds at `nowMs` (a fire in the last
 * GROWTH_REFIRE_MS named them), sorted. Its clear names these — the clients the operator
 * was told to split — not whichever org happens to be on top when the share drops.
 */
export function announcedOrgIds(
  state: TriggerDedupeState,
  nowMs: number,
): string[] {
  return Object.keys(liveOrgFires(state.orgLastFiredAtMs, nowMs) ?? {}).sort();
}

/**
 * The state after the transition's side effect ran: `next` only when delivered, so a
 * failed fire or clear is retried next tick. A `none` transition's `next` is `state`
 * itself, so it needs no commit at all.
 */
export function commitTransition(
  state: TriggerDedupeState,
  transition: DedupeTransition,
  delivered: boolean,
): TriggerDedupeState {
  return delivered ? transition.next : state;
}

// ---------------------------------------------------------------------------
// Webhook body and snapshot
// ---------------------------------------------------------------------------

type WebhookState = "fired" | "cleared";

export interface GrowthWebhookBody {
  /** One line; makes the body a valid Slack incoming-webhook payload (ntfy accepts it too). */
  text: string;
  trigger: GrowthTriggerId;
  value: number | null;
  threshold: number;
  authorizedMove: string;
  boxId: string;
  /** ISO time of THIS event (the fire, or the clear). */
  firedAt: string;
  state: WebhookState;
}

export function buildWebhookBody(input: {
  evaluation: TriggerEvaluation;
  boxId: string;
  nowMs: number;
  state: WebhookState;
  /**
   * client_share clears only: announcedOrgIds(state before the clear, nowMs). When
   * non-empty the cleared text names them, so the clear answers the fires it ends.
   */
  announcedOrgIds?: readonly string[];
}): GrowthWebhookBody {
  const { evaluation, boxId, nowMs, state } = input;
  const move = AUTHORIZED_MOVES[evaluation.trigger];
  const announced =
    state === "cleared" &&
    evaluation.trigger === "client_share" &&
    input.announcedOrgIds !== undefined &&
    input.announcedOrgIds.length > 0
      ? `no longer over for ${input.announcedOrgIds.join(", ")} (announced in the last 24 h); `
      : "";
  const text =
    state === "fired"
      ? `[growth] ${evaluation.trigger} FIRED on ${boxId}: ${evaluation.summary}. Authorized move: ${move}`
      : `[growth] ${evaluation.trigger} cleared on ${boxId}: ${announced}${evaluation.summary}`;
  return {
    text: text.replace(/[\r\n]+/g, " "),
    trigger: evaluation.trigger,
    value: evaluation.value,
    threshold: evaluation.threshold,
    authorizedMove: move,
    boxId,
    firedAt: new Date(nowMs).toISOString(),
    state,
  };
}

interface SnapshotTriggerEntry {
  value: number | null;
  threshold: number;
  verdict: GrowthVerdict;
  reason?: string;
  firing: boolean;
  lastFiredAt: string | null;
  /** client_share only, once it has fired: orgId → ISO time of the last fire naming it. */
  orgLastFiredAt?: Record<string, string>;
}

export interface GrowthSnapshot {
  evaluatedAt: string;
  boxId: string;
  windowDays: number;
  triggers: Record<GrowthTriggerId, SnapshotTriggerEntry>;
  /** Null when the engine was unreadable this tick. */
  unattributed: RunWindowStats["unattributed"] | null;
  busiestDay: RunWindowStats["busiestDay"];
  clients: number | null;
  prsPerDay: number | null;
  queueWaitDailyP90S: Array<number | null> | null;
}

/**
 * The `growth-triggers.json` object, written every tick (AC 5) so an operator can read
 * the last evaluation of every trigger without the sink. `states` is the COMMITTED dedupe
 * state after this tick's deliveries.
 */
export function buildSnapshot(input: {
  nowMs: number;
  boxId: string;
  evaluations: Readonly<Record<GrowthTriggerId, TriggerEvaluation>>;
  states: Readonly<Record<GrowthTriggerId, TriggerDedupeState>>;
  stats: RunWindowStats | null;
}): GrowthSnapshot {
  const triggers = {} as Record<GrowthTriggerId, SnapshotTriggerEntry>;
  for (const id of GROWTH_TRIGGER_IDS) {
    const e = input.evaluations[id];
    const s = input.states[id];
    triggers[id] = {
      value: e.value,
      threshold: e.threshold,
      verdict: e.verdict,
      firing: s.firing,
      lastFiredAt:
        s.lastFiredAtMs === null
          ? null
          : new Date(s.lastFiredAtMs).toISOString(),
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
      ...(s.orgLastFiredAtMs !== undefined
        ? {
            orgLastFiredAt: Object.fromEntries(
              Object.entries(s.orgLastFiredAtMs).map(([org, at]) => [
                org,
                new Date(at).toISOString(),
              ]),
            ),
          }
        : {}),
    };
  }
  return {
    evaluatedAt: new Date(input.nowMs).toISOString(),
    boxId: input.boxId,
    windowDays: GROWTH_WINDOW_DAYS,
    triggers,
    unattributed: input.stats?.unattributed ?? null,
    busiestDay: input.stats?.busiestDay ?? null,
    clients: input.stats?.clients ?? null,
    prsPerDay: input.stats?.prsPerDay ?? null,
    queueWaitDailyP90S: input.stats?.queueWaitDailyP90S ?? null,
  };
}

/** client_share's persisted per-org fires, keeping only those that still hold at `seedMs`. */
function seedOrgFires(
  raw: unknown,
  seedMs: number,
): Record<string, number> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const parsed: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const orgId = nonEmptyString(key);
    const at = parseTimestampMs(value);
    if (orgId !== null && at !== null) parsed[orgId] = at;
  }
  return liveOrgFires(parsed, seedMs);
}

/**
 * Seed the dedupe states from a previous snapshot (parsed JSON, or anything) so a worker
 * restart does not re-fire every trigger that was already firing. Anything unreadable
 * seeds the initial state for that trigger — worst case one duplicate alert, never a
 * suppressed one that was not delivered.
 *
 * A `lastFiredAt` after `seedMs` (the arm-time clock) is a fire from the future and cannot
 * be honoured as a hold: it seeds `lastFiredAtMs: null`, but KEEPS `firing`, so a trigger
 * that was firing can still be cleared when it drops under (seeding the initial state
 * would drop that pending clear). client_share's per-org fires are seeded the same way:
 * only entries that still hold at `seedMs` survive.
 */
export function dedupeStatesFromSnapshot(
  raw: unknown,
  seedMs: number,
): Record<GrowthTriggerId, TriggerDedupeState> {
  const out = {} as Record<GrowthTriggerId, TriggerDedupeState>;
  const triggers =
    typeof raw === "object" && raw !== null
      ? (raw as { triggers?: unknown }).triggers
      : undefined;
  for (const id of GROWTH_TRIGGER_IDS) {
    const entry =
      typeof triggers === "object" && triggers !== null
        ? (triggers as Record<string, unknown>)[id]
        : undefined;
    if (typeof entry !== "object" || entry === null) {
      out[id] = INITIAL_DEDUPE_STATE;
      continue;
    }
    const e = entry as {
      firing?: unknown;
      lastFiredAt?: unknown;
      orgLastFiredAt?: unknown;
    };
    const orgFires =
      id === "client_share" ? seedOrgFires(e.orgLastFiredAt, seedMs) : null;
    const orgField = orgFires !== null ? { orgLastFiredAtMs: orgFires } : {};
    const lastFiredAtMs = parseTimestampMs(e.lastFiredAt);
    if (lastFiredAtMs !== null && lastFiredAtMs > seedMs) {
      out[id] = { firing: e.firing === true, lastFiredAtMs: null, ...orgField };
      continue;
    }
    out[id] = {
      // An explicit `lastFiredAt: null` with `firing: true` is the state the future-fire
      // branch above seeds and the next snapshot writes back: keep it firing, or the
      // pending clear is lost on the SECOND restart. A missing or junk `lastFiredAt`
      // still seeds idle.
      firing:
        e.firing === true && (lastFiredAtMs !== null || e.lastFiredAt === null),
      lastFiredAtMs,
      ...orgField,
    };
  }
  return out;
}
