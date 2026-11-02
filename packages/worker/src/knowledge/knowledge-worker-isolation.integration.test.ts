import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import {
  APIContracts,
  type Hatchet,
  type Worker,
} from "@hatchet-dev/typescript-sdk";

import {
  REST,
  bootstrapTenant,
  composeDownV,
  composeUp,
  connectPg,
  pollUntil,
} from "../agent-run/hatchet-it-harness";
import { mirrorPaths } from "./mirror-paths";

/**
 * PD-18 / PIPE-06 isolation half, against a real, isolated hatchet-lite
 * (HATCHET_IT=1; skipped otherwise). A review-sim worker with ONE slot is held
 * busy by a blocking task while the real knowledge worker (built by
 * knowledgeWorkerOptions, reconcile config unset) completes a knowledge-reconcile
 * and a knowledge-mirror-purge run. A second review-sim run stays QUEUED until
 * the first is released: the knowledge worker never executed a review task.
 *
 * SAFETY: the harness runs the isolated compose project `automata-hatchet-it`.
 */
const Status = APIContracts.V1TaskStatus;
type Status = APIContracts.V1TaskStatus;

const itEnabled = process.env.HATCHET_IT === "1";
vi.setConfig({ testTimeout: 240_000 });

const SIM = "it-review-sim";

describe.skipIf(!itEnabled)(
  "PD-18 knowledge worker isolation (dockerized hatchet-lite, HATCHET_IT=1)",
  () => {
    let pg: Client;
    let tenantId: string;
    let token: string;
    let hatchet: Hatchet;
    let reviewWorker: Worker;
    let knowledgeWorker: Worker;
    let mirrorRoot: string;
    const started = new Set<string>();
    const gates = new Map<string, () => void>();
    const suffix = Math.random().toString(36).slice(2, 8);

    const trigger = async (
      workflowName: string,
      input: Record<string, unknown>,
    ): Promise<string> => {
      const res = await fetch(
        `${REST}/api/v1/stable/tenants/${tenantId}/workflow-runs/trigger`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ workflowName, input }),
        },
      );
      expect(res.status, `trigger ${workflowName}`).toBe(200);
      const body = (await res.json()) as {
        run?: { metadata?: { id?: string } };
      };
      const id = body.run?.metadata?.id ?? "";
      expect(id).not.toBe("");
      return id;
    };

    const statusOf = async (id: string): Promise<Status> => {
      try {
        return await hatchet.runs.get_status(id);
      } catch (e) {
        if ((e as { response?: { status?: number } }).response?.status === 404)
          return Status.QUEUED;
        throw e;
      }
    };

    const untilStatus = (id: string, want: Status, what: string) =>
      pollUntil(
        what,
        () => statusOf(id),
        (s) => s === want,
        90_000,
        500,
      );

    beforeAll(async () => {
      await composeUp();
      pg = await connectPg();
      ({ tenantId, token } = await bootstrapTenant(pg));
      process.env.HATCHET_CLIENT_TOKEN = token;
      process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
      mirrorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "it-kw-mirror-"));
      // The knowledge task bodies read their config from the process env.
      process.env.WORKER_MIRROR_ROOT = mirrorRoot;
      delete process.env.WORKER_CONTROL_PLANE_URL;
      delete process.env.KNOWLEDGE_RECONCILE_SECRET;
      delete process.env.WORKER_RECONCILE_SLOTS;
      delete process.env.HATCHET_ENGINE_TENANT_ID;

      const sdk = await import("@hatchet-dev/typescript-sdk");
      hatchet = sdk.Hatchet.init();
      const sim = hatchet.task({
        name: SIM,
        executionTimeout: "5m",
        retries: 0,
        fn: async (input: { label: string }) => {
          started.add(input.label);
          await new Promise<void>((resolve) => gates.set(input.label, resolve));
          return { label: input.label };
        },
      });
      const { knowledgeWorkerOptions } = await import("./knowledge-worker");
      const { loadKnowledgeWorkerConfig } = await import("./reconcile-config");

      reviewWorker = await hatchet.worker(`it-review-${suffix}`, {
        workflows: [sim],
        slots: 1,
      });
      knowledgeWorker = await hatchet.worker(
        `automata-knowledge-it-${suffix}`,
        knowledgeWorkerOptions(loadKnowledgeWorkerConfig(process.env)),
      );
      void reviewWorker.start();
      void knowledgeWorker.start();
      await Promise.all([
        reviewWorker.waitUntilReady(60_000),
        knowledgeWorker.waitUntilReady(60_000),
      ]);
    }, 240_000);

    afterAll(async () => {
      for (const release of gates.values()) release();
      await reviewWorker?.stop().catch(() => {});
      await knowledgeWorker?.stop().catch(() => {});
      await pg?.end().catch(() => {});
      await fs.rm(mirrorRoot, { recursive: true, force: true });
      await composeDownV();
    }, 90_000);

    it("a knowledge run completes while the review worker's only slot is busy, and never takes a review slot", async () => {
      const a = await trigger(SIM, { label: "a" });
      await pollUntil(
        "sim a running",
        async () => started.has("a"),
        Boolean,
        60_000,
        250,
      );
      expect(await statusOf(a)).toBe(Status.RUNNING);

      const reconcile = await trigger("knowledge-reconcile", {
        intentId: "it-intent",
        organizationId: "it-org",
        repoFullName: "owner/repo",
        targetSha: "a".repeat(40),
      });
      await untilStatus(
        reconcile,
        Status.COMPLETED,
        "knowledge-reconcile COMPLETED",
      );
      // Still busy: the knowledge run did not free or use the review slot.
      expect(await statusOf(a)).toBe(Status.RUNNING);

      const b = await trigger(SIM, { label: "b" });
      const purgeRoot = mirrorPaths(mirrorRoot, "default", "it-org", "o/r");
      await fs.mkdir(purgeRoot.bare, { recursive: true });
      const purge = await trigger("knowledge-mirror-purge", {
        organizationId: "it-org",
      });
      await untilStatus(purge, Status.COMPLETED, "knowledge-mirror-purge");
      await expect(fs.stat(purgeRoot.orgDir)).rejects.toThrow();

      // The second review run is still queued behind the busy slot.
      expect(started.has("b")).toBe(false);
      expect(await statusOf(b)).toBe(Status.QUEUED);

      const workers = await hatchet.workers.list();
      const mine = (workers.rows ?? []).filter(
        (w) =>
          w.status === "ACTIVE" &&
          (w.name.endsWith(`it-review-${suffix}`) ||
            w.name.endsWith(`automata-knowledge-it-${suffix}`)),
      );
      expect(mine).toHaveLength(2);
      for (const w of mine) {
        const limits = Object.values(w.slotConfig ?? {}).map((s) => s.limit);
        expect(limits, w.name).toEqual([1]);
      }

      gates.get("a")?.();
      await untilStatus(a, Status.COMPLETED, "sim a COMPLETED");
      await pollUntil(
        "sim b running once the slot is free",
        async () => started.has("b"),
        Boolean,
        60_000,
        250,
      );
      gates.get("b")?.();
      await untilStatus(b, Status.COMPLETED, "sim b COMPLETED");
    });
  },
);
