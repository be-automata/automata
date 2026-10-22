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

/**
 * #386 against a REAL dockerized hatchet-lite (HATCHET_IT=1): the drain-time
 * redelivery, reproduced with real worker PROCESSES and a real SIGTERM — the
 * SDK's own `exitGracefully`, as `systemctl restart` drives it.
 *
 *  1. Worker A picks up a run; A is SIGTERMed while the run is executing.
 *  2. The drain is held past the engine's heartbeat window, then the run ends
 *     (inside the drain) and A exits.
 *  3. Worker B (the relaunched process) starts on the same ledger root.
 *
 * Control (no guard, the pre-#386 code): the engine hands B the SAME workflow
 * run and B executes it again. Guarded: B refuses it before the run fn body —
 * as a no-op COMPLETED when the first attempt returned (the drained attempt's
 * own FINISHED is ignored once the engine REASSIGNED the run, so B's result IS
 * the run's status), as a FAILED throw when the first attempt failed.
 *
 * Measured: a 5 s drain hold is NOT redelivered (the engine accepts A's own
 * event); 45 s is. Only a drain that outlasts the engine's heartbeat window
 * exposes a run to this.
 *
 * SAFETY: the harness runs the isolated compose project `automata-hatchet-it`.
 */
const itEnabled = process.env.HATCHET_IT === "1";
vi.setConfig({ testTimeout: 420_000 });

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "terminal-guard-worker.ts",
);
/** The least time A's drain is held after SIGTERM before its run ends. */
const DRAIN_HOLD_MS = Number(process.env.IT_DRAIN_HOLD_MS ?? 45_000);
/**
 * How much longer the drain may be held while waiting for the engine to
 * record REASSIGNED. The engine's heartbeat sweep does not fire at a fixed
 * offset from the SIGTERM: on CI runners 45 s alone left both guarded cases
 * without a REASSIGNED in about half of the runs on 2026-10-22, so the drill
 * ends the run once the redelivery it exists to reproduce has really begun.
 */
const REASSIGN_WAIT_MS = Number(process.env.IT_REASSIGN_WAIT_MS ?? 120_000);
/** How long B is watched for a redelivery. */
const REDELIVERY_WATCH_MS = Number(
  process.env.IT_REDELIVERY_WATCH_MS ?? 90_000,
);

interface WorkerProc {
  child: ChildProcess;
  lines: string[];
  exited: Promise<number | null>;
}

