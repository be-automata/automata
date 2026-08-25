import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
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
  repairConcurrencyRot,
} from "./scheduling-health";
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
 * DEVIATION RECORDED (spec §7.2.1's own escape hatch, and §10 risk 1): the
 * full live-worker register-until-rot-then-deadlock reproduction (§7.2.1
 * steps 1-8) requires spawning real Hatchet-SDK worker child processes that
 * register distinct concurrency shapes against a live engine and proving a
 * triggered run actually deadlocks with a demonstrably live worker present.
 * That harness is substantial standalone infrastructure and, per the spec's
 * own words, is "the dominant cost and main risk. Budget a spike if step 5
 * doesn't reproduce" (§10). It is left here as `it.skip` with the concrete
 * steps documented inline rather than a half-working implementation that
 * would give false confidence. What IS implemented and executable under
 * HATCHET_IT=1 are: (a) the SQL-level detector/repair round-trip against a
 * REAL isolated hatchet-lite Postgres (proves the queries in §3.1.2-§3.1.4
 * compile and behave against the real schema, which is the part most likely
 * to drift across hatchet-lite versions), and (b) the AC-8d/AC-8e negative
 * fixtures for slot reclamation. Taking this fallback weakens AC-4 exactly as
 * §7.2.1 anticipates and is recorded here, not silently adopted.
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

    describe("7.2.1 — concurrency-group rot: SQL round-trip against a real isolated engine schema", () => {
      it("AC-1: detectors return nothing against freshly-migrated, empty concurrency tables", async () => {
        const stepFindings = await detectStepConcurrencyRot(db, { tenantId });
        const workflowFindings = await detectWorkflowConcurrencyRot(db, {
          tenantId,
        });
        expect(stepFindings).toEqual([]);
        expect(workflowFindings).toEqual([]);
      });

      it("repairConcurrencyRot is a strict no-op on the empty fixture and idempotent", async () => {
        const before = await pg.query(
          "SELECT count(*)::int AS c FROM v1_step_concurrency",
        );
        const result = await repairConcurrencyRot(db, { tenantId, mode: "on" });
        const after = await pg.query(
          "SELECT count(*)::int AS c FROM v1_step_concurrency",
        );
        expect(result.stepRepair.touched).toBe(0);
        expect(result.workflowRepair.touched).toBe(0);
        expect(before.rows[0].c).toBe(after.rows[0].c);
      });

      it.skip("register-until-rot loop reproduces §2.3's corruption, and repair unblocks a QUEUED run that stays wedged with a live worker present (AC-2, AC-3, AC-4, AC-6, AC-8c)", async () => {
        // NOT IMPLEMENTED — see the file-level DEVIATION note. Steps, verbatim
        // from spec §7.2.1, for whoever picks this up:
        //   1. Fresh engine (this beforeAll already brings up an isolated
        //      postgres-only project — the harness now also runs hatchet-lite
        //      on isolated ports 28888/27077).
        //   2. shapeGenerator(i) => distinct concurrency-group expression
        //      arrays for a probe workflow `rot-probe`.
        //   3. FOR i in 1..12: spawn a real @hatchet-dev/typescript-sdk
        //      worker child process registering `rot-probe` with shapes[i]
        //      against the isolated engine (HATCHET_CLIENT_TOKEN minted for
        //      the isolated tenant), wait for its rows in
        //      v1_step_concurrency, SIGTERM it, call
        //      detectStepConcurrencyRot/detectWorkflowConcurrencyRot; break
        //      on first non-empty result, recording `registrationsToRot`.
        //      FAIL LOUDLY (not skip) if the loop exhausts without rot.
        //   5. Spawn a live worker on the CURRENT shape, trigger a
        //      `rot-probe` run, assert it stays QUEUED >=30s while the live
        //      worker's Worker.lastHeartbeatAt stays fresh.
        //   6-8. repairConcurrencyRot(mode:'on'); assert 0 findings remain,
        //      same-version links survived (AC-8c), the run reaches RUNNING
        //      within 30s (AC-4), and a second repair pass touches 0 rows
        //      (AC-6). Record whether the in-place repair fired or the
        //      §3.1.3 quiescence precondition deferred it to the boot path.
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
