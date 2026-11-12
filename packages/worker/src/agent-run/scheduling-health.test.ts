import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ENGINE_DB_POOL_OPTIONS, type PgLike } from "./engine-db";
import {
  alertableRecoveryLatencySeconds,
  detectSchedulingTimeoutEvents,
  detectStepConcurrencyRot,
  detectStuckQueued,
  detectWorkflowConcurrencyRot,
  findReclaimableSlots,
  nominalRecoveryLatencySeconds,
  reclaimEngineSlots,
  detectConcurrencyRot,
} from "./scheduling-health";
import { loadWorkerConfig, resolveMechanismMode } from "./config";
import {
  bootTimeSlotReclaim,
  runMaintenanceTick,
  startMaintenanceLoop,
} from "./scheduling-maintenance";

const TENANT_ID = "707d0855-80ab-4e1f-a156-f1c4546cbf52";
/** ADR-013 P3: the config every box must carry (image + per-run ceiling). */
const REQ = {
  WORKER_BATTERIES_IMAGE: `ghcr.io/be-automata/automata-batteries@sha256:${"ab".repeat(32)}`,
  WORKER_RUN_MEMORY_MAX: "1500M",
};

/** Records every statement/params pair and answers from a keyed lookup table matched against the SQL text. */
class FakePg implements PgLike {
  calls: { text: string; params?: unknown[] }[] = [];
  constructor(
    private readonly responder: (
      text: string,
      params: unknown[] | undefined,
    ) => { rows: Record<string, unknown>[] },
  ) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Row[] }> {
    this.calls.push({ text, params });
    return this.responder(text, params) as { rows: Row[] };
  }
}

