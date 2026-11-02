import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";

import { mirrorPaths } from "./mirror-paths";

// hatchet.task() runs Hatchet.init() at import, which needs a decodable token.
function fakeHatchetToken(): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc({
    sub: "tenant-test",
    server_url: "http://localhost:8888",
    grpc_broadcast_address: "localhost:7070",
  })}.sig`;
}
process.env.HATCHET_CLIENT_TOKEN = fakeHatchetToken();
process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";

let wf: typeof import("./workflow");
beforeAll(async () => {
  wf = await import("./workflow");
});

const SHA = "a".repeat(40);
const GOOD = {
  intentId: "i1",
  organizationId: "org1",
  repoFullName: "o/r",
  targetSha: SHA,
};

afterEach(() => vi.restoreAllMocks());

describe("registration options", () => {
  it("reconcile: 5m schedule, 10m execution, retries 0, per-repo round robin", () => {
    const o = wf.KNOWLEDGE_RECONCILE_OPTIONS;
    expect(o.name).toBe("knowledge-reconcile");
    expect(o.scheduleTimeout).toBe("5m");
    expect(o.executionTimeout).toBe("10m");
    expect(o.retries).toBe(0);
    expect(o.concurrency).toHaveLength(1);
    expect(o.concurrency[0]).toEqual({
      expression: "input.organizationId + ':' + input.repoFullName",
      maxRuns: 1,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    });
  });

  it("purge: retries 0 and its own timeouts", () => {
    const o = wf.KNOWLEDGE_MIRROR_PURGE_OPTIONS;
    expect(o.name).toBe("knowledge-mirror-purge");
    expect(o.retries).toBe(0);
    expect(o.executionTimeout).toBe("5m");
  });

  it("buildKnowledgeWorkflows is exactly the two workflows, none named run", () => {
    const names = wf
      .buildKnowledgeWorkflows()
      .map((w) => (w as unknown as { name: string }).name);
    expect(names).toEqual(["knowledge-reconcile", "knowledge-mirror-purge"]);
    expect(names).not.toContain("run");
  });
});

describe("handleKnowledgeReconcile", () => {
  const configured = {
    WORKER_CONTROL_PLANE_URL: "https://www.example",
    KNOWLEDGE_RECONCILE_SECRET: "s",
  };

  it("rejects a non-reference input without running the body", async () => {
    const runReconcile = vi.fn();
    const bad: unknown[] = [
      { ...GOOD, targetSha: undefined },
      { ...GOOD, targetSha: "Z".repeat(40) },
      { ...GOOD, targetSha: "abc" },
      { ...GOOD, extra: 1, intentId: "" },
      null,
    ];
    for (const input of bad) {
      const res = await wf.handleKnowledgeReconcile(input, {
        env: configured,
        runReconcile,
        log: () => {},
      });
      expect(res).toEqual({
        outcome: "failed",
        code: "control_plane_rejected",
      });
    }
    expect(runReconcile).not.toHaveBeenCalled();
  });

  it("returns noop and logs once when reconcile is not configured", async () => {
    const runReconcile = vi.fn();
    const log = vi.fn();
    const res = await wf.handleKnowledgeReconcile(GOOD, {
      env: {},
      runReconcile,
      log,
    });
    expect(res).toEqual({ outcome: "noop" });
    expect(runReconcile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("runs the body with the loaded config and never leaks the secret into logs", async () => {
    const runReconcile = vi.fn(async () => ({ outcome: "published" as const }));
    const createClient = vi.fn(() => ({}) as never);
    const log = vi.fn();
    const res = await wf.handleKnowledgeReconcile(GOOD, {
      env: configured,
      runReconcile,
      createClient,
      log,
    });
    expect(res).toEqual({ outcome: "published" });
    expect(createClient).toHaveBeenCalledWith({
      baseUrl: "https://www.example",
      secret: "s",
    });
    expect(runReconcile).toHaveBeenCalledTimes(1);
  });

  it("never throws when the body throws", async () => {
    const res = await wf.handleKnowledgeReconcile(GOOD, {
      env: configured,
      createClient: () => ({}) as never,
      runReconcile: async () => {
        throw new Error("boom with secret s");
      },
      log: (m) => expect(m).not.toContain("boom"),
    });
    expect(res).toEqual({ outcome: "failed", code: "worker_error" });
  });
});

describe("handleKnowledgeMirrorPurge", () => {
  it("purges the org's mirrors with reconcile credentials unset (PD-20)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kw-purge-"));
    try {
      const env = { WORKER_MIRROR_ROOT: root };
      const { orgDir, bare } = mirrorPaths(root, "default", "org1", "o/r");
      await fs.mkdir(bare, { recursive: true });
      const res = await wf.handleKnowledgeMirrorPurge(
        { organizationId: "org1" },
        { env, log: () => {} },
      );
      expect(res).toEqual({ outcome: "purged" });
      await expect(fs.stat(orgDir)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe organization id without touching disk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kw-purge-"));
    try {
      const marker = path.join(root, "keep");
      await fs.writeFile(marker, "x");
      for (const organizationId of ["", "a/b", "..", "x..y", 5]) {
        const res = await wf.handleKnowledgeMirrorPurge(
          { organizationId },
          { env: { WORKER_MIRROR_ROOT: root }, log: () => {} },
        );
        expect(res).toEqual({ outcome: "failed" });
      }
      await expect(fs.stat(marker)).resolves.toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
