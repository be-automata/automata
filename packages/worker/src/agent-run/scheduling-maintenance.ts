import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createEngineDb, resolveTenantId, type EngineDb } from "./engine-db";
import { resolveMechanismMode, type WorkerConfig } from "./config";
import {
  alertableRecoveryLatencySeconds,
  detectSchedulingTimeoutEvents,
  detectStuckQueued,
  nominalRecoveryLatencySeconds,
  reclaimEngineSlots,
  repairConcurrencyRot,
  type MaintenanceMode,
} from "./scheduling-health";

/**
 * Orchestration layer for #69 (§3.4/§3.5): the maintenance tick, its periodic
 * loop, the snapshot writer, and the optional `/healthz` server. Unlike
 * `scheduling-health.ts` this module DOES read `process.env` (via
 * `WorkerConfig`), use timers, and touch fs — it is the impure shell around
 * the pure detectors/remediators.
 *
 * Every property in §3.4's failure-behaviour table is implemented here:
 * safe-on-healthy, safe-on-busy (via the mechanisms' own quiescence
 * preconditions), idempotent, bounded (LIMIT + statement_timeout, upstream in
 * engine-db.ts), safe-concurrently (advisory lock), never-fails-a-run
 * (try/catch end to end, modelled on the egress batcher's contract at
 * workflow.ts:163-169).
 */

export type Logger = (line: Record<string, unknown>) => void;

const defaultLogger: Logger = (line) => console.log(JSON.stringify(line));

export interface SchedulingHealthSnapshot {
  ts: string;
  engineReachable: boolean;
  stuckQueued: { count: number; oldestQueuedForS: number; externalIds: string[] };
  schedulingTimedOut1h: number;
  requeuedNoWorker1h: number;
  rot: { stepLevel: number; workflowLevel: number; repaired: number; mode: MaintenanceMode };
  slots: { filled: number; reclaimable: number; reclaimed: number; mode: MaintenanceMode };
  healthy: boolean;
}

function emptySnapshot(engineReachable: boolean): SchedulingHealthSnapshot {
  return {
    ts: new Date().toISOString(),
    engineReachable,
    stuckQueued: { count: 0, oldestQueuedForS: 0, externalIds: [] },
    schedulingTimedOut1h: 0,
    requeuedNoWorker1h: 0,
    rot: { stepLevel: 0, workflowLevel: 0, repaired: 0, mode: "off" },
    slots: { filled: 0, reclaimable: 0, reclaimed: 0, mode: "off" },
    healthy: engineReachable,
  };
}

/** Write-temp-then-rename so a reader never observes a partial snapshot file. */
export function writeSnapshotAtomic(
  runNamespaceRoot: string,
  snapshot: SchedulingHealthSnapshot,
): void {
  try {
    fs.mkdirSync(runNamespaceRoot, { recursive: true });
  } catch {
    // best-effort; the write below will surface the real error if this matters
  }
  const target = path.join(runNamespaceRoot, "scheduling-health.json");
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tmp, target);
}

export interface RunMaintenanceTickOpts {
  config: WorkerConfig;
  selfWorkerId: string | null;
  log?: Logger;
  /** Injectable for tests: overrides the engine-db factory. */
  engineDb?: EngineDb | null;
}

/**
 * Runs one maintenance tick: acquire the advisory lock (skip if already held
 * by a sibling launchd unit), run mechanisms 1–3 in order, write the snapshot,
 * emit structured logs. Never throws — a thrown error is caught, logged as
 * `scheduling.tick_error`, and the tick returns with `engineReachable: false`
 * (AC-14). Never blocks `worker.start()`.
 */
