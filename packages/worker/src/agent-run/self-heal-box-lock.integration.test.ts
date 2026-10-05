import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  APIContracts,
  type Hatchet,
  type Worker,
  type WorkflowDeclaration,
} from "@hatchet-dev/typescript-sdk";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withBoxLock } from "./box-lock";
import {
  AGENT_RUN_VARIANTS,
  buildAgentRunDefinition,
  type AgentRunVariantName,
} from "./definition";
import {
  REST,
  bootstrapTenant,
  composeDownV,
  composeUp,
  connectPg,
  pollUntil,
} from "./hatchet-it-harness";

/**
 * RES-12 (phase 9): a PR review dispatched while a self-heal run holds the box
 * is QUEUED behind it and starts once the holder lets go — it is neither
 * starved past its 30 m schedule timeout nor cancelled.
 *
 * Shape under test, against a REAL isolated hatchet-lite engine (HATCHET_IT=1,
 * compose project automata-hatchet-it, same harness as
 * supersede.integration.test.ts) with the SHIPPED registration shapes and a
 * stub fn:
 *   - self-heal fix runs dispatch on the legacy `agent-run` workflow (no
 *     supersedePolicy — the task lane);
 *   - reviews dispatch on a policy variant (`agent-run-newest` here);
 *   - concurrency groups are scoped PER WORKFLOW on hatchet-lite v0.94.10
 *     (docs/uat/hatchet-lite-v0.94.10-observed.md §5), so the engine admits
 *     the review while the task run is live and the worker's kernel box lock
 *     (box-lock.ts) is what makes it wait. That wait happens inside the task
 *     fn, so the review is waiting on the lock — engine status QUEUED or
 *     RUNNING, never executing its body — until the holder releases.
 *
 * Engine priority is NOT adopted for reviews: it is unverified on
 * hatchet-lite, and a separate review workflow would add a competing
 * concurrency group. The www admission gate (09-05) is the bulkhead that
 * keeps the self-heal lane to one box slot.
 */

const Status = APIContracts.V1TaskStatus;
type Status = APIContracts.V1TaskStatus;
const TERMINAL: Status[] = [Status.COMPLETED, Status.CANCELLED, Status.FAILED];

/** How long the self-heal run's fake agent holds the box lock. */
const HOLD_MS = 20_000;
/** The review is dispatched this long after the holder starts executing. */
const REVIEW_DELAY_MS = 2_000;
/** Slack allowed between the holder releasing and the review starting. */
const START_SLACK_MS = 30_000;

type StubInput = { label: string; sleepMs: number };

type Execution = {
  label: string;
  /** The task fn was entered (engine admitted the run; may wait on the lock). */
  enteredAt: number;
  /** The box lock was acquired and the body started. */
  startedAt?: number;
  endedAt?: number;
  cancelled: boolean;
};

const itEnabled = process.env.HATCHET_IT === "1";

vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!itEnabled)(
  "RES-12: a review queues behind a self-heal run on the box lock (dockerized hatchet-lite, HATCHET_IT=1)",
  () => {
    let pg: Client;
    let tenantId: string;
    let token: string;
    let hatchet: Hatchet;
    let worker: Worker;
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    let workflows: WorkflowDeclaration<StubInput, {}>[];
    const executions = new Map<string, Execution>();
    let boxLockDir = "";

    /** Every run holds the box lock for its body (production shape). */
    async function stubRun(
      input: StubInput,
      ctx: { cancelled: boolean; abortController?: AbortController },
    ): Promise<{ label: string }> {
      const ex: Execution = {
        label: input.label,
        enteredAt: Date.now(),
        cancelled: false,
      };
      executions.set(input.label, ex);
      return withBoxLock(
        {
          root: boxLockDir,
          holder: input.label,
          signal: ctx.abortController?.signal,
        },
        async () => {
          ex.startedAt = Date.now();
          const until = Date.now() + input.sleepMs;
          while (Date.now() < until) {
            if (ctx.cancelled) {
              ex.cancelled = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          ex.endedAt = Date.now();
          return { label: input.label };
        },
      );
    }

    const uid = (p: string) =>
      `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    /** The control plane's REST trigger contract (copied, never imported). */
    async function dispatch(
      workflowName: AgentRunVariantName,
      o: { label: string; sleepMs: number; prKey?: string; orgId: string },
    ): Promise<{ id: string; label: string; triggeredAt: number }> {
      const input = {
        deliveryId: uid("d"),
        ...o,
        label: uid(o.label),
      };
      const triggeredAt = Date.now();
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
            input,
            additionalMetadata: { label: input.label },
          }),
        },
      );
      expect(res.status, `trigger ${workflowName}`).toBe(200);
      const body = (await res.json()) as {
        run?: { metadata?: { id?: string } };
      };
      const id = body.run?.metadata?.id ?? "";
      expect(id).not.toBe("");
      return { id, label: input.label, triggeredAt };
    }

    const statusOf = async (id: string): Promise<Status> => {
      try {
        return await hatchet.runs.get_status(id);
      } catch (e) {
        // The OLAP row can trail a fresh trigger: 404 = not started yet.
        if ((e as { response?: { status?: number } }).response?.status === 404)
          return Status.QUEUED;
        throw e;
      }
    };
    const waitTerminal = (id: string, what: string) =>
      pollUntil(
        `${what} terminal`,
        () => statusOf(id),
        (s) => TERMINAL.includes(s),
        HOLD_MS + START_SLACK_MS + 30_000,
      );
    const waitFor = async <T>(
      what: string,
      read: () => T | undefined,
    ): Promise<T> => {
      const v = await pollUntil(
        what,
        async () => read(),
        (x) => x !== undefined,
        60_000,
        10,
      );
      if (v === undefined) throw new Error(`${what}: no value`);
      return v;
    };

    beforeAll(async () => {
      boxLockDir = await mkdtemp(path.join(tmpdir(), "it-res12-box-lock-"));
      await composeUp();
      pg = await connectPg();
      ({ tenantId, token } = await bootstrapTenant(pg));

      process.env.HATCHET_CLIENT_TOKEN = token;
      process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
      const sdk = await import("@hatchet-dev/typescript-sdk");
      hatchet = sdk.Hatchet.init();

      // The SHIPPED shapes for every name production registers, stub fn.
      workflows = (
        Object.keys(AGENT_RUN_VARIANTS) as AgentRunVariantName[]
      ).map((name) => {
        const def = buildAgentRunDefinition(name, AGENT_RUN_VARIANTS[name]);
        const wf = hatchet.workflow<StubInput>(def.workflow);
        wf.task({ ...def.task, fn: stubRun });
        return wf;
      });
      // More slots than runs: only the box lock may serialise them.
      worker = await hatchet.worker("it-res12-worker", { workflows, slots: 8 });
      void worker.start();
      await worker.waitUntilReady(60_000);
    }, 240_000);

    afterAll(async () => {
      await worker?.stop().catch(() => {});
      await pg?.end().catch(() => {});
      await composeDownV();
      if (boxLockDir) await rm(boxLockDir, { recursive: true, force: true });
    }, 90_000);

    it("the review waits on the lock while the self-heal run holds it, then starts within hold + 30 s; nothing is cancelled or expired", async () => {
      // 1. The self-heal (task-lane) run takes the box.
      const holder = await dispatch("agent-run", {
        label: "self-heal-fix",
        sleepMs: HOLD_MS,
        orgId: "org-a",
      });
      const holderStartedAt = await waitFor(
        "self-heal run holds the lock",
        () => executions.get(holder.label)?.startedAt,
      );

      // 2. A review on a policy variant arrives 2 s later.
      await new Promise((r) => setTimeout(r, REVIEW_DELAY_MS));
      const review = await dispatch("agent-run-newest", {
        label: "review",
        sleepMs: 200,
        prKey: uid("org-a/repo/1"),
        orgId: "org-a",
      });

      // 3. While the lock is held the review is waiting: never executing,
      //    never terminal. Sample until shortly before the holder lets go.
      const waitingStatuses = new Set<Status>();
      const sampleUntil = holderStartedAt + HOLD_MS - 2_000;
      while (Date.now() < sampleUntil) {
        const status = await statusOf(review.id);
        waitingStatuses.add(status);
        expect(TERMINAL).not.toContain(status);
        expect(executions.get(review.label)?.startedAt).toBeUndefined();
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(executions.get(holder.label)?.endedAt).toBeUndefined();

      // 4. Both complete; the review started after the holder released and
      //    within the holder's remaining time + 30 s.
      expect(await waitTerminal(holder.id, "self-heal run")).toBe(
        Status.COMPLETED,
      );
      expect(await waitTerminal(review.id, "review")).toBe(Status.COMPLETED);
      const h = executions.get(holder.label)!;
      const r = executions.get(review.label)!;
      expect(h.cancelled).toBe(false);
      expect(r.cancelled).toBe(false);
      expect(r.startedAt!).toBeGreaterThanOrEqual(h.endedAt!);
      expect(r.startedAt! - h.endedAt!).toBeLessThanOrEqual(START_SLACK_MS);
      expect(r.startedAt! - review.triggeredAt).toBeLessThanOrEqual(
        HOLD_MS + START_SLACK_MS,
      );

      // Recorded, not asserted beyond "not terminal": on hatchet-lite v0.94.10
      // the review's own workflow admits it, so it waits inside the task fn.
      const admitted = r.enteredAt < h.endedAt!;
      console.log(
        `[RES-12] review engine statuses while waiting: ${[...waitingStatuses].join(",")}; ` +
          `admitted before release: ${admitted}; ` +
          `start after release: ${r.startedAt! - h.endedAt!}ms; ` +
          `dispatch-to-start: ${r.startedAt! - review.triggeredAt}ms`,
      );
    });
  },
);
