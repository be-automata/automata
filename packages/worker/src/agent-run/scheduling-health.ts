import type { PgLike } from "./engine-db";

/**
 * Pure scheduling-health detectors + remediators for the Hatchet engine DB
 * (#69). This module is deliberately PURE: no `process.env`, no timers, no fs,
 * no logging — every knob arrives as a function parameter. That is the import
 * contract #128's anti-rot E2E depends on (§7.3) and it is asserted by
 * `scheduling-health.test.ts`.
 *
 * Every exported detector/remediator is `(db: PgLike, opts) => Promise<...>`,
 * unit-testable against a fake `PgLike` with zero docker.
 */

export type MaintenanceMode = "off" | "dry-run" | "on";

/** Falls back to the safe (`dry-run`) value on anything but an exact match — the
 * established exact-string-opt-in doctrine (`config.ts:134-140`). */
export function normalizeMode(value: string | undefined): MaintenanceMode {
  if (value === "off" || value === "on" || value === "dry-run") {
    return value;
  }
  return "dry-run";
}

export interface StepRotRow {
  id: number;
  stepId: string;
  expression: string;
  parentStrategyId: number | null;
}

export interface WorkflowRotRow {
  id: number;
  workflowVersionId: string;
  expression: string;
  childStrategyIds: number[];
}

export interface RepairResult<Row> {
  touched: number;
  rows: Row[];
  deferred: boolean;
}

export interface ReclaimCandidateRow {
  taskId: string;
  taskInsertedAt: string;
  taskRetryCount: number;
  strategyId: number;
  key: string;
  workflowRunId: string;
  orphan: boolean;
}

export interface ReclaimResult {
  touched: number;
  rows: ReclaimCandidateRow[];
}

export interface StuckQueuedRow {
  externalId: string;
  workflowRunId: string;
  workflowId: string;
  insertedAt: string;
  scheduleTimeout: string | null;
  queuedForS: number;
}

const DEFAULT_LIMIT = 100;

// ---------------------------------------------------------------------------
// §3.1.2 / §3.1.3 — step-level concurrency-group rot
// ---------------------------------------------------------------------------

/**
 * Rot: an ACTIVE strategy whose parent pointer leads outside its own live chain
 * — missing, inactive, or belonging to a different step (§3.1.2, §2.3).
 */
/**
 * `v1_task_runtime.evicted_at` exists on some hatchet-lite v0.94.x databases
 * and not on others (a fresh CI engine at the pinned tag lacks it; a
 * longer-lived one migrated it in). The reclaim query must not depend on a
 * column the engine may not have — resolve it once per process.
 */
