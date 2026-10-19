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
 * #371 against a REAL dockerized hatchet-lite (HATCHET_IT=1; skipped
 * otherwise, like its siblings). These are the ENGINE facts the design rests
 * on — the worker-side deferral loop itself is unit-tested in
 * workflow-cleanup.test.ts:
 *
 *  1. An in-process deferral wait is invisible to the engine: the task stays
 *     RUNNING, one attempt, completes.
 *  2. With `retries: 0` (the shipped shape) an executionTimeout is NOT retried:
 *     exactly one attempt, the run FAILS final. (Measured with retries > 0 the
 *     engine re-executed attempts 0, 1, 2 — the reason deferrals are not
 *     engine retries.)
 *  3. A newer run of the same PR under CANCEL_IN_PROGRESS cancels the older one
 *     that is waiting in process — newest-wins holds through a deferral.
 *     (Measured with engine retries the retry re-entered as the "newest" item
 *     and cancelled the newer run instead.)
 *
 * SAFETY: the harness runs the isolated compose project `automata-hatchet-it`,
 * never the pilot's `automata-hatchet` (see hatchet-it-harness.ts).
 */
const Status = APIContracts.V1TaskStatus;
type Status = APIContracts.V1TaskStatus;
const TERMINAL: Status[] = [Status.COMPLETED, Status.CANCELLED, Status.FAILED];

type StubInput = {
  label: string;
  mode: "wait-then-complete" | "sleep" | "outlive-timeout";
  /** Same prKey ⇒ same per-PR concurrency group (supersede policies). */
  prKey?: string;
};

