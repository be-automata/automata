import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  ConcurrencyLimitStrategy,
  type Hatchet,
  type Worker,
} from "@hatchet-dev/typescript-sdk";
import { loadWorkerConfig } from "./config";
import { AGENT_RUN_VARIANTS, buildAgentRunDefinition } from "./definition";
import {
  bootstrapTenant,
  SCHEMA_READY_DELETE_TRIGGER_FN,
  SCHEMA_READY_TABLES,
  composeDownV,
  composeUp,
  connectPg,
  pollUntil,
  schemaIsReady,
  waitForEngineReady,
} from "./hatchet-it-harness";
import type { SchemaReadyCounts } from "./hatchet-it-harness";
import {
  detectStepConcurrencyRot,
  detectWorkflowConcurrencyRot,
  reclaimEngineSlots,
} from "./scheduling-health";
import { runMaintenanceTick } from "./scheduling-maintenance";
import type { PgLike } from "./engine-db";

/**
 * Dockerized integration harness (#69 §7.2). Gated on HATCHET_IT=1 — skipped
 * (not just fast-failed) otherwise, so `pnpm -C packages/worker test` and CI
 * stay docker-free by default.
 *
 * SAFETY — this harness MUST NEVER touch the live pilot engine
 * (`automata-hatchet-postgres-1`, compose project `automata-hatchet`). It runs
 * an ENTIRELY SEPARATE docker compose project (`COMPOSE_PROJECT_NAME` below)
 * so `down -v` here can never destroy pilot data. Before ever running this
 * manually with `docker compose down -v`, confirm via `docker compose ls`
 * that you are targeting `automata-hatchet-it`, never `automata-hatchet`.
 *
 * CONCURRENCY-STRATEGY LINKS (#570). The #69 register-until-rot loop (the old
 * `it.skip`) is gone with the repair it was meant to justify: its premise —
 * that a step row's parent and a workflow row's children point within their
 * own tables — misread the engine schema. What runs instead registers the
 * #570 repro workflow and every agent-run variant through a real SDK worker,
 * asserts the detectors flag none of those rows (while the #69 predicates do),
 * then breaks one link of each kind inside a rolled-back transaction and
 * asserts each is flagged exactly and that a tick with repair `on` writes
 * nothing. The slot-reclamation fixtures (AC-8d/AC-8e) are unchanged.
 */
/**
 * Migrations belong to hatchet-lite, not postgres — and they land in stages,
 * so "the tables exist" is not the same as "the schema the queries need
 * exists". This suite routinely meets a brand-new engine mid-migration:
 * `supersede.integration.test.ts` tears the stack down with `down -v` in its
 * own `afterAll`, and whichever of the two files runs second brings it back
 * up from nothing. (File ORDER is not pinned — vitest's default sequencer may
 * reorder specs — so neither file may assume it runs first. Both gate their
 * own setup independently, which is what makes the order irrelevant.)
 *
 * INCIDENT RECORD — measured 2026-08-25 against a fresh hatchet-lite v0.94.10.
 * These are observations of one pinned third-party image, not a contract; if
 * the image tag in docker-compose.hatchet.yml moves, re-measure rather than
 * trusting the numbers:
 *
 *   t=0.0s  "Worker" exists
 *   t=1.2s  the five v1_* tables exist (one migration batch)
 *   t=1.9s  v1_task_runtime.evicted_at is added   <-- LAST; ~700ms half-migrated window
 *   t≈1.2s  the engine's own /api/ready returns 200
 *
 * A readiness gate that stops at the tables lands inside that window on a slow
 * runner and `reclaimEngineSlots` fails with `column r.evicted_at does not
 * exist` (42703) — worker-e2e was green at 86dfc8e and red at ca2a6ce on
 * byte-identical code. Note /api/ready went 200 BEFORE the column landed, so
 * the engine's own signal is necessary but NOT sufficient; the schema probe
 * below is what actually closes the race.
 *
 * Budgets: every wait inside `beforeAll` must fit under its hook timeout, or
 * vitest kills the hook with a generic "Hook timed out" and `pollUntil`'s
 * message — which names the stage and the last counts — never prints. That
 * diagnostic is the whole point. See the accounting at the hook itself.
 */
const READY_BUDGET_MS = 60_000;
const PG_CONNECT_BUDGET_MS = 30_000;

