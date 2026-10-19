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
  cancelled?: boolean;
};

const itEnabled = process.env.HATCHET_IT === "1";
// 42 runs at 3 wide × 3 s each is ~45 s of execution plus scheduling; the
// budget below is a ceiling for a slow docker host, not an expectation.
vi.setConfig({ testTimeout: 240_000 });

const BURST = 42;
const ORGS = ["org-a", "org-b", "org-c"];
/**
 * SKEWED, not round-robin: three orgs served fairly by GROUP_ROUND_ROBIN on
 * three slots would never put more than one run of any org live at once, and
 * the per-org cap would be untested. Most of the burst comes from org-a, so it
 * alone could fill all three slots — the cap must hold it to 2 while the other
 * orgs take the third slot (maxLive still reaches 3).
 */
const orgFor = (i: number): string =>
  i % 7 < 5 ? ORGS[0]! : ORGS[1 + (i % 2)]!;
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
      // Nothing in this burst is ever cancelled (distinct PR keys on the strict
      // variant), so one timer is the whole run.
      await new Promise((r) => setTimeout(r, input.sleepMs));
      if (ctx.cancelled) ex.cancelled = true;
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
      // Triggered one at a time ON PURPOSE. Observed on hatchet-lite v0.94.10
      // (2026-10-19): 42 CONCURRENT trigger POSTs left 31 runs COMPLETED on
      // the engine without ever being dispatched to the worker (11 executed,
      // serially) — a silently lost run, tracked as #395 with the skipped
      // concurrent variant below. This case proves AC 6 for sequential
      // triggers only.
      const dispatched: Array<{ id: string; label: string; orgId: string }> =
        [];
      for (let i = 0; i < BURST; i++) {
        const orgId = orgFor(i);
        // Every run outlives the whole sequential trigger loop (42 POSTs take
        // well under 3 s even on a slow docker host), so consecutive org-a
        // triggers ALWAYS overlap and the exact-peak assertions below do not
        // depend on POST latency.
        const sleepMs = 3_000;
        const d = await dispatch(
          { orgId, prKey: `${orgId}/repo/${i}`, sleepMs },
          `${burstId}-${i}`,
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
          const pending = dispatched.filter((d) => !finals.has(d.id));
          const statuses = await Promise.all(
            pending.map((d) => statusOf(d.id)),
          );
          pending.forEach((d, i) => {
            const s = statuses[i]!;
            if (TERMINAL.includes(s)) finals.set(d.id, s);
          });
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
      // Every engine-terminal run must ALSO have executed: a COMPLETED row
      // that never reached the stub is an engine fault, not a pass.
      expect(executions.size, `executed ${executions.size} of ${BURST}`).toBe(
        BURST,
      );

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
      const maxPerOrg = new Map<string, number>();
      for (const e of edges) {
        live += e.d;
        maxLive = Math.max(maxLive, live);
        const o = (perOrg.get(e.orgId) ?? 0) + e.d;
        perOrg.set(e.orgId, o);
        maxPerOrg.set(e.orgId, Math.max(maxPerOrg.get(e.orgId) ?? 0, o));
      }
      expect(maxLive).toBeLessThanOrEqual(WORKER_SLOTS);
      for (const [org, m] of maxPerOrg) {
        expect(m, org).toBeLessThanOrEqual(CAPS.perOrgMaxRuns);
      }
      // The caps were USED, not merely respected: org-a (30 of 42 runs) must
      // have reached the per-org cap exactly — it could have filled all three
      // slots and was held to 2 — while the other orgs took the third slot.
      const shape = JSON.stringify({ maxLive, maxPerOrg: [...maxPerOrg] });
      expect(maxPerOrg.get(ORGS[0]!), shape).toBe(CAPS.perOrgMaxRuns);
      expect(maxLive, shape).toBe(WORKER_SLOTS);
      expect([...executions.values()].some((e) => e.cancelled)).toBe(false);
    });

    // #395: the same burst with every trigger in flight at once. Fails today
    // on hatchet-lite v0.94.10 (31 of 42 runs reach COMPLETED without ever
    // executing). Kept skipped so the regression stays visible and
    // reproducible; unskip to investigate.
    it.skip(`#395: ${BURST} CONCURRENT triggers — every run that reaches COMPLETED must have executed`, async () => {
      const burstId = uid("cburst");
      const dispatched = await Promise.all(
        Array.from({ length: BURST }, async (_, i) => {
          const orgId = orgFor(i);
          return dispatch(
            { orgId, prKey: `${orgId}/crepo/${i}`, sleepMs: 1_000 },
            `${burstId}-${i}`,
          );
        }),
      );
      expect(new Set(dispatched.map((d) => d.id)).size).toBe(BURST);
      const finals = new Map<string, Status>();
      await pollUntil(
        "every concurrent burst run terminal",
        async () => {
          const pending = dispatched.filter((d) => !finals.has(d.id));
          const statuses = await Promise.all(
            pending.map((d) => statusOf(d.id)),
          );
          pending.forEach((d, i) => {
            if (TERMINAL.includes(statuses[i]!)) finals.set(d.id, statuses[i]!);
          });
          return finals.size;
        },
        (c) => c === BURST,
        200_000,
        500,
      );
      const executed = dispatched.filter((d) => executions.has(d.label)).length;
      expect(executed, "executed of terminal").toBe(finals.size);
    });
  },
);
