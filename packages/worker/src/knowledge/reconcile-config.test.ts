import { describe, expect, it } from "vitest";

import { loadKnowledgeWorkerConfig } from "./reconcile-config";
import { loadMirrorConfig } from "./mirror-paths";

describe("loadKnowledgeWorkerConfig", () => {
  it("defaults: one slot, default tenant, mirror defaults, reconcile off", () => {
    const cfg = loadKnowledgeWorkerConfig({});
    expect(cfg.slots).toBe(1);
    expect(cfg.tenantId).toBe("default");
    expect(cfg.mirror).toEqual(loadMirrorConfig({}));
    expect(cfg.reconcile).toBeNull();
    expect(cfg.warnings).toEqual([]);
  });

  it("reconcile is on when both the URL and the secret are set", () => {
    const cfg = loadKnowledgeWorkerConfig({
      WORKER_CONTROL_PLANE_URL: "https://www.example",
      KNOWLEDGE_RECONCILE_SECRET: "s",
      HATCHET_ENGINE_TENANT_ID: "tenant-1",
    });
    expect(cfg.reconcile).toEqual({
      controlPlaneUrl: "https://www.example",
      secret: "s",
    });
    expect(cfg.tenantId).toBe("tenant-1");
  });

  it("a half-set reconcile config degrades to null with a warning and never throws", () => {
    const urlOnly = loadKnowledgeWorkerConfig({
      WORKER_CONTROL_PLANE_URL: "https://www.example",
    });
    expect(urlOnly.reconcile).toBeNull();
    expect(urlOnly.warnings).toEqual(["reconcile_half_configured"]);
    const secretOnly = loadKnowledgeWorkerConfig({
      KNOWLEDGE_RECONCILE_SECRET: "hunter2",
    });
    expect(secretOnly.reconcile).toBeNull();
    expect(secretOnly.warnings).toEqual(["reconcile_half_configured"]);
    expect(JSON.stringify(secretOnly)).not.toContain("hunter2");
  });

  it("refuses http outside loopback but allows localhost and 127.0.0.1", () => {
    const bad = loadKnowledgeWorkerConfig({
      WORKER_CONTROL_PLANE_URL: "http://www.example",
      KNOWLEDGE_RECONCILE_SECRET: "s",
    });
    expect(bad.reconcile).toBeNull();
    expect(bad.warnings).toEqual(["reconcile_insecure_url"]);
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
      const ok = loadKnowledgeWorkerConfig({
        WORKER_CONTROL_PLANE_URL: url,
        KNOWLEDGE_RECONCILE_SECRET: "s",
      });
      expect(ok.reconcile?.controlPlaneUrl).toBe(url);
      expect(ok.warnings).toEqual([]);
    }
  });

  it("an unparseable URL degrades with the insecure-url warning", () => {
    const cfg = loadKnowledgeWorkerConfig({
      WORKER_CONTROL_PLANE_URL: "not a url",
      KNOWLEDGE_RECONCILE_SECRET: "s",
    });
    expect(cfg.reconcile).toBeNull();
    expect(cfg.warnings).toEqual(["reconcile_insecure_url"]);
  });

  it("WORKER_RECONCILE_SLOTS accepts 1 and 2 and throws naming the knob otherwise", () => {
    expect(
      loadKnowledgeWorkerConfig({ WORKER_RECONCILE_SLOTS: "2" }).slots,
    ).toBe(2);
    for (const bad of ["0", "3", "x", "1.5"]) {
      expect(() =>
        loadKnowledgeWorkerConfig({ WORKER_RECONCILE_SLOTS: bad }),
      ).toThrow(/WORKER_RECONCILE_SLOTS/);
    }
  });

  it("an invalid mirror knob throws naming that knob", () => {
    expect(() =>
      loadKnowledgeWorkerConfig({ WORKER_MIRROR_ROOT: "relative/path" }),
    ).toThrow(/WORKER_MIRROR_ROOT/);
  });
});
