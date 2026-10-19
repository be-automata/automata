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
export const GROWTH_WINDOW_DAYS = 7;
/** Queue-wait daily p90 must exceed this on every one of the 7 days. */
export const QUEUE_WAIT_P90_THRESHOLD_S = 600;
/** The p90 is nearest-rank at this percentile. */
export const QUEUE_WAIT_PERCENTILE = 0.9;
/** One client's share of ATTRIBUTED run time must exceed this (Q-1). */
export const CLIENT_SHARE_THRESHOLD = 0.4;
/** ...and only when the window holds at least this many distinct orgs (Q-1). */
export const CLIENT_SHARE_MIN_ORGS = 2;
/** Scale-composite arm: distinct clients must exceed this. */
export const SCALE_CLIENTS_THRESHOLD = 5;
/** Scale-composite arm: the 7-day average of distinct PRs per UTC day must exceed this (Q-2). */
export const SCALE_PRS_PER_DAY_THRESHOLD = 100;
/** Scale composite fires when at least this many of its three arms hold ("any two"). */
export const SCALE_COMPOSITE_MIN_ARMS = 2;
/** CANCELLED run time over all run time must exceed this (#372 AC 9). */
export const SUPERSEDE_WASTE_THRESHOLD = 0.2;
/** A trigger that stays over re-fires at most once per this window. */
export const GROWTH_REFIRE_MS = 24 * 60 * 60 * 1000;

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

/** Verbatim from the #373 signal table: the one move each trigger authorizes. */
export const AUTHORIZED_MOVES: Readonly<Record<GrowthTriggerId, string>> = {
  queue_wait_p90: "Raise the cap, then resize CX43 (cap 6) / CX53 (cap 8)",
  ram_swap: "Add a second shared box on the same tenant",
  client_share:
    "Split that client to its own box (tickets 6/7); also fires manually on isolation / write-lane requests",
  scale_composite: "Start the per-run sandbox path",
  supersede_waste: "Revisit the default policy",
};

export type GrowthVerdict = "over" | "under" | "unknown";