export async function runMaintenanceTick(
  opts: RunMaintenanceTickOpts,
): Promise<SchedulingHealthSnapshot> {
  const log = opts.log ?? defaultLogger;
  const { config } = opts;

  if (!config.engineDatabaseUrl) {
    // Master gate (AC-13): inert no-op, no connection attempted, no snapshot written.
    return emptySnapshot(false);
  }

  const db = opts.engineDb !== undefined ? opts.engineDb : createEngineDb(process.env);
  if (!db) {
    return emptySnapshot(false);
  }

  try {
    const tenantId = config.engineTenantId || (await resolveTenantId(db));

    const rotMode = resolveMechanismMode(
      config.concurrencyRotRepairMode,
      config.schedulingMaintenanceMode,
    );
    const slotMode = resolveMechanismMode(
      config.slotReclaimMode,
      config.schedulingMaintenanceMode,
    );

    const lockOutcome = await db.withAdvisoryLock(async (client) => {
      const rot =
        rotMode === "off"
          ? null
          : await repairConcurrencyRot(client, {
              tenantId,
              mode: rotMode,
              limit: config.maintBatch,
            });

      const slotCandidates =
        slotMode === "off"
          ? null
          : await reclaimEngineSlots(client, {
              tenantId,
              deadAfterSeconds: config.workerDeadAfterS,
              minSlotAgeSeconds: config.slotMinAgeS,
              selfWorkerId: opts.selfWorkerId,
              mode: slotMode,
              limit: config.maintBatch,
            });

      const stuckQueued =
        config.stuckQueuedDetect === "off"
          ? []
          : await detectStuckQueued(client, {
              tenantId,
              thresholdSeconds: config.stuckQueuedS,
              limit: config.maintBatch,
            });

      const schedulingEvents = await detectSchedulingTimeoutEvents(client, {
        tenantId,
        windowSeconds: 3600,
      });

      return { rot, slotCandidates, stuckQueued, schedulingEvents };
    });

    if (!lockOutcome.acquired) {
      log({ event: "scheduling.tick_skipped_locked" });
      return emptySnapshot(true);
    }

    const { rot, slotCandidates, stuckQueued, schedulingEvents } = lockOutcome.result;

    const stepFindingCount = rot?.stepFindings.length ?? 0;
    const workflowFindingCount = rot?.workflowFindings.length ?? 0;
    const rotRepaired = (rot?.stepRepair.touched ?? 0) + (rot?.workflowRepair.touched ?? 0);

    if (stepFindingCount > 0 || workflowFindingCount > 0) {
      log({
        event: "scheduling.rot_detected",
        stepIds: rot?.stepFindings.map((r) => r.id) ?? [],
        workflowIds: rot?.workflowFindings.map((r) => r.id) ?? [],
        mode: rotMode,
      });
    }
    if (rotRepaired > 0) {
      log({ event: "scheduling.rot_repaired", rowsTouched: rotRepaired });
    }

    const slotsReclaimable = slotCandidates?.rows.length ?? 0;
    const slotsReclaimed = slotCandidates?.touched ?? 0;
    if (slotsReclaimed > 0) {
      log({ event: "scheduling.slots_reclaimed", rowsTouched: slotsReclaimed });
    }

    if (stuckQueued.length > 0) {
      log({
        event: "scheduling.stuck_queued",
        count: stuckQueued.length,
        oldestQueuedForS: Math.max(...stuckQueued.map((r) => r.queuedForS)),
        externalIds: stuckQueued.map((r) => r.externalId),
      });
    }

    const healthy =
      stepFindingCount === 0 &&
      workflowFindingCount === 0 &&
      slotsReclaimable === 0 &&
      stuckQueued.length === 0;

    const snapshot: SchedulingHealthSnapshot = {
      ts: new Date().toISOString(),
      engineReachable: true,
      stuckQueued: {
        count: stuckQueued.length,
        oldestQueuedForS:
          stuckQueued.length > 0 ? Math.max(...stuckQueued.map((r) => r.queuedForS)) : 0,
        externalIds: stuckQueued.map((r) => r.externalId),
      },
      schedulingTimedOut1h: schedulingEvents.schedulingTimedOut,
      requeuedNoWorker1h: schedulingEvents.requeuedNoWorker,
      rot: {
        stepLevel: stepFindingCount,
        workflowLevel: workflowFindingCount,
        repaired: rotRepaired,
        mode: rotMode,
      },
      slots: {
        filled: 0,
        reclaimable: slotsReclaimable,
        reclaimed: slotsReclaimed,
        mode: slotMode,
      },
      healthy,
    };

    writeSnapshotAtomic(config.runNamespaceRoot, snapshot);
    return snapshot;
  } catch (err) {
    log({ event: "scheduling.tick_error", error: String(err) });
    return emptySnapshot(false);
  } finally {
    // Only close a db we created ourselves — a caller-injected fake/pool is theirs to manage.
    if (opts.engineDb === undefined && db) {
      try {
        await db.close();
      } catch {
        // best-effort
      }
    }
  }
}

export interface MaintenanceLoopHandle {
  stop(): void;
  healthServer: Server | null;
}

/**
 * Starts the periodic maintenance tick (`HATCHET_MAINT_INTERVAL_S`, §3.4) and,
 * if `config.healthPort` is set, an optional loopback `/healthz` (§3.3 item 3).
 * `setInterval(...).unref()` mirrors the egress batcher (`workflow.ts:183-185`)
 * — never holds the process open. Entirely `try/catch`-guarded so it can never
 * block or crash `worker.start()` (AC-14).
 */
