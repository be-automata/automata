/**
 * #373 (epic #193 ticket 5): growth-trigger evaluator — the I/O half.
 *
 * The pure half (`growth-triggers.ts`) turns values into verdicts, transitions and
 * bytes. This module feeds it: the engine's windowed collection route, `/proc`, the
 * webhook sink, the snapshot file, and the tick driver that ties them together.
 *
 * FAILS TO UNKNOWN, NEVER THROWS. Every read degrades to `unreadable` with a FIXED
 * phrase (plus at most an HTTP status or an Error's `name`). An Error's `message` is
 * never echoed: a URL-parse or network error can carry the URL, and the webhook URL is
 * itself a credential (a Slack incoming webhook). The engine token, the Authorization
 * header and every response body are likewise never logged or returned (V5, §14).
 *
 * ONLY THE COLLECTION ROUTE. By-id GETs return 403 for API tokens on this engine, so
 * every engine read goes through `/api/v1/stable/tenants/{t}/workflow-runs` (AC 3).
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildSnapshot,
  buildWebhookBody,
  commitTransition,
  decideTransition,
  dedupeStatesFromSnapshot,
  evaluateRamSwap,
  evaluateRunSignals,
  growthWindow,
  parseMemTotalAvailable,
  parsePswpin,
  parseRunRow,
  pruneMemSamples,
  type GrowthSnapshot,
  type GrowthTriggerId,
  type GrowthWebhookBody,
  type MemSample,
  type RunRow,
  type RunsReading,
  type TriggerDedupeState,
  type TriggerEvaluation,
} from "./growth-triggers";
import { loadGrowthTriggerConfig } from "./growth-trigger-config";
import { writeSnapshotAtomic } from "./scheduling-maintenance";

/** Rows per page of the collection route. */
export const GROWTH_RUNS_PAGE_LIMIT = 200;
/** Hard cap on pages per read (~600 run rows / 7 days today; 50 pages = 10 000 rows). */
export const GROWTH_RUNS_MAX_PAGES = 50;
/** Upper bound on one webhook POST; the effective timeout is min(this, intervalMs / 2) (V2). */
export const GROWTH_WEBHOOK_TIMEOUT_CAP_MS = 10_000;
/** The snapshot file under `<runNamespaceRoot>`. */
export const GROWTH_SNAPSHOT_FILENAME = "growth-triggers.json";
/** Snapshot permissions (V9): owner rw, group r, other none. */
export const GROWTH_SNAPSHOT_MODE = 0o640;
/** A tick must finish within this fraction of the interval, so ticks cannot stack. */
export const GROWTH_TICK_BUDGET_FRACTION = 0.8;

const PROC_MEMINFO = "/proc/meminfo";
const PROC_VMSTAT = "/proc/vmstat";

/** The error's class name only (`TimeoutError`, `AbortError`, `TypeError`) — never its message. */
function errorName(err: unknown): string {
  return err instanceof Error && err.name ? err.name : "unknown error";
}

// ---------------------------------------------------------------------------
// Engine collection route
// ---------------------------------------------------------------------------

export interface ReadRunWindowInput {
  apiUrl: string;
  tenantId: string;
  /** Never logged, never returned. */
  token: string;
  /** The reader's `since`, normally growthWindow(now).startMs. */
  sinceMs: number;
  /** Absolute clock time after which no request may still be in flight. */
  deadlineMs: number;
  fetchImpl?: typeof fetch;
  /** Clock used against `deadlineMs`; defaults to Date.now. */
  now?: () => number;
}

interface RunsPage {
  rows: unknown[];
  currentPage: number | null;
  nextPage: number | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Boundary guard for one collection-route body: `{rows: [...], pagination?: {...}}`. */
function parseRunsPage(body: unknown): RunsPage | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { rows?: unknown; pagination?: unknown };
  if (!Array.isArray(b.rows)) return null;
  const p =
    typeof b.pagination === "object" && b.pagination !== null
      ? (b.pagination as { current_page?: unknown; next_page?: unknown })
      : {};
  return {
    rows: b.rows,
    currentPage: finiteNumber(p.current_page),
    nextPage: finiteNumber(p.next_page),
  };
}

export function buildRunWindowUrl(input: {
  apiUrl: string;
  tenantId: string;
  sinceMs: number;
  offset: number;
}): string {
  const base = input.apiUrl.replace(/\/+$/, "");
  const since = encodeURIComponent(new Date(input.sinceMs).toISOString());
  return (
    `${base}/api/v1/stable/tenants/${encodeURIComponent(input.tenantId)}/workflow-runs` +
    `?since=${since}&limit=${GROWTH_RUNS_PAGE_LIMIT}&offset=${input.offset}&only_tasks=true`
  );
}

