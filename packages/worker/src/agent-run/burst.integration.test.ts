import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import {
  APIContracts,
  type Hatchet,
  type Worker,
} from "@hatchet-dev/typescript-sdk";
import { AGENT_RUN_VARIANTS, buildAgentRunDefinition } from "./definition";
import {
  REST,
  bootstrapTenant,
  composeDownV,
  composeUp,
  connectPg,
  pollUntil,
} from "./hatchet-it-harness";

/**
 * #372 / epic #193 AC 6: a synthetic burst at the RAISED caps against a real,
 * isolated hatchet-lite (HATCHET_IT=1; skipped otherwise, like its siblings).
 * 42 dispatches — the epic's observed busiest hour — on ONE variant
 * (`agent-run-strict`: GROUP_ROUND_ROBIN per PR, so distinct PR keys never
 * cancel each other and nothing is superseded) registered with the shipped
 * definition at caps global 3 / per-org 2 and a worker with `slots: 3`.
 *
 * What is asserted comes from the stub's own in-process execution log
 * (startedAt/endedAt per run — exact, no OLAP lag) plus the engine's terminal
 * status: every dispatched run reaches COMPLETED (none lost), never more than
 * 3 executed at once (the worker's slots), never more than 2 of one org at once
 * (the per-org cap — both caps are per workflow variant, which is why the
 * burst stays on one variant). The box-side ENOMEM half of AC 6 is the
 * production drill in deploy/uat/phase2-4.md; this is the engine half.
 *
 * SAFETY: the harness runs the isolated compose project `automata-hatchet-it`,
 * never the pilot's `automata-hatchet` (see hatchet-it-harness.ts).
 */
const Status = APIContracts.V1TaskStatus;
type Status = APIContracts.V1TaskStatus;
const TERMINAL: Status[] = [Status.COMPLETED, Status.CANCELLED, Status.FAILED];

type StubInput = {
  label: string;
  orgId: string;
  prKey: string;
  sleepMs: number;
};
type Execution = {
  label: string;
  orgId: string;
  startedAt: number;
  endedAt?: number;
};

const itEnabled = process.env.HATCHET_IT === "1";
// 42 runs at 3 wide × ~1 s each is ~15 s of execution plus scheduling; the
// budget below is a ceiling for a slow docker host, not an expectation.
vi.setConfig({ testTimeout: 240_000 });

const BURST = 42;
const ORGS = ["org-a", "org-b", "org-c"];
const CAPS = { globalMaxRuns: 3, perOrgMaxRuns: 2 };
const WORKER_SLOTS = 3;
const WORKFLOW = "agent-run-strict" as const;