const itEnabled = process.env.HATCHET_IT === "1";
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!itEnabled)(
  "#371 admission deferral — engine facts (dockerized hatchet-lite, HATCHET_IT=1)",
  () => {
    let pg: Client;
    let tenantId: string;
    let token: string;
    let hatchet: Hatchet;
    let worker: Worker;
    /** label → retryCount of each attempt that EXECUTED, in order. */
    const attempts = new Map<string, number[]>();
    const WORKFLOW = "agent-run";
    const NEWEST_WORKFLOW = "agent-run-newest";
    /** CANCEL_NEWEST is irrelevant for one run; it carries the 3 s timeout. */
    const TIMEOUT_WORKFLOW = "agent-run-discard";

    async function stubRun(
      input: StubInput,
      ctx: { retryCount?: () => number; cancelled: boolean },
    ): Promise<{ label: string }> {
      attempts.set(input.label, [
        ...(attempts.get(input.label) ?? []),
        ctx.retryCount?.() ?? 0,
      ]);
      const sleepTicks = async (ticks: number) => {
        for (let i = 0; i < ticks && !ctx.cancelled; i++) {
          await new Promise((r) => setTimeout(r, 200));
        }
      };
      if (input.mode === "wait-then-complete") {
        // The worker's deferral wait, as the engine sees it: a running task
        // that does nothing for a while, then proceeds. 10 s — clearly longer
        // than hatchet-lite's OLAP status lag, so the RUNNING window is
        // observable by a 100 ms poll (a shorter stub could go QUEUED →
        // COMPLETED between two reads and fail this IT without a regression).
        await sleepTicks(50);
      } else if (input.mode === "sleep") {
        await sleepTicks(40);
      } else {
        await sleepTicks(100); // outlives the 3 s executionTimeout
      }
      return { label: input.label };
    }

    const uid = (p: string) =>
      `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    async function dispatch(
      o: StubInput,
      workflowName: string = WORKFLOW,
    ): Promise<{ id: string; label: string }> {
      const label = uid(o.label);
      const res = await fetch(
        `${REST}/api/v1/stable/tenants/${tenantId}/workflow-runs/trigger`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workflowName,
            input: {
              ...o,
              label,
              orgId: "org-a",
              deliveryId: uid("d"),
              prKey: o.prKey ?? uid("pr"),
            },
            additionalMetadata: { label },
          }),
        },
      );
      expect(res.status).toBe(200);
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
    const waitTerminal = (id: string, label: string) =>
      pollUntil(
        `${label} terminal`,
        () => statusOf(id),
        (s) => TERMINAL.includes(s),
        110_000,
        250,
      );

    beforeAll(async () => {
      await composeUp();
      pg = await connectPg();
      ({ tenantId, token } = await bootstrapTenant(pg));
      process.env.HATCHET_CLIENT_TOKEN = token;
      process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
      const sdk = await import("@hatchet-dev/typescript-sdk");
      hatchet = sdk.Hatchet.init();
      const make = (
        name: keyof typeof AGENT_RUN_VARIANTS,
        timeout?: string,
      ) => {
        const def = buildAgentRunDefinition(name, AGENT_RUN_VARIANTS[name]);
        expect(def.task.retries).toBe(0);
        const wf = hatchet.workflow<StubInput>(def.workflow);
        wf.task({
          ...def.task,
          ...(timeout
            ? {
                executionTimeout: timeout as typeof def.task.executionTimeout,
              }
            : {}),
          fn: stubRun,
        });
        return wf;
      };
      worker = await hatchet.worker("it-admission-worker", {
        workflows: [
          make(WORKFLOW),
          make(NEWEST_WORKFLOW),
          make(TIMEOUT_WORKFLOW, "3s"),
        ],
        slots: 4,
      });
      void worker.start();
      await worker.waitUntilReady(60_000);
    }, 240_000);

    afterAll(async () => {
      await worker?.stop().catch(() => {});
      await pg?.end().catch(() => {});
      await composeDownV();
    }, 90_000);

    it("an in-process deferral wait is invisible to the engine: RUNNING throughout, one attempt, COMPLETED", async () => {
      const { id, label } = await dispatch({
        label: "wait",
        mode: "wait-then-complete",
      });
      // The OLAP status can lag the dispatch (QUEUED, or a 404 read as QUEUED,
      // for a moment after the stub has started), so sample from the first
      // RUNNING read onwards.
      const seen: Status[] = [];
      const final = await pollUntil(
        `${label} terminal`,
        async () => {
          const s = await statusOf(id);
          if (seen.length > 0 || s === Status.RUNNING) seen.push(s);
          return s;
        },
        (s) => TERMINAL.includes(s),
        90_000,
        100,
      );
      expect(final).toBe(Status.COMPLETED);
      expect(attempts.get(label)).toEqual([0]);
      // From the first RUNNING to the terminal read nothing but RUNNING was
      // observed — no QUEUED (an engine retry), no FAILED.
      expect(seen.length).toBeGreaterThan(1);
      expect(new Set(seen.slice(0, -1))).toEqual(new Set([Status.RUNNING]));
      expect(seen.at(-1)).toBe(Status.COMPLETED);
    });

    it("retries 0 on the shipped shape: an executionTimeout is NOT re-executed — one attempt, FAILED final", async () => {
      const { id, label } = await dispatch(
        { label: "timeout", mode: "outlive-timeout" },
        TIMEOUT_WORKFLOW,
      );
      const final = await waitTerminal(id, label);
      await new Promise((r) => setTimeout(r, 6_000));
      expect(attempts.get(label)).toEqual([0]);
      expect(final).toBe(Status.FAILED);
    });

    it("newest-wins holds through a deferral: a newer run of the same PR cancels the older one waiting in process, and itself completes", async () => {
      const prKey = uid("pr-nw");
      const a = await dispatch(
        { label: "nw-A", mode: "sleep", prKey },
        NEWEST_WORKFLOW,
      );
      await pollUntil(
        `${a.label} started`,
        async () => attempts.get(a.label)?.length ?? 0,
        (n) => n >= 1,
        30_000,
        50,
      );
      const b = await dispatch(
        { label: "nw-B", mode: "wait-then-complete", prKey },
        NEWEST_WORKFLOW,
      );
      const fa = await waitTerminal(a.id, a.label);
      const fb = await waitTerminal(b.id, b.label);
      expect(fa).toBe(Status.CANCELLED);
      expect(fb).toBe(Status.COMPLETED);
      expect(attempts.get(a.label)).toEqual([0]);
      expect(attempts.get(b.label)).toEqual([0]);
    });
  },
);
