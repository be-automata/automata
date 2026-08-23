import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config";

describe("loadWorkerConfig", () => {
  it("falls back to sensible defaults when nothing is set", () => {
    const cfg = loadWorkerConfig({});
    expect(cfg.nodeBin).toBe(process.execPath);
    expect(cfg.anthropicApiKey).toBe("");
    expect(cfg.claudeBinDir).toBe(""); // no CLAUDE_BIN → rely on login PATH
    expect(cfg.pollIntervalMs).toBe(7000);
    expect(path.isAbsolute(cfg.daemonDist)).toBe(true);
    expect(cfg.daemonDist).toMatch(/daemon\/dist\/index\.js$/);
    expect(cfg.workdirRoot).toMatch(/automata-worker-runs$/);
    expect(cfg.botLogin).toBe("automata-ai-bot[bot]");
    expect(cfg.runNamespaceRoot).toBe("/tmp/automata-agent-run");
  });

  it("honours WORKER_RUN_NAMESPACE_ROOT override", () => {
    expect(
      loadWorkerConfig({ WORKER_RUN_NAMESPACE_ROOT: "/data/agent-runs" })
        .runNamespaceRoot,
    ).toBe("/data/agent-runs");
  });

  describe("boxTrust (D1) — who the box belongs to decides how runs authenticate", () => {
    it("defaults to shared: an unconfigured box never gets a provider credential on disk", () => {
      expect(loadWorkerConfig({}).boxTrust).toBe("shared");
    });

    it("only the exact string 'owner' opts in", () => {
      expect(loadWorkerConfig({ WORKER_BOX_TRUST: "owner" }).boxTrust).toBe(
        "owner",
      );
      expect(loadWorkerConfig({ WORKER_BOX_TRUST: "  owner  " }).boxTrust).toBe(
        "owner",
      );
    });

    it("box-key opts the box's own ANTHROPIC_API_KEY in as the run credential", () => {
      // Regression: collapsing this into "shared" forced every run onto the
      // credits proxy. On a platform with no credit balance that killed runs
      // that had been working on the box key for months.
      expect(loadWorkerConfig({ WORKER_BOX_TRUST: "box-key" }).boxTrust).toBe(
        "box-key",
      );
    });

    it("anything truthy-but-wrong degrades to shared rather than opting in", () => {
      // A typo or a truthy-looking value must not hand a tenant credential to a
      // box that was never meant to hold one.
      for (const value of [
        "true",
        "1",
        "OWNER",
        "Owner",
        "yes",
        "",
        "shared",
      ]) {
        expect(
          loadWorkerConfig({ WORKER_BOX_TRUST: value }).boxTrust,
          `WORKER_BOX_TRUST=${JSON.stringify(value)} must not opt in`,
        ).toBe("shared");
      }
    });
  });

  describe("credentialBroker (#81) — who holds the installation token", () => {
    it("defaults to on: the agent env never carries the raw token unless the operator opts out", () => {
      expect(loadWorkerConfig({}).credentialBroker).toBe("on");
    });

    it("only the exact rollback string opts out; junk stays brokered", () => {
      expect(
        loadWorkerConfig({ WORKER_CREDENTIAL_BROKER: "legacy-direct" })
          .credentialBroker,
      ).toBe("legacy-direct");
      expect(
        loadWorkerConfig({ WORKER_CREDENTIAL_BROKER: " legacy-direct " })
          .credentialBroker,
      ).toBe("legacy-direct");
      for (const value of ["off", "false", "0", "LEGACY-DIRECT", ""]) {
        expect(
          loadWorkerConfig({ WORKER_CREDENTIAL_BROKER: value })
            .credentialBroker,
          `WORKER_CREDENTIAL_BROKER=${JSON.stringify(value)} must not opt out`,
        ).toBe("on");
      }
    });
  });

  it("honours WORKER_BOT_LOGIN override", () => {
    expect(
      loadWorkerConfig({ WORKER_BOT_LOGIN: "somnio-bot[bot]" }).botLogin,
    ).toBe("somnio-bot[bot]");
  });

  it("honours explicit env overrides", () => {
    const cfg = loadWorkerConfig({
      WORKER_NODE_BIN: "/usr/bin/node",
      WORKER_DAEMON_DIST: "/opt/daemon/dist/index.js",
      ANTHROPIC_API_KEY: "sk-abc",
      WORKER_WORKDIR_ROOT: "/data/runs",
      WORKER_POLL_INTERVAL_MS: "5000",
    });
    expect(cfg.nodeBin).toBe("/usr/bin/node");
    expect(cfg.daemonDist).toBe("/opt/daemon/dist/index.js");
    expect(cfg.anthropicApiKey).toBe("sk-abc");
    expect(cfg.workdirRoot).toBe("/data/runs");
    expect(cfg.pollIntervalMs).toBe(5000);
  });

  it("accepts CLAUDE_BIN as either a binary path or a directory", () => {
    expect(loadWorkerConfig({ CLAUDE_BIN: "/x/bin/claude" }).claudeBinDir).toBe(
      "/x/bin",
    );
    expect(loadWorkerConfig({ CLAUDE_BIN: "/x/bin" }).claudeBinDir).toBe(
      "/x/bin",
    );
  });

  it("ignores a non-positive or non-numeric poll interval", () => {
    expect(
      loadWorkerConfig({ WORKER_POLL_INTERVAL_MS: "0" }).pollIntervalMs,
    ).toBe(7000);
    expect(
      loadWorkerConfig({ WORKER_POLL_INTERVAL_MS: "nope" }).pollIntervalMs,
    ).toBe(7000);
  });

  describe("scheduling deadlock recovery (#69, §3.5) — 12 knobs, master-gated", () => {
    it("defaults: master gate unset, everything else safe", () => {
      const cfg = loadWorkerConfig({});
      expect(cfg.engineDatabaseUrl).toBe("");
      expect(cfg.engineTenantId).toBe("");
      expect(cfg.schedulingMaintenanceMode).toBe("dry-run");
      expect(cfg.concurrencyRotRepairMode).toBe("inherit");
      expect(cfg.slotReclaimMode).toBe("inherit");
      expect(cfg.stuckQueuedDetect).toBe("on");
      expect(cfg.stuckQueuedS).toBe(900);
      expect(cfg.workerDeadAfterS).toBe(600);
      expect(cfg.slotMinAgeS).toBe(600);
      expect(cfg.maintIntervalS).toBe(60);
      expect(cfg.maintBatch).toBe(100);
      expect(cfg.healthPort).toBeNull();
    });

    it("stuckQueuedS default is exactly half of scheduleTimeout (workflow.ts:236) — locks the two from drifting apart", () => {
      const THIRTY_MINUTES_S = 30 * 60;
      expect(loadWorkerConfig({}).stuckQueuedS).toBe(THIRTY_MINUTES_S / 2);
    });

    it("honours HATCHET_ENGINE_DATABASE_URL and HATCHET_ENGINE_TENANT_ID overrides", () => {
      const cfg = loadWorkerConfig({
        HATCHET_ENGINE_DATABASE_URL:
          "postgresql://hatchet:hatchet@127.0.0.1:55433/hatchet?sslmode=disable",
        HATCHET_ENGINE_TENANT_ID: "707d0855-80ab-4e1f-a156-f1c4546cbf52",
      });
      expect(cfg.engineDatabaseUrl).toBe(
        "postgresql://hatchet:hatchet@127.0.0.1:55433/hatchet?sslmode=disable",
      );
      expect(cfg.engineTenantId).toBe("707d0855-80ab-4e1f-a156-f1c4546cbf52");
    });

    it("only exact off/dry-run/on opt WORKER_SCHEDULING_MAINTENANCE in; junk falls back to dry-run", () => {
      expect(
        loadWorkerConfig({ WORKER_SCHEDULING_MAINTENANCE: "on" })
          .schedulingMaintenanceMode,
      ).toBe("on");
      expect(
        loadWorkerConfig({ WORKER_SCHEDULING_MAINTENANCE: "off" })
          .schedulingMaintenanceMode,
      ).toBe("off");
      for (const value of ["ON", "true", "1", "enabled", ""]) {
        expect(
          loadWorkerConfig({ WORKER_SCHEDULING_MAINTENANCE: value })
            .schedulingMaintenanceMode,
          `WORKER_SCHEDULING_MAINTENANCE=${JSON.stringify(value)} must degrade to dry-run`,
        ).toBe("dry-run");
      }
    });

    it("per-mechanism overrides accept off/dry-run/on/inherit; junk falls back to inherit", () => {
      expect(
        loadWorkerConfig({ WORKER_CONCURRENCY_ROT_REPAIR: "on" })
          .concurrencyRotRepairMode,
      ).toBe("on");
      expect(
        loadWorkerConfig({ WORKER_SLOT_RECLAIM: "off" }).slotReclaimMode,
      ).toBe("off");
      expect(
        loadWorkerConfig({ WORKER_CONCURRENCY_ROT_REPAIR: "garbage" })
          .concurrencyRotRepairMode,
      ).toBe("inherit");
    });

    it("WORKER_STUCK_QUEUED_DETECT only turns off on the exact string 'off'", () => {
      expect(
        loadWorkerConfig({ WORKER_STUCK_QUEUED_DETECT: "off" })
          .stuckQueuedDetect,
      ).toBe("off");
      for (const value of ["false", "0", "OFF", "", undefined]) {
        expect(
          loadWorkerConfig({ WORKER_STUCK_QUEUED_DETECT: value })
            .stuckQueuedDetect,
        ).toBe("on");
      }
    });

    it("numeric knobs honour explicit overrides and fall back to defaults on garbage", () => {
      const cfg = loadWorkerConfig({
        HATCHET_STUCK_QUEUED_S: "5",
        HATCHET_WORKER_DEAD_AFTER_S: "2",
        HATCHET_SLOT_MIN_AGE_S: "0",
        HATCHET_MAINT_INTERVAL_S: "10",
        HATCHET_MAINT_BATCH: "500",
      });
      expect(cfg.stuckQueuedS).toBe(5);
      expect(cfg.workerDeadAfterS).toBe(2);
      // "0" is non-positive → falls back to the safe default, same doctrine as pollIntervalMs.
      expect(cfg.slotMinAgeS).toBe(600);
      expect(cfg.maintIntervalS).toBe(10);
      expect(cfg.maintBatch).toBe(500);

      const garbage = loadWorkerConfig({
        HATCHET_STUCK_QUEUED_S: "nope",
        HATCHET_MAINT_BATCH: "-5",
      });
      expect(garbage.stuckQueuedS).toBe(900);
      expect(garbage.maintBatch).toBe(100);
    });

    it("WORKER_HEALTH_PORT is unset by default and only a positive number opts a listener in", () => {
      expect(loadWorkerConfig({}).healthPort).toBeNull();
      expect(loadWorkerConfig({ WORKER_HEALTH_PORT: "9191" }).healthPort).toBe(
        9191,
      );
      expect(
        loadWorkerConfig({ WORKER_HEALTH_PORT: "not-a-port" }).healthPort,
      ).toBeNull();
      expect(loadWorkerConfig({ WORKER_HEALTH_PORT: "0" }).healthPort).toBeNull();
    });
  });
});