describe.skipIf(!itEnabled)(
  "#372 synthetic burst at the raised caps (dockerized hatchet-lite, HATCHET_IT=1)",
  () => {
    let pg: Client;
    let tenantId: string;
    let token: string;
    let hatchet: Hatchet;
    let worker: Worker;
    const executions = new Map<string, Execution>();

    async function stubRun(
      input: StubInput,
      ctx: { cancelled: boolean },
    ): Promise<{ label: string }> {
      const ex: Execution = {
        label: input.label,
        orgId: input.orgId,
        startedAt: Date.now(),
      };
      executions.set(input.label, ex);
      const until = Date.now() + input.sleepMs;
      while (Date.now() < until && !ctx.cancelled) {
        await new Promise((r) => setTimeout(r, 50));
      }
      ex.endedAt = Date.now();
      return { label: input.label };
    }

    const uid = (p: string) =>
      `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    async function dispatch(
      o: Omit<StubInput, "label">,
      label: string,
    ): Promise<{ id: string; label: string }> {
      const res = await fetch(
        `${REST}/api/v1/stable/tenants/${tenantId}/workflow-runs/trigger`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workflowName: WORKFLOW,
            input: { ...o, label, deliveryId: uid("d") },
            additionalMetadata: { label, orgId: o.orgId },
          }),
        },
      );
      expect(res.status, `trigger ${label}`).toBe(200);
      const body = (await res.json()) as {
        run?: { metadata?: { id?: string } };
      };
      return { id: body.run?.metadata?.id ?? "", label };
    }

    const statusOf = async (id: string): Promise<Status> => {
      try {
        return await hatchet.runs.get_status(id);
      } catch (e) {
        if ((e as { response?: { status?: number } }).response?.status === 404)
          return Status.QUEUED;
        throw e;
      }
    };

    beforeAll(async () => {
      await composeUp();
      pg = await connectPg();
      ({ tenantId, token } = await bootstrapTenant(pg));
      process.env.HATCHET_CLIENT_TOKEN = token;
      process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
      const sdk = await import("@hatchet-dev/typescript-sdk");
      hatchet = sdk.Hatchet.init();
      // The SHIPPED definition at the raised caps — exactly what
      // buildWorkflows(caps) registers on a box with WORKER_GLOBAL_MAX_RUNS=3
      // WORKER_PER_ORG_MAX_RUNS=2 WORKER_BOX_SLOTS=3.
      const def = buildAgentRunDefinition(
        WORKFLOW,
        AGENT_RUN_VARIANTS[WORKFLOW],
        CAPS,
      );
      expect(def.task.slotCost).toBe(1);
      const wf = hatchet.workflow<StubInput>(def.workflow);
      wf.task({ ...def.task, fn: stubRun });
      worker = await hatchet.worker("it-burst-worker", {
        workflows: [wf],
        slots: WORKER_SLOTS,
      });
      void worker.start();
      await worker.waitUntilReady(60_000);
    }, 240_000);

    afterAll(async () => {
      await worker?.stop().catch(() => {});
      await pg?.end().catch(() => {});
      await composeDownV();
    }, 90_000);

    it(`${BURST} dispatches at caps ${CAPS.globalMaxRuns}/${CAPS.perOrgMaxRuns} with ${WORKER_SLOTS} slots: every run COMPLETED (none lost), at most ${WORKER_SLOTS} executing at once, at most ${CAPS.perOrgMaxRuns} per org at once`, async () => {
      const burstId = uid("burst");
      const dispatched: Array<{ id: string; label: string; orgId: string }> =
        [];
      for (let i = 0; i < BURST; i++) {
        const orgId = ORGS[i % ORGS.length]!;
        const label = `${burstId}-${i}`;
        const d = await dispatch(
          { orgId, prKey: `${orgId}/repo/${i}`, sleepMs: 1_000 },
          label,
        );
        dispatched.push({ ...d, orgId });
      }
      expect(dispatched.every((d) => d.id)).toBe(true);
      expect(new Set(dispatched.map((d) => d.id)).size).toBe(BURST);

      // Every run reaches a terminal state — and that state is COMPLETED.
      const finals = new Map<string, Status>();
      await pollUntil(
        "every burst run terminal",
        async () => {
          for (const d of dispatched) {
            if (finals.has(d.id)) continue;
            const s = await statusOf(d.id);
            if (TERMINAL.includes(s)) finals.set(d.id, s);
          }
          return finals.size;
        },
        (n) => n === BURST,
        200_000,
        500,
      );
      const tally: Record<string, number> = {};
      for (const s of finals.values()) tally[s] = (tally[s] ?? 0) + 1;
      expect(tally, JSON.stringify(tally)).toEqual({
        [Status.COMPLETED]: BURST,
      });
      expect(executions.size).toBe(BURST);

      // Overlap from the stub's own clock: sweep every start/end edge.
      const edges: Array<{ t: number; d: 1 | -1; orgId: string }> = [];
      for (const ex of executions.values()) {
        expect(ex.endedAt, ex.label).toBeDefined();
        edges.push({ t: ex.startedAt, d: 1, orgId: ex.orgId });
        edges.push({ t: ex.endedAt!, d: -1, orgId: ex.orgId });
      }
      // Ends before starts at the same instant: a slot freed is a slot granted.
      edges.sort((a, b) => a.t - b.t || a.d - b.d);
      let live = 0;
      let maxLive = 0;
      const perOrg = new Map<string, number>();
      let maxPerOrg = 0;
      for (const e of edges) {
        live += e.d;
        maxLive = Math.max(maxLive, live);
        const o = (perOrg.get(e.orgId) ?? 0) + e.d;
        perOrg.set(e.orgId, o);
        maxPerOrg = Math.max(maxPerOrg, o);
      }
      expect(maxLive).toBeLessThanOrEqual(WORKER_SLOTS);
      expect(maxPerOrg).toBeLessThanOrEqual(CAPS.perOrgMaxRuns);
      // The raised caps were USED, not merely respected: with 42 one-second
      // runs and 3 slots the engine must have run more than one at a time.
      expect(maxLive).toBeGreaterThan(1);
      const starts = [...executions.values()].map((e) => e.startedAt).sort();
      const span = (starts.at(-1)! - starts[0]!) / 1000;
      // Serial would take ≥ 41 s of starts; three-wide stays well under that.
      expect(span).toBeLessThan(41);
    });
  },
);
