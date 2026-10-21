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
  announcedOrgIds,
  buildSnapshot,
  buildWebhookBody,
  classifyRunRow,
  commitTransition,
  decideTransition,
  dedupeStatesFromSnapshot,
  evaluateRamSwap,
  evaluateRunSignals,
  GROWTH_TRIGGER_IDS,
  growthWindow,
  parseMemTotalAvailable,
  parsePswpin,
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
import { errnoCode } from "./node-errors";
import {
  writeSnapshotAtomic,
  type SnapshotWriteOptions,
} from "./scheduling-maintenance";

/** Rows per page of the collection route. */
export const GROWTH_RUNS_PAGE_LIMIT = 200;
/** Hard cap on pages per read (~600 run rows / 7 days today; 50 pages = 10 000 rows). */
export const GROWTH_RUNS_MAX_PAGES = 50;
/**
 * Upper bound on ONE engine page request; the effective bound is min(this, the engine
 * read budget left). Without it, a single hung page on a long interval would hold the
 * read for up to half the interval (hours at the one-day ceiling).
 */
export const GROWTH_ENGINE_REQUEST_TIMEOUT_CAP_MS = 30_000;
/**
 * Upper bound on one webhook POST; the effective timeout is min(this, intervalMs / 2, time
 * left before the 0.95 × interval tick deadline) (V2).
 */
const GROWTH_WEBHOOK_TIMEOUT_CAP_MS = 10_000;
/** The snapshot file under `<runNamespaceRoot>`. */
export const GROWTH_SNAPSHOT_FILENAME = "growth-triggers.json";
/** Snapshot permissions (V9): owner rw, group r, other none. */
export const GROWTH_SNAPSHOT_MODE = 0o640;
/**
 * The engine read must finish within this fraction of the interval. Half, not the whole
 * tick budget: a hung engine must still leave the tick time to POST a /proc-backed fire
 * (ram_swap does not depend on the engine).
 */
const GROWTH_ENGINE_READ_BUDGET_FRACTION = 0.5;
/**
 * The engine run window is re-read at most this often. The run signals are 7-COMPLETE-day
 * figures that only move when a UTC day rolls over (V6), so re-paging up to 10 000 rows
 * every tick buys nothing between rolls. The read is refreshed when the tick's window
 * changed (a new UTC day) or when the last SUCCESSFUL read is at least this old; /proc is
 * still sampled every tick.
 */
export const GROWTH_ENGINE_REFRESH_MS = 3_600_000;
/** Every POST must finish within this fraction of the interval, so ticks cannot stack. */
const GROWTH_TICK_BUDGET_FRACTION = 0.95;

const PROC_MEMINFO = "/proc/meminfo";
const PROC_VMSTAT = "/proc/vmstat";
/** The fixed phrase for a read or POST that ran out of tick budget. */
const DEADLINE_EXCEEDED = "tick deadline exceeded";
/** N1: a run task the reader cannot place in time (e.g. no parseable `createdAt`). */
export const MALFORMED_RUN_ROW = "engine read: malformed run row";
/** N1: a non-empty page with no row in the engine's row shape. */
export const UNRECOGNIZED_PAGE = "engine read: no recognizable row on a page";
/** N6: the reason the run triggers read `unknown` on a box with tenant signals off. */
export const TENANT_SIGNALS_OFF = "tenant signals off on this box";
/** N2: the longest a timed-out POST's retry is backed off. */
export const GROWTH_WEBHOOK_BACKOFF_CAP_MS = 3_600_000;

/** The error's class name only (`TimeoutError`, `AbortError`, `TypeError`) — never its message. */
function errorName(err: unknown): string {
  return err instanceof Error && err.name ? err.name : "unknown error";
}

type Bounded<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Run `work` with an abort signal that fires after `ms`, and stop WAITING at `ms` even if
 * `work` ignores the signal (a peer that accepts the connection and never answers, or a
 * body that never ends). `AbortSignal.timeout` alone only helps when the fetch honours
 * it; the deadline is what keeps ticks from stacking. Rejections of `work` propagate.
 */