/** An `EngineDb` whose advisory lock is always acquired and runs `fn` on `inner`. */
function makeEngineDb(inner: PgLike) {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    withConnection: vi.fn(),
    withAdvisoryLock: vi.fn(async (fn: (c: PgLike) => Promise<unknown>) => ({
      acquired: true as const,
      result: await fn(inner),
    })),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("scheduling-health.ts (#69) — pure detectors/remediators", () => {
  describe("healthy fixture (AC-1)", () => {
    const emptyDb = new FakePg(() => ({ rows: [] }));

    it("every rot detector returns nothing on an empty engine", async () => {
      const stepFindings = await detectStepConcurrencyRot(emptyDb, {
        tenantId: TENANT_ID,
      });
      const workflowFindings = await detectWorkflowConcurrencyRot(emptyDb, {
        tenantId: TENANT_ID,
      });
      expect(stepFindings).toEqual([]);
      expect(workflowFindings).toEqual([]);
    });

    it("slot reclamation finds nothing on an empty engine", async () => {
      const result = await reclaimEngineSlots(emptyDb, {
        tenantId: TENANT_ID,
        deadAfterSeconds: 600,
        minSlotAgeSeconds: 600,
        selfWorkerId: null,
        mode: "on",
      });
      expect(result).toEqual({ touched: 0, rows: [] });
    });
  });

  describe("link resolution follows the engine's schema (#570)", () => {
    // hatchet v1-core.sql @ v0.94.10: a step row's parent_strategy_id is a
    // v1_workflow_concurrency id (:233, :289-290, joined at :869), and a
    // workflow row's child_strategy_ids are v1_step_concurrency ids
    // (:314-319). The #69 detectors joined each column to its own table.
    const captureSql = async () => {
      const db = new FakePg(() => ({ rows: [] }));
      await detectStepConcurrencyRot(db, { tenantId: TENANT_ID });
      await detectWorkflowConcurrencyRot(db, { tenantId: TENANT_ID });
      const [step, workflow] = db.calls.map((c) => c.text);
      return { step: step ?? "", workflow: workflow ?? "" };
    };

    it("the step detector resolves parent_strategy_id in v1_workflow_concurrency, on the engine's three key columns", async () => {
      const { step } = await captureSql();
      expect(step).toMatch(
        /NOT EXISTS \(\s*SELECT 1 FROM v1_workflow_concurrency w\s+WHERE w\.workflow_id\s+= c\.workflow_id\s+AND w\.workflow_version_id = c\.workflow_version_id\s+AND w\.id\s+= c\.parent_strategy_id\)/,
      );
      expect(step).not.toMatch(/JOIN v1_step_concurrency p/);
      expect(step).not.toMatch(/step_id <>/);
    });

    it("the workflow detector resolves child_strategy_ids in v1_step_concurrency, same version, pointing back at the parent", async () => {
      const { workflow } = await captureSql();
      expect(workflow).toMatch(
        /SELECT 1 FROM v1_step_concurrency s\s+WHERE s\.workflow_id\s+= c\.workflow_id\s+AND s\.workflow_version_id = c\.workflow_version_id\s+AND s\.id\s+= x\.child_id\s+AND s\.parent_strategy_id\s+= c\.id/,
      );
      expect(workflow).not.toMatch(/JOIN v1_workflow_concurrency k/);
    });

    it("maps flagged rows to the public shape", async () => {
      const db = new FakePg((text) =>
        /FROM v1_step_concurrency c/.test(text)
          ? {
              rows: [
                {
                  id: 2,
                  step_id: "s2",
                  expression: "'all'",
                  parent_strategy_id: 9,
                },
              ],
            }
          : {
              rows: [
                {
                  id: 1,
                  workflow_version_id: "v1",
                  expression: "'all'",
                  child_strategy_ids: null,
                },
              ],
            },
      );
      const found = await detectConcurrencyRot(db, { tenantId: TENANT_ID });
      expect(found.stepFindings).toEqual([
        { id: 2, stepId: "s2", expression: "'all'", parentStrategyId: 9 },
      ]);
      expect(found.workflowFindings).toEqual([
        {
          id: 1,
          workflowVersionId: "v1",
          expression: "'all'",
          childStrategyIds: [],
        },
      ]);
    });
  });

  describe("dry-run mode (AC-7)", () => {
    it("rot detection never writes to the concurrency tables (#570)", async () => {
      const db = new FakePg(() => ({ rows: [] }));
      await detectConcurrencyRot(db, { tenantId: TENANT_ID });
      expect(db.calls).toHaveLength(2);
      for (const call of db.calls) {
        expect(call.text).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
      }
    });

    it("dry-run slot reclamation issues zero DELETE statements", async () => {
      const db = new FakePg(() => ({
        rows: [
          {
            task_id: "t1",
            task_inserted_at: "2026-08-23T00:00:00Z",
            task_retry_count: 0,
            strategy_id: 6,
            key: "hog",
            workflow_run_id: "wr1",
            orphan: false,
          },
        ],
      }));
      const result = await reclaimEngineSlots(db, {
        tenantId: TENANT_ID,
        deadAfterSeconds: 600,
        minSlotAgeSeconds: 600,
        selfWorkerId: null,
        mode: "dry-run",
      });
      expect(result.touched).toBe(0);
      expect(result.rows).toHaveLength(1);
      const mutating = db.calls.filter((c) =>
        /^\s*(UPDATE|DELETE)/i.test(c.text),
      );
      expect(mutating).toHaveLength(0);
    });
  });

  describe("boundedness (AC-9)", () => {
    it("every detection statement carries a LIMIT", async () => {
      const db = new FakePg(() => ({ rows: [] }));
      await detectStepConcurrencyRot(db, { tenantId: TENANT_ID });
      await detectWorkflowConcurrencyRot(db, { tenantId: TENANT_ID });
      await findReclaimableSlots(db, {
        tenantId: TENANT_ID,
        deadAfterSeconds: 600,
        minSlotAgeSeconds: 600,
        selfWorkerId: null,
      });
      await detectStuckQueued(db, {
        tenantId: TENANT_ID,
        thresholdSeconds: 900,
      });
      for (const call of db.calls) {
        expect(call.text).toMatch(/\bLIMIT\b/);
      }
    });
  });

  describe("self-exclusion / tenant-scope / NULL-heartbeat wiring (AC-8)", () => {
    it("the generated candidate SQL carries the self-exclusion, tenant-scope and non-null-heartbeat clauses", async () => {
      const db = new FakePg(() => ({ rows: [] }));
      await findReclaimableSlots(db, {
        tenantId: TENANT_ID,
        deadAfterSeconds: 600,
        minSlotAgeSeconds: 600,
        selfWorkerId: "self-worker-1",
      });
      const call = db.calls[0];
      expect(call?.text).toMatch(/"tenantId"\s*=\s*\$1/);
      expect(call?.text).toMatch(/"lastHeartbeatAt"\s+IS\s+NOT\s+NULL/);
      expect(call?.text).toMatch(/id\s*<>\s*\$3/);
      expect(call?.params).toEqual([TENANT_ID, 600, "self-worker-1", 100, 600]);
    });
  });

  describe("no schedule_timeout_at gate (§3.2.2 correction)", () => {
    it("no generated reclamation statement references schedule_timeout_at", async () => {
      const db = new FakePg(() => ({ rows: [] }));
      await findReclaimableSlots(db, {
        tenantId: TENANT_ID,
        deadAfterSeconds: 2,
        minSlotAgeSeconds: 0,
        selfWorkerId: null,
      });
      await reclaimEngineSlots(db, {
        tenantId: TENANT_ID,
        deadAfterSeconds: 2,
        minSlotAgeSeconds: 0,
        selfWorkerId: null,
        mode: "on",
      });
      for (const call of db.calls) {
        expect(call.text).not.toMatch(/schedule_timeout_at/);
      }
    });
  });

  describe("latency bounds (AC-5b)", () => {
    it("nominal = deadAfter + interval; alertable = deadAfter + 2*interval, from the actual production defaults", () => {
      const cfg = loadWorkerConfig(REQ);
      expect(
        nominalRecoveryLatencySeconds(cfg.workerDeadAfterS, cfg.maintIntervalS),
      ).toBe(660); // 600 + 60 = 11 min
      expect(
        alertableRecoveryLatencySeconds(
          cfg.workerDeadAfterS,
          cfg.maintIntervalS,
        ),
      ).toBe(720); // 600 + 120 = 12 min
    });
  });

  describe("threshold arithmetic", () => {
    it("default stuckQueuedS (900) is exactly half of the 30m scheduleTimeout at workflow.ts:236", () => {
      const cfg = loadWorkerConfig(REQ);
      const scheduleTimeoutS = 30 * 60;
      expect(cfg.stuckQueuedS).toBe(scheduleTimeoutS / 2);
    });
  });

  describe("stuck-QUEUED and scheduling-timed-out signals", () => {
    it("detectStuckQueued forwards the threshold and shapes rows", async () => {
      const db = new FakePg(() => ({
        rows: [
          {
            external_id: "ext-1",
            workflow_run_id: "wr-1",
            workflow_id: "wf-1",
            inserted_at: "2026-08-23T00:00:00Z",
            schedule_timeout: "30m",
            queued_for_s: 42,
          },
        ],
      }));
      const rows = await detectStuckQueued(db, {
        tenantId: TENANT_ID,
        thresholdSeconds: 5,
      });
      expect(rows).toEqual([
        {
          externalId: "ext-1",
          workflowRunId: "wr-1",
          workflowId: "wf-1",
          insertedAt: "2026-08-23T00:00:00Z",
          scheduleTimeout: "30m",
          queuedForS: 42,
        },
      ]);
      expect(db.calls[0]?.params).toEqual([TENANT_ID, 5, 100]);
    });

    it("detectSchedulingTimeoutEvents maps event_type counts, defaulting missing types to 0", async () => {
      const db = new FakePg(() => ({
        rows: [{ event_type: "SCHEDULING_TIMED_OUT", count: "3" }],
      }));
      const counts = await detectSchedulingTimeoutEvents(db, {
        tenantId: TENANT_ID,
        windowSeconds: 3600,
      });
      expect(counts).toEqual({ schedulingTimedOut: 3, requeuedNoWorker: 0 });
    });
  });

  describe("dead-generation partition guard (AC-8d)", () => {
    it("the candidate SQL excludes a dead-but-still-progressing task via the no-progress NOT EXISTS", async () => {
      const db = new FakePg(() => ({ rows: [] }));
      await findReclaimableSlots(db, {
        tenantId: TENANT_ID,
        deadAfterSeconds: 600,
        minSlotAgeSeconds: 600,
        selfWorkerId: null,
      });
      const call = db.calls[0];
      expect(call?.text).toMatch(/v1_task_events_olap/);
      expect(call?.text).toMatch(/NOT EXISTS/);
    });
  });
});

describe("runMaintenanceTick — resilience and gating", () => {
  const baseConfig = loadWorkerConfig({
    ...REQ,
    HATCHET_ENGINE_DATABASE_URL: "postgresql://fake",
    HATCHET_ENGINE_TENANT_ID: TENANT_ID,
  });

  it("master gate: with engineDatabaseUrl unset, no engine db is touched", async () => {
    const unconfigured = loadWorkerConfig(REQ);
    const log = vi.fn();
    const snapshot = await runMaintenanceTick({
      config: unconfigured,
      selfWorkerId: null,
      log,
      engineDb: undefined,
    });
    expect(snapshot.engineReachable).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("a PgLike that throws resolves (never rejects) and reports engineReachable: false (AC-14)", async () => {
    const throwingDb = {
      query: vi.fn().mockRejectedValue(new Error("connection refused")),
      withConnection: vi
        .fn()
        .mockRejectedValue(new Error("connection refused")),
      withAdvisoryLock: vi
        .fn()
        .mockRejectedValue(new Error("connection refused")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const log = vi.fn();
    const snapshot = await runMaintenanceTick({
      config: baseConfig,
      selfWorkerId: null,
      log,
      engineDb: throwingDb as never,
    });
    expect(snapshot.engineReachable).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduling.tick_error" }),
    );
  });

  it("advisory lock not acquired → zero subsequent statements, tick_skipped_locked logged (AC-10)", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const lockedDb = {
      query,
      withConnection: vi.fn(),
      withAdvisoryLock: vi.fn().mockResolvedValue({ acquired: false }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const log = vi.fn();
    await runMaintenanceTick({
      config: baseConfig,
      selfWorkerId: null,
      log,
      engineDb: lockedDb as never,
    });
    expect(query).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduling.tick_skipped_locked" }),
    );
  });
});

describe("concurrency rot is detection only (#570)", () => {
  const rotRow = {
    id: 2,
    step_id: "s2",
    expression: "'all'",
    parent_strategy_id: 9,
  };

  async function tickWith(env: Record<string, string>) {
    const root = mkdtempSync(path.join(tmpdir(), "rot-570-"));
    try {
      const config = loadWorkerConfig({
        ...REQ,
        HATCHET_ENGINE_DATABASE_URL: "postgresql://fake",
        HATCHET_ENGINE_TENANT_ID: TENANT_ID,
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_SLOT_RECLAIM: "off",
        ...env,
      });
      const inner = new FakePg((text) =>
        /FROM v1_step_concurrency c/.test(text)
          ? { rows: [rotRow] }
          : { rows: [] },
      );
      const db = makeEngineDb(inner);
      const log = vi.fn();
      const snapshot = await runMaintenanceTick({
        config,
        selfWorkerId: null,
        log,
        engineDb: db as never,
      });
      return { snapshot, log, inner };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("WORKER_CONCURRENCY_ROT_REPAIR=on detects, reports dry-run, repairs nothing and writes nothing", async () => {
    const { snapshot, log, inner } = await tickWith({
      WORKER_CONCURRENCY_ROT_REPAIR: "on",
    });
    expect(snapshot.rot).toEqual({
      stepLevel: 1,
      workflowLevel: 0,
      repaired: 0,
      mode: "dry-run",
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "scheduling.rot_detected",
        stepIds: [2],
        mode: "dry-run",
      }),
    );
    expect(
      inner.calls.filter((c) => /\b(UPDATE|DELETE|INSERT)\b/i.test(c.text)),
    ).toHaveLength(0);
  });

  it("WORKER_SCHEDULING_MAINTENANCE=on (inherited) is detection only too", async () => {
    const { snapshot } = await tickWith({
      WORKER_SCHEDULING_MAINTENANCE: "on",
    });
    expect(snapshot.rot.mode).toBe("dry-run");
    expect(snapshot.rot.repaired).toBe(0);
  });

  it("WORKER_CONCURRENCY_ROT_REPAIR=off issues no rot query", async () => {
    const { snapshot, inner } = await tickWith({
      WORKER_CONCURRENCY_ROT_REPAIR: "off",
    });
    expect(snapshot.rot.mode).toBe("off");
    expect(
      inner.calls.filter((c) => /_concurrency c\b/.test(c.text)),
    ).toHaveLength(0);
  });

  it("startMaintenanceLoop says once, at boot, that a resolved 'on' no longer repairs", () => {
    const base = {
      ...REQ,
      HATCHET_ENGINE_DATABASE_URL: "postgresql://127.0.0.1:1/none",
      HATCHET_ENGINE_TENANT_ID: TENANT_ID,
    };
    const removed = (log: ReturnType<typeof vi.fn>) =>
      log.mock.calls.filter(
        ([line]) =>
          (line as { event?: string }).event ===
          "scheduling.rot_repair_removed",
      );

    const onLog = vi.fn();
    startMaintenanceLoop(
      loadWorkerConfig({ ...base, WORKER_CONCURRENCY_ROT_REPAIR: "on" }),
      null,
      onLog,
    ).stop();
    expect(removed(onLog)).toHaveLength(1);

    const dryLog = vi.fn();
    startMaintenanceLoop(loadWorkerConfig(base), null, dryLog).stop();
    expect(removed(dryLog)).toHaveLength(0);
  });

  // Generated by /ship coverage audit (#570).
  // Value: protects=the boot notice follows the RESOLVED rot mode (inherit, explicit off, master gate);
  // fails_when=the check reads concurrencyRotRepairMode directly, ignores an explicit off, or moves above the master gate;
  // why_new=the test above covers only explicit 'on' and the default; seam=none;
  // no_claim=no engine is reached (unroutable URL; the tick's own failure is not asserted)
  it.each([
    {
      name: "inherited WORKER_SCHEDULING_MAINTENANCE=on",
      env: { WORKER_SCHEDULING_MAINTENANCE: "on" },
      url: "postgresql://127.0.0.1:1/none",
      notices: 1,
    },
    {
      name: "explicit off overriding a global 'on'",
      env: {
        WORKER_SCHEDULING_MAINTENANCE: "on",
        WORKER_CONCURRENCY_ROT_REPAIR: "off",
      },
      url: "postgresql://127.0.0.1:1/none",
      notices: 0,
    },
    {
      name: "'on' behind the master gate (no engine URL)",
      env: { WORKER_CONCURRENCY_ROT_REPAIR: "on" },
      url: undefined,
      notices: 0,
    },
  ])("boot notice for $name: $notices", ({ env, url, notices }) => {
    const log = vi.fn();
    startMaintenanceLoop(
      loadWorkerConfig({
        ...REQ,
        ...(url ? { HATCHET_ENGINE_DATABASE_URL: url } : {}),
        HATCHET_ENGINE_TENANT_ID: TENANT_ID,
        WORKER_SLOT_RECLAIM: "off",
        ...env,
      }),
      null,
      log,
    ).stop();
    expect(
      log.mock.calls.filter(
        ([line]) =>
          (line as { event?: string }).event ===
          "scheduling.rot_repair_removed",
      ),
    ).toHaveLength(notices);
  });
});

describe("the reclaim queries project evicted_at unconditionally", () => {
  /**
   * #69 guard. A compatibility shim once resolved this predicate at runtime
   * from information_schema and dropped it when the probe said the column was
   * absent. That is not a compatible fallback — it is a DIFFERENT query:
   * without `AND r.evicted_at IS NULL` the LEFT JOIN matches evicted runtime
   * rows, so `orphan` computes false for a slot whose task was evicted and the
   * slot is never reclaimed. That is precisely the leak #69 exists to close,
   * arrived at silently and cached for the life of the process.
   *
   * The shim also made this suite test the wrong thing: it pinned the probe to
   * false in a global beforeEach, so every fixture below saw the no-predicate
   * variant and the shape that actually runs in production had zero unit
   * coverage. The integration suite now guarantees the column exists before
   * the queries run (hatchet-it-harness.ts, schemaIsReady), so the predicate
   * is unconditional again — and these assertions keep it that way.
   */
  const captureSql = async (mode: "on" | "dry-run") => {
    const db = new FakePg(() => ({ rows: [] }));
    await reclaimEngineSlots(db, {
      tenantId: TENANT_ID,
      deadAfterSeconds: 600,
      minSlotAgeSeconds: 600,
      selfWorkerId: null,
      mode,
    });
    return db.calls.map((c) => c.text);
  };

  it("the write path (mode 'on') filters evicted runtime rows out of the join", async () => {
    const sql = await captureSql("on");
    const del = sql.find((t) => /DELETE FROM v1_concurrency_slot/.test(t));
    expect(del).toBeDefined();
    expect(del).toMatch(
      /LEFT JOIN v1_task_runtime r[\s\S]*AND r\.evicted_at IS NULL/,
    );
  });

  it("the read path (mode 'dry-run') filters them out identically", async () => {
    const sql = await captureSql("dry-run");
    const sel = sql.find((t) => /FROM v1_concurrency_slot s/.test(t));
    expect(sel).toBeDefined();
    expect(sel).toMatch(
      /LEFT JOIN v1_task_runtime r[\s\S]*AND r\.evicted_at IS NULL/,
    );
  });

  it("no statement probes information_schema for the column — the predicate is not conditional", async () => {
    for (const mode of ["on", "dry-run"] as const) {
      for (const text of await captureSql(mode)) {
        expect(text).not.toMatch(/information_schema\.columns/);
      }
    }
  });
});

describe("reclaimEngineSlots — orphan labeling on the write path", () => {
  it("mode 'on' maps each returned row's orphan flag from the DELETE's RETURNING, not a hardcoded value", async () => {
    const db = new FakePg((text) => {
      if (/DELETE FROM v1_concurrency_slot/.test(text)) {
        return {
          rows: [
            {
              task_id: "t1",
              task_inserted_at: "2026-08-23T00:00:00Z",
              task_retry_count: 0,
              strategy_id: 1,
              key: "k",
              workflow_run_id: "wr1",
              orphan: true,
            },
            {
              task_id: "t2",
              task_inserted_at: "2026-08-23T00:00:00Z",
              task_retry_count: 0,
              strategy_id: 1,
              key: "k",
              workflow_run_id: "wr2",
              orphan: false,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const result = await reclaimEngineSlots(db, {
      tenantId: TENANT_ID,
      deadAfterSeconds: 600,
      minSlotAgeSeconds: 600,
      selfWorkerId: null,
      mode: "on",
    });
    const deleteCall = db.calls.find((c) =>
      /DELETE FROM v1_concurrency_slot/.test(c.text),
    );
    expect(deleteCall?.text).toMatch(/RETURNING[\s\S]*c\.orphan/);
    expect(result.touched).toBe(2);
    expect(result.rows.map((r) => r.orphan)).toEqual([true, false]);
  });
});

describe("bootTimeSlotReclaim — boot-path hygiene and gating", () => {
  const config = loadWorkerConfig({
    ...REQ,
    HATCHET_ENGINE_DATABASE_URL: "postgresql://fake",
    HATCHET_ENGINE_TENANT_ID: TENANT_ID,
    WORKER_SLOT_RECLAIM: "on",
  });

  it("master gate: with engineDatabaseUrl unset, the db is never touched", async () => {
    const db = makeEngineDb(new FakePg(() => ({ rows: [] })));
    await bootTimeSlotReclaim(loadWorkerConfig(REQ), vi.fn(), db as never);
    expect(db.withAdvisoryLock).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("runs the reclaim through withAdvisoryLock (hygiene timeouts), never on the raw db, and closes the pool", async () => {
    const inner = new FakePg((text) =>
      /DELETE FROM v1_concurrency_slot/.test(text)
        ? {
            rows: [
              {
                task_id: "t1",
                task_inserted_at: "2026-08-23T00:00:00Z",
                task_retry_count: 0,
                strategy_id: 1,
                key: "k",
                workflow_run_id: "wr1",
                orphan: true,
              },
            ],
          }
        : { rows: [] },
    );
    const db = makeEngineDb(inner);
    const log = vi.fn();
    await bootTimeSlotReclaim(config, log, db as never);
    expect(db.withAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled(); // raw (hygiene-less) path unused
    expect(
      inner.calls.some((c) => /DELETE FROM v1_concurrency_slot/.test(c.text)),
    ).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "scheduling.boot_slots_reclaimed",
        rowsTouched: 1,
      }),
    );
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("advisory lock not acquired → clean skip, no raw queries, pool closed (AC-10)", async () => {
    const db = {
      query: vi.fn(),
      withConnection: vi.fn(),
      withAdvisoryLock: vi.fn().mockResolvedValue({ acquired: false }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const log = vi.fn();
    await bootTimeSlotReclaim(config, log, db as never);
    expect(db.query).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduling.tick_skipped_locked" }),
    );
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("a throwing engine db resolves (never rejects), logs tick_error, and still closes (AC-14)", async () => {
    const db = {
      query: vi.fn().mockRejectedValue(new Error("connection refused")),
      withConnection: vi.fn(),
      withAdvisoryLock: vi
        .fn()
        .mockRejectedValue(new Error("connection refused")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const log = vi.fn();
    await expect(
      bootTimeSlotReclaim(config, log, db as never),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduling.tick_error" }),
    );
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("slot reclaim 'off' → no engine queries at all", async () => {
    const offConfig = loadWorkerConfig({
      ...REQ,
      HATCHET_ENGINE_DATABASE_URL: "postgresql://fake",
      WORKER_SLOT_RECLAIM: "off",
    });
    const db = makeEngineDb(new FakePg(() => ({ rows: [] })));
    await bootTimeSlotReclaim(offConfig, vi.fn(), db as never);
    expect(db.withAdvisoryLock).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("startMaintenanceLoop — healthz listener resilience", () => {
  it("EADDRINUSE on the health port is logged, not an uncaught crash (AC-14)", async () => {
    // Occupy an ephemeral port first, then point the health listener at it.
    const blocker = createNetServer();
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => {
        const addr = blocker.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    const config = loadWorkerConfig({
      ...REQ,
      HATCHET_ENGINE_DATABASE_URL: "postgresql://fake",
      HATCHET_ENGINE_TENANT_ID: TENANT_ID,
      WORKER_HEALTH_PORT: String(port),
    });
    const log = vi.fn();
    const handle = startMaintenanceLoop(config, null, log);
    try {
      // The 'error' event is asynchronous — wait for the handler to log it.
      await vi.waitFor(() => {
        expect(log).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "scheduling.tick_error",
            error: expect.stringContaining("healthz listen failed"),
          }),
        );
      });
    } finally {
      handle.stop();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("engine-db pool options", () => {
  it("bounds pool.connect() so a black-holed engine host cannot hang the awaited boot path (AC-14)", () => {
    expect(ENGINE_DB_POOL_OPTIONS.connectionTimeoutMillis).toBe(5_000);
    expect(ENGINE_DB_POOL_OPTIONS.max).toBe(2);
  });
});

describe("resolveMechanismMode", () => {
  it("an explicit mode wins; 'inherit' defers to the global mode", () => {
    expect(resolveMechanismMode("on", "dry-run")).toBe("on");
    expect(resolveMechanismMode("off", "on")).toBe("off");
    expect(resolveMechanismMode("inherit", "dry-run")).toBe("dry-run");
    expect(resolveMechanismMode("inherit", "on")).toBe("on");
  });
});
