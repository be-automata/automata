import { execFile } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import type { Hatchet, Worker } from "@hatchet-dev/typescript-sdk";
import { AGENT_RUN_VARIANTS, buildAgentRunDefinition } from "./definition";

const execFileAsync = promisify(execFile);

/**
 * #125 C3 (#128): the supersede-policy E2E suite against a REAL, ISOLATED
 * hatchet-lite engine with a real SDK worker and a STUB task fn. The
 * concurrency + idempotency shapes under test are the shipped ones
 * (`buildAgentRunDefinition`), not a lookalike. Gated on HATCHET_IT=1 like
 * scheduling-health.integration.test.ts — skipped otherwise, so the default
 * worker suite stays docker-free.
 *
 * SAFETY — never touches the live pilot engine: its own compose project
 * (`automata-hatchet-it`), its own ports (25433 / 28888 / 27077), and the
 * engine's broadcast address is overridden to the isolated gRPC port so a
 * minted token can never point a worker at the live 7077.
 *
 * No magic sleeps: every wait is a poll with a 30s budget (spec §Definiciones).
 * Where Hatchet semantics were unknown up front (cancel-of-QUEUED under the
 * global cap, cross-org ordering under the global cap, delivery-id dedupe),
 * the test ASSERTS the result observed on the first green run and freezes it
 * as the documented contract — a semantic change in a future engine upgrade
 * breaks it on purpose.
 */
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const COMPOSE_FILE = path.join(packageRoot, "docker-compose.hatchet.yml");
const IT_OVERRIDE_FILE = path.join(
  packageRoot,
  ".hatchet-it-e2e-override.generated.yml",
);
const COMPOSE_PROJECT_NAME = "automata-hatchet-it";
const IT_PG_PORT = 25433;
const IT_REST_PORT = 28888;
const IT_GRPC_PORT = 27077;
const IT_OVERRIDE_YAML = `services:
  postgres:
    ports:
      - "127.0.0.1:${IT_PG_PORT}:5432"
  hatchet-lite:
    ports: !override
      - "127.0.0.1:${IT_REST_PORT}:8888"
      - "127.0.0.1:${IT_GRPC_PORT}:7077"
    environment:
      SERVER_GRPC_BROADCAST_ADDRESS: localhost:${IT_GRPC_PORT}
      SERVER_URL: http://localhost:${IT_REST_PORT}
      SERVER_INTERNAL_CLIENT_INTERNAL_GRPC_BROADCAST_ADDRESS: localhost:7077
`;
const REST = `http://127.0.0.1:${IT_REST_PORT}`;
const POLL_BUDGET_MS = 30_000;

type Status = "QUEUED" | "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED";

/** What the stub fn saw for one execution (keyed by the input label). */
type Execution = {
  label: string;
  startedAt: number;
  endedAt?: number;
  cancelled: boolean;
};

async function compose(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", [
    "compose",
    "-f",
    COMPOSE_FILE,
    "-f",
    IT_OVERRIDE_FILE,
    "-p",
    COMPOSE_PROJECT_NAME,
    "--project-directory",
    packageRoot,
    ...args,
  ]);
  return stdout;
}

