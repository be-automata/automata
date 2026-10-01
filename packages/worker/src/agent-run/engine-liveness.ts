/**
 * #215: in-process engine-liveness watchdog.
 *
 * WHY THIS SIGNAL AND NOT A CHEAPER ONE. On 2026-09-29 the worker wedged alive for 41
 * minutes: the SDK's gRPC connection to the engine broke, it never reconnected, never
 * threw, and the process stayed up, so systemd's Restart=always never fired. During that
 * whole window THREE obvious signals were GREEN and all three lied:
 *   - the TCP socket to 127.0.0.1:7077 stayed ESTABLISHED on a dead connection;
 *   - `systemctl is-active automata-worker` said `active`;
 *   - the engine's /api/ready returned 200, while every engine reconciliation loop failed.
 * A fourth tempting signal, grepping the journal, is just as dead: the SDK emitted no
 * heartbeat-failure line, no reconnect line, NOTHING, between 19:19:05 and the operator's
 * SIGTERM at 20:00:30.
 *
 * DO NOT "simplify" this watchdog into any of those. The only honest signal is the
 * ABSENCE of a successful engine interaction read from the ENGINE's own view of this
 * worker: the `Worker` row's `lastHeartbeatAt`, which went 40m47s stale while everything
 * above looked healthy.
 *
 * FAILS TO UNKNOWN, NEVER TO WEDGED. An unreadable probe — network error, non-2xx, a body
 * that does not match the declared envelope, no row for this worker — is "unreadable" for
 * as long as it lasts and never exits. Only a genuinely stale-but-READABLE heartbeat does.
 */

import { applyNamespace } from "@hatchet-dev/typescript-sdk/util/apply-namespace";

/**
 * Upper bound on the probe's abort budget, milliseconds. The effective timeout is
 * `Math.min(LIVENESS_PROBE_TIMEOUT_CAP_MS, Math.floor(livenessPollS * 1000 / 2))`, so it
 * is always at most half a tick period (§17: a hung request must not stack ticks) and
 * never more than 10s even at a long poll period.
 */
export const LIVENESS_PROBE_TIMEOUT_CAP_MS = 10_000;

export type LivenessReading =
  | { kind: "reading"; lastHeartbeatAtMs: number }
  | { kind: "unreadable"; reason: string };

export type LivenessVerdict =
  | { kind: "healthy"; stalenessMs: number }
  | { kind: "unreadable"; reason: string }
  | { kind: "wedged"; stalenessMs: number };

export interface EngineLivenessProbeConfig {
  apiUrl: string;
  tenantId: string;
  token: string;
  /** The NAMESPACED name the engine knows this worker by. See resolveProbeWorkerName. */
  probeWorkerName: string;
  /**
   * Abort budget for the one GET, milliseconds. Passed in rather than guessed, because
   * §17 requires it to sit well below the watchdog's tick period and the probe cannot
   * see that period. The wiring site derives it as
   * `Math.min(LIVENESS_PROBE_TIMEOUT_CAP_MS, Math.floor(livenessPollS * 1000 / 2))`.
   */
  timeoutMs: number;
}

export interface EngineLivenessWatchdogOptions {
  staleAfterMs: number;
  pollIntervalMs: number;
  /**
   * The NAMESPACED name, for the FATAL line only. The driver never probes on its own —
   * the name lives inside the injected `probe` closure — but formatWedgedLine names the
   * worker, so the driver must be told it explicitly.
   */
  probeWorkerName: string;
  probe: () => Promise<LivenessReading>;
  /** Injected clock. Tests pass a fake; production passes () => Date.now(). */
  now: () => number;
  /** Injected exit. Tests capture; production logs + process.exit(1). */
  onWedged: (message: string) => void;
  log?: (message: string) => void;
}

export interface EngineLivenessWatchdogHandle {
  /** One evaluation. Exported for tests: no real timers anywhere in the suite. */
  tick: () => Promise<LivenessVerdict>;
  /**
   * The immediate best-effort tick the driver fires at arm time. Production ignores it;
   * a test awaits it so its assertions are not racing a floating promise that reads the
   * injected clock at whatever value the test has since moved it to.
   */
  firstTick: Promise<LivenessVerdict>;
  stop: () => void;
}