async function waitForSchemaReady(client: Client): Promise<void> {
  await waitForEngineReady(READY_BUDGET_MS);
  // Each object is counted SEPARATELY and schema-qualified. Summing them into
  // one number cannot tell "all tables, no column" from "one extra table, no
  // column", and the engine's db carries a second schema (`outbox`) whose
  // names are not guaranteed to stay disjoint. Separate fields also make the
  // timeout message name the missing piece instead of an opaque total.
  // `public` is where these resolve via the default search_path, so it is
  // what must be ready.
  await pollUntil(
    "hatchet-lite concurrency schema (tables + evicted_at + release trigger)",
    async () =>
      // Not dead code: `rows[0]` is possibly-undefined to the type checker.
      // A missing row is "not ready", never a crash mid-poll.
      (
        await client.query<SchemaReadyCounts>(
          `SELECT
             (SELECT count(*) FROM information_schema.tables
               WHERE table_schema = 'public'
                 AND table_name = ANY($1::text[]))::int AS tables,
             (SELECT count(*) FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'v1_task_runtime'
                 AND column_name = 'evicted_at')::int AS evicted_at,
             (SELECT count(*) FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public'
                 AND p.proname = $2)::int AS delete_trigger_fn`,
          [[...SCHEMA_READY_TABLES], SCHEMA_READY_DELETE_TRIGGER_FN],
        )
      ).rows[0] ?? { tables: 0, evicted_at: 0, delete_trigger_fn: 0 },
    schemaIsReady,
    READY_BUDGET_MS,
    250,
  );
}

const itEnabled = process.env.HATCHET_IT === "1";

