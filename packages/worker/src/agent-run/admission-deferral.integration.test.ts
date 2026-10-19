import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import {
  APIContracts,
  type Hatchet,
  type Worker,
} from "@hatchet-dev/typescript-sdk";
import { AGENT_RUN_VARIANTS, buildAgentRunDefinition } from "./definition";
import { AdmissionDeferredError } from "./headroom";
import { fenceNonRetryable } from "./retry-classification";
import {
  REST,
  bootstrapTenant,
  composeDownV,
  composeUp,
  connectPg,
  pollUntil,
} from "./hatchet-it-harness";

/**
 * #371 AC 6 — the engine re-queue proof, against a REAL dockerized hatchet-lite
 * (HATCHET_IT=1; skipped otherwise, like its siblings). The unit tests prove the
 * worker throws `AdmissionDeferredError` before any side effect and fences every
 * later error non-retryable; what only the engine can prove is the other half of
 * ADR-007 Decision 5: a deferral is a DELAY. The run must read QUEUED between
 * attempts — never FAILED, never CANCELLED — and COMPLETE on the attempt that
 * admits, with `ctx.retryCount()` = 1 on that attempt. And the fence must hold
 * on the same registration: a plain error after admission fails ONCE, with no
 * second execution, whatever `retries` says.
 *
 * SAFETY: the harness runs the isolated compose project `automata-hatchet-it`,
 * never the pilot's `automata-hatchet` (see hatchet-it-harness.ts).
 */
const Status = APIContracts.V1TaskStatus;
type Status = APIContracts.V1TaskStatus;
const TERMINAL: Status[] = [Status.COMPLETED, Status.CANCELLED, Status.FAILED];

type StubInput = { label: string; mode: "defer-once" | "fail-after-admission" };

const itEnabled = process.env.HATCHET_IT === "1";
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!itEnabled)(
  "#371 admission deferral E2E (dockerized hatchet-lite, HATCHET_IT=1)",
  () => {
    let pg: Client;
    let tenantId: string;
    let token: string;
    let hatchet: Hatchet;
    let worker: Worker;
    /** label → the retryCount the engine handed each attempt, in order. */
    const attempts = new Map<string, number[]>();
    const WORKFLOW = "agent-run";

    async function stubRun(
      input: StubInput,
      ctx: { retryCount?: () => number },
    ): Promise<{ label: string }> {
      const attempt = ctx.retryCount?.() ?? 0;
      attempts.set(input.label, [
        ...(attempts.get(input.label) ?? []),
        attempt,
      ]);
      if (input.mode === "defer-once" && attempt === 0) {
        // Exactly what the headroom check throws: plain Error subclass.
        throw new AdmissionDeferredError(
          "mem-available-below-floor",
          {
            memAvailable: 1,
            committedAs: 2,
            commitLimit: 3,
            reserved: 0,
            floor: 5,
            fraction: 0.9,
            runCommit: 6,
          },
          attempt,
        );
      }
      if (input.mode === "fail-after-admission") {
        // The run's own fence: a plain error after admission must not retry.
        throw fenceNonRetryable(new Error("agent exploded after admission"));
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

    beforeAll(async () => {
      await composeUp();
      pg = await connectPg();
      ({ tenantId, token } = await bootstrapTenant(pg));
      process.env.HATCHET_CLIENT_TOKEN = token;
      process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
      const sdk = await import("@hatchet-dev/typescript-sdk");
      hatchet = sdk.Hatchet.init();
      // The SHIPPED `agent-run` shape with the #371 registration: retries = the
      // deferral budget, exponential backoff.
      const def = buildAgentRunDefinition(
        WORKFLOW,
        AGENT_RUN_VARIANTS[WORKFLOW],
        {
          admissionRetries: 2,
        },
      );
      expect(def.task.retries).toBe(2);
      expect(def.task.backoff).toBeDefined();
      const wf = hatchet.workflow<StubInput>(def.workflow);
      wf.task({ ...def.task, fn: stubRun });
      worker = await hatchet.worker("it-admission-worker", {
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

    it("a deferral is a DELAY: the attempt that throws AdmissionDeferredError is re-queued (QUEUED, never FAILED/CANCELLED) and the next attempt runs with retryCount 1 and completes", async () => {
      const { id, label } = await dispatch({
        label: "defer",
        mode: "defer-once",
      });
      // Sample (status, attempts so far) until terminal. The pre-start 404 also
      // reads as QUEUED, so the re-queue proof is QUEUED observed AFTER attempt 0
      // ran and BEFORE attempt 1 did — the backoff window.
      const seen: Array<[Status, number]> = [];
      const final = await pollUntil(
        `${label} terminal`,
        async () => {
          const s = await statusOf(id);
          seen.push([s, attempts.get(label)?.length ?? 0]);
          return s;
        },
        (s) => TERMINAL.includes(s),
        90_000,
        100,
      );
      expect(final).toBe(Status.COMPLETED);
      const statuses = seen.map(([s]) => s);
      expect(statuses).not.toContain(Status.FAILED);
      expect(statuses).not.toContain(Status.CANCELLED);
      expect(
        seen.some(([s, n]) => s === Status.QUEUED && n === 1),
        `QUEUED between the attempts; saw ${JSON.stringify(seen)}`,
      ).toBe(true);
      expect(attempts.get(label)).toEqual([0, 1]);
    });

    it("exactly-once: a plain error after admission is fenced non-retryable — the run FAILS once and never re-executes, even with retries registered", async () => {
      const { id, label } = await dispatch({
        label: "fence",
        mode: "fail-after-admission",
      });
      const final = await pollUntil(
        `${label} terminal`,
        () => statusOf(id),
        (s) => TERMINAL.includes(s),
        90_000,
        100,
      );
      expect(final).toBe(Status.FAILED);
      // Give a would-be retry well over its 2 s backoff; it must not come.
      await new Promise((r) => setTimeout(r, 6_000));
      expect(attempts.get(label)).toEqual([0]);
    });
  },
);