async function pollUntil<T>(
  what: string,
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  budgetMs = POLL_BUDGET_MS,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (ok(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${budgetMs}ms waiting for ${what}; last=${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const itEnabled = process.env.HATCHET_IT === "1";

// Every case polls a real engine (worker warm-up, cancel propagation, the 50-run
// anti-rot loop): the 5s vitest default is not a scheduling budget.
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!itEnabled)(
  "#125 C3 supersede policies E2E (dockerized hatchet-lite, HATCHET_IT=1)",
  () => {
    let pg: Client;
    let tenantId: string;
    let token: string;
    let hatchet: Hatchet;
    let worker: Worker;
    const executions = new Map<string, Execution>();
    // Declared workflows by name (SDK-side trigger path for the idempotency probe).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const declared = new Map<string, any>();

    /** The stub run fn: sleeps `input.sleepMs` in 100ms ticks, honouring cancel. */
    async function stubRun(
      input: { label: string; sleepMs: number },
      ctx: { cancelled: boolean },
    ): Promise<{ label: string }> {
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
    }

    async function trigger(
      workflowName: string,
      input: {
        label: string;
        sleepMs: number;
        prKey: string;
        orgId: string;
        deliveryId: string;
      },
    ): Promise<{ id: string; status: number; triggeredAt: number }> {
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
        status: res.status,
        triggeredAt,
      };
    }

    // A run triggered over gRPC can be a few ms ahead of its OLAP row; the
    // REST status read 404s until then — treat that as "not started yet".
    const statusOf = async (id: string): Promise<Status> => {
      try {
        return (await hatchet.runs.get_status(id)) as unknown as Status;
      } catch (e) {
        if ((e as { response?: { status?: number } }).response?.status === 404)
          return "QUEUED";
        throw e;
      }
    };

    const waitStatus = (id: string, wanted: Status[], what = id) =>
      pollUntil(
        `${what} ∈ ${wanted.join("|")}`,
        () => statusOf(id),
        (s) => wanted.includes(s),
      );

    const waitStarted = (label: string) =>
      pollUntil(
        `${label} started`,
        async () => executions.get(label),
        (e) => e !== undefined,
      );

    const uid = (p: string) =>
      `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    beforeAll(async () => {
      await writeFile(IT_OVERRIDE_FILE, IT_OVERRIDE_YAML, "utf8");
      await compose(["up", "-d", "postgres", "hatchet-lite"]);
      pg = await pollUntil(
        "postgres ready",
        async () => {
          const c = new Client({
            host: "127.0.0.1",
            port: IT_PG_PORT,
            user: "hatchet",
            password: "hatchet",
            database: "hatchet",
          });
          try {
            await c.connect();
            await c.query("SELECT 1");
            return c;
          } catch {
            await c.end().catch(() => {});
            return null;
          }
        },
        (c) => c !== null,
        90_000,
        1000,
      ).then((c) => c!);
      // hatchet-lite bootstraps the default tenant after its migrations.
      tenantId = await pollUntil(
        "default tenant",
        async () => {
          const r = await pg
            .query(`SELECT id FROM "Tenant" WHERE slug = 'default' LIMIT 1`)
            .catch(() => ({ rows: [] as { id: string }[] }));
          return r.rows[0]?.id ?? "";
        },
        (id) => id.length > 0,
        120_000,
        2000,
      );
      await pollUntil(
        "REST ready",
        () =>
          fetch(`${REST}/api/ready`)
            .then((r) => r.status)
            .catch(() => 0),
        (s) => s === 200,
        60_000,
        1000,
      );
      const minted = await compose([
        "exec",
        "-T",
        "hatchet-lite",
        "/hatchet-admin",
        "token",
        "create",
        "--config",
        "/config",
        "--tenant-id",
        tenantId,
        "--name",
        "it-e2e",
      ]);
      token = minted.trim().split("\n").pop()!.trim();
      expect(token.split(".")).toHaveLength(3);

      process.env.HATCHET_CLIENT_TOKEN = token;
      process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
      const sdk = await import("@hatchet-dev/typescript-sdk");
      hatchet = sdk.Hatchet.init();

      // The SHIPPED shapes, stub fn. All four names, exactly as production.
      const workflows = (
        Object.keys(AGENT_RUN_VARIANTS) as (keyof typeof AGENT_RUN_VARIANTS)[]
      ).map((name) => {
        const def = buildAgentRunDefinition(name, AGENT_RUN_VARIANTS[name]);
        const wf = hatchet.workflow<{ label: string; sleepMs: number }>(
          def.workflow,
        );
        wf.task({ ...def.task, fn: stubRun });
        declared.set(name, wf);
        return wf;
      });
      worker = await hatchet.worker("it-e2e-worker", { workflows, slots: 8 });
      void worker.start();
      await worker.waitUntilReady(60_000);
    }, 240_000);

    afterAll(async () => {
      await worker?.stop().catch(() => {});
      await pg?.end().catch(() => {});
      await compose(["down", "-v"]).catch(() => {});
      await rm(IT_OVERRIDE_FILE, { force: true }).catch(() => {});
    }, 90_000);

    it("newest-wins (agent-run-newest, CANCEL_IN_PROGRESS): a second dispatch on the same prKey cancels the live run and runs itself", async () => {
      const prKey = uid("org-a/repo/1");
      const a = await trigger("agent-run-newest", {
        label: uid("nw-old"),
        sleepMs: 8000,
        prKey,
        orgId: "org-a",
        deliveryId: uid("d"),
      });
      expect(a.status).toBe(200);
      await waitStatus(a.id, ["RUNNING"], "old run");
      const b = await trigger("agent-run-newest", {
        label: uid("nw-new"),
        sleepMs: 200,
        prKey,
        orgId: "org-a",
        deliveryId: uid("d"),
      });
      expect(await waitStatus(a.id, ["CANCELLED", "COMPLETED"], "old")).toBe(
        "CANCELLED",
      );
      expect(await waitStatus(b.id, ["COMPLETED", "CANCELLED", "FAILED"])).toBe(
        "COMPLETED",
      );
      // The stub observed the engine cancel (ctx.cancelled) — the seam the
      // worker's real run fn posts its `superseded` terminal from.
      const old = executions.get(
        [...executions.keys()].find((k) => k.startsWith("nw-old"))!,
      );
      expect(old?.cancelled).toBe(true);
    });

    it("complete-run · discard (agent-run-discard, CANCEL_NEWEST): the newcomer is CANCELLED, the incumbent finishes", async () => {
      const prKey = uid("org-a/repo/2");
      const a = await trigger("agent-run-discard", {
        label: uid("dc-old"),
        sleepMs: 3000,
        prKey,
        orgId: "org-a",
        deliveryId: uid("d"),
      });
      await waitStatus(a.id, ["RUNNING"]);
      const b = await trigger("agent-run-discard", {
        label: uid("dc-new"),
        sleepMs: 200,
        prKey,
        orgId: "org-a",
        deliveryId: uid("d"),
      });
      expect(await waitStatus(b.id, ["CANCELLED", "COMPLETED", "FAILED"])).toBe(
        "CANCELLED",
      );
      expect(await waitStatus(a.id, ["COMPLETED", "CANCELLED", "FAILED"])).toBe(
        "COMPLETED",
      );
      // A discarded newcomer never started executing (no credits burned).
      expect([...executions.keys()].some((k) => k.startsWith("dc-new"))).toBe(
        false,
      );
    });

    it("complete-run · queue (agent-run-strict, GROUP_ROUND_ROBIN): strict FIFO per prKey, no overlap", async () => {
      const prKey = uid("org-a/repo/3");
      const labels = ["q1", "q2", "q3"].map((l) => uid(l));
      const runs = [];
      for (const label of labels) {
        runs.push(
          await trigger("agent-run-strict", {
            label,
            sleepMs: 600,
            prKey,
            orgId: "org-a",
            deliveryId: uid("d"),
          }),
        );
      }
      for (const r of runs) {
        expect(
          await waitStatus(r.id, ["COMPLETED", "CANCELLED", "FAILED"]),
        ).toBe("COMPLETED");
      }
      const ex = labels.map((l) => executions.get(l)!);
      expect(ex.every(Boolean)).toBe(true);
      expect(ex[0]!.startedAt).toBeLessThanOrEqual(ex[1]!.startedAt);
      expect(ex[1]!.startedAt).toBeLessThanOrEqual(ex[2]!.startedAt);
      expect(ex[0]!.endedAt!).toBeLessThanOrEqual(ex[1]!.startedAt);
      expect(ex[1]!.endedAt!).toBeLessThanOrEqual(ex[2]!.startedAt);
    });

    it("CHARACTERIZATION — mixed semantics under the global cap of 1: per-org GROUP_ROUND_ROBIN does NOT interleave orgs; the global single-group key is FIFO", async () => {
      // Org A has a backlog of 3 runs on 3 PRs; org B has 1, dispatched last.
      // The per-PR CANCEL_IN_PROGRESS entry never interferes (distinct PRs).
      const a = ["a1", "a2", "a3"].map((l) => uid(l));
      const runsA = [];
      for (const [i, label] of a.entries()) {
        runsA.push(
          await trigger("agent-run-newest", {
            label,
            sleepMs: 700,
            prKey: uid(`org-a/repo/${10 + i}`),
            orgId: "org-a",
            deliveryId: uid("d"),
          }),
        );
      }
      const bLabel = uid("b1");
      const runB = await trigger("agent-run-newest", {
        label: bLabel,
        sleepMs: 200,
        prKey: uid("org-b/repo/1"),
        orgId: "org-b",
        deliveryId: uid("d"),
      });
      for (const r of [...runsA, runB]) {
        expect(
          await waitStatus(r.id, ["COMPLETED", "CANCELLED", "FAILED"]),
        ).toBe("COMPLETED");
      }
      const all = [...a, bLabel]
        .map((l) => executions.get(l)!)
        .sort((x, y) => x.startedAt - y.startedAt);
      // Global cap of 1: no two executions overlap (the memory-budget invariant).
      for (let i = 1; i < all.length; i++) {
        expect(all[i - 1]!.endedAt!).toBeLessThanOrEqual(all[i]!.startedAt);
      }
      // CONTRACT (observed on hatchet-lite v0.94.10, reproducible): the start
      // order is pure FIFO — a1, a2, a3, b1. The stacked global cap is ONE
      // concurrency group, and GROUP_ROUND_ROBIN across a single group is
      // FIFO; the per-org entry (cap 1 per org) only serializes within an
      // org. So "one org's backlog can never head-of-line-block another"
      // (workflow.ts Phase 2 #3a) is NOT delivered at global cap 1 — B waits
      // behind A's whole backlog. Real cross-org fairness needs global>1
      // (memory-gated, #3b) or an engine-side ordering primitive. Frozen
      // here so a future engine change is a deliberate, visible decision.
      expect(all.map((e) => e.label.slice(0, 2))).toEqual([
        "a1",
        "a2",
        "a3",
        "b1",
      ]);
    });

    it("CHARACTERIZATION: newest-wins on a run still QUEUED behind the global cap — the queued older run is cancelled before it ever starts", async () => {
      // Occupy the global slot with an unrelated run, then dispatch X1 then X2
      // on one prKey while X1 is still QUEUED.
      const blocker = await trigger("agent-run-newest", {
        label: uid("blocker"),
        sleepMs: 2500,
        prKey: uid("org-z/repo/1"),
        orgId: "org-z",
        deliveryId: uid("d"),
      });
      await waitStatus(blocker.id, ["RUNNING"]);
      const prKey = uid("org-a/repo/20");
      const x1Label = uid("x1");
      const x1 = await trigger("agent-run-newest", {
        label: x1Label,
        sleepMs: 300,
        prKey,
        orgId: "org-a",
        deliveryId: uid("d"),
      });
      expect(await statusOf(x1.id)).toBe("QUEUED");
      const x2 = await trigger("agent-run-newest", {
        label: uid("x2"),
        sleepMs: 300,
        prKey,
        orgId: "org-a",
        deliveryId: uid("d"),
      });
      const x1Final = await waitStatus(x1.id, [
        "CANCELLED",
        "COMPLETED",
        "FAILED",
      ]);
      const x2Final = await waitStatus(x2.id, [
        "CANCELLED",
        "COMPLETED",
        "FAILED",
      ]);
      await waitStatus(blocker.id, ["COMPLETED", "CANCELLED", "FAILED"]);
      // CONTRACT (observed on hatchet-lite v0.94.10): CANCEL_IN_PROGRESS
      // cancels the older run even while it is only QUEUED under the global
      // cap; it never executes. If an engine upgrade changes this, the
      // control plane's terminal accounting (C4) must be revisited.
      expect(x1Final).toBe("CANCELLED");
      expect(executions.has(x1Label)).toBe(false);
      expect(x2Final).toBe("COMPLETED");
    });

    /**
     * Idempotency (#127 AC4 / #126 idempotency). FINDING (2026-08-24): SDK
     * 1.26.0 registers WORKFLOW-level `idempotency` (task-level is dropped),
     * and hatchet-lite v0.94.10 accepts the registration but persists no
     * workflow idempotency config (its schema has `v1_idempotency_key` for
     * durable events only) — the same deliveryId triggered twice, over REST
     * AND over the SDK, executes TWICE and claims 0 key rows. Delivery-id
     * dedupe therefore needs an engine upgrade; until then www's per-thread
     * double-dispatch guard + the C4 sweep are the protection. Two tests:
     * a characterization that freezes what THIS engine does, and an
     * expected-failure gate that turns red the day the engine dedupes —
     * flip both together (and close the follow-up) when that happens.
     */
    it("CHARACTERIZATION (hatchet-lite v0.94.10): a repeated deliveryId is NOT deduped — two runs execute and no idempotency key is claimed", async () => {
      const prKey = uid("org-a/repo/30");
      const deliveryId = uid("gh-delivery");
      const keyCount = async () =>
        (await pg.query("SELECT count(*)::int AS n FROM v1_idempotency_key"))
          .rows[0].n as number;
      const keysBefore = await keyCount();
      const first = await trigger("agent-run-strict", {
        label: uid("idem-1"),
        sleepMs: 200,
        prKey,
        orgId: "org-a",
        deliveryId,
      });
      const dup = await trigger("agent-run-strict", {
        label: uid("idem-dup"),
        sleepMs: 200,
        prKey,
        orgId: "org-a",
        deliveryId,
      });
      expect(first.status).toBe(200);
      expect(dup.status).toBe(200);
      expect(dup.id).not.toBe(first.id);
      await waitStatus(first.id, ["COMPLETED", "CANCELLED", "FAILED"]);
      await waitStatus(dup.id, ["COMPLETED", "CANCELLED", "FAILED"]);
      const execs = [...executions.keys()].filter((k) => k.startsWith("idem-"));
      expect(execs.some((k) => k.startsWith("idem-1"))).toBe(true);
      expect(execs.some((k) => k.startsWith("idem-dup"))).toBe(true);
      expect(await keyCount()).toBe(keysBefore);
    });

    it.fails(
      "EXPECTED FAILURE until the engine dedupes: the same deliveryId twice ⇒ ONE execution (flip to `it` after the hatchet-lite upgrade)",
      async () => {
        const prKey = uid("org-a/repo/31");
        const deliveryId = uid("gh-delivery-gate");
        const wf = declared.get("agent-run-strict")!;
        const input = (label: string) => ({
          label,
          sleepMs: 200,
          prKey,
          orgId: "org-a",
          deliveryId,
        });
        const r1 = await wf.runNoWait(input(uid("gate-1")));
        const r2 = await wf.runNoWait(input(uid("gate-dup")));
        // Wait for BOTH terminals (a deduped duplicate resolves to r1's run).
        for (const r of [r1, r2]) {
          await waitStatus(await r.workflowRunId, [
            "COMPLETED",
            "CANCELLED",
            "FAILED",
          ]);
        }
        const execs = [...executions.keys()].filter((k) =>
          k.startsWith("gate-"),
        );
        expect(execs.some((k) => k.startsWith("gate-dup"))).toBe(false);
      },
    );

    it("a different deliveryId on the same prKey is always a second run", async () => {
      const prKey = uid("org-a/repo/32");
      const a = await trigger("agent-run-strict", {
        label: uid("other-1"),
        sleepMs: 100,
        prKey,
        orgId: "org-a",
        deliveryId: uid("gh-delivery-a"),
      });
      const b = await trigger("agent-run-strict", {
        label: uid("other-2"),
        sleepMs: 100,
        prKey,
        orgId: "org-a",
        deliveryId: uid("gh-delivery-b"),
      });
      expect(await waitStatus(a.id, ["COMPLETED", "CANCELLED", "FAILED"])).toBe(
        "COMPLETED",
      );
      expect(await waitStatus(b.id, ["COMPLETED", "CANCELLED", "FAILED"])).toBe(
        "COMPLETED",
      );
    });

    it("anti-rot (#69 regression guard): 50 sequential ephemeral per-PR groups — no scheduling degradation, zero residual QUEUED/RUNNING", async () => {
      const latencies: number[] = [];
      for (let i = 1; i <= 50; i++) {
        const label = uid(`rot-${i}`);
        const r = await trigger("agent-run-newest", {
          label,
          sleepMs: 50,
          prKey: uid(`org-r/repo/${i}`),
          orgId: `org-r-${i % 3}`,
          deliveryId: uid("d"),
        });
        expect(r.status).toBe(200);
        const ex = await waitStarted(label);
        latencies.push(ex!.startedAt - r.triggeredAt);
        await waitStatus(r.id, ["COMPLETED", "CANCELLED", "FAILED"]);
      }
      // Latency of run 50 ≤ 2× run 1, with a 1s floor on the baseline so a
      // 40ms-vs-90ms jitter cannot fail a healthy scheduler; a rotted
      // scheduler shows seconds-to-forever, not milliseconds.
      const baseline = Math.max(latencies[0]!, 1000);
      expect(latencies[49]!).toBeLessThanOrEqual(2 * baseline);
      const live = await hatchet.runs.list({
        statuses: ["QUEUED", "RUNNING"] as never,
      });
      expect(live.rows?.length ?? 0).toBe(0);
    });
  },
);