function startWorker(
  name: string,
  root: string,
  guard: boolean,
  token: string,
): WorkerProc {
  const child = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
    env: {
      ...process.env,
      HATCHET_CLIENT_TOKEN: token,
      HATCHET_CLIENT_TLS_STRATEGY: "none",
      LEDGER_ROOT: root,
      GUARD: guard ? "1" : "0",
      WORKER_NAME: name,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const collect = (buf: Buffer) => {
    for (const l of buf.toString().split("\n"))
      if (l.trim()) lines.push(`[${name}] ${l}`);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return { child, lines, exited };
}

const has = (w: WorkerProc, re: RegExp) => w.lines.some((l) => re.test(l));

describe.skipIf(!itEnabled)(
  "#386 drain-time redelivery — real SIGTERM against dockerized hatchet-lite (HATCHET_IT=1)",
  () => {
    let pg: Client;
    let tenantId: string;
    let token: string;
    const procs: WorkerProc[] = [];
    const roots: string[] = [];

    async function trigger(label: string, fail: boolean): Promise<string> {
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
              fail,
              orgId: `org-${label}`,
              deliveryId: `d-${label}`,
              prKey: `pr-${label}`,
            },
            additionalMetadata: { label },
          }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        run?: { metadata?: { id?: string } };
      };
      return body.run?.metadata?.id ?? "";
    }

    async function engineEvents(runId: string): Promise<string[]> {
      const events = await pg.query<{
        event_type: string;
        retry_count: number;
      }>(
        `SELECT e.event_type, e.retry_count FROM v1_task_events_olap e
           JOIN v1_tasks_olap t ON t.id = e.task_id AND t.inserted_at = e.task_inserted_at
          WHERE t.workflow_run_id = $1 ORDER BY e.event_timestamp, e.id`,
        [runId],
      );
      return events.rows.map((e) => `${e.event_type}#${e.retry_count}`);
    }

    /** One drill: returns how often the run fn body executed and whether B refused. */
    async function drill(guard: boolean, fail = false) {
      const label = `${guard ? "guarded" : "control"}${fail ? "-fail" : ""}-${Date.now().toString(36)}`;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "it-386-"));
      roots.push(root);

      const a = startWorker(`it-386-a-${label}`, root, guard, token);
      procs.push(a);
      await pollUntil(
        "worker A ready",
        async () => has(a, /READY/),
        Boolean,
        90_000,
      );
      const runId = await trigger(label, fail);
      expect(runId).not.toBe("");
      await pollUntil(
        "worker A executes the run",
        async () => has(a, /^\[[^\]]+\] EXEC /),
        Boolean,
        60_000,
      );

      // systemctl restart: SIGTERM, then the drain. Hold it past the engine's
      // heartbeat window (until the engine has REASSIGNED the run), then let
      // the run end INSIDE the drain.
      const sigtermAt = Date.now();
      a.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, DRAIN_HOLD_MS));
      const reassignDeadline = Date.now() + REASSIGN_WAIT_MS;
      while (
        Date.now() < reassignDeadline &&
        !(await engineEvents(runId)).includes("REASSIGNED#0")
      ) {
        await new Promise((r) => setTimeout(r, 1_000));
      }
      const drainHeldMs = Date.now() - sigtermAt;
      fs.writeFileSync(path.join(root, `release-${label}`), "");
      const aExit = await Promise.race([
        a.exited,
        new Promise<"stuck">((r) => setTimeout(() => r("stuck"), 60_000)),
      ]);

      // The relaunched process, on the same ledger root.
      const b = startWorker(`it-386-b-${label}`, root, guard, token);
      procs.push(b);
      await pollUntil(
        "worker B ready",
        async () => has(b, /READY/),
        Boolean,
        90_000,
      );
      const deadline = Date.now() + REDELIVERY_WATCH_MS;
      while (Date.now() < deadline && !has(b, /EXEC |REFUSED |NOOP /)) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const executions = [...a.lines, ...b.lines].filter((l) =>
        / EXEC /.test(l),
      ).length;
      const refused = has(b, new RegExp(`REFUSED ${runId}`));
      const noop = has(b, new RegExp(`NOOP ${runId}`));
      const ledger = fs.existsSync(
        path.join(root, "run-terminals", `${runId}.json`),
      );
      // The engine's own record once the run settles: its final status and
      // the event timeline (REASSIGNED marks the drain-time redelivery).
      const engine = await pollUntil(
        "engine run settled",
        async () => {
          const run = await pg.query<{ readable_status: string }>(
            "SELECT readable_status FROM v1_runs_olap WHERE external_id = $1",
            [runId],
          );
          return {
            status: run.rows[0]?.readable_status ?? "",
            events: await engineEvents(runId),
          };
        },
        (r) => ["COMPLETED", "FAILED", "CANCELLED"].includes(r.status),
        30_000,
      );
      b.child.kill("SIGTERM");
      await b.exited;
      console.log(
        JSON.stringify({
          guard,
          fail,
          runId,
          aExit,
          executions,
          refused,
          noop,
          ledger,
          engine,
          drainHeldMs,
        }),
      );
      console.log(
        [...a.lines, ...b.lines]
          .filter((l) =>
            /EXEC|REFUSED|NOOP|LEDGER|exit|pending|Task run/i.test(l),
          )
          .join("\n"),
      );
      return { executions, refused, noop, ledger, aExit, engine };
    }

    beforeAll(async () => {
      await composeUp();
      pg = await connectPg();
      ({ tenantId, token } = await bootstrapTenant(pg));
    }, 240_000);

    afterAll(async () => {
      for (const p of procs) p.child.kill("SIGKILL");
      for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
      await pg?.end().catch(() => {});
      await composeDownV();
    }, 90_000);

    it("control (no guard): the engine redelivers the drained run to the relaunched worker, which executes it AGAIN", async () => {
      const r = await drill(false);
      expect(r.aExit).toBe(0);
      expect(r.engine.events).toContain("REASSIGNED#0");
      expect(r.executions).toBe(2);
    });

    it("guarded, first attempt RETURNED: the redelivery completes as a no-op — one execution, engine COMPLETED", async () => {
      const r = await drill(true);
      expect(r.aExit).toBe(0);
      expect(r.ledger).toBe(true);
      expect(r.engine.events).toContain("REASSIGNED#0");
      expect(r.noop).toBe(true);
      expect(r.refused).toBe(false);
      expect(r.executions).toBe(1);
      expect(r.engine.status).toBe("COMPLETED");
    });

    it("guarded, first attempt FAILED: the redelivery is refused with a throw — one execution, engine FAILED", async () => {
      const r = await drill(true, true);
      expect(r.aExit).toBe(0);
      expect(r.ledger).toBe(true);
      expect(r.engine.events).toContain("REASSIGNED#0");
      expect(r.refused).toBe(true);
      expect(r.noop).toBe(false);
      expect(r.executions).toBe(1);
      expect(r.engine.status).toBe("FAILED");
    });
  },
);