/**
 * The engine knows this worker by `applyNamespace(options.name, client.config.namespace)`
 * (`v1/client/worker/worker-internal.js:91`), so a probe that matched the RAW
 * `automata-worker-${boxId}` would find no row the moment a namespace is configured,
 * read "unreadable" forever, and never exit — a box that LOOKS guarded while running
 * unguarded. `HATCHET_CLIENT_NAMESPACE` is unset everywhere on `main` today, so the two
 * names are identical on the live box; that is a fact about today's config, not an
 * invariant, which is exactly why this goes through the same transform. The namespace
 * must come from `hatchet.config.namespace` (the SDK normalises it to a trailing `_` at
 * `config-loader.js:82-85`), never from the raw env var, and never from
 * `worker._internal.name`.
 */
export function resolveProbeWorkerName(
  rawName: string,
  namespace: string | undefined,
): string {
  return applyNamespace(rawName, namespace);
}

/**
 * Defensive boundary guard for the engine's worker-collection body.
 * `@hatchet-dev/typescript-sdk/clients/rest/generated/data-contracts.d.ts:2112` declares
 * `export interface WorkerList { pagination?: PaginationResponse; rows?: Worker[] }`, and
 * `Worker.lastHeartbeatAt?: string` is OPTIONAL (`:2070-2074`) — so nothing below may be
 * assumed present. Accepts an object whose `rows`, when present, is an array; every field
 * is re-checked per row by the caller. Anything else → the caller reports "unreadable".
 */
export function isWorkerList(
  value: unknown,
): value is { rows?: Array<{ name?: unknown; lastHeartbeatAt?: unknown }> } {
  if (typeof value !== "object" || value === null) return false;
  const rows = (value as { rows?: unknown }).rows;
  if (rows === undefined) return true;
  return Array.isArray(rows);
}

/**
 * One GET against the engine's tenant worker COLLECTION route
 * (`GET /api/v1/tenants/{tenant}/worker`, `clients/rest/generated/Api.js:1271`) — the
 * by-id worker route returns 403 for API tokens on this engine.
 *
 * Every failure path — network throw, non-2xx, non-JSON body, shape mismatch, no row for
 * this worker, an absent or unparseable `lastHeartbeatAt` — returns `unreadable` with a
 * short reason. NEVER logs or embeds the token, the Authorization header, or the body
 * (§14): the reason is a fixed phrase plus at most a status code or an Error.message.
 */
export async function probeEngineLiveness(
  cfg: EngineLivenessProbeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<LivenessReading> {
  const url = `${cfg.apiUrl.replace(/\/+$/, "")}/api/v1/tenants/${cfg.tenantId}/worker`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    return {
      kind: "unreadable",
      reason: `request failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  if (!res.ok) {
    return { kind: "unreadable", reason: `http ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "unreadable", reason: "body is not JSON" };
  }

  if (!isWorkerList(body)) {
    return { kind: "unreadable", reason: "body does not match WorkerList" };
  }

  // A relaunched worker registers under the same name and the engine can briefly hold the
  // dead registration's row too (§11), so take the GREATEST parseable heartbeat among the
  // matching rows — an old row must never manufacture a false wedge.
  let newest: number | null = null;
  for (const row of body.rows ?? []) {
    if (typeof row !== "object" || row === null) continue;
    if (row.name !== cfg.probeWorkerName) continue;
    if (typeof row.lastHeartbeatAt !== "string") continue;
    const parsed = Date.parse(row.lastHeartbeatAt);
    if (Number.isNaN(parsed)) continue;
    if (newest === null || parsed > newest) newest = parsed;
  }

  if (newest === null) {
    return {
      kind: "unreadable",
      reason: "no row with a parseable lastHeartbeatAt for this worker",
    };
  }
  return { kind: "reading", lastHeartbeatAtMs: newest };
}

/**
 * Pure. `unreadable` passes through untouched (D-6: unknown is never wedged). A negative
 * staleness (engine clock ahead of the box) clamps to 0 and is therefore always healthy.
 */
export function evaluateLiveness(
  reading: LivenessReading,
  nowMs: number,
  staleAfterMs: number,
): LivenessVerdict {
  if (reading.kind === "unreadable") {
    return { kind: "unreadable", reason: reading.reason };
  }
  const stalenessMs = Math.max(0, nowMs - reading.lastHeartbeatAtMs);
  return stalenessMs > staleAfterMs
    ? { kind: "wedged", stalenessMs }
    : { kind: "healthy", stalenessMs };
}

/**
 * The single loud line (§15). Exported so the test asserts the operator-visible string
 * rather than a paraphrase (D-12).
 */