export interface TriggerEvaluation {
  trigger: GrowthTriggerId;
  verdict: GrowthVerdict;
  /** The observed value; null exactly when the verdict is `unknown`. */
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
  actionId: string;
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
    actionId,
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

export interface GrowthWindow {
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
export function runTimeMs(row: RunRow): number | null {
  if (row.startedAtMs === null || row.finishedAtMs === null) return null;
  const d = row.finishedAtMs - row.startedAtMs;
  return d >= 0 ? d : null;
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

export interface RunWindowStats {
  windowDays: number;
  /** Per-day nearest-rank p90 queue wait in seconds, oldest first; null for a day with no started run. */
  queueWaitDailyP90S: Array<number | null>;
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

export interface RunSignalsInput {
  runs: RunsReading;
  nowMs: number;
  /** `WORKER_ENTERPRISE_QUESTIONNAIRE=1`: the composite's manual arm. */
  questionnaire: boolean;
}

export interface RunSignalsResult {
  queueWait: TriggerEvaluation;
  clientShare: TriggerEvaluation;
  scaleComposite: TriggerEvaluation;
  supersedeWaste: TriggerEvaluation;
  /** Null when the engine was unreadable this tick. */
  stats: RunWindowStats | null;
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

/**
 * Evaluate the four engine-backed triggers over the last 7 complete UTC days.
 *
 * QUEUE WAIT. Each day's p90 of `startedAt − createdAt` over its STARTED run tasks (a
 * QUEUED row without `startedAt` is excluded — a documented limitation, V7). The trigger
 * is "> 10 min for 7 consecutive days", so its value is the streak's WEAKEST day, with an
 * empty day counting as 0: a day with no run tasks breaks the streak by definition.
 *
 * CLIENT SHARE. Org run time ÷ ATTRIBUTED run time; unattributed time is reported, never
 * an org (OD-0). One org at 100% is not a split signal — it is a single-tenant box — so the
 * trigger cannot fire below CLIENT_SHARE_MIN_ORGS distinct orgs (Q-1).
 *
 * SCALE COMPOSITE. Arms: clients > 5, PRs/day > 100 (7-day average, Q-2), questionnaire.
 * Value = arms held; over at ≥ SCALE_COMPOSITE_MIN_ARMS. No single arm justifies the
 * per-run sandbox path on its own.
 *
 * SUPERSEDE WASTE. CANCELLED run time ÷ all run time.
 */
export function evaluateRunSignals(input: RunSignalsInput): RunSignalsResult {
  if (input.runs.kind === "unreadable") {
    const reason = input.runs.reason;
    return {
      queueWait: unknownEvaluation(
        "queue_wait_p90",
        QUEUE_WAIT_P90_THRESHOLD_S,
        reason,
      ),
      clientShare: unknownEvaluation(
        "client_share",
        CLIENT_SHARE_THRESHOLD,
        reason,
      ),
      scaleComposite: unknownEvaluation(
        "scale_composite",
        SCALE_COMPOSITE_MIN_ARMS,
        reason,
      ),
      supersedeWaste: unknownEvaluation(
        "supersede_waste",
        SUPERSEDE_WASTE_THRESHOLD,
        reason,
      ),
      stats: null,
    };
  }

  const window = growthWindow(input.nowMs);
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
    if (row.startedAtMs !== null) {
      // Clamped at 0: a sub-second clock skew between engine writers is "started at once".
      waitsByDay[day]?.push(Math.max(0, row.startedAtMs - row.createdAtMs));
    }
    if (row.repoFullName !== null && row.prNumber !== null) {
      prsByDay[day]?.add(`${row.repoFullName.toLowerCase()}#${row.prNumber}`);
    }
    if (row.orgId !== null) orgs.add(row.orgId);
    const t = runTimeMs(row);
    if (t === null) continue;
    if (row.orgId === null) {
      unattributedMs += t;
    } else {
      attributedMs += t;
      orgTimeMs.set(row.orgId, (orgTimeMs.get(row.orgId) ?? 0) + t);
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
  // Thresholds compare the UNROUNDED value; only the reported value is rounded, so a
  // reading just past a threshold cannot be rounded back onto it.
  const weakestDayRawS = Math.min(...dailyP90Ms.map((v) => (v ?? 0) / 1000));
  const weakestDayS = round(weakestDayRawS);
  const emptyDays = queueWaitDailyP90S.filter((v) => v === null).length;
  const queueWait: TriggerEvaluation = {
    trigger: "queue_wait_p90",
    verdict: weakestDayRawS > QUEUE_WAIT_P90_THRESHOLD_S ? "over" : "under",
    value: weakestDayS,
    threshold: QUEUE_WAIT_P90_THRESHOLD_S,
    summary:
      `queue-wait p90: weakest of the last ${GROWTH_WINDOW_DAYS} UTC days ${weakestDayS}s ` +
      `(threshold > ${QUEUE_WAIT_P90_THRESHOLD_S}s every day` +
      (emptyDays > 0 ? `; ${emptyDays} day(s) with no started run` : "") +
      ")",
  };

  // Client share.
  let topOrg: { orgId: string; share: number } | null = null;
  if (attributedMs > 0) {
    for (const [orgId, ms] of orgTimeMs) {
      const share = ms / attributedMs;
      if (topOrg === null || share > topOrg.share) topOrg = { orgId, share };
    }
  }
  const topClient: RunWindowStats["topClient"] =
    topOrg === null
      ? null
      : { orgId: topOrg.orgId, share: round(topOrg.share) };
  const maxShareRaw = topOrg?.share ?? 0;
  const maxShare = round(maxShareRaw);
  const shareOver =
    orgs.size >= CLIENT_SHARE_MIN_ORGS && maxShareRaw > CLIENT_SHARE_THRESHOLD;
  const clientShare: TriggerEvaluation = {
    trigger: "client_share",
    verdict: shareOver ? "over" : "under",
    value: maxShare,
    threshold: CLIENT_SHARE_THRESHOLD,
    summary:
      topClient === null
        ? `client share: no attributed run time in the last ${GROWTH_WINDOW_DAYS} UTC days`
        : `client share: ${topClient.orgId} holds ${round(maxShare * 100, 1)}% of attributed run time ` +
          `across ${orgs.size} org(s) (threshold > ${CLIENT_SHARE_THRESHOLD * 100}% with ≥ ${CLIENT_SHARE_MIN_ORGS} orgs)`,
  };

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
  const arms = {
    clients: orgs.size > SCALE_CLIENTS_THRESHOLD,
    prsPerDay: prsPerDayRaw > SCALE_PRS_PER_DAY_THRESHOLD,
    questionnaire: input.questionnaire,
  };
  const armsHeld = Object.values(arms).filter(Boolean).length;
  const scaleComposite: TriggerEvaluation = {
    trigger: "scale_composite",
    verdict: armsHeld >= SCALE_COMPOSITE_MIN_ARMS ? "over" : "under",
    value: armsHeld,
    threshold: SCALE_COMPOSITE_MIN_ARMS,
    summary:
      `scale composite: ${armsHeld} of 3 arms (clients ${orgs.size} > ${SCALE_CLIENTS_THRESHOLD}: ${arms.clients}; ` +
      `PRs/day ${prsPerDay} > ${SCALE_PRS_PER_DAY_THRESHOLD}: ${arms.prsPerDay}; ` +
      `questionnaire: ${arms.questionnaire}; fires on ≥ ${SCALE_COMPOSITE_MIN_ARMS})`,
  };

  // Supersede waste.
  const totalMs = attributedMs + unattributedMs;
  const wasteRaw = totalMs > 0 ? cancelledMs / totalMs : 0;
  const waste = round(wasteRaw);
  const supersedeWaste: TriggerEvaluation = {
    trigger: "supersede_waste",
    verdict: wasteRaw > SUPERSEDE_WASTE_THRESHOLD ? "over" : "under",
    value: waste,
    threshold: SUPERSEDE_WASTE_THRESHOLD,
    summary:
      `supersede waste: ${round(waste * 100, 1)}% of run time was CANCELLED ` +
      `(threshold > ${SUPERSEDE_WASTE_THRESHOLD * 100}%)`,
  };

  return {
    queueWait,
    clientShare,
    scaleComposite,
    supersedeWaste,
    stats: {
      windowDays: GROWTH_WINDOW_DAYS,
      queueWaitDailyP90S,
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
export function ramUtilisation(sample: MemSample): number {
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

export interface RamSwapInput {
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
  const first = sorted[0];
  if (first === undefined || first.atMs > cutoff) {
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
}

export const INITIAL_DEDUPE_STATE: TriggerDedupeState = {
  firing: false,
  lastFiredAtMs: null,
};

export type DedupeAction = "none" | "fire" | "clear";

export interface DedupeTransition {
  action: DedupeAction;
  /** The state to commit — but only after the action's POST succeeded (V2). */
  next: TriggerDedupeState;
}

/**
 * Pure transition. `fire` when over and the last fire is ≥ refireMs old or there was none
 * — whether or not the trigger is still `firing`, so a condition that flaps (fire → clear
 * → over again) is announced at most once per window (AC 4), and one that stays over is
 * re-announced once a day, not every tick. `clear` once when it drops under while firing,
 * never held by the window; `unknown` is always a no-op.
 *
 * The transition is a PROPOSAL. A failed webhook must not be recorded as delivered (V2) —
 * otherwise a sink outage at the moment of the fire would silence the trigger for 24 h —
 * so the caller applies `next` via `commitTransition(state, t, delivered)` after the POST.
 */
export function decideTransition(
  state: TriggerDedupeState,
  verdict: GrowthVerdict,
  nowMs: number,
  refireMs: number = GROWTH_REFIRE_MS,
): DedupeTransition {
  if (verdict === "over") {
    const due =
      state.lastFiredAtMs === null || nowMs - state.lastFiredAtMs >= refireMs;
    return due
      ? { action: "fire", next: { firing: true, lastFiredAtMs: nowMs } }
      : { action: "none", next: state };
  }
  if (verdict === "under" && state.firing) {
    return {
      action: "clear",
      next: { firing: false, lastFiredAtMs: state.lastFiredAtMs },
    };
  }
  return { action: "none", next: state };
}

/**
 * The state after the transition's side effect ran. `none` always commits (nothing to
 * deliver); `fire` and `clear` commit only when delivered, so the next tick retries.
 */
export function commitTransition(
  state: TriggerDedupeState,
  transition: DedupeTransition,
  delivered: boolean,
): TriggerDedupeState {
  if (transition.action === "none") return transition.next;
  return delivered ? transition.next : state;
}

// ---------------------------------------------------------------------------
// Webhook body and snapshot
// ---------------------------------------------------------------------------

export type WebhookState = "fired" | "cleared";

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
}): GrowthWebhookBody {
  const { evaluation, boxId, nowMs, state } = input;
  const move = AUTHORIZED_MOVES[evaluation.trigger];
  const text =
    state === "fired"
      ? `[growth] ${evaluation.trigger} FIRED on ${boxId}: ${evaluation.summary}. Authorized move: ${move}`
      : `[growth] ${evaluation.trigger} cleared on ${boxId}: ${evaluation.summary}`;
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

export interface SnapshotTriggerEntry {
  value: number | null;
  /** Null only for a trigger that was not evaluated this tick. */
  threshold: number | null;
  verdict: GrowthVerdict;
  reason?: string;
  firing: boolean;
  lastFiredAt: string | null;
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
  evaluations: readonly TriggerEvaluation[];
  states: Readonly<Partial<Record<GrowthTriggerId, TriggerDedupeState>>>;
  stats: RunWindowStats | null;
}): GrowthSnapshot {
  const byId = new Map(input.evaluations.map((e) => [e.trigger, e]));
  const triggers = {} as Record<GrowthTriggerId, SnapshotTriggerEntry>;
  for (const id of GROWTH_TRIGGER_IDS) {
    const e = byId.get(id);
    const s = input.states[id] ?? INITIAL_DEDUPE_STATE;
    const entry: SnapshotTriggerEntry = {
      value: e?.value ?? null,
      threshold: e?.threshold ?? null,
      verdict: e?.verdict ?? "unknown",
      firing: s.firing,
      lastFiredAt:
        s.lastFiredAtMs === null
          ? null
          : new Date(s.lastFiredAtMs).toISOString(),
    };
    if (e === undefined) entry.reason = "not evaluated";
    else if (e.reason !== undefined) entry.reason = e.reason;
    triggers[id] = entry;
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

/**
 * Seed the dedupe states from a previous snapshot (parsed JSON, or anything) so a worker
 * restart does not re-fire every trigger that was already firing. Anything unreadable
 * seeds the initial state for that trigger — worst case one duplicate alert, never a
 * suppressed one that was not delivered.
 */
export function dedupeStatesFromSnapshot(
  raw: unknown,
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
    const e = entry as { firing?: unknown; lastFiredAt?: unknown };
    const lastFiredAtMs = parseTimestampMs(e.lastFiredAt);
    out[id] = {
      firing: e.firing === true && lastFiredAtMs !== null,
      lastFiredAtMs,
    };
  }
  return out;
}