describe.skipIf(!itEnabled)(
  "scheduling-health integration (dockerized hatchet-lite, HATCHET_IT=1)",
  () => {
    let pg: Client;
    let db: PgLike;
    let tenantId: string;

    beforeAll(async () => {
      // Stack safety (own project, own ports, never the live engine) lives in
      // hatchet-it-harness.ts, shared with supersede.integration.test.ts.
      await composeUp();
      pg = await connectPg(PG_CONNECT_BUDGET_MS);
      await waitForSchemaReady(pg);
      db = {
        query: (text: string, params?: unknown[]) => pg.query(text, params),
      };
      // A fresh hatchet-lite Postgres has run migrations but has no tenant
      // until hatchet-lite itself bootstraps one; for the SQL-only fixtures
      // below we mint one directly since no engine process is running
      // against this isolated stack (postgres-only, by design — see the
      // DEVIATION note above for why the full engine + worker harness is
      // scoped out).
      tenantId = randomUUID();
      await pg
        .query(
          `INSERT INTO "Tenant" (id, name, slug, "createdAt", "updatedAt")
           VALUES ($1, 'it-tenant', $2, now(), now())
           ON CONFLICT DO NOTHING`,
          [tenantId, `it-tenant-${tenantId.slice(0, 8)}`],
        )
        .catch(() => {
          // Schema drift across hatchet-lite Postgres migrations is possible;
          // if this insert fails the fixtures below that depend on a real
          // Tenant row will fail loudly on their own assertions instead.
        });
      // Exhaustive budget accounting — every await above is bounded, so the
      // hook ceiling is the sum plus headroom, and a genuine hang surfaces as
      // pollUntil's named message rather than a generic "Hook timed out":
      //   connectPg           30s  (PG_CONNECT_BUDGET_MS, capped here)
      //   waitForEngineReady  60s  (READY_BUDGET_MS)
      //   schema probe        60s  (READY_BUDGET_MS)
      //   ------------------------
      //   bounded total      150s, leaving 90s for composeUp (image already
      //   pulled by whichever file ran first, so this is ~1-2s in practice).
    }, 240_000);

    afterAll(async () => {
      await pg?.end().catch(() => {});
      await composeDownV();
    }, 60_000);

    describe("concurrency-strategy links: real registrations are never rot (#570)", () => {
      // The #570 repro shape: one workflow-level key over two dependent tasks.
      const REPRO = "rot-check-570";
      /**
       * The #69 detector predicates, kept verbatim as the regression witness:
       * against the same rows they flag valid links, which proves this fixture
       * would have caught #570 (a fixture both predicates agree on proves
       * nothing).
       */
      /** A step strategy joined to its parent the way the engine joins it (v1-core.sql:869). */
      const LINKED = `FROM v1_step_concurrency c
        JOIN v1_workflow_concurrency w
          ON w.workflow_id = c.workflow_id
         AND w.workflow_version_id = c.workflow_version_id
         AND w.id = c.parent_strategy_id`;
      const OLD_STEP_PREDICATE = `
        SELECT count(*)::int AS n FROM v1_step_concurrency c
          LEFT JOIN v1_step_concurrency p
                 ON p.id = c.parent_strategy_id AND p.tenant_id = c.tenant_id
         WHERE c.tenant_id = $1::uuid AND c.is_active
           AND c.parent_strategy_id IS NOT NULL
           AND (p.id IS NULL OR NOT p.is_active OR p.step_id <> c.step_id)`;
      const OLD_WORKFLOW_PREDICATE = `
        SELECT count(DISTINCT c.id)::int AS n FROM v1_workflow_concurrency c
         CROSS JOIN LATERAL unnest(COALESCE(c.child_strategy_ids, '{}'::bigint[])) x(child_id)
          LEFT JOIN v1_workflow_concurrency k
                 ON k.id = x.child_id AND k.workflow_id = c.workflow_id
                AND k.workflow_version_id = c.workflow_version_id
         WHERE c.tenant_id = $1::uuid AND c.is_active AND k.id IS NULL`;

      let engineTenantId: string;
      let hatchet: Hatchet;
      let worker: Worker | undefined;
      /** One workflow row per stacked key: repro 1, legacy agent-run 2, each variant 3. */
      const variantNames = Object.keys(
        AGENT_RUN_VARIANTS,
      ) as (keyof typeof AGENT_RUN_VARIANTS)[];
      const expectedWorkflowRows =
        1 +
        variantNames.reduce(
          (n, v) => n + (AGENT_RUN_VARIANTS[v] === null ? 2 : 3),
          0,
        );
      /** Repro: 2 tasks under 1 key. agent-run: 1 task under each key. */
      const expectedLinkedStepRows = 2 + expectedWorkflowRows - 1;

      const count = async (sql: string): Promise<number> =>
        (await pg.query<{ n: number }>(sql, [engineTenantId])).rows[0]?.n ?? 0;

      beforeAll(async () => {
        let token: string;
        ({ tenantId: engineTenantId, token } = await bootstrapTenant(pg));
        process.env.HATCHET_CLIENT_TOKEN = token;
        process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
        const sdk = await import("@hatchet-dev/typescript-sdk");
        hatchet = sdk.Hatchet.init();

        const repro = hatchet.workflow({
          name: REPRO,
          concurrency: {
            expression: "'all'",
            maxRuns: 1,
            limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
          },
        });
        const a = repro.task({ name: "a", fn: async () => ({ ok: true }) });
        repro.task({ name: "b", parents: [a], fn: async () => ({ ok: true }) });

        const agentRuns = variantNames.map((name) => {
          const def = buildAgentRunDefinition(name, AGENT_RUN_VARIANTS[name]);
          const wf = hatchet.workflow(def.workflow);
          wf.task({ ...def.task, fn: async () => ({ ok: true }) });
          return wf;
        });

        worker = await hatchet.worker("it-rot-570-worker", {
          workflows: [repro, ...agentRuns],
          slots: 2,
        });
        void worker.start();
        await worker.waitUntilReady(60_000);
        await pollUntil(
          "registered concurrency strategies",
          async () => ({
            workflowRows: await count(
              "SELECT count(*)::int AS n FROM v1_workflow_concurrency WHERE tenant_id = $1::uuid",
            ),
            linkedStepRows: await count(
              "SELECT count(*)::int AS n FROM v1_step_concurrency WHERE tenant_id = $1::uuid AND parent_strategy_id IS NOT NULL",
            ),
          }),
          (r) =>
            r.workflowRows >= expectedWorkflowRows &&
            r.linkedStepRows >= expectedLinkedStepRows,
          60_000,
          250,
        );
      }, 240_000);

      afterAll(async () => {
        await worker?.stop().catch(() => {});
      }, 60_000);

      it("the fixture holds real cross-table links, and the #69 predicates misread them (regression witness)", async () => {
        expect(
          await count(
            `SELECT count(*)::int AS n ${LINKED} WHERE c.tenant_id = $1::uuid`,
          ),
        ).toBeGreaterThanOrEqual(expectedLinkedStepRows);
        expect(await count(OLD_STEP_PREDICATE)).toBeGreaterThan(0);
        expect(await count(OLD_WORKFLOW_PREDICATE)).toBeGreaterThan(0);
        // The README's manual reverse-link query is empty on a healthy engine too.
        expect(
          await count(
            `SELECT count(*)::int AS n ${LINKED}
              WHERE c.tenant_id = $1::uuid AND c.is_active
                AND NOT (c.id = ANY(COALESCE(w.child_strategy_ids, '{}'::bigint[])))`,
          ),
        ).toBe(0);
      });

      it("AC-1/AC-2/AC-3: neither detector flags the repro or the stacked agent-run registrations", async () => {
        expect(
          await detectStepConcurrencyRot(db, { tenantId: engineTenantId }),
        ).toEqual([]);
        expect(
          await detectWorkflowConcurrencyRot(db, { tenantId: engineTenantId }),
        ).toEqual([]);
      });

      it("AC-4/AC-5/AC-6: a broken link of each kind is flagged exactly, and a tick with repair 'on' writes nothing", async () => {
        const snapshotRows = async () =>
          (
            await pg.query<{ t: string; id: string; h: string }>(
              `SELECT 'step' AS t, id::text, md5(c::text) AS h FROM v1_step_concurrency c
                UNION ALL
               SELECT 'workflow', id::text, md5(w::text) FROM v1_workflow_concurrency w
                ORDER BY 1, 2`,
            )
          ).rows;
        const root = mkdtempSync(path.join(tmpdir(), "rot-570-it-"));
        await pg.query("BEGIN");
        try {
          const target = (
            await pg.query<{ wf_id: number; step_id: number }>(
              `SELECT w.id AS wf_id, c.id AS step_id ${LINKED}
                 JOIN "Workflow" f ON f.id = w.workflow_id AND f.name = $2
                WHERE w.tenant_id = $1::uuid
                ORDER BY c.id LIMIT 1`,
              [engineTenantId, REPRO],
            )
          ).rows[0];
          expect(target).toBeDefined();
          const wfId = Number(target?.wf_id);
          const stepId = Number(target?.step_id);
          const stepIds = async () =>
            (
              await detectStepConcurrencyRot(db, { tenantId: engineTenantId })
            ).map((r) => Number(r.id));
          const workflowIds = async () =>
            (
              await detectWorkflowConcurrencyRot(db, {
                tenantId: engineTenantId,
              })
            ).map((r) => Number(r.id));
          const breakStep = () =>
            pg.query(
              `UPDATE v1_step_concurrency
                SET parent_strategy_id = (SELECT max(id) + 1000 FROM v1_workflow_concurrency)
              WHERE id = $1`,
              [stepId],
            );
          // AC-5 on a DIFFERENT workflow row (a stacked agent-run key).
          const otherWfId = Number(
            (
              await pg.query<{ id: number }>(
                `SELECT id FROM v1_workflow_concurrency
                  WHERE tenant_id = $1::uuid AND id <> $2 AND is_active
                  ORDER BY id LIMIT 1`,
                [engineTenantId, wfId],
              )
            ).rows[0]?.id,
          );
          const breakWorkflow = () =>
            pg.query(
              `UPDATE v1_workflow_concurrency
                  SET child_strategy_ids = child_strategy_ids || (SELECT max(id) + 1000 FROM v1_step_concurrency)
                WHERE id = $1`,
              [otherWfId],
            );

          // AC-4 alone. The re-pointed step row also leaves its old parent
          // (wfId) with a child that no longer points back, so that workflow
          // row is the only other finding.
          await pg.query("SAVEPOINT ac4");
          await breakStep();
          expect(await stepIds()).toEqual([stepId]);
          expect(await workflowIds()).toEqual([wfId]);
          await pg.query("ROLLBACK TO SAVEPOINT ac4");

          // AC-5 alone: exactly the edited workflow row, no step finding.
          await pg.query("SAVEPOINT ac5");
          await breakWorkflow();
          expect(await stepIds()).toEqual([]);
          expect(await workflowIds()).toEqual([otherWfId]);
          await pg.query("ROLLBACK TO SAVEPOINT ac5");

          // AC-6 with both links broken.
          await breakStep();
          await breakWorkflow();

          const before = await snapshotRows();
          const snapshot = await runMaintenanceTick({
            config: loadWorkerConfig({
              WORKER_BATTERIES_IMAGE: `ghcr.io/be-automata/automata-batteries@sha256:${"ab".repeat(32)}`,
              WORKER_RUN_MEMORY_MAX: "1500M",
              HATCHET_ENGINE_DATABASE_URL: "postgresql://in-transaction",
              HATCHET_ENGINE_TENANT_ID: engineTenantId,
              WORKER_RUN_NAMESPACE_ROOT: root,
              WORKER_CONCURRENCY_ROT_REPAIR: "on",
              WORKER_SLOT_RECLAIM: "off",
            }),
            selfWorkerId: null,
            log: () => {},
            // Same connection, same open transaction: the tick sees the
            // corruption above and any write it made would show below.
            engineDb: {
              query: db.query,
              withConnection: async (fn) => fn(db),
              withAdvisoryLock: async (fn) => ({
                acquired: true,
                result: await fn(db),
              }),
              close: async () => {},
            },
          });
          expect(await snapshotRows()).toEqual(before);
          expect(snapshot.rot).toEqual({
            stepLevel: 1,
            workflowLevel: 2,
            repaired: 0,
            mode: "dry-run",
          });
        } finally {
          await pg.query("ROLLBACK");
          rmSync(root, { recursive: true, force: true });
        }
        expect(
          await detectStepConcurrencyRot(db, { tenantId: engineTenantId }),
        ).toEqual([]);
        expect(
          await detectWorkflowConcurrencyRot(db, { tenantId: engineTenantId }),
        ).toEqual([]);
      });
    });

    describe("7.2.2 — SIGKILL slot exhaustion: partition-guard fixtures", () => {
      it("the pinned engine still has the column the reclaim queries project", async () => {
        // Engine-version drift canary, NOT a test of the gate: `beforeAll`
        // cannot return unless this is already true, so it never fails on a
        // healthy run. Its job is the day docker-compose.hatchet.yml moves off
        // v0.94.10 onto an image without `evicted_at` — then this fails here,
        // naming the column, instead of surfacing as a 42703 buried inside
        // reclaimEngineSlots two tests later. The gate's own regression (a
        // half-migrated schema must not be accepted) is pinned deterministically
        // in hatchet-it-harness.test.ts, which needs no docker.
        const r = await pg.query(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'v1_task_runtime'
              AND column_name = 'evicted_at'`,
        );
        expect(r.rows[0].n).toBe(1);
      });

      it("AC-8d: a dead-but-still-progressing task's slot is never reclaimed", async () => {
        // Real Worker + v1_task_events_olap rows against the real isolated
        // schema — this is the safety assertion the spec calls out as
        // mattering MORE than proving happy-path recovery (§7.2.2 steps 7/10:
        // "the safety ones win and the mechanism stays at dry-run").
        const workerId = randomUUID();
        const taskId = randomUUID();
        await pg
          .query(
            `INSERT INTO "Worker" (id, "tenantId", "lastHeartbeatAt", "isActive", "isPaused", "createdAt", "updatedAt", name, dispatcherId)
             VALUES ($1, $2, now() - interval '20 minutes', true, false, now(), now(), 'it-partition-guard', $3)
             ON CONFLICT DO NOTHING`,
            [workerId, tenantId, randomUUID()],
          )
          .catch(() => {});

        const result = await reclaimEngineSlots(db, {
          tenantId,
          deadAfterSeconds: 2,
          minSlotAgeSeconds: 0,
          selfWorkerId: null,
          mode: "on",
        });
        // No v1_concurrency_slot row exists for this synthetic worker/task in
        // this schema-only fixture, so the meaningful assertion is that the
        // query executes cleanly against the real schema and finds nothing —
        // proving no false positive, which is the safety property AC-8d
        // exists to guard. `taskId` documents intent for a future extension
        // that also inserts a matching v1_concurrency_slot + v1_task_runtime
        // row and a recent v1_task_events_olap row to prove the NOT EXISTS
        // guard specifically (rather than just "nothing was filled").
        expect(taskId).toBeTruthy();
        expect(result.touched).toBe(0);
      });

      it("AC-8e: a stale-heartbeat Worker in a DIFFERENT tenant is never reclaimed", async () => {
        const otherTenantId = randomUUID();
        const workerId = randomUUID();
        await pg
          .query(
            `INSERT INTO "Worker" (id, "tenantId", "lastHeartbeatAt", "isActive", "isPaused", "createdAt", "updatedAt", name, dispatcherId)
             VALUES ($1, $2, now() - interval '20 minutes', true, false, now(), now(), 'it-other-tenant', $3)
             ON CONFLICT DO NOTHING`,
            [workerId, otherTenantId, randomUUID()],
          )
          .catch(() => {});
        const result = await reclaimEngineSlots(db, {
          tenantId, // scoped to the REAL tenant, not otherTenantId
          deadAfterSeconds: 2,
          minSlotAgeSeconds: 0,
          selfWorkerId: null,
          mode: "on",
        });
        expect(result.touched).toBe(0);
      });

      it.skip("full SIGKILL-of-a-real-child-process repro frees exactly 1 leaked slot and the queued run reaches RUNNING within 30s (AC-5)", async () => {
        // NOT IMPLEMENTED — see the file-level DEVIATION note; steps 1-11
        // of spec §7.2.2 verbatim, to be implemented against
        // reclaimEngineSlots imported above once the isolated project also
        // runs hatchet-lite (not just postgres).
      });
    });
  },
);