export function startMaintenanceLoop(
  config: WorkerConfig,
  selfWorkerId: string | null,
  log: Logger = defaultLogger,
): MaintenanceLoopHandle {
  let latestSnapshot: SchedulingHealthSnapshot = emptySnapshot(false);

  if (!config.engineDatabaseUrl) {
    // Master gate (AC-13): no timer started, no listener opened.
    return { stop: () => {}, healthServer: null };
  }

  const tick = () => {
    runMaintenanceTick({ config, selfWorkerId, log })
      .then((snapshot) => {
        latestSnapshot = snapshot;
      })
      .catch((err) => {
        // runMaintenanceTick already swallows its own errors; this is
        // defense-in-depth so the loop itself can never throw.
        log({ event: "scheduling.tick_error", error: String(err) });
      });
  };

  const timer = setInterval(tick, config.maintIntervalS * 1000);
  timer.unref?.();
  // Fire once at boot too, best-effort, so the first snapshot doesn't wait a full interval.
  tick();

  let healthServer: Server | null = null;
  if (config.healthPort) {
    try {
      healthServer = createServer((req, res) => {
        if (req.url !== "/healthz") {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(latestSnapshot.healthy ? 200 : 503, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify(latestSnapshot));
      });
      healthServer.listen(config.healthPort, "127.0.0.1");
      healthServer.unref();
    } catch (err) {
      log({ event: "scheduling.tick_error", error: `healthz listen failed: ${String(err)}` });
      healthServer = null;
    }
  }

  return {
    stop: () => {
      clearInterval(timer);
      healthServer?.close();
    },
    healthServer,
  };
}

/**
 * Boot-time (secondary / belt-and-braces) slot reclaim (§3.2.4 item 2). Called
 * with `selfWorkerId: null` because at this instant the caller owns no worker
 * id yet — the query is trivially safe. Fires meaningfully only when the box
 * was down long enough for the prior generation to go stale (reboot, stopped
 * unit, `hatchet:down`); with launchd's ~15s `KeepAlive` relaunch it will
 * normally find nothing (§3.2.2b). Entirely `try/catch`-guarded: it must never
 * prevent boot (AC-14) — this is the literal "before `hatchet.worker(...)`"
 * hook the spec (§5 item 7) describes.
 *
 * Runs inside `withAdvisoryLock`, never on the raw pool: that is the only path
 * that applies the CONNECTION_HYGIENE_SQL timeouts (statement_timeout 5s /
 * lock_timeout 1s), so a lock-contended DELETE errors out fast instead of
 * hanging the awaited boot path — and a sibling launchd unit mid-tick makes
 * this a clean skip rather than a concurrent second reclaim.
 */
export async function bootTimeSlotReclaim(
  config: WorkerConfig,
  log: Logger = defaultLogger,
  /** Test seam: pass an EngineDb to skip pool construction. `null` = gate closed. */
  engineDb?: EngineDb | null,
): Promise<void> {
  if (!config.engineDatabaseUrl) {
    return; // master gate
  }
  const db = engineDb !== undefined ? engineDb : createEngineDb(process.env);
  if (!db) {
    return;
  }
  try {
    const slotMode = resolveMechanismMode(
      config.slotReclaimMode,
      config.schedulingMaintenanceMode,
    );
    if (slotMode === "off") {
      return;
    }
    const lockOutcome = await db.withAdvisoryLock(async (client) => {
      const tenantId = config.engineTenantId || (await resolveTenantId(client));
      return reclaimEngineSlots(client, {
        tenantId,
        deadAfterSeconds: config.workerDeadAfterS,
        minSlotAgeSeconds: config.slotMinAgeS,
        selfWorkerId: null,
        mode: slotMode,
        limit: config.maintBatch,
      });
    });
    if (!lockOutcome.acquired) {
      log({ event: "scheduling.tick_skipped_locked" });
      return;
    }
    if (lockOutcome.result.touched > 0) {
      log({ event: "scheduling.boot_slots_reclaimed", rowsTouched: lockOutcome.result.touched });
    }
  } catch (err) {
    log({ event: "scheduling.tick_error", error: `boot reclaim: ${String(err)}` });
  } finally {
    try {
      await db.close();
    } catch {
      // best-effort
    }
  }
}

export {
  alertableRecoveryLatencySeconds,
  nominalRecoveryLatencySeconds,
};
