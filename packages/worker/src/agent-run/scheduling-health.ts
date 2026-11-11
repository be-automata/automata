import type { PgLike } from "./engine-db";

/**
 * Pure scheduling-health detectors + remediators for the Hatchet engine DB
 * (#69). Concurrency-strategy checks are detection only (#570). This module is
 * deliberately PURE: no `process.env`, no timers, no fs, no logging — every
 * knob arrives as a function parameter. That is the import contract #128's
 * anti-rot E2E depends on (§7.3).
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
// §3.1 — concurrency-strategy link integrity (detection only, #570)
// ---------------------------------------------------------------------------
//
// Hatchet links the two strategy tables ACROSS each other, never within one
// (hatchet sql/schema/v1-core.sql @ v0.94.10):
//   - v1_step_concurrency.parent_strategy_id holds a v1_workflow_concurrency.id
//     (schema comment :233, trigger insert :289-290). The slot-insert trigger
//     resolves it with `wc.workflow_id = ps.workflow_id AND
//     wc.workflow_version_id = ps.workflow_version_id AND wc.id =
//     ps.parent_strategy_id` (:869).
//   - v1_workflow_concurrency.child_strategy_ids holds the ids of the
//     v1_step_concurrency rows the same trigger inserted (:314-319).
// The #69 detectors joined each column back to its own table, so a healthy
// workflow-level strategy read as rot (#570). They now ask exactly the
// question the engine's own join asks. The #69 repairs wrote to these tables
// under the misread and were removed with it: nothing in this module writes
// to v1_step_concurrency or v1_workflow_concurrency.

/**
 * An ACTIVE step strategy whose `parent_strategy_id` does not resolve to a
 * workflow strategy of the same workflow version — the link the engine's
 * slot-insert trigger needs to create the workflow-level slot.
 */
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
      WHERE c.tenant_id = $1::uuid
        AND c.is_active
        AND c.parent_strategy_id IS NOT NULL
        -- No tenant_id clause: workflow_id is tenant-scoped and part of the key.
        AND NOT EXISTS (
             SELECT 1 FROM v1_workflow_concurrency w
              WHERE w.workflow_id         = c.workflow_id
                AND w.workflow_version_id = c.workflow_version_id
                AND w.id                  = c.parent_strategy_id)
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
 * An ACTIVE workflow strategy with a `child_strategy_ids` entry that is not a
 * step strategy of the same workflow version pointing back at it.
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
    `SELECT c.id, c.workflow_version_id, c.expression, c.child_strategy_ids
       FROM v1_workflow_concurrency c
      WHERE c.tenant_id = $1::uuid
        AND c.is_active
        AND EXISTS (
             SELECT 1
               FROM unnest(COALESCE(c.child_strategy_ids, '{}'::bigint[])) AS x(child_id)
              WHERE NOT EXISTS (
                     SELECT 1 FROM v1_step_concurrency s
                      WHERE s.workflow_id         = c.workflow_id
                        AND s.workflow_version_id = c.workflow_version_id
                        AND s.id                  = x.child_id
                        AND s.parent_strategy_id  = c.id))
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

/** Both link-integrity detectors — the single call site the maintenance tick uses. */
export async function detectConcurrencyRot(
  db: PgLike,
  opts: { tenantId: string; limit?: number },
): Promise<{
  stepFindings: StepRotRow[];
  workflowFindings: WorkflowRotRow[];
}> {
  const stepFindings = await detectStepConcurrencyRot(db, opts);
  const workflowFindings = await detectWorkflowConcurrencyRot(db, opts);
  return { stepFindings, workflowFindings };
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
               AND r.evicted_at IS NULL
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
               AND r.evicted_at IS NULL
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
 * any ops alert threshold MUST use (§3.2.2): the tick that would have fired
 * can be skipped by a maintenance tick overlapping a long previous tick, or
 * a worker restart mid-interval, costing one further interval.
 */
export function alertableRecoveryLatencySeconds(
  deadAfterSeconds: number,
  maintIntervalSeconds: number,
): number {
  return deadAfterSeconds + 2 * maintIntervalSeconds;
}