/**
 * Offset-paginated read of every run task created since `sinceMs` (V7). Stops on a
 * short page, or when `pagination.next_page` is missing or not past `current_page`.
 * More than GROWTH_RUNS_MAX_PAGES pages → `unreadable` "page cap": a partial window
 * would silently understate every run signal. Each request's abort budget is the time
 * left until `deadlineMs`, so a slow engine cannot push the tick past its interval.
 */
export async function readRunWindow(
  input: ReadRunWindowInput,
): Promise<RunsReading> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const rows: RunRow[] = [];
  let offset = 0;

  for (let page = 0; page < GROWTH_RUNS_MAX_PAGES; page++) {
    const remainingMs = input.deadlineMs - now();
    if (remainingMs <= 0) {
      return {
        kind: "unreadable",
        reason: "engine read: tick deadline exceeded",
      };
    }
    const url = buildRunWindowUrl({
      apiUrl: input.apiUrl,
      tenantId: input.tenantId,
      sinceMs: input.sinceMs,
      offset,
    });

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${input.token}` },
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch (err) {
      return {
        kind: "unreadable",
        reason: `engine read: request failed (${errorName(err)})`,
      };
    }
    if (!res.ok) {
      return { kind: "unreadable", reason: `engine read: http ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: "unreadable", reason: "engine read: body is not JSON" };
    }
    const parsed = parseRunsPage(body);
    if (parsed === null) {
      return {
        kind: "unreadable",
        reason: "engine read: body does not match the workflow-runs list",
      };
    }

    for (const raw of parsed.rows) {
      const row = parseRunRow(raw);
      if (row !== null) rows.push(row);
    }

    const shortPage = parsed.rows.length < GROWTH_RUNS_PAGE_LIMIT;
    const noNext =
      parsed.nextPage === null ||
      (parsed.currentPage !== null && parsed.nextPage <= parsed.currentPage);
    if (shortPage || noNext) return { kind: "rows", rows };
    offset += parsed.rows.length;
  }
  return { kind: "unreadable", reason: "engine read: page cap" };
}

// ---------------------------------------------------------------------------
// /proc
// ---------------------------------------------------------------------------

export type MemReading =
  | { kind: "sample"; sample: MemSample }
  | { kind: "unreadable"; reason: string };

export type ReadText = (filePath: string) => Promise<string>;

/**
 * One RAM/swap sample. An unreadable or malformed `/proc/meminfo` is `unreadable` (the
 * RAM trigger reads `unknown` this tick). An unreadable `/proc/vmstat` is NOT: the RAM
 * arm is still honest, so the sample carries `pswpin: null`, which breaks the swap
 * streak instead of inventing one.
 */
export async function readMemSample(
  readText: ReadText,
  nowMs: number,
): Promise<MemReading> {
  let meminfo: string;
  try {
    meminfo = await readText(PROC_MEMINFO);
  } catch (err) {
    return {
      kind: "unreadable",
      reason: `cannot read /proc/meminfo (${errorName(err)})`,
    };
  }
  const mem = parseMemTotalAvailable(meminfo);
  if (mem === null) {
    return {
      kind: "unreadable",
      reason: "/proc/meminfo lacks MemTotal/MemAvailable",
    };
  }
  let pswpin: number | null = null;
  try {
    pswpin = parsePswpin(await readText(PROC_VMSTAT));
  } catch {
    pswpin = null;
  }
  return { kind: "sample", sample: { atMs: nowMs, ...mem, pswpin } };
}

// ---------------------------------------------------------------------------
// Webhook sink
// ---------------------------------------------------------------------------

export type WebhookResult =
  | { delivered: true; status: number }
  | { delivered: false; status?: number; reason: string };

/**
 * One JSON POST. Any 2xx is delivered; non-2xx, network error and timeout are not.
 * The URL is a secret: it never appears in the returned reason (fixed phrases only).
 */
export async function postWebhook(
  url: string,
  body: GrowthWebhookBody,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
  } catch (err) {
    const name = errorName(err);
    return {
      delivered: false,
      reason:
        name === "TimeoutError" || name === "AbortError"
          ? "timeout"
          : `request failed (${name})`,
    };
  }
  if (!res.ok) {
    return { delivered: false, status: res.status, reason: "non-2xx" };
  }
  return { delivered: true, status: res.status };
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export interface GrowthEngineTarget {
  apiUrl: string;
  tenantId: string;
  /** Never logged. */
  token: string;
}

