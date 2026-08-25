import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import {
  APIContracts,
  type Hatchet,
  type Worker,
  type WorkflowDeclaration,
} from "@hatchet-dev/typescript-sdk";
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
import { withBoxSlot } from "./box-slot";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * #125 C3 (#128): the supersede-policy E2E suite against a REAL, ISOLATED
 * hatchet-lite engine with a real SDK worker and a STUB task fn. The
 * concurrency + idempotency shapes under test are the shipped ones
 * (`buildAgentRunDefinition`), not a lookalike. Gated on HATCHET_IT=1 like
 * scheduling-health.integration.test.ts — skipped otherwise, so the default
 * worker suite stays docker-free. Stack safety lives in hatchet-it-harness.ts.
 *
 * No magic sleeps: every wait is a poll with a budget. Where engine semantics
 * were unknown up front (cancel-of-QUEUED under the global cap, cross-org
 * ordering under the global cap, delivery-id dedupe) the test ASSERTS what the
 * engine did on the first green run and freezes it as the documented contract
 * — see docs/uat/hatchet-lite-v0.94.10-observed.md. A future engine upgrade
 * that changes one of them breaks the matching case on purpose.
 */

const Status = APIContracts.V1TaskStatus;
type Status = APIContracts.V1TaskStatus;
const TERMINAL: Status[] = [Status.COMPLETED, Status.CANCELLED, Status.FAILED];

/** `boxSlot: true` runs the stub under the worker-side box slot (box-slot.ts). */
type StubInput = { label: string; sleepMs: number; boxSlot?: boolean };

/** What the stub fn saw for one execution (keyed by the input label). */
type Execution = {
  label: string;
  startedAt: number;
  endedAt?: number;
  cancelled: boolean;
};

const itEnabled = process.env.HATCHET_IT === "1";

