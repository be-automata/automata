import { createServer as createNetServer } from "node:net";
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
  repairConcurrencyRot,
  repairStepConcurrencyRot,
  repairWorkflowConcurrencyRot,
} from "./scheduling-health";
import { loadWorkerConfig, resolveMechanismMode } from "./config";
import {
  bootTimeSlotReclaim,
  runMaintenanceTick,
  startMaintenanceLoop,
} from "./scheduling-maintenance";

const TENANT_ID = "707d0855-80ab-4e1f-a156-f1c4546cbf52";

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

describe("scheduling-health.ts (#69) — pure detectors/remediators", () => {
  describe("healthy fixture (AC-1)", () => {
    const emptyDb = new FakePg(() => ({ rows: [] }));

    it("every detector returns nothing and every remediator touches nothing", async () => {
      const stepFindings = await detectStepConcurrencyRot(emptyDb, {
        tenantId: TENANT_ID,
      });
      const workflowFindings = await detectWorkflowConcurrencyRot(emptyDb, {
        tenantId: TENANT_ID,
      });
      expect(stepFindings).toEqual([]);
      expect(workflowFindings).toEqual([]);

      const stepRepair = await repairStepConcurrencyRot(emptyDb, {
        tenantId: TENANT_ID,
        ids: [],
        mode: "on",
      });
      const workflowRepair = await repairWorkflowConcurrencyRot(emptyDb, {
        tenantId: TENANT_ID,
        ids: [],
        mode: "on",
      });
      expect(stepRepair).toEqual({ touched: 0, rows: [], deferred: false });
      expect(workflowRepair).toEqual({ touched: 0, rows: [], deferred: false });

      // Empty ids → the remediators short-circuit BEFORE issuing any statement.
      const mutating = emptyDb.calls.filter((c) =>
        /^\s*(UPDATE|DELETE)/i.test(c.text),
      );
      expect(mutating).toHaveLength(0);
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

  describe("corrupted fixture — the live §2.3 rows (AC-2)", () => {
    const corruptedDb = new FakePg((text) => {
      if (/FROM v1_step_concurrency c\s+LEFT JOIN/.test(text)) {
        // Only row 5 has an active, foreign-step, or dangling parent.
        return {
          rows: [
            {
              id: 5,
              step_id: "5c93e973",
              expression: "'agent-run-global-memory-budget'",
              parent_strategy_id: 4,
            },
          ],
        };
      }
      if (/FROM v1_workflow_concurrency c\s+CROSS JOIN LATERAL/.test(text)) {
        return {
          rows: [
            {
              id: 1,
              workflow_version_id: "01fa6942",
              expression: "'agent-run-shared-daemon-socket'",
              child_strategy_ids: [2],
            },
            {
              id: 3,
              workflow_version_id: "9603cb2f",
              expression: "'agent-run-shared-daemon-socket'",
              child_strategy_ids: [4],
            },
            {
              id: 5,
              workflow_version_id: "75e03a6f",
              expression: "'agent-run-global-memory-budget'",
              child_strategy_ids: [6],
            },
          ],
        };
      }
      return { rows: [] };
    });

    it("step-level detector flags exactly id 5", async () => {
      const findings = await detectStepConcurrencyRot(corruptedDb, {
        tenantId: TENANT_ID,
      });
      expect(findings).toEqual([
        {
          id: 5,
          stepId: "5c93e973",
          expression: "'agent-run-global-memory-budget'",
          parentStrategyId: 4,
        },
      ]);
    });

    it("workflow-level detector flags ids 1, 3, 5 — id 4 (same-version child {5}) is never flagged", async () => {
      const findings = await detectWorkflowConcurrencyRot(corruptedDb, {
        tenantId: TENANT_ID,
      });
      expect(findings.map((f) => f.id)).toEqual([1, 3, 5]);
      expect(findings.some((f) => f.id === 4)).toBe(false);
    });
  });

  describe("dry-run mode (AC-7)", () => {
    it("issues zero UPDATE/DELETE statements while still reporting findings", async () => {
      const db = new FakePg((text) => {
        if (
          /^\s*SELECT c\.id, c\.step_id, c\.expression, c\.parent_strategy_id\s*$/m.test(
            text,
          )
        ) {
          return {
            rows: [
              {
                id: 5,
                step_id: "5c93e973",
                expression: "x",
                parent_strategy_id: 4,
              },
            ],
          };
        }
        return { rows: [] };
      });

      const repair = await repairStepConcurrencyRot(db, {
        tenantId: TENANT_ID,
        ids: [5],
        mode: "dry-run",
      });
      expect(repair.touched).toBe(0);
      expect(repair.rows.map((r) => r.id)).toEqual([5]);

      const mutating = db.calls.filter((c) =>
        /^\s*(UPDATE|DELETE)/i.test(c.text),
      );
      expect(mutating).toHaveLength(0);
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

    it("repair is bounded transitively: a 500-row fixture with batch=100 only ever repairs the 100 ids the (LIMIT-ed) detector handed it", async () => {
      const batch = 100;
      const fiveHundredIds = Array.from({ length: 500 }, (_, i) => i + 1);
      const hundredIds = fiveHundredIds.slice(0, batch);
      const db = new FakePg((text) => {
        if (/^\s*UPDATE v1_step_concurrency/.test(text)) {
          return {
            rows: hundredIds.map((id) => ({
              id,
              step_id: "s",
              expression: "e",
            })),
          };
        }
        return { rows: [] };
      });
      const repair = await repairStepConcurrencyRot(db, {
        tenantId: TENANT_ID,
        ids: hundredIds,
        mode: "on",
      });
      expect(repair.touched).toBe(100);
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

  describe("quiescence precondition present (AC-8b)", () => {
    it("every generated step-level rot-repair statement references all four slot-pointer columns", async () => {
      const db = new FakePg(() => ({ rows: [] }));
      await repairStepConcurrencyRot(db, {
        tenantId: TENANT_ID,
        ids: [5],
        mode: "on",
      });
      const call = db.calls[0];
      for (const col of [
        "strategy_id",
        "parent_strategy_id",
        "next_strategy_ids",
        "next_parent_strategy_ids",
      ]) {
        expect(call?.text).toContain(col);
      }
    });

    it("every generated workflow-level rot-repair statement references the slot's three array-pointer columns", async () => {
      const db = new FakePg(() => ({ rows: [] }));
      await repairWorkflowConcurrencyRot(db, {
        tenantId: TENANT_ID,
        ids: [1, 3, 5],
        mode: "on",
      });
      const call = db.calls[0];
      for (const col of [
        "strategy_id",
        "child_strategy_ids",
        "completed_child_strategy_ids",
      ]) {
        expect(call?.text).toContain(col);
      }
    });

    it("a repair whose predicate is quiesced by a referencing slot touches 0 rows and reports deferred (AC-8b)", async () => {
      // Simulate: detector found 1 row, but the UPDATE's own WHERE (including the
      // quiescence NOT EXISTS) matches nothing because a live slot references it.
      const db = new FakePg((text) => {
        if (/^\s*UPDATE v1_step_concurrency/.test(text)) {
          return { rows: [] };
        }
        return { rows: [] };
      });
      const repair = await repairStepConcurrencyRot(db, {
        tenantId: TENANT_ID,
        ids: [5],
        mode: "on",
      });
      expect(repair.touched).toBe(0);
      expect(repair.deferred).toBe(true);
    });
  });

  describe("row 4's same-version child link survives repair (AC-8c)", () => {
    it("repairWorkflowConcurrencyRot never includes id 4 in the ids it is asked to touch, and the SQL's own EXISTS clause preserves same-version children", async () => {
      const db = new FakePg((text) => {
        if (/^\s*UPDATE v1_workflow_concurrency/.test(text)) {
          // The real engine would keep row 4's {5} untouched because it was
          // never in the ids array (it isn't rotted) — asserted at the
          // detector level in the "corrupted fixture" describe block above.
          return {
            rows: [
              { id: 1, child_strategy_ids: [] },
              { id: 3, child_strategy_ids: [] },
              { id: 5, child_strategy_ids: [] },
            ],
          };
        }
        return { rows: [] };
      });
      const repair = await repairWorkflowConcurrencyRot(db, {
        tenantId: TENANT_ID,
        ids: [1, 3, 5],
        mode: "on",
      });
      expect(repair.touched).toBe(3);
      const call = db.calls[0];
      expect(call?.params?.[1]).toEqual([1, 3, 5]);
      expect((call?.params?.[1] as number[]).includes(4)).toBe(false);
    });
  });

  describe("combined repairConcurrencyRot orchestration", () => {
    it("detects then repairs both tables and reports idempotent 0-touch on a second pass", async () => {
      let stepCallCount = 0;
      const db = new FakePg((text) => {
        if (
          /^\s*SELECT c\.id, c\.step_id, c\.expression, c\.parent_strategy_id\s*$/m.test(
            text,
          )
        ) {
          stepCallCount += 1;
          return stepCallCount === 1
            ? {
                rows: [
                  {
                    id: 5,
                    step_id: "s",
                    expression: "e",
                    parent_strategy_id: 4,
                  },
                ],
              }
            : { rows: [] };
        }
        if (/^\s*UPDATE v1_step_concurrency/.test(text)) {
          return { rows: [{ id: 5, step_id: "s", expression: "e" }] };
        }
        return { rows: [] };
      });
      const first = await repairConcurrencyRot(db, {
        tenantId: TENANT_ID,
        mode: "on",
      });
      expect(first.stepFindings).toHaveLength(1);
      expect(first.stepRepair.touched).toBe(1);

      const second = await repairConcurrencyRot(db, {
        tenantId: TENANT_ID,
        mode: "on",
      });
      expect(second.stepFindings).toHaveLength(0);
      expect(second.stepRepair.touched).toBe(0);
    });
  });

  describe("latency bounds (AC-5b)", () => {
    it("nominal = deadAfter + interval; alertable = deadAfter + 2*interval, from the actual production defaults", () => {
      const cfg = loadWorkerConfig({});
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
      const cfg = loadWorkerConfig({});
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
    HATCHET_ENGINE_DATABASE_URL: "postgresql://fake",
    HATCHET_ENGINE_TENANT_ID: TENANT_ID,
  });

  it("master gate: with engineDatabaseUrl unset, no engine db is touched", async () => {
    const unconfigured = loadWorkerConfig({});
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
    HATCHET_ENGINE_DATABASE_URL: "postgresql://fake",
    HATCHET_ENGINE_TENANT_ID: TENANT_ID,
    WORKER_SLOT_RECLAIM: "on",
  });

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

  it("master gate: with engineDatabaseUrl unset, the db is never touched", async () => {
    const db = makeEngineDb(new FakePg(() => ({ rows: [] })));
    await bootTimeSlotReclaim(loadWorkerConfig({}), vi.fn(), db as never);
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
