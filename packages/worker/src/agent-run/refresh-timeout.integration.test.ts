import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import {
  APIContracts,
  type Duration,
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
import { TASK_LANE_REFRESH } from "./run-budget";

/**
 * #742 OD-1 gate, against a REAL dockerized hatchet-lite (HATCHET_IT=1; skipped
 * otherwise, like its siblings). The task lane gets its 60-minute budget by
 * calling `ctx.refreshTimeout` on a task registered with `"30m"`. This IT
 * measures, at a 10 s scale, the facts that design rests on:
 *
 *  R1. A refreshed run outlives its registered timeout (and the task `ctx`
 *      the SDK hands the run fn carries a working `refreshTimeout`).
 *  R2. The semantics: ADDITIVE (deadline = registered + increment) or
 *      RESET-FROM-NOW (deadline = refresh time + increment). `TASK_LANE_REFRESH`
 *      in run-budget.ts must match, or this case fails.
 *  R3. `retries: 0` still means a timed-out REFRESHED run is never re-executed
 *      (the #371 fact, extended).
 *
 * R0 is the control: the registered timeout bites at this scale.
 */
const Status = APIContracts.V1TaskStatus;
type Status = APIContracts.V1TaskStatus;
const TERMINAL: Status[] = [Status.COMPLETED, Status.CANCELLED, Status.FAILED];

type StubInput = {
  label: string;
  /** Refresh increment and the offset (ms) at which it is called; none = no call. */
  refresh?: string;
  refreshAtMs?: number;
  /** How long the stub keeps working (ms), honouring `ctx.cancelled`. */
  runMs: number;
};

const itEnabled = process.env.HATCHET_IT === "1";
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!itEnabled)(
  "#742 refreshTimeout — engine facts (dockerized hatchet-lite, HATCHET_IT=1)",
  () => {
    let pg: Client;
    let tenantId: string;
    let token: string;
    let hatchet: Hatchet;
    let worker: Worker;
    const attempts = new Map<string, number[]>();
    const refreshTypes = new Map<string, string>();
    const WORKFLOW = "agent-run-discard";
    const TIMEOUT_S = 10;

    async function stubRun(
      input: StubInput,
      ctx: {
        retryCount?: () => number;
        cancelled: boolean;
        refreshTimeout?: (by: Duration) => Promise<void>;
      },
    ): Promise<{ label: string }> {
      attempts.set(input.label, [
        ...(attempts.get(input.label) ?? []),
        ctx.retryCount?.() ?? 0,
      ]);
      refreshTypes.set(input.label, typeof ctx.refreshTimeout);
      const started = Date.now();
      let refreshed = input.refresh === undefined;
      while (Date.now() - started < input.runMs && !ctx.cancelled) {
        if (!refreshed && Date.now() - started >= (input.refreshAtMs ?? 0)) {
          refreshed = true;
          await ctx.refreshTimeout?.(input.refresh as Duration);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return { label: input.label };
    }

    const uid = (p: string) =>
      `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    async function dispatch(
      o: StubInput,
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
            workflowName: WORKFLOW,
            input: {
              ...o,
              label,
              orgId: "org-a",
              deliveryId: uid("d"),
              prKey: uid("pr"),
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
      const def = buildAgentRunDefinition(
        WORKFLOW,
        AGENT_RUN_VARIANTS[WORKFLOW],
      );
      expect(def.task.retries).toBe(0);
      const wf = hatchet.workflow<StubInput>(def.workflow);
      wf.task({
        ...def.task,
        executionTimeout: `${TIMEOUT_S}s`,
        fn: stubRun,
      });
      worker = await hatchet.worker("it-refresh-worker", {
        workflows: [wf],
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

    it("R0 control: with no refresh the registered timeout bites — FAILED, one attempt", async () => {
      const { id, label } = await dispatch({ label: "r0", runMs: 15_000 });
      const final = await waitTerminal(id, label);
      expect(final).toBe(Status.FAILED);
      expect(attempts.get(label)).toEqual([0]);
    });

    it("R1 holds: a refreshed run outlives its registered timeout and COMPLETES (ctx.refreshTimeout is a function)", async () => {
      const { id, label } = await dispatch({
        label: "r1",
        refresh: "20s",
        refreshAtMs: 1_000,
        runMs: 15_000,
      });
      const final = await waitTerminal(id, label);
      expect(refreshTypes.get(label)).toBe("function");
      expect(final).toBe(Status.COMPLETED);
      expect(attempts.get(label)).toEqual([0]);
    });

    it("R2 semantics: TASK_LANE_REFRESH matches the engine (additive vs reset-from-now)", async () => {
      // refresh "10s" at t=4s, run 17s. Additive: deadline 10+10=20s -> the run
      // completes. Reset-from-now: deadline 4+10=14s -> the run is cancelled.
      const { id, label } = await dispatch({
        label: "r2",
        refresh: "10s",
        refreshAtMs: 4_000,
        runMs: 17_000,
      });
      const final = await waitTerminal(id, label);
      const additive = final === Status.COMPLETED;
      console.info(
        `#742 R2 measured: refreshTimeout is ${additive ? "ADDITIVE" : "RESET-FROM-NOW"} (final ${final})`,
      );
      // 30m on a registered 30m is the 60m budget only if additive.
      expect(additive).toBe(TASK_LANE_REFRESH === "30m");
      expect(attempts.get(label)).toEqual([0]);
    });

    it("R3 no re-execute: retries 0 never re-executes a timed-out REFRESHED run", async () => {
      const { id, label } = await dispatch({
        label: "r3",
        refresh: "10s",
        refreshAtMs: 1_000,
        runMs: 60_000,
      });
      const final = await waitTerminal(id, label);
      await new Promise((r) => setTimeout(r, 6_000));
      expect(final).toBe(Status.FAILED);
      expect(attempts.get(label)).toEqual([0]);
    });
  },
);