// Every case polls a real engine; the 5s vitest default is not a scheduling budget.
vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!itEnabled)(
  "#125 C3 supersede policies E2E (dockerized hatchet-lite, HATCHET_IT=1)",
  () => {
    let pg: Client;
    let tenantId: string;
    let token: string;
    let hatchet: Hatchet;
    let worker: Worker;
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    let workflows: WorkflowDeclaration<StubInput, {}>[];
    const executions = new Map<string, Execution>();

    let boxSlotDir = "";

    /** The stub run fn: sleeps `input.sleepMs` in 100ms ticks, honouring cancel. */
    async function stubRun(
      input: StubInput,
      ctx: { cancelled: boolean; abortController?: AbortController },
    ): Promise<{ label: string }> {
      const body = async () => {
        const ex: Execution = {
          label: input.label,
          startedAt: Date.now(),
          cancelled: false,
        };
        executions.set(input.label, ex);
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
      };
      return input.boxSlot
        ? withBoxSlot(
            {
              dir: boxSlotDir,
              holder: input.label,
              signal: ctx.abortController?.signal,
              pollMs: 25,
            },
            body,
          )
        : body();
    }

    const uid = (p: string) =>
      `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    /**
     * Mirrors the control plane's REST trigger contract (apps/www transport.ts)
     * — copied, not imported: the worker never depends on www. Only the
     * discriminating fields are spelled at call sites; org/delivery default.
     */
    async function dispatch(
      workflowName: AgentRunVariantName,
      o: {
        label: string;
        sleepMs: number;
        prKey: string;
        orgId?: string;
        deliveryId?: string;
        boxSlot?: boolean;
      },
    ): Promise<{
      id: string;
      label: string;
      status: number;
      triggeredAt: number;
    }> {
      const input = {
        orgId: "org-a",
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
      const body = (await res.json().catch(() => ({}))) as {
        run?: { metadata?: { id?: string } };
      };
      return {
        id: body.run?.metadata?.id ?? "",
        label: input.label,
        status: res.status,
        triggeredAt,
      };
    }

    // A run triggered over gRPC can be a few ms ahead of its OLAP row; the
    // REST status read 404s until then — treat that as "not started yet".
    const statusOf = async (id: string): Promise<Status> => {
      try {
        return await hatchet.runs.get_status(id);
      } catch (e) {
        if ((e as { response?: { status?: number } }).response?.status === 404)
          return Status.QUEUED;
        throw e;
      }
    };
    const waitStatus = (id: string, wanted: Status[], what = id) =>
      pollUntil(
        `${what} ∈ ${wanted.join("|")}`,
        () => statusOf(id),
        (s) => wanted.includes(s),
      );
    const waitTerminal = (id: string, what?: string) =>
      waitStatus(id, TERMINAL, what);
    // In-memory reads: poll fast.
    const waitStarted = (label: string) =>
      pollUntil(
        `${label} started`,
        async () => executions.get(label),
        (e): e is Execution => e !== undefined,
        30_000,
        10,
      );
    const waitEnded = (label: string) =>
      pollUntil(
        `${label} ended`,
        async () => executions.get(label)?.endedAt,
        (t) => t !== undefined,
        30_000,
        10,
      );

    beforeAll(async () => {
      boxSlotDir = await mkdtemp(path.join(tmpdir(), "it-box-slot-"));
      await composeUp();
      pg = await connectPg();
      ({ tenantId, token } = await bootstrapTenant(pg));

      process.env.HATCHET_CLIENT_TOKEN = token;
      process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
      const sdk = await import("@hatchet-dev/typescript-sdk");
      hatchet = sdk.Hatchet.init();

      // The SHIPPED shapes, stub fn. All four names, exactly as production.
      workflows = (
        Object.keys(AGENT_RUN_VARIANTS) as AgentRunVariantName[]
      ).map((name) => {
        const def = buildAgentRunDefinition(name, AGENT_RUN_VARIANTS[name]);
        const wf = hatchet.workflow<StubInput>(def.workflow);
        wf.task({ ...def.task, fn: stubRun });
        return wf;
      });
      worker = await hatchet.worker("it-e2e-worker", { workflows, slots: 8 });
      void worker.start();
      await worker.waitUntilReady(60_000);
    }, 240_000);

    afterAll(async () => {
      await worker?.stop().catch(() => {});
      await pg?.end().catch(() => {});
      await composeDownV();
    }, 90_000);

    it("newest-wins (agent-run-newest, CANCEL_IN_PROGRESS): a second dispatch on the same prKey cancels the live run and runs itself", async () => {
      const prKey = uid("org-a/repo/1");
      const old = await dispatch("agent-run-newest", {
        label: "nw-old",
        sleepMs: 8000,
        prKey,
      });
      expect(old.status).toBe(200);
      await waitStatus(old.id, [Status.RUNNING], "old run");
      const fresh = await dispatch("agent-run-newest", {
        label: "nw-new",
        sleepMs: 200,
        prKey,
      });
      expect(await waitTerminal(old.id, "old")).toBe(Status.CANCELLED);
      expect(await waitTerminal(fresh.id)).toBe(Status.COMPLETED);
      // The stub observed the engine cancel (ctx.cancelled) — the seam the
      // worker's real run fn posts its `superseded` terminal from.
      expect(executions.get(old.label)?.cancelled).toBe(true);
    });

    it("complete-run · discard (agent-run-discard, CANCEL_NEWEST): the newcomer is CANCELLED, the incumbent finishes", async () => {
      const prKey = uid("org-a/repo/2");
      const incumbent = await dispatch("agent-run-discard", {
        label: "dc-old",
        sleepMs: 1500,
        prKey,
      });
      await waitStatus(incumbent.id, [Status.RUNNING]);
      const newcomer = await dispatch("agent-run-discard", {
        label: "dc-new",
        sleepMs: 200,
        prKey,
      });
      expect(await waitTerminal(newcomer.id)).toBe(Status.CANCELLED);
      expect(await waitTerminal(incumbent.id)).toBe(Status.COMPLETED);
      // A discarded newcomer never started executing (no credits burned).
      expect(executions.has(newcomer.label)).toBe(false);
    });

    it("complete-run · queue (agent-run-strict, GROUP_ROUND_ROBIN): strict FIFO per prKey, no overlap", async () => {
      const prKey = uid("org-a/repo/3");
      const runs = [];
      for (const label of ["q1", "q2", "q3"]) {
        runs.push(
          await dispatch("agent-run-strict", { label, sleepMs: 600, prKey }),
        );
      }
      for (const r of runs) {
        expect(await waitTerminal(r.id)).toBe(Status.COMPLETED);
      }
      const ex = runs.map((r) => executions.get(r.label));
      expect(ex.every((e) => e !== undefined)).toBe(true);
      for (let i = 1; i < ex.length; i++) {
        expect(ex[i - 1]!.endedAt!).toBeLessThanOrEqual(ex[i]!.startedAt);
      }
    });

    it("CHARACTERIZATION — mixed semantics under the global cap of 1: per-org GROUP_ROUND_ROBIN does NOT interleave orgs; the global single-group key is FIFO", async () => {
      // Org A has a backlog of 3 runs on 3 PRs; org B has 1, dispatched last.
      // The per-PR CANCEL_IN_PROGRESS entry never interferes (distinct PRs).
      const a = [];
      for (const [i, label] of ["a1", "a2", "a3"].entries()) {
        a.push(
          await dispatch("agent-run-newest", {
            label,
            sleepMs: 700,
            prKey: uid(`org-a/repo/${10 + i}`),
          }),
        );
      }
      const b = await dispatch("agent-run-newest", {
        label: "b1",
        sleepMs: 200,
        prKey: uid("org-b/repo/1"),
        orgId: "org-b",
      });
      for (const r of [...a, b]) {
        expect(await waitTerminal(r.id)).toBe(Status.COMPLETED);
      }
      const all = [...a, b]
        .map((r) => executions.get(r.label)!)
        .sort((x, y) => x.startedAt - y.startedAt);
      // Global cap of 1: no two executions overlap (the memory-budget invariant).
      for (let i = 1; i < all.length; i++) {
        expect(all[i - 1]!.endedAt!).toBeLessThanOrEqual(all[i]!.startedAt);
      }
      // CONTRACT (hatchet-lite v0.94.10, reproducible): pure FIFO — a1, a2,
      // a3, b1. The global cap is ONE concurrency group and GROUP_ROUND_ROBIN
      // over a single group is FIFO; the per-org entry only serializes within
      // an org. See docs/uat/hatchet-lite-v0.94.10-observed.md §1.
      expect(all.map((e) => e.label.slice(0, 2))).toEqual([
        "a1",
        "a2",
        "a3",
        "b1",
      ]);
    });

    it("CHARACTERIZATION: newest-wins on a run still QUEUED behind the global cap — the queued older run is cancelled before it ever starts", async () => {
      // Occupy the global slot with an unrelated run, then dispatch X1 then X2
      // on one prKey while X1 is still QUEUED. The blocker sleeps well past the
      // OLAP status-write lag (~1s): a shorter blocker lets X1 start and finish
      // before its "still QUEUED" read, which is what a 1.2s value did.
      const blocker = await dispatch("agent-run-newest", {
        label: "blocker",
        sleepMs: 2500,
        prKey: uid("org-z/repo/1"),
        orgId: "org-z",
      });
      await waitStatus(blocker.id, [Status.RUNNING]);
      const prKey = uid("org-a/repo/20");
      const x1 = await dispatch("agent-run-newest", {
        label: "x1",
        sleepMs: 300,
        prKey,
      });
      expect(await statusOf(x1.id)).toBe(Status.QUEUED);
      const x2 = await dispatch("agent-run-newest", {
        label: "x2",
        sleepMs: 300,
        prKey,
      });
      const x1Final = await waitTerminal(x1.id);
      const x2Final = await waitTerminal(x2.id);
      await waitTerminal(blocker.id);
      // CONTRACT (hatchet-lite v0.94.10): CANCEL_IN_PROGRESS cancels the
      // older run even while it is only QUEUED under the global cap; it never
      // executes. See docs/uat/hatchet-lite-v0.94.10-observed.md §2.
      expect(x1Final).toBe(Status.CANCELLED);
      expect(executions.has(x1.label)).toBe(false);
      expect(x2Final).toBe(Status.COMPLETED);
    });

    /**
     * Delivery-id idempotency (#127 AC4 / #126). CONTRACT (hatchet-lite
     * v0.94.10): the engine accepts the workflow-level `idempotency` config
     * but persists none and claims no key — a repeated deliveryId executes
     * twice over REST. This is the single flip point: the day an engine
     * upgrade dedupes, `idem-dup` stops executing and this case goes red —
     * then invert the assertions and close the follow-up. See
     * docs/uat/hatchet-lite-v0.94.10-observed.md §3.
     */
    it("CHARACTERIZATION (hatchet-lite v0.94.10): a repeated deliveryId is NOT deduped — two runs execute and no idempotency key is claimed", async () => {
      const prKey = uid("org-a/repo/30");
      const deliveryId = uid("gh-delivery");
      const keyCount = async () =>
        (await pg.query("SELECT count(*)::int AS n FROM v1_idempotency_key"))
          .rows[0].n as number;
      const keysBefore = await keyCount();
      const first = await dispatch("agent-run-strict", {
        label: "idem-1",
        sleepMs: 200,
        prKey,
        deliveryId,
      });
      const dup = await dispatch("agent-run-strict", {
        label: "idem-dup",
        sleepMs: 200,
        prKey,
        deliveryId,
      });
      expect(first.status).toBe(200);
      expect(dup.status).toBe(200);
      expect(dup.id).not.toBe(first.id);
      await waitTerminal(first.id);
      await waitTerminal(dup.id);
      expect(executions.has(first.label)).toBe(true);
      expect(executions.has(dup.label)).toBe(true);
      expect(await keyCount()).toBe(keysBefore);
    });

    it("a different deliveryId on the same prKey is always a second run", async () => {
      const prKey = uid("org-a/repo/32");
      const a = await dispatch("agent-run-strict", {
        label: "other-1",
        sleepMs: 100,
        prKey,
      });
      const b = await dispatch("agent-run-strict", {
        label: "other-2",
        sleepMs: 100,
        prKey,
      });
      expect(await waitTerminal(a.id)).toBe(Status.COMPLETED);
      expect(await waitTerminal(b.id)).toBe(Status.COMPLETED);
    });

    it("CHARACTERIZATION (hatchet-lite v0.94.10): concurrency groups are scoped PER WORKFLOW — the global memory-budget key does NOT cap across variants", async () => {
      const blocker = await dispatch("agent-run-newest", {
        label: "xv-blocker",
        sleepMs: 2500,
        prKey: uid("org-z/repo/8"),
        orgId: "org-z",
      });
      await waitStatus(blocker.id, [Status.RUNNING]);
      const other = await dispatch("agent-run-strict", {
        label: "xv-strict",
        sleepMs: 300,
        prKey: uid("org-a/repo/50"),
      });
      await waitTerminal(other.id);
      await waitTerminal(blocker.id);
      const b = executions.get(blocker.label)!;
      const o = executions.get(other.label)!;
      // CONTRACT: the strict run started WHILE the newest run was live. This
      // is why the worker enforces the box slot itself (next case; box-slot.ts).
      // See docs/uat/hatchet-lite-v0.94.10-observed.md §5.
      expect(o.startedAt).toBeLessThan(b.endedAt!);
    });

    it("worker box slot (box-slot.ts): runs on DIFFERENT variants never overlap on one box", async () => {
      const blocker = await dispatch("agent-run-newest", {
        label: "bs-blocker",
        sleepMs: 2500,
        prKey: uid("org-z/repo/9"),
        orgId: "org-z",
        boxSlot: true,
      });
      await waitStatus(blocker.id, [Status.RUNNING]);
      const other = await dispatch("agent-run-strict", {
        label: "bs-strict",
        sleepMs: 300,
        prKey: uid("org-a/repo/51"),
        boxSlot: true,
      });
      await waitTerminal(other.id);
      await waitTerminal(blocker.id);
      const b = executions.get(blocker.label)!;
      const o = executions.get(other.label)!;
      expect(o.startedAt).toBeGreaterThanOrEqual(b.endedAt!);
    });

    it("ROLLBACK DRILL (docs/runbooks/supersede-rollback.md step 2): pending native runs are bulk-cancelled — QUEUED first, then RUNNING — and nothing is left live", async () => {
      // Every run holds the worker box slot (production shape): one body
      // executes at a time on the box no matter what the engine admits (§5).
      const blocker = await dispatch("agent-run-strict", {
        label: "drill-blocker",
        sleepMs: 4000,
        prKey: uid("org-z/repo/9"),
        orgId: "org-z",
        boxSlot: true,
      });
      await waitStarted(blocker.label);
      const pending: Awaited<ReturnType<typeof dispatch>>[] = [];
      for (let i = 0; i < 3; i++) {
        pending.push(
          await dispatch("agent-run-strict", {
            label: `drill-p${i}`,
            // Long enough that a run admitted in the instant the blocker's
            // cancel frees the box slot cannot COMPLETE before its own cancel
            // is delivered (CI saw a 200ms body finish first — that is the
            // race the runbook describes, not a drill failure).
            sleepMs: 3000,
            prKey: uid(`org-a/repo/${40 + i}`),
            boxSlot: true,
          }),
        );
      }
      const listIds = async (statuses: Status[]) =>
        ((await hatchet.runs.list({ statuses })).rows ?? []).map(
          (r) => r.metadata.id,
        );
      // The OLAP list can lag a just-triggered run: wait until every pending
      // run is listed as QUEUED or RUNNING (engine-admitted but blocked on the
      // box slot) before draining.
      await pollUntil(
        "all pending runs listed",
        () => listIds([Status.QUEUED, Status.RUNNING]),
        (ids) => pending.every((r) => ids.includes(r.id)),
      );
      const cancel = async (ids: string[]) => {
        if (ids.length === 0) return;
        const res = await fetch(
          `${REST}/api/v1/stable/tenants/${tenantId}/tasks/cancel`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ externalIds: ids }),
          },
        );
        expect(res.ok).toBe(true);
      };
      // The runbook's order: QUEUED first (a cancelled running run frees its
      // slot at once and a still-queued run could otherwise start), then RUNNING.
      await cancel(await listIds([Status.QUEUED]));
      await cancel(await listIds([Status.RUNNING]));
      for (const r of pending) {
        expect(await waitTerminal(r.id)).toBe(Status.CANCELLED);
      }
      await waitTerminal(blocker.id);
      // No drained run COMPLETES. A cancel is delivered asynchronously, so a
      // run admitted in the very instant the blocker's cancel freed the box
      // slot can start its body — and is then cancelled on its first tick
      // (observed; see the runbook). Never a full execution.
      for (const r of pending) {
        const ex = executions.get(r.label);
        expect(ex === undefined || ex.cancelled).toBe(true);
      }
      const remaining = await pollUntil(
        "zero live runs after the drain",
        () => listIds([Status.QUEUED, Status.RUNNING]),
        (ids) => ids.length === 0,
      );
      expect(remaining).toEqual([]);
    });

    it("anti-rot (#69 regression guard): 50 sequential ephemeral per-PR groups — no scheduling degradation, zero residual QUEUED/RUNNING", async () => {
      // Latency = trigger → stub start, measured for run 1 and run 50 against
      // an IDLE scheduler (runs 2..49 are fired as a batch in between and
      // drained before run 50 so the measurement is honest and the loop is
      // seconds, not a minute). Each run is its own ephemeral per-PR group.
      const fire = (i: number) =>
        dispatch("agent-run-newest", {
          label: `rot-${i}`,
          sleepMs: 50,
          prKey: uid(`org-r/repo/${i}`),
          orgId: `org-r-${i % 3}`,
        });
      const measure = async (i: number) => {
        const r = await fire(i);
        expect(r.status).toBe(200);
        const ex = (await waitStarted(r.label))!;
        await waitEnded(r.label);
        return ex.startedAt - r.triggeredAt;
      };
      const first = await measure(1);
      const middle = [];
      for (let i = 2; i <= 49; i++) middle.push(await fire(i));
      for (const r of middle) await waitEnded(r.label);
      const last = await measure(50);
      // ≤ 2× run 1 with a 1s floor on the baseline: a 40ms-vs-90ms jitter
      // cannot fail a healthy scheduler; a rotted one shows seconds-to-forever.
      expect(last).toBeLessThanOrEqual(2 * Math.max(first, 1000));
      const live = await pollUntil(
        "zero live runs after drain",
        async () =>
          (
            await hatchet.runs.list({
              statuses: [Status.QUEUED, Status.RUNNING],
            })
          ).rows?.length ?? 0,
        (n) => n === 0,
      );
      expect(live).toBe(0);
    });
  },
);
