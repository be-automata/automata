import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  REST,
  bootstrapTenant,
  composeDownV,
  composeUp,
  connectPg,
  pollUntil,
} from "./hatchet-it-harness";
import { drainForRestart, type DrainEngine } from "./safe-restart";

/**
 * The safe restart (#386 follow-up) against a REAL dockerized hatchet-lite
 * (HATCHET_IT=1), with real worker PROCESSES and the same SDK calls
 * scripts/drain-for-restart.ts makes:
 *
 *  - drained: pausing the busy worker stops new assignments while its run
 *    keeps going; the drain reports `drained` only once that run ended; the
 *    SIGTERM that follows interrupts nothing (no REASSIGNED), and the run
 *    queued during the pause goes to the relaunched worker — every run
 *    executes exactly once.
 *  - timeout: a drain that cannot finish unpauses the worker, which then
 *    takes new work again.
 *
 * SAFETY: the harness runs the isolated compose project `automata-hatchet-it`.
 */
const itEnabled = process.env.HATCHET_IT === "1";
vi.setConfig({ testTimeout: 300_000 });

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "terminal-guard-worker.ts",
);

interface WorkerProc {
  child: ChildProcess;
  lines: string[];
  exited: Promise<number | null>;
}

describe.skipIf(!itEnabled)(
  "safe restart — pause, drain, restart against dockerized hatchet-lite (HATCHET_IT=1)",
  () => {
    let pg: Client;
    let tenantId: string;
    let token: string;
    let engine: DrainEngine;
    const procs: WorkerProc[] = [];
    const roots: string[] = [];

    function startWorker(name: string, root: string): WorkerProc {
      const child = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
        env: {
          ...process.env,
          HATCHET_CLIENT_TOKEN: token,
          HATCHET_CLIENT_TLS_STRATEGY: "none",
          LEDGER_ROOT: root,
          GUARD: "1",
          WORKER_NAME: name,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const lines: string[] = [];
      const collect = (buf: Buffer) => {
        for (const l of buf.toString().split("\n")) if (l.trim()) lines.push(l);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const exited = new Promise<number | null>((resolve) =>
        child.on("exit", (code) => resolve(code)),
      );
      const proc = { child, lines, exited };
      procs.push(proc);
      return proc;
    }

    const ready = (w: WorkerProc, label: string) =>
      pollUntil(label, async () => w.lines.includes("READY"), Boolean, 90_000);
    const executed = (w: WorkerProc, label: string) =>
      w.lines.filter((l) => l.startsWith(`EXEC ${label} `)).length;

    async function trigger(label: string): Promise<string> {
      const res = await fetch(
        `${REST}/api/v1/stable/tenants/${tenantId}/workflow-runs/trigger`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workflowName: "agent-run",
            input: {
              label,
              orgId: `org-${label}`,
              deliveryId: `d-${label}`,
              prKey: `pr-${label}`,
            },
          }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        run?: { metadata?: { id?: string } };
      };
      const id = body.run?.metadata?.id ?? "";
      expect(id).not.toBe("");
      return id;
    }

    async function settled(runId: string) {
      return pollUntil(
        `run ${runId} settled`,
        async () => {
          const run = await pg.query<{ readable_status: string }>(
            "SELECT readable_status FROM v1_runs_olap WHERE external_id = $1",
            [runId],
          );
          const events = await pg.query<{ e: string }>(
            `SELECT e.event_type || '#' || e.retry_count AS e FROM v1_task_events_olap e
               JOIN v1_tasks_olap t ON t.id = e.task_id AND t.inserted_at = e.task_inserted_at
              WHERE t.workflow_run_id = $1 ORDER BY e.event_timestamp, e.id`,
            [runId],
          );
          return {
            status: run.rows[0]?.readable_status ?? "",
            events: events.rows.map((r) => r.e),
          };
        },
        (r) => ["COMPLETED", "FAILED", "CANCELLED"].includes(r.status),
        90_000,
      );
    }

    beforeAll(async () => {
      await composeUp();
      pg = await connectPg();
      ({ tenantId, token } = await bootstrapTenant(pg));
      process.env.HATCHET_CLIENT_TOKEN = token;
      process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
      const sdk = await import("@hatchet-dev/typescript-sdk");
      const hatchet = sdk.Hatchet.init();
      // The same calls scripts/drain-for-restart.ts makes.
      engine = {
        listWorkers: () => hatchet.workers.list(),
        setPaused: async (id, paused) => {
          await (paused
            ? hatchet.workers.pause(id)
            : hatchet.workers.unpause(id));
        },
      };
    }, 240_000);

    afterAll(async () => {
      for (const p of procs) p.child.kill("SIGKILL");
      for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
      await pg?.end().catch(() => {});
      await composeDownV();
    }, 90_000);

    it("drains a busy worker without interrupting it; the restart re-executes nothing and the queued run goes to the relaunched worker", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "it-safe-restart-"));
      roots.push(root);
      const name = `it-safe-${Date.now().toString(36)}`;
      const a = startWorker(name, root);
      await ready(a, "worker A ready");

      const inflight = await trigger("inflight");
      await pollUntil(
        "A executes the in-flight run",
        async () => executed(a, "inflight"),
        (n) => n === 1,
        60_000,
      );

      const log: string[] = [];
      const drain = drainForRestart({
        engine,
        workerName: name,
        timeoutMs: 180_000,
        pollMs: 1_000,
        log: (m) => log.push(m),
      });
      await pollUntil(
        "A paused",
        async () => log.some((l) => l.startsWith("drain: paused worker")),
        Boolean,
        30_000,
      );

      // A run queued while A is paused must not go to A, even though A will
      // have a free slot the moment its in-flight run ends.
      const queued = await trigger("queued");
      await new Promise((r) => setTimeout(r, 5_000));
      fs.writeFileSync(path.join(root, "release-inflight"), "");
      const result = await drain;
      expect(result.kind, log.join("\n")).toBe("drained");
      await new Promise((r) => setTimeout(r, 5_000));
      expect(executed(a, "queued")).toBe(0);

      // The restart: SIGTERM an idle worker, relaunch under the same name.
      const sigtermAt = Date.now();
      a.child.kill("SIGTERM");
      expect(await a.exited).toBe(0);
      const drainMs = Date.now() - sigtermAt;
      fs.writeFileSync(path.join(root, "release-queued"), "");
      const b = startWorker(name, root);
      await ready(b, "worker B ready");

      const [first, second] = await Promise.all([
        settled(inflight),
        settled(queued),
      ]);
      console.log(JSON.stringify({ drainMs, first, second, log }));
      expect(first.status).toBe("COMPLETED");
      expect(first.events.some((e) => e.startsWith("REASSIGNED"))).toBe(false);
      expect(executed(a, "inflight") + executed(b, "inflight")).toBe(1);
      expect(second.status).toBe("COMPLETED");
      expect(executed(a, "queued")).toBe(0);
      expect(executed(b, "queued")).toBe(1);
      b.child.kill("SIGTERM");
      await b.exited;
    });

    it("a drain that cannot finish unpauses the worker, which then takes new work again", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "it-safe-restart-"));
      roots.push(root);
      const name = `it-safe-to-${Date.now().toString(36)}`;
      const c = startWorker(name, root);
      await ready(c, "worker C ready");

      const busy = await trigger("busy");
      await pollUntil(
        "C executes the busy run",
        async () => executed(c, "busy"),
        (n) => n === 1,
        60_000,
      );
      const result = await drainForRestart({
        engine,
        workerName: name,
        timeoutMs: 5_000,
        pollMs: 1_000,
        log: () => {},
      });
      expect(result).toMatchObject({ kind: "timeout", busySlots: 1 });

      // Unpaused: once its slot is free, C runs the next run itself.
      const next = await trigger("next");
      fs.writeFileSync(path.join(root, "release-busy"), "");
      fs.writeFileSync(path.join(root, "release-next"), "");
      await pollUntil(
        "C executes the next run",
        async () => executed(c, "next"),
        (n) => n === 1,
        60_000,
      );
      expect((await settled(busy)).status).toBe("COMPLETED");
      expect((await settled(next)).status).toBe("COMPLETED");
      c.child.kill("SIGTERM");
      await c.exited;
    });
  },
);