export type WriteSnapshot = (
  dir: string,
  snapshot: GrowthSnapshot,
  filename: string,
  mode: number,
) => void;

export interface GrowthTriggerDeps {
  /** Resolved ONCE at arm time (production: loadAuthProbeConfig). May throw: arm propagates. */
  resolveEngine: () => GrowthEngineTarget;
  boxId: string;
  /** `<runNamespaceRoot>`; the snapshot is GROWTH_SNAPSHOT_FILENAME inside it. */
  snapshotDir: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  readText?: ReadText;
  /** Defaults to writeSnapshotAtomic (whose signature this mirrors). */
  writeSnapshot?: WriteSnapshot;
  /** The previous snapshot's text, or null when there is none. May throw. */
  readSnapshot?: (filePath: string) => string | null;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export interface GrowthTickResult {
  /** True when another tick was still in flight and this one did nothing. */
  skipped: boolean;
  /** The snapshot written (or attempted) this tick; null when skipped or the tick failed. */
  snapshot: GrowthSnapshot | null;
}

export interface GrowthTriggersHandle {
  /** One evaluation. Exported for tests: no real timers anywhere in the suite. */
  tick: () => Promise<GrowthTickResult>;
  /** The immediate tick fired at arm time; tests await it. */
  firstTick: Promise<GrowthTickResult>;
  stop: () => void;
}

function logLine(
  log: (line: string) => void,
  event: string,
  fields: Record<string, unknown>,
): void {
  log(`${event} ${JSON.stringify(fields)}`);
}

/**
 * Synchronous on purpose: seeding happens once, at arm time, before the first tick.
 * A missing file is a first boot (null); anything else throws and the caller logs it.
 */
function defaultReadSnapshot(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * V10. Null — before ANY log, timer, fetch or file read — when
 * `WORKER_ALERT_WEBHOOK_URL` is unset (AC 1). A bad knob throws from
 * loadGrowthTriggerConfig (AC 7); the boot site decides to refuse.
 *
 * Otherwise seeds the dedupe states from the existing snapshot (a restart does not
 * re-fire), arms an unref'd interval and fires one immediate tick. A tick:
 *   1. reads the run window and a /proc sample (bounded by a deadline < interval);
 *   2. evaluates every trigger (unreadable → `unknown`, logged; state unchanged);
 *   3. for each fire/clear transition POSTs the webhook and commits the transition only
 *      when delivered (V2: a failed POST retries next tick);
 *   4. ALWAYS writes the snapshot atomically with mode 0640 (AC 5, V9).
 * Ticks never overlap and a tick never throws.
 */
export function armGrowthTriggers(
  env: NodeJS.ProcessEnv,
  deps: GrowthTriggerDeps,
): GrowthTriggersHandle | null {
  const config = loadGrowthTriggerConfig(env);
  if (config === null) return null;

  const engine = deps.resolveEngine();
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readText: ReadText =
    deps.readText ?? ((p: string) => readFile(p, "utf8"));
  const writeSnapshot: WriteSnapshot =
    deps.writeSnapshot ??
    ((dir, snap, file, mode) => writeSnapshotAtomic(dir, snap, file, mode));
  const readSnapshot = deps.readSnapshot ?? defaultReadSnapshot;
  const schedule =
    deps.setInterval ??
    ((fn: () => void, ms: number): unknown => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
  const unschedule =
    deps.clearInterval ??
    ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const log = deps.log ?? ((line: string) => console.log(line));

  const intervalMs = config.intervalS * 1000;
  const sustainMs = config.sustainS * 1000;
  const postTimeoutMs = Math.min(
    GROWTH_WEBHOOK_TIMEOUT_CAP_MS,
    Math.floor(intervalMs / 2),
  );
  const tickBudgetMs = Math.floor(intervalMs * GROWTH_TICK_BUDGET_FRACTION);
  const snapshotPath = path.join(deps.snapshotDir, GROWTH_SNAPSHOT_FILENAME);

  // Seed (restart must not re-fire). Unreadable → initial states: worst case one
  // duplicate alert, never a suppressed one.
  let states: Record<GrowthTriggerId, TriggerDedupeState>;
  try {
    const text = readSnapshot(snapshotPath);
    states = dedupeStatesFromSnapshot(text === null ? null : JSON.parse(text));
  } catch (err) {
    logLine(log, "growth.snapshot_seed_failed", { error: errorName(err) });
    states = dedupeStatesFromSnapshot(null);
  }

  let memSamples: MemSample[] = [];
  let inFlight = false;
  let skipLogged = false;

  const runTick = async (): Promise<GrowthSnapshot> => {
    const startMs = now();
    const deadlineMs = startMs + tickBudgetMs;

    const [runs, mem] = await Promise.all([
      readRunWindow({
        apiUrl: engine.apiUrl,
        tenantId: engine.tenantId,
        token: engine.token,
        sinceMs: growthWindow(startMs).startMs,
        deadlineMs,
        fetchImpl,
        now,
      }),
      readMemSample(readText, startMs),
    ]);

    const nowMs = now();
    if (mem.kind === "sample") {
      memSamples = pruneMemSamples(
        [...memSamples, mem.sample],
        nowMs,
        sustainMs,
      );
    }
    const runSignals = evaluateRunSignals({
      runs,
      nowMs,
      questionnaire: config.questionnaire,
    });
    const ramSwap = evaluateRamSwap({
      samples: memSamples,
      nowMs,
      ramFraction: config.ramFraction,
      sustainMs,
      ...(mem.kind === "unreadable" ? { unreadableReason: mem.reason } : {}),
    });
    const evaluations: TriggerEvaluation[] = [
      runSignals.queueWait,
      ramSwap,
      runSignals.clientShare,
      runSignals.scaleComposite,
      runSignals.supersedeWaste,
    ];

    for (const evaluation of evaluations) {
      const id = evaluation.trigger;
      if (evaluation.verdict === "unknown") {
        logLine(log, "growth.trigger_unknown", {
          trigger: id,
          reason: evaluation.reason ?? "unknown",
        });
      }
      const current = states[id];
      const transition = decideTransition(current, evaluation.verdict, nowMs);
      if (transition.action === "none") {
        states[id] = commitTransition(current, transition, true);
        continue;
      }
      const state = transition.action === "fire" ? "fired" : "cleared";
      const body = buildWebhookBody({
        evaluation,
        boxId: deps.boxId,
        nowMs,
        state,
      });
      const remainingMs = deadlineMs - now();
      const result: WebhookResult =
        remainingMs <= 0
          ? { delivered: false, reason: "tick deadline exceeded" }
          : await postWebhook(
              config.webhookUrl,
              body,
              Math.min(postTimeoutMs, remainingMs),
              fetchImpl,
            );
      states[id] = commitTransition(current, transition, result.delivered);
      if (result.delivered) {
        logLine(
          log,
          state === "fired" ? "growth.trigger_fired" : "growth.trigger_cleared",
          {
            trigger: id,
            value: evaluation.value,
            threshold: evaluation.threshold,
            boxId: deps.boxId,
            at: body.firedAt,
          },
        );
      } else {
        logLine(log, "growth.webhook_failed", {
          trigger: id,
          state,
          ...(result.status !== undefined ? { status: result.status } : {}),
          reason: result.reason,
        });
      }
    }

    const snapshot = buildSnapshot({
      nowMs,
      boxId: deps.boxId,
      evaluations,
      states,
      stats: runSignals.stats,
    });
    try {
      writeSnapshot(
        deps.snapshotDir,
        snapshot,
        GROWTH_SNAPSHOT_FILENAME,
        GROWTH_SNAPSHOT_MODE,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      logLine(log, "growth.snapshot_write_failed", {
        error: typeof code === "string" ? code : errorName(err),
      });
    }
    return snapshot;
  };

  const tick = async (): Promise<GrowthTickResult> => {
    if (inFlight) {
      if (!skipLogged) {
        skipLogged = true;
        logLine(log, "growth.tick_skipped", {
          reason: "previous tick still in flight",
        });
      }
      return { skipped: true, snapshot: null };
    }
    inFlight = true;
    skipLogged = false;
    try {
      return { skipped: false, snapshot: await runTick() };
    } catch (err) {
      logLine(log, "growth.tick_error", {
        reason: "tick failed",
        error: errorName(err),
      });
      return { skipped: false, snapshot: null };
    } finally {
      inFlight = false;
    }
  };

  const handle = schedule(() => {
    void tick();
  }, intervalMs);
  logLine(log, "growth.armed", {
    boxId: deps.boxId,
    intervalS: config.intervalS,
    sustainS: config.sustainS,
    ramFraction: config.ramFraction,
    questionnaire: config.questionnaire,
  });
  const firstTick = tick();

  return { tick, firstTick, stop: () => unschedule(handle) };
}