export function formatWedgedLine(
  stalenessMs: number,
  staleAfterMs: number,
  probeWorkerName: string,
): string {
  const observedS = Math.round(stalenessMs / 1000);
  const thresholdS = staleAfterMs / 1000;
  return (
    `[worker-liveness] FATAL: no successful engine interaction for ${observedS}s ` +
    `(threshold ${thresholdS}s) — worker "${probeWorkerName}" is wedged alive; ` +
    `exiting non-zero so the supervisor restarts it`
  );
}

/**
 * The driver. Master-gated like the #69 maintenance loop: `staleAfterMs <= 0` returns a
 * no-op handle — no timer, no probe. Otherwise an unref'd interval plus one immediate
 * best-effort tick. `tick()` never throws; a rejected `probe()` becomes `unreadable`.
 */
export function startEngineLivenessWatchdog(
  opts: EngineLivenessWatchdogOptions,
): EngineLivenessWatchdogHandle {
  if (opts.staleAfterMs <= 0) {
    const off: LivenessVerdict = { kind: "unreadable", reason: "off" };
    return {
      tick: async () => off,
      firstTick: Promise.resolve(off),
      stop: () => {},
    };
  }

  /**
   * BOOT GRACE — the one input under which a HEALTHY worker would otherwise exit, and it
   * is reachable on exactly the restart this watchdog itself causes.
   *
   * The engine Worker row is NOT created by `hatchet.worker(name, …)` (that only
   * registers workflows over REST); it is created inside `worker.start()`, when
   * `createListener()` does the gRPC Register and the SDK finally learns its `workerId`
   * (`v1/client/worker/worker-internal.js:764-765`). The watchdog is armed before that
   * call, so for the first moments of every boot the ONLY row the engine holds under this
   * worker's name is the DEAD PREDECESSOR's — and after a wedge that predecessor's
   * `lastHeartbeatAt` is, by construction, staler than the threshold. The "take the
   * greatest heartbeat" rule in probeEngineLiveness cannot help here: before registration
   * there is no fresher row to beat it. Unguarded, the immediate first tick would read
   * 41-minute-old heartbeat, declare the brand-new process wedged and exit it — then
   * systemd restarts, and the whole thing repeats every RestartSec until the engine
   * expires the row. A restart loop on a healthy box is worse than the bug this guards.
   *
   * So: for the first `staleAfterMs` of this process's life a `wedged` verdict is not
   * evidence about THIS process — it cannot be, since a process younger than the
   * threshold cannot have been silent for longer than the threshold — and is reported as
   * UNKNOWN, like every other thing the watchdog cannot honestly read. The inertness is
   * bounded by exactly one threshold window, after which a still-stale row does mean this
   * worker is not heartbeating and does exit.
   */
  const armedAtMs = opts.now();

  // `fired` makes onWedged at-most-once per process: a synchronous onWedged in a test
  // cannot be re-entered, and a real process.exit in flight is not raced.
  let fired = false;
  // One line per CONTIGUOUS unreadable streak, not one per tick (§15).
  let unreadableLogged = false;

  const tick = async (): Promise<LivenessVerdict> => {
    let reading: LivenessReading;
    try {
      reading = await opts.probe();
    } catch (err) {
      reading = {
        kind: "unreadable",
        reason: `probe threw: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }

    const nowMs = opts.now();
    const evaluated = evaluateLiveness(reading, nowMs, opts.staleAfterMs);
    const verdict: LivenessVerdict =
      evaluated.kind === "wedged" && nowMs - armedAtMs < opts.staleAfterMs
        ? {
            kind: "unreadable",
            reason:
              "stale heartbeat older than this process — a dead predecessor's row, " +
              "not yet guarded",
          }
        : evaluated;

    if (verdict.kind === "unreadable") {
      if (!unreadableLogged) {
        unreadableLogged = true;
        opts.log?.(
          `probe unreadable (${verdict.reason}) — treating as UNKNOWN, not wedged`,
        );
      }
      return verdict;
    }
    unreadableLogged = false;

    if (verdict.kind === "wedged" && !fired) {
      fired = true;
      opts.onWedged(
        formatWedgedLine(
          verdict.stalenessMs,
          opts.staleAfterMs,
          opts.probeWorkerName,
        ),
      );
    }
    return verdict;
  };

  const timer = setInterval(() => {
    void tick();
  }, opts.pollIntervalMs);
  timer.unref?.();
  const firstTick = tick();

  return { tick, firstTick, stop: () => clearInterval(timer) };
}