let evictedAtSupported: boolean | null = null;
async function evictedAtPredicate(db: PgLike): Promise<string> {
  if (evictedAtSupported === null) {
    const r = await db.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_name = 'v1_task_runtime' AND column_name = 'evicted_at'
       ) AS ok`,
    );
    evictedAtSupported = r.rows[0]?.ok === true;
  }
  return evictedAtSupported ? "AND r.evicted_at IS NULL" : "";
}

export async function detectStepConcurrencyRot(
  db: PgLike,
  opts: { tenantId: string; limit?: number },
): Promise<StepRotRow[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const result = await db.query<{
    id: number;
    step_id: string;
    expression: string;
    parent_strategy_id: number | null;
  }>(
    `SELECT c.id, c.step_id, c.expression, c.parent_strategy_id
       FROM v1_step_concurrency c
       LEFT JOIN v1_step_concurrency p
              ON p.id = c.parent_strategy_id
             AND p.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1::uuid
        AND c.is_active
        AND c.parent_strategy_id IS NOT NULL
        AND (p.id IS NULL OR NOT p.is_active OR p.step_id <> c.step_id)
      ORDER BY c.id
      LIMIT $2`,
    [opts.tenantId, limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    stepId: r.step_id,
    expression: r.expression,
    parentStrategyId: r.parent_strategy_id,
  }));
}

/**
 * Repair (or, in dry-run, report) the rows `detectStepConcurrencyRot` flagged.
 * The rot predicate is re-checked inside the write's own `WHERE`, and a
 * QUIESCENCE PRECONDITION declines to touch any strategy an in-flight
 * `v1_concurrency_slot` is currently traversing via `strategy_id`,
 * `parent_strategy_id`, `next_strategy_ids` or `next_parent_strategy_ids`
 * (§3.1.3) — of either the row itself or its (dangling) parent. Deferral is
 * safe and costs at most one tick; it may be permanent in the deadlock case
 * (§3.1.3, §10 risk 2).
 */
export async function repairStepConcurrencyRot(
  db: PgLike,
  opts: { tenantId: string; ids: number[]; mode: MaintenanceMode },
): Promise<RepairResult<StepRotRow>> {
  if (opts.ids.length === 0 || opts.mode === "off") {
    return { touched: 0, rows: [], deferred: false };
  }
  const quiescenceWhere = `
    AND NOT EXISTS (
         SELECT 1 FROM v1_concurrency_slot s
          WHERE s.tenant_id = c.tenant_id
            AND (    s.strategy_id             =    c.id
                  OR s.parent_strategy_id      =    c.id
                  OR s.next_strategy_ids        @> ARRAY[c.id]
                  OR s.next_parent_strategy_ids @> ARRAY[c.id]
                  OR s.strategy_id             =    c.parent_strategy_id
                  OR s.parent_strategy_id      =    c.parent_strategy_id
                  OR s.next_strategy_ids        @> ARRAY[c.parent_strategy_id]
                  OR s.next_parent_strategy_ids @> ARRAY[c.parent_strategy_id]))`;

  if (opts.mode === "dry-run") {
    const result = await db.query<{
      id: number;
      step_id: string;
      expression: string;
      parent_strategy_id: number | null;
    }>(
      `SELECT c.id, c.step_id, c.expression, c.parent_strategy_id
         FROM v1_step_concurrency c
        WHERE c.tenant_id = $1::uuid
          AND c.id = ANY($2::bigint[])
          AND c.is_active
          AND c.parent_strategy_id IS NOT NULL
          AND NOT EXISTS (
               SELECT 1 FROM v1_step_concurrency p
                WHERE p.id = c.parent_strategy_id
                  AND p.tenant_id = c.tenant_id
                  AND p.is_active
                  AND p.step_id = c.step_id)
          ${quiescenceWhere}`,
      [opts.tenantId, opts.ids],
    );
    return {
      touched: 0,
      rows: result.rows.map((r) => ({
        id: r.id,
        stepId: r.step_id,
        expression: r.expression,
        parentStrategyId: r.parent_strategy_id,
      })),
      deferred: false,
    };
  }

  const result = await db.query<{
    id: number;
    step_id: string;
    expression: string;
  }>(
    `UPDATE v1_step_concurrency c
        SET parent_strategy_id = NULL
      WHERE c.tenant_id = $1::uuid
        AND c.id = ANY($2::bigint[])
        AND c.is_active
        AND c.parent_strategy_id IS NOT NULL
        AND NOT EXISTS (
             SELECT 1 FROM v1_step_concurrency p
              WHERE p.id = c.parent_strategy_id
                AND p.tenant_id = c.tenant_id
                AND p.is_active
                AND p.step_id = c.step_id)
        ${quiescenceWhere}
      RETURNING c.id, c.step_id, c.expression`,
    [opts.tenantId, opts.ids],
  );
  return {
    touched: result.rows.length,
    rows: result.rows.map((r) => ({
      id: r.id,
      stepId: r.step_id,
      expression: r.expression,
      parentStrategyId: null,
    })),
    deferred: result.rows.length < opts.ids.length,
  };
}

// ---------------------------------------------------------------------------
// §3.1.4 — workflow-level concurrency-group rot
// ---------------------------------------------------------------------------

/**
 * Rot: an ACTIVE strategy whose child array names a strategy that does not
 * exist in the same `(workflow_id, workflow_version_id)` (§3.1.4).
 */
export async function detectWorkflowConcurrencyRot(
  db: PgLike,
  opts: { tenantId: string; limit?: number },
): Promise<WorkflowRotRow[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const result = await db.query<{
    id: number;
    workflow_version_id: string;
    expression: string;
    child_strategy_ids: number[];
  }>(
    `SELECT DISTINCT c.id, c.workflow_version_id, c.expression, c.child_strategy_ids
       FROM v1_workflow_concurrency c
       CROSS JOIN LATERAL unnest(COALESCE(c.child_strategy_ids, '{}'::bigint[])) AS x(child_id)
       LEFT JOIN v1_workflow_concurrency k
              ON k.id = x.child_id
             AND k.workflow_id = c.workflow_id
             AND k.workflow_version_id = c.workflow_version_id
      WHERE c.tenant_id = $1::uuid
        AND c.is_active
        AND k.id IS NULL
      ORDER BY c.id
      LIMIT $2`,
    [opts.tenantId, limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    workflowVersionId: r.workflow_version_id,
    expression: r.expression,
    childStrategyIds: r.child_strategy_ids ?? [],
  }));
}

/**
 * Repair the rows `detectWorkflowConcurrencyRot` flagged: strip any child id
 * that does not resolve within the same `(workflow_id, workflow_version_id)`,
 * keeping same-version links intact (§3.1.1 precision correction, AC-8c). Same
 * quiescence-precondition shape as the step-level repair, against
 * `v1_workflow_concurrency_slot` (§3.1.4).
 */
export async function repairWorkflowConcurrencyRot(
  db: PgLike,
  opts: { tenantId: string; ids: number[]; mode: MaintenanceMode },
): Promise<RepairResult<WorkflowRotRow>> {
  if (opts.ids.length === 0 || opts.mode === "off") {
    return { touched: 0, rows: [], deferred: false };
  }
  const quiescenceWhere = `
    AND NOT EXISTS (
         SELECT 1 FROM v1_workflow_concurrency_slot s
          WHERE s.tenant_id = c.tenant_id
            AND (    s.strategy_id = c.id
                  OR s.strategy_id = ANY(c.child_strategy_ids)
                  OR s.child_strategy_ids           && c.child_strategy_ids
                  OR s.completed_child_strategy_ids && c.child_strategy_ids))`;

  if (opts.mode === "dry-run") {
    const result = await db.query<{
      id: number;
      workflow_version_id: string;
      expression: string;
      child_strategy_ids: number[];
    }>(
      `SELECT c.id, c.workflow_version_id, c.expression, c.child_strategy_ids
         FROM v1_workflow_concurrency c
        WHERE c.tenant_id = $1::uuid
          AND c.id = ANY($2::bigint[])
          AND c.is_active
          ${quiescenceWhere}`,
      [opts.tenantId, opts.ids],
    );
    return {
      touched: 0,
      rows: result.rows.map((r) => ({
        id: r.id,
        workflowVersionId: r.workflow_version_id,
        expression: r.expression,
        childStrategyIds: r.child_strategy_ids ?? [],
      })),
      deferred: false,
    };
  }

  const result = await db.query<{
    id: number;
    child_strategy_ids: number[];
  }>(
    `UPDATE v1_workflow_concurrency c
        SET child_strategy_ids = COALESCE((
              SELECT array_agg(x ORDER BY x)
                FROM unnest(c.child_strategy_ids) x
               WHERE EXISTS (SELECT 1 FROM v1_workflow_concurrency k
                              WHERE k.id = x
                                AND k.workflow_id = c.workflow_id
                                AND k.workflow_version_id = c.workflow_version_id)
            ), '{}'::bigint[])
      WHERE c.tenant_id = $1::uuid
        AND c.id = ANY($2::bigint[])
        AND c.is_active
        ${quiescenceWhere}
      RETURNING c.id, c.child_strategy_ids`,
    [opts.tenantId, opts.ids],
  );
  return {
    touched: result.rows.length,
    rows: result.rows.map((r) => ({
      id: r.id,
      workflowVersionId: "",
      expression: "",
      childStrategyIds: r.child_strategy_ids ?? [],
    })),
    deferred: result.rows.length < opts.ids.length,
  };
}

/** Combined detect+repair across both tables — the single call site the integration harness (§7.2.1) and the maintenance tick use. */
export async function repairConcurrencyRot(
  db: PgLike,
  opts: { tenantId: string; mode: MaintenanceMode; limit?: number },
): Promise<{
  stepFindings: StepRotRow[];
  workflowFindings: WorkflowRotRow[];
  stepRepair: RepairResult<StepRotRow>;
  workflowRepair: RepairResult<WorkflowRotRow>;
}> {
  const stepFindings = await detectStepConcurrencyRot(db, opts);
  const workflowFindings = await detectWorkflowConcurrencyRot(db, opts);
  const stepRepair = await repairStepConcurrencyRot(db, {
    tenantId: opts.tenantId,
    ids: stepFindings.map((r) => r.id),
    mode: opts.mode,
  });
  const workflowRepair = await repairWorkflowConcurrencyRot(db, {
    tenantId: opts.tenantId,
    ids: workflowFindings.map((r) => r.id),
    mode: opts.mode,
  });
  return { stepFindings, workflowFindings, stepRepair, workflowRepair };
}

// ---------------------------------------------------------------------------
// §3.2 — SIGKILL slot reclamation
// ---------------------------------------------------------------------------

/**
 * Candidates for reclamation (§3.2.2/§3.2.3): a filled slot that is either (a)
 * an orphan — no live `v1_task_runtime` row, past `minSlotAgeSeconds` — or (b)
 * dead-owned — its runtime's worker belongs to a dead generation (heartbeat
 * stale past `deadAfterSeconds`, excluding `selfWorkerId`, excluding a
 * never-heartbeated worker) AND has emitted no task event within the same dead
 * window (the partition-hazard no-progress guard, §3.2.1 guard 2). Deliberately
 * does NOT gate on `schedule_timeout_at` (§3.2.2 correction).
 */
export async function findReclaimableSlots(
  db: PgLike,
  opts: {
    tenantId: string;
    deadAfterSeconds: number;
    minSlotAgeSeconds: number;
    selfWorkerId: string | null;
    limit?: number;
  },
): Promise<ReclaimCandidateRow[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const evictedPredicate = await evictedAtPredicate(db);
  const result = await db.query<{
    task_id: string;
    task_inserted_at: string;
    task_retry_count: number;
    strategy_id: number;
    key: string;
    workflow_run_id: string;
    orphan: boolean;
  }>(
    `WITH dead_workers AS (
       SELECT id FROM "Worker"
        WHERE "tenantId" = $1::uuid
          AND "lastHeartbeatAt" IS NOT NULL
          AND "lastHeartbeatAt" < now() - make_interval(secs => $2::int)
          AND ($3::uuid IS NULL OR id <> $3::uuid)
     ),
     candidates AS (
       SELECT s.task_id, s.task_inserted_at, s.task_retry_count, s.strategy_id,
              s.key, s.workflow_run_id, r.worker_id,
              (r.task_id IS NULL) AS orphan
         FROM v1_concurrency_slot s
         LEFT JOIN v1_task_runtime r
                ON r.task_id          = s.task_id
               AND r.task_inserted_at = s.task_inserted_at
               AND r.retry_count      = s.task_retry_count
               ${evictedPredicate}
        WHERE s.tenant_id = $1::uuid
          AND s.is_filled
          AND (
                ( r.task_id IS NULL
                  AND s.task_inserted_at < now() - make_interval(secs => $5::int) )
                OR ( r.worker_id IN (SELECT id FROM dead_workers)
                     AND NOT EXISTS (
                          SELECT 1 FROM v1_task_events_olap e
                           WHERE e.tenant_id        = s.tenant_id
                             AND e.task_id          = s.task_id
                             AND e.task_inserted_at = s.task_inserted_at
                             AND e.event_timestamp  > now() - make_interval(secs => $2::int)) )
              )
        ORDER BY s.sort_id
        LIMIT $4
     )
     SELECT task_id, task_inserted_at, task_retry_count, strategy_id, key, workflow_run_id, orphan
       FROM candidates`,
    [
      opts.tenantId,
      opts.deadAfterSeconds,
      opts.selfWorkerId,
      limit,
      opts.minSlotAgeSeconds,
    ],
  );
  return result.rows.map((r) => ({
    taskId: r.task_id,
    taskInsertedAt: r.task_inserted_at,
    taskRetryCount: r.task_retry_count,
    strategyId: r.strategy_id,
    key: r.key,
    workflowRunId: r.workflow_run_id,
    orphan: r.orphan,
  }));
}

/**
 * Deletes exactly the rows `findReclaimableSlots` would find (mode `on`), or
 * reports them without writing (mode `dry-run`/`off`). The `DELETE` fires the
 * engine's own `after_v1_concurrency_slot_delete_function()` release trigger
 * (§2.4) — reclamation is not a raw poke at internals.
 */
export async function reclaimEngineSlots(
  db: PgLike,
  opts: {
    tenantId: string;
    deadAfterSeconds: number;
    minSlotAgeSeconds: number;
    selfWorkerId: string | null;
    mode: MaintenanceMode;
    limit?: number;
  },
): Promise<ReclaimResult> {
  if (opts.mode === "off") {
    return { touched: 0, rows: [] };
  }
  if (opts.mode === "dry-run") {
    const rows = await findReclaimableSlots(db, opts);
    return { touched: 0, rows };
  }
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const evictedPredicate = await evictedAtPredicate(db);
  const result = await db.query<{
    task_id: string;
    task_inserted_at: string;
    task_retry_count: number;
    strategy_id: number;
    key: string;
    workflow_run_id: string;
    orphan: boolean;
  }>(
    `WITH dead_workers AS (
       SELECT id FROM "Worker"
        WHERE "tenantId" = $1::uuid
          AND "lastHeartbeatAt" IS NOT NULL
          AND "lastHeartbeatAt" < now() - make_interval(secs => $2::int)
          AND ($3::uuid IS NULL OR id <> $3::uuid)
     ),
     candidates AS (
       SELECT s.task_id, s.task_inserted_at, s.task_retry_count, s.strategy_id,
              s.key, s.workflow_run_id, r.worker_id,
              (r.task_id IS NULL) AS orphan
         FROM v1_concurrency_slot s
         LEFT JOIN v1_task_runtime r
                ON r.task_id          = s.task_id
               AND r.task_inserted_at = s.task_inserted_at
               AND r.retry_count      = s.task_retry_count
               ${evictedPredicate}
        WHERE s.tenant_id = $1::uuid
          AND s.is_filled
          AND (
                ( r.task_id IS NULL
                  AND s.task_inserted_at < now() - make_interval(secs => $5::int) )
                OR ( r.worker_id IN (SELECT id FROM dead_workers)
                     AND NOT EXISTS (
                          SELECT 1 FROM v1_task_events_olap e
                           WHERE e.tenant_id        = s.tenant_id
                             AND e.task_id          = s.task_id
                             AND e.task_inserted_at = s.task_inserted_at
                             AND e.event_timestamp  > now() - make_interval(secs => $2::int)) )
              )
        ORDER BY s.sort_id
        LIMIT $4
     )
     DELETE FROM v1_concurrency_slot s
      USING candidates c
      WHERE s.task_id          = c.task_id
        AND s.task_inserted_at = c.task_inserted_at
        AND s.task_retry_count = c.task_retry_count
        AND s.strategy_id      = c.strategy_id
     RETURNING s.task_id, s.task_inserted_at, s.task_retry_count, s.strategy_id, s.key, s.workflow_run_id, c.orphan`,
    [
      opts.tenantId,
      opts.deadAfterSeconds,
      opts.selfWorkerId,
      limit,
      opts.minSlotAgeSeconds,
    ],
  );
  return {
    touched: result.rows.length,
    rows: result.rows.map((r) => ({
      taskId: r.task_id,
      taskInsertedAt: r.task_inserted_at,
      taskRetryCount: r.task_retry_count,
      strategyId: r.strategy_id,
      key: r.key,
      workflowRunId: r.workflow_run_id,
      orphan: r.orphan,
    })),
  };
}

// ---------------------------------------------------------------------------
// §3.3 — stuck-QUEUED health signal (detection only)
// ---------------------------------------------------------------------------

export async function detectStuckQueued(
  db: PgLike,
  opts: { tenantId: string; thresholdSeconds: number; limit?: number },
): Promise<StuckQueuedRow[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const result = await db.query<{
    external_id: string;
    workflow_run_id: string;
    workflow_id: string;
    inserted_at: string;
    schedule_timeout: string | null;
    queued_for_s: number;
  }>(
    `SELECT external_id, workflow_run_id, workflow_id, inserted_at, schedule_timeout,
            EXTRACT(epoch FROM (now() - inserted_at))::int AS queued_for_s
       FROM v1_tasks_olap
      WHERE tenant_id = $1::uuid
        AND readable_status = 'QUEUED'
        AND inserted_at <  now() - make_interval(secs => $2::int)
        AND inserted_at >= now() - interval '7 days'
      ORDER BY inserted_at
      LIMIT $3`,
    [opts.tenantId, opts.thresholdSeconds, limit],
  );
  return result.rows.map((r) => ({
    externalId: r.external_id,
    workflowRunId: r.workflow_run_id,
    workflowId: r.workflow_id,
    insertedAt: r.inserted_at,
    scheduleTimeout: r.schedule_timeout,
    queuedForS: r.queued_for_s,
  }));
}

export interface SchedulingEventCounts {
  schedulingTimedOut: number;
  requeuedNoWorker: number;
}

/** §2.6 secondary signal: `SCHEDULING_TIMED_OUT` is an event, not a status. */
export async function detectSchedulingTimeoutEvents(
  db: PgLike,
  opts: { tenantId: string; windowSeconds: number },
): Promise<SchedulingEventCounts> {
  const result = await db.query<{ event_type: string; count: string }>(
    `SELECT event_type, count(*) as count
       FROM v1_task_events_olap
      WHERE tenant_id = $1::uuid
        AND event_type IN ('SCHEDULING_TIMED_OUT', 'REQUEUED_NO_WORKER')
        AND event_timestamp > now() - make_interval(secs => $2::int)
      GROUP BY 1`,
    [opts.tenantId, opts.windowSeconds],
  );
  const byType = new Map(
    result.rows.map((r) => [r.event_type, Number(r.count)]),
  );
  return {
    schedulingTimedOut: byType.get("SCHEDULING_TIMED_OUT") ?? 0,
    requeuedNoWorker: byType.get("REQUEUED_NO_WORKER") ?? 0,
  };
}

// ---------------------------------------------------------------------------
// §3.2.2 recovery-latency bound — pure arithmetic, asserted by AC-5b.
// ---------------------------------------------------------------------------

/** `deadAfterSeconds + maintIntervalSeconds` — the common case. */
export function nominalRecoveryLatencySeconds(
  deadAfterSeconds: number,
  maintIntervalSeconds: number,
): number {
  return deadAfterSeconds + maintIntervalSeconds;
}

/**
 * `deadAfterSeconds + 2 * maintIntervalSeconds` — the figure the runbook and
 * any ops alert threshold MUST use (§3.2.2): with two launchd units ticking,
 * the tick that would have fired can lose the advisory-lock race and skip,
 * costing one further interval.
 */
export function alertableRecoveryLatencySeconds(
  deadAfterSeconds: number,
  maintIntervalSeconds: number,
): number {
  return deadAfterSeconds + 2 * maintIntervalSeconds;
}