async function withDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<Bounded<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort(new DOMException("deadline exceeded", "TimeoutError"));
        resolve({ timedOut: true });
      },
      Math.max(1, ms),
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([
      (async (): Promise<Bounded<T>> => ({
        timedOut: false,
        value: await work(controller.signal),
      }))(),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Engine collection route
// ---------------------------------------------------------------------------

interface ReadRunWindowInput {
  apiUrl: string;
  tenantId: string;
  /** Never logged, never returned. */
  token: string;
  /** The reader's `since`, normally growthWindow(now).startMs. */
  sinceMs: number;
  /**
   * The reader's `until`, normally growthWindow(now).endMs (00:00 UTC today): the engine
   * honours it (verified on the box's engine 2026-10-20 with limit=1, where num_pages is a
   * row count: 620 → 604, newest row before `until`), so today's partial day is never
   * paged in only to be dropped.
   */
  untilMs: number;
  /** Absolute clock time after which no request may still be in flight. */
  deadlineMs: number;
  fetchImpl?: typeof fetch;
  /** Clock used against `deadlineMs`; defaults to Date.now. */
  now?: () => number;
}

interface RunsPage {
  rows: unknown[];
  /**
   * The engine's own paging verdict, when the body carries a `pagination` object with
   * numeric `current_page` and `num_pages`: true iff `current_page < num_pages`. Null when
   * pagination is absent, and only then does the reader fall back to the short-page stop.
   *
   * NOT `next_page`: measured on the box's engine (hatchet-lite, 2026-10-19) it is always
   * `current_page + 1`, the last page included (last page {current_page 4, next_page 5,
   * num_pages 4}; empty window {current_page 1, next_page 2, num_pages 0}) — trusting it
   * read every window as "more pages" and ended every read unreadable (roborev job 745).
   * apps/www's transport reader pages on `num_pages` for the same reason.
   */
  hasMore: boolean | null;
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
      ? (b.pagination as { current_page?: unknown; num_pages?: unknown })
      : {};
  const currentPage = finiteNumber(p.current_page);
  const numPages = finiteNumber(p.num_pages);
  return {
    rows: b.rows,
    hasMore:
      currentPage === null || numPages === null ? null : currentPage < numPages,
  };
}

function buildRunWindowUrl(input: {
  apiUrl: string;
  tenantId: string;
  sinceMs: number;
  untilMs: number;
  offset: number;
}): string {
  const base = input.apiUrl.replace(/\/+$/, "");
  const since = encodeURIComponent(new Date(input.sinceMs).toISOString());
  const until = encodeURIComponent(new Date(input.untilMs).toISOString());
  return (
    `${base}/api/v1/stable/tenants/${encodeURIComponent(input.tenantId)}/workflow-runs` +
    `?since=${since}&until=${until}&limit=${GROWTH_RUNS_PAGE_LIMIT}&offset=${input.offset}&only_tasks=true`
  );
}

type PageFetch =
  | { kind: "page"; page: RunsPage }
  | { kind: "unreadable"; reason: string };

async function fetchRunsPage(
  url: string,
  token: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<PageFetch> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
  } catch (err) {
    return {
      kind: "unreadable",
      reason: `engine read: request failed (${errorName(err)})`,
    };
  }
  if (!res.ok) {
    await discardBody(res);
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
  return { kind: "page", page: parsed };
}

/**
 * Offset-paginated read of every run task created in [`sinceMs`, `untilMs`) (V7). When the body
 * carries `pagination` with numeric `current_page` and `num_pages`, the engine decides:
 * the read goes on while `current_page < num_pages`, whatever the page size — an engine
 * that caps `limit` below GROWTH_RUNS_PAGE_LIMIT returns short pages that are NOT the
 * end. Only without pagination does a short page end the read. A page with no rows ends
 * the read (an empty window, or a collection that shrank between pages). More than
 * GROWTH_RUNS_MAX_PAGES pages → `unreadable` "page cap": a partial window would silently
 * understate every run signal.
 *
 * Each request (headers AND body) is bounded by min(GROWTH_ENGINE_REQUEST_TIMEOUT_CAP_MS,
 * time left until `deadlineMs`), whether or not the engine honours the abort, so neither
 * one hung page nor a hung engine can push the tick past its interval.
 *
 * Rows are deduped by engine id across pages: offset paging over a collection that
 * grows while it is read can shift a row onto the next page, and counting it twice
 * would inflate every time sum. Rows with no id are kept as they are.
 *
 * A MALFORMED READ IS UNKNOWN, NEVER UNDER. A run task (`actionId` ends `:run`) that
 * cannot be placed in time, or a non-empty page none of whose rows has the engine's row
 * shape, makes the whole read `unreadable` with a fixed reason: silently dropping those
 * rows would hand the evaluator a window with less run time than the box had (or none),
 * which reads as `under` and would clear a firing trigger. Recognisable non-run rows
 * (`:on-failure-task`, …) are still skipped silently, as is a stray unrecognisable row on
 * a page that also carries recognisable ones.
 */
export async function readRunWindow(
  input: ReadRunWindowInput,
): Promise<RunsReading> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const rowsById = new Map<string, RunRow>();
  const anonymousRows: RunRow[] = [];
  let offset = 0;

  for (let page = 0; page < GROWTH_RUNS_MAX_PAGES; page++) {
    const remainingMs = input.deadlineMs - now();
    if (remainingMs <= 0) {
      return {
        kind: "unreadable",
        reason: `engine read: ${DEADLINE_EXCEEDED}`,
      };
    }
    const url = buildRunWindowUrl({
      apiUrl: input.apiUrl,
      tenantId: input.tenantId,
      sinceMs: input.sinceMs,
      untilMs: input.untilMs,
      offset,
    });

    const capped = remainingMs > GROWTH_ENGINE_REQUEST_TIMEOUT_CAP_MS;
    const bounded = await withDeadline(
      capped ? GROWTH_ENGINE_REQUEST_TIMEOUT_CAP_MS : remainingMs,
      (signal) => fetchRunsPage(url, input.token, signal, fetchImpl),
    );
    if (bounded.timedOut) {
      return {
        kind: "unreadable",
        reason: capped
          ? `engine read: request timed out after ${GROWTH_ENGINE_REQUEST_TIMEOUT_CAP_MS} ms`
          : `engine read: ${DEADLINE_EXCEEDED}`,
      };
    }
    if (bounded.value.kind === "unreadable") return bounded.value;
    const parsed = bounded.value.page;

    let recognized = 0;
    for (const raw of parsed.rows) {
      const c = classifyRunRow(raw);
      if (c.kind === "unrecognized") continue;
      recognized += 1;
      if (c.kind === "malformed_run") {
        return { kind: "unreadable", reason: MALFORMED_RUN_ROW };
      }
      if (c.kind === "skip") continue;
      if (c.row.id === null) anonymousRows.push(c.row);
      else rowsById.set(c.row.id, c.row);
    }
    if (parsed.rows.length > 0 && recognized === 0) {
      return { kind: "unreadable", reason: UNRECOGNIZED_PAGE };
    }

    const more =
      parsed.rows.length > 0 &&
      (parsed.hasMore ?? parsed.rows.length >= GROWTH_RUNS_PAGE_LIMIT);
    if (!more) {
      return { kind: "rows", rows: [...rowsById.values(), ...anonymousRows] };
    }
    offset += parsed.rows.length;
  }
  return { kind: "unreadable", reason: "engine read: page cap" };
}

// ---------------------------------------------------------------------------
// /proc
// ---------------------------------------------------------------------------

type MemReading =
  | { kind: "sample"; sample: MemSample }
  | { kind: "unreadable"; reason: string };

type ReadText = (filePath: string) => Promise<string>;

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

/**
 * Cancel a response body this module will not read. Under undici an unread body keeps
 * its connection out of the pool until garbage collection — a slow leak on a long-lived
 * worker whose sink or engine keeps answering errors. Never throws.
 */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already consumed or errored: nothing left to release.
  }
}

type WebhookResult =
  | { delivered: true; status: number }
  | { delivered: false; status?: number; reason: string };

/**
 * One JSON POST. Any 2xx is delivered; non-2xx, network error and timeout are not.
 * The URL is a secret: it never appears in the returned reason (fixed phrases only).
 *
 * Redirects are NOT followed (`redirect: "manual"`): following one would re-send the
 * alert body to a host the operator never configured. A 3xx — or the opaque-redirect
 * response a manual-mode fetch may return instead — is "redirect not followed", not
 * delivered, and retried next tick like any other failure.
 */
export async function postWebhook(
  url: string,
  body: GrowthWebhookBody,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookResult> {
  let res: Response;
  try {
    const bounded = await withDeadline(timeoutMs, (signal) =>
      fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal,
      }),
    );
    if (bounded.timedOut) return { delivered: false, reason: "timeout" };
    res = bounded.value;
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
  // The sink's reply is never read; release it so the connection returns to the pool.
  await discardBody(res);
  if (
    res.type === "opaqueredirect" ||
    (res.status >= 300 && res.status < 400)
  ) {
    return {
      delivered: false,
      ...(res.status > 0 ? { status: res.status } : {}),
      reason: "redirect not followed",
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

interface GrowthEngineTarget {
  apiUrl: string;
  tenantId: string;
  /** Never logged. */
  token: string;
}

export type WriteSnapshot = (
  dir: string,
  snapshot: GrowthSnapshot,
  options: Required<Pick<SnapshotWriteOptions, "filename" | "mode">> &
    Pick<SnapshotWriteOptions, "log">,
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
  /**
   * How old the last successful engine read may get before a tick re-reads it. Defaults
   * to GROWTH_ENGINE_REFRESH_MS; a test that changes the engine between ticks passes 0.
   */
  engineRefreshMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (line: string) => void;
}

interface GrowthTickResult {
  /** True when another tick was still in flight and this one did nothing. */
  skipped: boolean;
  /** The snapshot written (or attempted) this tick; null when skipped or the tick failed. */
  snapshot: GrowthSnapshot | null;
}

interface GrowthTriggersHandle {
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
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
}

/**
 * V10. Null — before ANY log, timer, fetch or file read — when
 * `WORKER_ALERT_WEBHOOK_URL` is unset (AC 1). A bad knob throws from
 * loadGrowthTriggerConfig (AC 7); the boot site decides to refuse.
 *
 * `deps.resolveEngine` failing throws a FIXED-phrase Error naming only the cause's class:
 * the boot site prints what arm throws, and a resolver's message could carry a URL.
 *
 * `WORKER_GROWTH_TRIGGER_TENANT_SIGNALS=off` (N6): the engine is neither resolved nor
 * read; the four run-based triggers read `unknown` (TENANT_SIGNALS_OFF) every tick — no
 * fire, no clear — and ram_swap and the snapshot are unaffected.
 *
 * Otherwise seeds the dedupe states from the existing snapshot (a restart does not
 * re-fire), arms an unref'd interval and fires one immediate tick. A tick:
 *   1. reads the run window (bounded by half the interval) when it is due — the tick's
 *      window is not the cached one (a new UTC day), or the last successful read is
 *      GROWTH_ENGINE_REFRESH_MS old; otherwise it re-evaluates the cached rows. An
 *      unreadable read leaves the cache (and its age) as it was, so the next tick
 *      retries, and evaluates `unknown`. A /proc sample is read every tick;
 *   2. evaluates every trigger (unreadable → `unknown`, logged once per streak; state
 *      unchanged);
 *   3. for each fire/clear transition POSTs the webhook and commits the transition only
 *      when delivered (V2: a failed POST retries next tick — after a TIMED-OUT POST the
 *      retry backs off 1, 2, 4, … ticks, capped at 1 h, see postBackoff; `growth.webhook_failed` is
 *      logged once per (trigger, state, reason) streak — a tick with no transition for that
 *      trigger ends the streak — `growth.webhook_recovered` on the next delivery); each POST is bounded by min(10 s, interval / 2, time left before
 *      0.95 × interval); a delivered transition is persisted to the snapshot at once, so
 *      a crash later in the tick cannot re-send it after restart;
 *   4. ALWAYS writes the snapshot atomically with mode 0640 (AC 5, V9).
 * Ticks never overlap and a tick never throws.
 */
export function armGrowthTriggers(
  env: NodeJS.ProcessEnv,
  deps: GrowthTriggerDeps,
): GrowthTriggersHandle | null {
  const config = loadGrowthTriggerConfig(env);
  if (config === null) return null;

  // Tenant signals off (N6): the engine is never read, so it is not resolved either.
  let engine: GrowthEngineTarget | null = null;
  try {
    if (config.tenantSignals) engine = deps.resolveEngine();
  } catch (err) {
    // Not the cause's message, and no `cause`: console.error prints both, and a resolver
    // error can carry the engine URL or a credential-bearing value.
    throw new Error(
      `growth triggers: cannot resolve the engine target (${errorName(err)})`,
    );
  }
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readText: ReadText =
    deps.readText ?? ((p: string) => readFile(p, "utf8"));
  const writeSnapshot: WriteSnapshot =
    deps.writeSnapshot ?? writeSnapshotAtomic;
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
  const engineRefreshMs = deps.engineRefreshMs ?? GROWTH_ENGINE_REFRESH_MS;

  const intervalMs = config.intervalS * 1000;
  const sustainMs = config.sustainS * 1000;
  const postTimeoutMs = Math.min(
    GROWTH_WEBHOOK_TIMEOUT_CAP_MS,
    Math.floor(intervalMs / 2),
  );
  const engineReadBudgetMs = Math.floor(
    intervalMs * GROWTH_ENGINE_READ_BUDGET_FRACTION,
  );
  const tickBudgetMs = Math.floor(intervalMs * GROWTH_TICK_BUDGET_FRACTION);
  const snapshotPath = path.join(deps.snapshotDir, GROWTH_SNAPSHOT_FILENAME);

  // Seed (restart must not re-fire). Unreadable → initial states: worst case one
  // duplicate alert, never a suppressed one. A lastFiredAt after the arm-time clock is
  // dropped by the seed (a fire from the future cannot hold anything).
  let states: Record<GrowthTriggerId, TriggerDedupeState>;
  try {
    const seedMs = now();
    const text = readSnapshot(snapshotPath);
    states = dedupeStatesFromSnapshot(
      text === null ? null : JSON.parse(text),
      seedMs,
    );
  } catch (err) {
    logLine(log, "growth.snapshot_seed_failed", { error: errorName(err) });
    // `null` seeds every trigger initial whatever the time, so no clock read is needed.
    states = dedupeStatesFromSnapshot(null, 0);
  }

  let memSamples: MemSample[] = [];
  // The last SUCCESSFUL engine read: the window it covered and when it was taken.
  let engineCache: {
    windowStartMs: number;
    readAtMs: number;
    runs: RunsReading;
  } | null = null;
  let inFlight = false;
  let skipLogged = false;
  // One `growth.trigger_unknown` per contiguous (trigger, reason) streak and one
  // `growth.trigger_known` when it reads again — not a line per trigger per tick for
  // as long as the engine is down (the engine-liveness `unreadableLogged` pattern).
  const unknownReasonLogged = new Map<GrowthTriggerId, string>();
  // One `growth.webhook_failed` per contiguous (trigger, state, reason) streak, and one
  // `growth.webhook_recovered` on the first delivery after it: a sink that is down for a
  // day must not write a line per trigger per tick.
  const webhookFailureLogged = new Map<GrowthTriggerId, string>();
  // One `growth.snapshot_write_failed` per contiguous streak of the same error (errno
  // code, else error name), and one `growth.snapshot_write_recovered` on the first write
  // after it: a read-only snapshot dir must not write a line per persist per tick.
  let snapshotFailureLogged: string | null = null;
  // N2: a sink that accepts the connection and answers only after the timeout (or never)
  // would otherwise be re-sent the same alert every tick. After the k-th CONSECUTIVE
  // timed-out POST of a (trigger, state) transition, the next attempt waits 2^(k−1) ticks
  // (attempts 1, 2, 4, … ticks apart), capped at GROWTH_WEBHOOK_BACKOFF_CAP_MS. The
  // transition itself is never dropped: it stays uncommitted and is retried when due.
  // Cleared on delivery, on a non-timeout outcome, and when the transition no longer
  // applies (no transition, or the other state).
  const backoffCapTicks = Math.max(
    1,
    Math.floor(GROWTH_WEBHOOK_BACKOFF_CAP_MS / intervalMs),
  );
  const postBackoff = new Map<
    GrowthTriggerId,
    { state: "fired" | "cleared"; timeouts: number; ticksToSkip: number }
  >();

  const runTick = async (): Promise<GrowthSnapshot> => {
    const startMs = now();
    // The engine read gets half the interval; POSTs may run until 0.95 of it.
    const engineDeadlineMs = startMs + engineReadBudgetMs;
    const deadlineMs = startMs + tickBudgetMs;

    // ONE window per tick, from the tick start: the read and the evaluation must agree
    // even when the tick crosses 00:00 UTC.
    const window = growthWindow(startMs);
    const cached = engineCache;
    const engineDue =
      cached === null ||
      cached.windowStartMs !== window.startMs ||
      // A clock that stepped back is not "fresh": re-read.
      startMs < cached.readAtMs ||
      startMs - cached.readAtMs >= engineRefreshMs;
    const readRuns = async (): Promise<RunsReading> => {
      if (engine === null) {
        return { kind: "unreadable", reason: TENANT_SIGNALS_OFF };
      }
      if (!engineDue && cached !== null) return cached.runs;
      const reading = await readRunWindow({
        apiUrl: engine.apiUrl,
        tenantId: engine.tenantId,
        token: engine.token,
        sinceMs: window.startMs,
        untilMs: window.endMs,
        deadlineMs: engineDeadlineMs,
        fetchImpl,
        now,
      });
      if (reading.kind === "rows") {
        engineCache = {
          windowStartMs: window.startMs,
          readAtMs: startMs,
          runs: reading,
        };
      }
      return reading;
    };
    const [runs, mem] = await Promise.all([
      readRuns(),
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
      window,
      questionnaire: config.questionnaire,
    });
    const ramSwap = evaluateRamSwap({
      samples: memSamples,
      nowMs,
      ramFraction: config.ramFraction,
      sustainMs,
      ...(mem.kind === "unreadable" ? { unreadableReason: mem.reason } : {}),
    });
    const evaluations: Record<GrowthTriggerId, TriggerEvaluation> = {
      queue_wait_p90: runSignals.queueWait,
      ram_swap: ramSwap,
      client_share: runSignals.clientShare,
      scale_composite: runSignals.scaleComposite,
      supersede_waste: runSignals.supersedeWaste,
    };

    // The snapshot of THIS tick's evaluations and the states committed so far. Written
    // after every delivered transition as well as at the end, so a process that dies
    // mid-tick after a POST (a crash loop, an OOM kill) restarts holding that delivery
    // instead of re-sending it.
    const persist = (): GrowthSnapshot => {
      const snapshot = buildSnapshot({
        nowMs,
        boxId: deps.boxId,
        evaluations,
        states,
        stats: runSignals.stats,
      });
      try {
        writeSnapshot(deps.snapshotDir, snapshot, {
          filename: GROWTH_SNAPSHOT_FILENAME,
          mode: GROWTH_SNAPSHOT_MODE,
          // The writer's temp-file cleanup line goes to this driver's log.
          log: ({ event, ...fields }) =>
            logLine(log, String(event ?? "snapshot.log"), fields),
        });
        if (snapshotFailureLogged !== null) {
          logLine(log, "growth.snapshot_write_recovered", {
            after: snapshotFailureLogged,
          });
          snapshotFailureLogged = null;
        }
      } catch (err) {
        const error = errnoCode(err) ?? errorName(err);
        if (snapshotFailureLogged !== error) {
          snapshotFailureLogged = error;
          logLine(log, "growth.snapshot_write_failed", { error });
        }
      }
      return snapshot;
    };

    for (const id of GROWTH_TRIGGER_IDS) {
      const evaluation = evaluations[id];
      if (evaluation.verdict === "unknown") {
        const reason = evaluation.reason ?? "unknown";
        if (unknownReasonLogged.get(id) !== reason) {
          unknownReasonLogged.set(id, reason);
          logLine(log, "growth.trigger_unknown", { trigger: id, reason });
        }
      } else if (unknownReasonLogged.has(id)) {
        unknownReasonLogged.delete(id);
        logLine(log, "growth.trigger_known", { trigger: id });
      }
      const current = states[id];
      // client_share's hold is per top org: a different dominant client is its own split.
      const topOrgId =
        id === "client_share" ? runSignals.stats?.topClient?.orgId : undefined;
      const transition = decideTransition(
        current,
        evaluation.verdict,
        nowMs,
        topOrgId === undefined ? {} : { topOrgId },
      );
      if (transition.action === "none") {
        // No transition ends this trigger's failure streak: a later outage with the same
        // reason is a new incident and is logged again.
        webhookFailureLogged.delete(id);
        postBackoff.delete(id);
        continue;
      }
      const state = transition.action === "fire" ? "fired" : "cleared";
      const backoff = postBackoff.get(id);
      if (backoff !== undefined && backoff.state !== state) {
        postBackoff.delete(id);
      } else if (backoff !== undefined && backoff.ticksToSkip > 0) {
        // Backed off after timeouts: not attempted, not committed, retried when due.
        postBackoff.set(id, {
          ...backoff,
          ticksToSkip: backoff.ticksToSkip - 1,
        });
        continue;
      }
      const body = buildWebhookBody({
        evaluation,
        boxId: deps.boxId,
        nowMs,
        state,
        ...(id === "client_share" && state === "cleared"
          ? { announcedOrgIds: announcedOrgIds(current, nowMs) }
          : {}),
      });
      const remainingMs = deadlineMs - now();
      const result: WebhookResult =
        remainingMs <= 0
          ? { delivered: false, reason: DEADLINE_EXCEEDED }
          : await postWebhook(
              config.webhookUrl,
              body,
              Math.min(postTimeoutMs, remainingMs),
              fetchImpl,
            );
      states[id] = commitTransition(current, transition, result.delivered);
      if (!result.delivered && result.reason === "timeout") {
        const timeouts = (postBackoff.get(id)?.timeouts ?? 0) + 1;
        postBackoff.set(id, {
          state,
          timeouts,
          ticksToSkip: Math.min(2 ** (timeouts - 1), backoffCapTicks) - 1,
        });
      } else if (result.delivered || result.reason !== DEADLINE_EXCEEDED) {
        // Delivered, or failed some other way: the timeout streak is over. A tick that
        // ran out of budget before POSTing says nothing about the sink and keeps it.
        postBackoff.delete(id);
      }
      if (result.delivered) {
        persist();
        if (webhookFailureLogged.has(id)) {
          webhookFailureLogged.delete(id);
          logLine(log, "growth.webhook_recovered", { trigger: id, state });
        }
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
        const streak = `${state}|${result.reason}`;
        if (webhookFailureLogged.get(id) !== streak) {
          webhookFailureLogged.set(id, streak);
          logLine(log, "growth.webhook_failed", {
            trigger: id,
            state,
            ...(result.status !== undefined ? { status: result.status } : {}),
            reason: result.reason,
          });
        }
      }
    }

    return persist();
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
    tenantSignals: config.tenantSignals,
  });
  const firstTick = tick();

  return { tick, firstTick, stop: () => unschedule(handle) };
}
