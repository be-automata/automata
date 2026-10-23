import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOX_SLOTS_MAX,
  loadWorkerConfig,
  parseBoxSlots,
  parseBytesEnv,
  parseCommitFraction,
  parseMaxDeferrals,
  parseLivenessPollS,
  parseLivenessStaleAfterS,
  parseMemoryMax,
  parseTasksMax,
  resolveBoxId,
  parseSlotCount,
} from "./config";

/**
 * ADR-013 P3: every box runs its agents in containers, so the pinned image and
 * the per-run ceiling (`--memory`) are required. REQ is that minimum; every
 * test below starts from it.
 */
const REQ = {
  WORKER_BATTERIES_IMAGE: `ghcr.io/be-automata/automata-batteries@sha256:${"ab".repeat(32)}`,
  WORKER_RUN_MEMORY_MAX: "1500M",
};

describe("loadWorkerConfig", () => {
  it("falls back to sensible defaults when nothing optional is set", () => {
    const cfg = loadWorkerConfig(REQ);
    expect(cfg.anthropicApiKey).toBe("");
    expect(cfg.pollIntervalMs).toBe(7000);
    expect(path.isAbsolute(cfg.daemonDist)).toBe(true);
    expect(cfg.daemonDist).toMatch(/daemon\/dist\/index\.js$/);
    expect(cfg.workdirRoot).toMatch(/automata-worker-runs$/);
    expect(cfg.botLogin).toBe("automata-ai-bot[bot]");
    expect(cfg.runNamespaceRoot).toBe("/tmp/automata-agent-run");
    expect(cfg.containerRuns.image.digest).toBe(`sha256:${"ab".repeat(32)}`);
    expect(cfg.memoryMaxBytes).toBe(1500 * 1024 ** 2);
    expect(cfg.tasksMax).toBe(4096);
  });

  // card: protects=ADR-013 I5/I7: a box without the pinned image, with a tag instead of a digest, or without the per-run ceiling refuses to load (boot AND every run), and a leftover WORKER_AGENT_USER or dev switch selects nothing; fails_when=any of those loads, or a leftover key changes the config; no_claim=the image being present in the rootless store (container-boot tests)
  it("refuses a box without the digest-pinned image or the ceiling; host-path keys select nothing", () => {
    expect(() => loadWorkerConfig({})).toThrow(/WORKER_BATTERIES_IMAGE/);
    expect(() => loadWorkerConfig({ WORKER_RUN_MEMORY_MAX: "1500M" })).toThrow(
      /WORKER_BATTERIES_IMAGE is empty/,
    );
    expect(() =>
      loadWorkerConfig({
        ...REQ,
        WORKER_BATTERIES_IMAGE: "ghcr.io/be-automata/automata-batteries:latest",
      }),
    ).toThrow(/not pinned by digest/);
    expect(() =>
      loadWorkerConfig({ WORKER_BATTERIES_IMAGE: REQ.WORKER_BATTERIES_IMAGE }),
    ).toThrow(/WORKER_RUN_MEMORY_MAX is unset/);
    const leftovers = loadWorkerConfig({
      ...REQ,
      WORKER_AGENT_USER: "automata-agent",
      // The retired dev switch (spelled out so no source names it).
      [["WORKER", "DEV", "CONTAINER", "RUNS"].join("_")]: "0",
    });
    expect(leftovers).toEqual(loadWorkerConfig(REQ));
  });

  it("honours WORKER_RUN_NAMESPACE_ROOT override", () => {
    expect(
      loadWorkerConfig({
        ...REQ,
        WORKER_RUN_NAMESPACE_ROOT: "/data/agent-runs",
      }).runNamespaceRoot,
    ).toBe("/data/agent-runs");
  });

  describe("runTerminalRoot (#386) — where the run-terminal ledger lives", () => {
    it("defaults to the run namespace root (today's behaviour)", () => {
      expect(loadWorkerConfig(REQ).runTerminalRoot).toBe(
        "/tmp/automata-agent-run",
      );
      expect(
        loadWorkerConfig({
          ...REQ,
          WORKER_RUN_NAMESPACE_ROOT: "/data/agent-runs",
        }).runTerminalRoot,
      ).toBe("/data/agent-runs");
    });

    it("honours WORKER_RUN_TERMINAL_ROOT — a durable dir survives the boot-time /tmp wipe", () => {
      expect(
        loadWorkerConfig({
          ...REQ,
          WORKER_RUN_TERMINAL_ROOT: " /usr/local/automata/state ",
        }).runTerminalRoot,
      ).toBe("/usr/local/automata/state");
    });

    it("refuses a relative WORKER_RUN_TERMINAL_ROOT at boot", () => {
      expect(() =>
        loadWorkerConfig({ ...REQ, WORKER_RUN_TERMINAL_ROOT: "state" }),
      ).toThrow(/WORKER_RUN_TERMINAL_ROOT must be an absolute path/);
    });
  });

  describe("boxTrust (D1) — who the box belongs to decides how runs authenticate", () => {
    it("defaults to shared: an unconfigured box never gets a provider credential on disk", () => {
      expect(loadWorkerConfig(REQ).boxTrust).toBe("shared");
    });

    it("only the exact string 'owner' opts in", () => {
      expect(
        loadWorkerConfig({ ...REQ, WORKER_BOX_TRUST: "owner" }).boxTrust,
      ).toBe("owner");
      expect(
        loadWorkerConfig({ ...REQ, WORKER_BOX_TRUST: "  owner  " }).boxTrust,
      ).toBe("owner");
    });

    it("box-key opts the box's own ANTHROPIC_API_KEY in as the run credential", () => {
      // Regression: collapsing this into "shared" forced every run onto the
      // credits proxy. On a platform with no credit balance that killed runs
      // that had been working on the box key for months.
      expect(
        loadWorkerConfig({ ...REQ, WORKER_BOX_TRUST: "box-key" }).boxTrust,
      ).toBe("box-key");
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
          loadWorkerConfig({ ...REQ, WORKER_BOX_TRUST: value }).boxTrust,
          `WORKER_BOX_TRUST=${JSON.stringify(value)} must not opt in`,
        ).toBe("shared");
      }
    });
  });

  describe("credentialBroker (#81) — who holds the installation token", () => {
    it("defaults to on: the agent env never carries the raw token unless the operator opts out", () => {
      expect(loadWorkerConfig(REQ).credentialBroker).toBe("on");
    });

    it("only the exact rollback string opts out; junk stays brokered", () => {
      expect(
        loadWorkerConfig({ ...REQ, WORKER_CREDENTIAL_BROKER: "legacy-direct" })
          .credentialBroker,
      ).toBe("legacy-direct");
      expect(
        loadWorkerConfig({
          ...REQ,
          WORKER_CREDENTIAL_BROKER: " legacy-direct ",
        }).credentialBroker,
      ).toBe("legacy-direct");
      for (const value of ["off", "false", "0", "LEGACY-DIRECT", ""]) {
        expect(
          loadWorkerConfig({ ...REQ, WORKER_CREDENTIAL_BROKER: value })
            .credentialBroker,
          `WORKER_CREDENTIAL_BROKER=${JSON.stringify(value)} must not opt out`,
        ).toBe("on");
      }
    });
  });

  describe("timeoutSalvage (#437 Part B) — the salvage's one-env-var rollback", () => {
    it("defaults to on, and only the exact string 'off' turns it off", () => {
      // protects=the Rollback note: WORKER_TIMEOUT_SALVAGE=off disables the
      // salvage, anything else keeps it on; fails_when=the default is off, a
      // padded "off" is ignored, or a typo ("OFF", "false", "0") disables it;
      // no_claim=the workflow honouring the value (workflow-cleanup tests).
      expect(loadWorkerConfig(REQ).timeoutSalvage).toBe("on");
      for (const value of ["off", " off "]) {
        expect(
          loadWorkerConfig({ ...REQ, WORKER_TIMEOUT_SALVAGE: value })
            .timeoutSalvage,
        ).toBe("off");
      }
      for (const value of ["on", "OFF", "false", "0", "", undefined]) {
        expect(
          loadWorkerConfig({ ...REQ, WORKER_TIMEOUT_SALVAGE: value })
            .timeoutSalvage,
          `WORKER_TIMEOUT_SALVAGE=${JSON.stringify(value)} must keep it on`,
        ).toBe("on");
      }
    });
  });

  it("honours WORKER_BOT_LOGIN override", () => {
    expect(
      loadWorkerConfig({ ...REQ, WORKER_BOT_LOGIN: "somnio-bot[bot]" })
        .botLogin,
    ).toBe("somnio-bot[bot]");
  });

  it("honours explicit env overrides", () => {
    const cfg = loadWorkerConfig({
      ...REQ,
      WORKER_DAEMON_DIST: "/opt/daemon/dist/index.js",
      ANTHROPIC_API_KEY: "sk-abc",
      WORKER_WORKDIR_ROOT: "/data/runs",
      WORKER_POLL_INTERVAL_MS: "5000",
    });
    expect(cfg.daemonDist).toBe("/opt/daemon/dist/index.js");
    expect(cfg.anthropicApiKey).toBe("sk-abc");
    expect(cfg.workdirRoot).toBe("/data/runs");
    expect(cfg.pollIntervalMs).toBe(5000);
  });

  it("ignores a non-positive or non-numeric poll interval", () => {
    expect(
      loadWorkerConfig({ ...REQ, WORKER_POLL_INTERVAL_MS: "0" }).pollIntervalMs,
    ).toBe(7000);
    expect(
      loadWorkerConfig({ ...REQ, WORKER_POLL_INTERVAL_MS: "nope" })
        .pollIntervalMs,
    ).toBe(7000);
  });

  describe("scheduling deadlock recovery (#69, §3.5) — 12 knobs, master-gated", () => {
    it("defaults: master gate unset, everything else safe", () => {
      const cfg = loadWorkerConfig(REQ);
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
      expect(loadWorkerConfig(REQ).stuckQueuedS).toBe(THIRTY_MINUTES_S / 2);
    });

    it("honours HATCHET_ENGINE_DATABASE_URL and HATCHET_ENGINE_TENANT_ID overrides", () => {
      const cfg = loadWorkerConfig({
        ...REQ,
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
        loadWorkerConfig({ ...REQ, WORKER_SCHEDULING_MAINTENANCE: "on" })
          .schedulingMaintenanceMode,
      ).toBe("on");
      expect(
        loadWorkerConfig({ ...REQ, WORKER_SCHEDULING_MAINTENANCE: "off" })
          .schedulingMaintenanceMode,
      ).toBe("off");
      for (const value of ["ON", "true", "1", "enabled", ""]) {
        expect(
          loadWorkerConfig({ ...REQ, WORKER_SCHEDULING_MAINTENANCE: value })
            .schedulingMaintenanceMode,
          `WORKER_SCHEDULING_MAINTENANCE=${JSON.stringify(value)} must degrade to dry-run`,
        ).toBe("dry-run");
      }
    });

    it("per-mechanism overrides accept off/dry-run/on/inherit; junk falls back to inherit", () => {
      expect(
        loadWorkerConfig({ ...REQ, WORKER_CONCURRENCY_ROT_REPAIR: "on" })
          .concurrencyRotRepairMode,
      ).toBe("on");
      expect(
        loadWorkerConfig({ ...REQ, WORKER_SLOT_RECLAIM: "off" })
          .slotReclaimMode,
      ).toBe("off");
      expect(
        loadWorkerConfig({ ...REQ, WORKER_CONCURRENCY_ROT_REPAIR: "garbage" })
          .concurrencyRotRepairMode,
      ).toBe("inherit");
    });

    it("WORKER_STUCK_QUEUED_DETECT only turns off on the exact string 'off'", () => {
      expect(
        loadWorkerConfig({ ...REQ, WORKER_STUCK_QUEUED_DETECT: "off" })
          .stuckQueuedDetect,
      ).toBe("off");
      for (const value of ["false", "0", "OFF", "", undefined]) {
        expect(
          loadWorkerConfig({ ...REQ, WORKER_STUCK_QUEUED_DETECT: value })
            .stuckQueuedDetect,
        ).toBe("on");
      }
    });

    it("numeric knobs honour explicit overrides and fall back to defaults on garbage", () => {
      const cfg = loadWorkerConfig({
        ...REQ,
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
        ...REQ,
        HATCHET_STUCK_QUEUED_S: "nope",
        HATCHET_MAINT_BATCH: "-5",
      });
      expect(garbage.stuckQueuedS).toBe(900);
      expect(garbage.maintBatch).toBe(100);
    });

    it("WORKER_HEALTH_PORT is unset by default and only a positive number opts a listener in", () => {
      expect(loadWorkerConfig(REQ).healthPort).toBeNull();
      expect(
        loadWorkerConfig({ ...REQ, WORKER_HEALTH_PORT: "9191" }).healthPort,
      ).toBe(9191);
      expect(
        loadWorkerConfig({ ...REQ, WORKER_HEALTH_PORT: "not-a-port" })
          .healthPort,
      ).toBeNull();
      expect(
        loadWorkerConfig({ ...REQ, WORKER_HEALTH_PORT: "0" }).healthPort,
      ).toBeNull();
    });
  });
});

describe("resolveBoxId (#192 P5)", () => {
  it("defaults to the hostname — unique per box, no provisioning step", () => {
    expect(resolveBoxId(undefined)).toBe(
      os
        .hostname()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40),
    );
    expect(resolveBoxId("  ")).toBe(resolveBoxId(undefined));
  });

  it("takes an explicit override", () => {
    expect(resolveBoxId("fsn1-exec-1")).toBe("fsn1-exec-1");
  });

  it("sanitises, because the value becomes part of an engine worker name", () => {
    expect(resolveBoxId("FSN1 Exec/1")).toBe("fsn1-exec-1");
    expect(resolveBoxId("--weird--")).toBe("weird");
    expect(resolveBoxId("a".repeat(80))).toHaveLength(40);
  });

  it("never yields an empty name", () => {
    // A worker registered under "automata-worker-" is worse than one under a
    // fallback: it looks like a truncation bug rather than a missing config.
    expect(resolveBoxId("!!!")).toBe("unknown-box");
    expect(resolveBoxId("///")).toBe("unknown-box");
  });
});

describe("#204: memory-ceiling knobs are validated at boot", () => {
  it("is OFF when unset — the default-off contract", () => {
    expect(parseMemoryMax(undefined)).toBe(0);
    expect(parseMemoryMax("")).toBe(0);
    expect(parseMemoryMax("   ")).toBe(0);
  });

  it("accepts bytes and K/M/G, because a byte count gets mistyped", () => {
    expect(parseMemoryMax("1073741824")).toBe(1024 ** 3);
    expect(parseMemoryMax("1G")).toBe(1024 ** 3);
    expect(parseMemoryMax("1500M")).toBe(1500 * 1024 ** 2);
    expect(parseMemoryMax("2g")).toBe(2 * 1024 ** 3);
  });

  it("THROWS on a value it cannot parse rather than silently disabling", () => {
    // A typo that quietly turned the ceiling off would leave the box exposed
    // while the config claims it is protected — the #192 cloud-init lesson.
    for (const bad of ["1.5G", "lots", "1GB", "-1", "1 G", "G"]) {
      expect(() => parseMemoryMax(bad), bad).toThrow(/WORKER_RUN_MEMORY_MAX/);
    }
  });

  it("refuses a ceiling that would kill every run", () => {
    // One agent session measures ~1.1 GB (ADR-002 §6). A 64M ceiling is not a
    // budget, it is an outage, and it should fail at boot not per run.
    expect(() => parseMemoryMax("64M")).toThrow(/below 256M/);
    expect(parseMemoryMax("256M")).toBe(256 * 1024 ** 2);
    // A typo that the regex happily accepts must not reach `memory.max`:
    // past 2^53 the product is imprecise, and further out it is Infinity.
    for (const huge of [
      "99999999999999999999G",
      "9007199254740993",
      "1000000000000G",
    ]) {
      expect(() => parseMemoryMax(huge), huge).toThrow(
        /exact integer number of bytes/,
      );
    }
    // And the realistic end of the range still parses exactly.
    expect(parseMemoryMax("1500M")).toBe(1500 * 1024 ** 2);
    expect(parseMemoryMax("8G")).toBe(8 * 1024 ** 3);
  });

  // card: protects=WORKER_RUN_TASKS_MAX (every container's --pids-limit) is validated at boot: a typo refuses to load; fails_when=a bad value loads; no_claim=the kernel enforcing it (prove-container-limits.sh)
  it("a malformed WORKER_RUN_TASKS_MAX is refused at boot", () => {
    expect(() =>
      loadWorkerConfig({ ...REQ, WORKER_RUN_TASKS_MAX: "not-a-number" }),
    ).toThrow(/WORKER_RUN_TASKS_MAX/);
    expect(
      loadWorkerConfig({ ...REQ, WORKER_RUN_TASKS_MAX: "512" }).tasksMax,
    ).toBe(512);
  });

  it("defaults tasksMax generously — it is a runaway guard, not a budget", () => {
    expect(parseTasksMax(undefined)).toBe(4096);
    expect(parseTasksMax("512")).toBe(512);
    for (const bad of ["0", "63", "abc", "1.5"]) {
      expect(() => parseTasksMax(bad), bad).toThrow(/WORKER_RUN_TASKS_MAX/);
    }
  });
});

describe("#215: engine-liveness watchdog knobs are validated at boot", () => {
  it("is OFF when unset — the default-off contract", () => {
    expect(parseLivenessStaleAfterS(undefined)).toBe(0);
    expect(parseLivenessStaleAfterS("")).toBe(0);
    expect(parseLivenessStaleAfterS("   ")).toBe(0);

    const cfg = loadWorkerConfig(REQ);
    expect(cfg.livenessStaleAfterS).toBe(0);
    expect(cfg.livenessPollS).toBe(0);
  });

  it("turns on with the default poll period when only the threshold is set", () => {
    const cfg = loadWorkerConfig({ ...REQ, WORKER_LIVENESS_STALE_S: "900" });
    expect(cfg.livenessStaleAfterS).toBe(900);
    expect(cfg.livenessPollS).toBe(60);
  });

  it("honours an explicit poll period", () => {
    const cfg = loadWorkerConfig({
      ...REQ,
      WORKER_LIVENESS_STALE_S: "900",
      WORKER_LIVENESS_POLL_S: "30",
    });
    expect(cfg.livenessStaleAfterS).toBe(900);
    expect(cfg.livenessPollS).toBe(30);
  });

  it("THROWS on a threshold it cannot parse rather than silently disabling", () => {
    // A typo that quietly turned the watchdog off would leave the box LOOKING
    // guarded while running unguarded — the exact failure this ticket removes.
    for (const bad of ["abc", "0", "-1", "900.5", "900s"]) {
      expect(() => parseLivenessStaleAfterS(bad), bad).toThrow(
        /WORKER_LIVENESS_STALE_S/,
      );
    }
  });

  it("refuses a hair-trigger threshold, naming the 300s floor", () => {
    // An idle worker is not a wedged worker; a short threshold restart-loops a
    // healthy box, which is worse than the bug it guards against.
    expect(() => parseLivenessStaleAfterS("60")).toThrow(/below 300s/);
    expect(() =>
      loadWorkerConfig({ ...REQ, WORKER_LIVENESS_STALE_S: "60" }),
    ).toThrow(/below 300s/);
    expect(parseLivenessStaleAfterS("300")).toBe(300);
  });

  it("refuses a poll period at or above the threshold — a hard boot failure", () => {
    // A watchdog that ticks no more often than its own threshold cannot observe
    // staleness: the box would look guarded and be guarded by nothing.
    expect(() =>
      loadWorkerConfig({
        ...REQ,
        WORKER_LIVENESS_STALE_S: "900",
        WORKER_LIVENESS_POLL_S: "900",
      }),
    ).toThrow(/WORKER_LIVENESS_POLL_S=900 must be well below/);
    expect(() =>
      loadWorkerConfig({
        ...REQ,
        WORKER_LIVENESS_STALE_S: "900",
        WORKER_LIVENESS_POLL_S: "1200",
      }),
    ).toThrow(/WORKER_LIVENESS_STALE_S=900/);
  });

  it("a stray WORKER_LIVENESS_POLL_S does NOT stop a box with the watchdog OFF", () => {
    // Same doctrine as WORKER_RUN_TASKS_MAX: with the feature off the value is
    // unused, so a leftover env var is not this feature's business to reject.
    const off = loadWorkerConfig({
      ...REQ,
      WORKER_LIVENESS_POLL_S: "not-a-number",
    });
    expect(off.livenessStaleAfterS).toBe(0);
    expect(off.livenessPollS).toBe(0);

    // Watchdog ON: now it IS used, so a typo must be refused at boot.
    expect(() =>
      loadWorkerConfig({
        ...REQ,
        WORKER_LIVENESS_STALE_S: "900",
        WORKER_LIVENESS_POLL_S: "not-a-number",
      }),
    ).toThrow(/WORKER_LIVENESS_POLL_S/);
  });

  it("defaults the poll period and refuses one below 5s", () => {
    expect(parseLivenessPollS(undefined)).toBe(60);
    expect(parseLivenessPollS("")).toBe(60);
    expect(parseLivenessPollS("15")).toBe(15);
    for (const bad of ["4", "0", "-5", "abc", "1.5"]) {
      expect(() => parseLivenessPollS(bad), bad).toThrow(
        /WORKER_LIVENESS_POLL_S must be an integer >= 5/,
      );
    }
  });
});

describe("#205: WORKER_BOX_SLOTS — the counting box budget is validated at boot", () => {
  it("defaults to 1 — the exclusive lock, byte-for-byte today's box", () => {
    expect(parseBoxSlots(undefined)).toBe(1);
    expect(parseBoxSlots("")).toBe(1);
    expect(parseBoxSlots("  ")).toBe(1);
    expect(loadWorkerConfig(REQ).boxSlots).toBe(1);
  });

  it("accepts an integer in [1, BOX_SLOTS_MAX] and refuses everything else, naming the knob", () => {
    expect(parseBoxSlots("3")).toBe(3);
    expect(parseBoxSlots(String(BOX_SLOTS_MAX))).toBe(BOX_SLOTS_MAX);
    for (const bad of [
      "0",
      "-1",
      "1.5",
      "two",
      "1e1",
      String(BOX_SLOTS_MAX + 1),
    ]) {
      expect(() => parseBoxSlots(bad), bad).toThrow(/WORKER_BOX_SLOTS/);
    }
  });

  // card: protects=N > 1 loads on the container baseline alone (each slot's run is its own container with its own --memory) once the engine cap moves with it; fails_when=N > 1 still demands a slot account or refuses a consistent tuple; no_claim=the box's commit budget (assertSlotsFitCommitLimit)
  it("N > 1 loads with the required ceiling and a matching engine cap — no slot accounts", () => {
    const cfg = loadWorkerConfig({
      ...REQ,
      WORKER_BOX_SLOTS: "3",
      // #372: the engine cap moves with the slots (the tuple is one setting).
      WORKER_GLOBAL_MAX_RUNS: "3",
    });
    expect(cfg.boxSlots).toBe(3);
  });

  it("refuses a deferral count whose worst-case wait breaks the stalled-cutoff budget, naming both numbers", () => {
    // 2+4+8+16+32+64 = 126 s, then 120 s per extra retry: 11 retries = 726 s > 720 s.
    expect(() =>
      loadWorkerConfig({ ...REQ, WORKER_ADMISSION_MAX_DEFERRALS: "11" }),
    ).toThrow(
      /WORKER_ADMISSION_MAX_DEFERRALS=11 waits up to 726s.*720s budget.*75-minute/,
    );
    expect(
      loadWorkerConfig({ ...REQ, WORKER_ADMISSION_MAX_DEFERRALS: "10" })
        .admissionMaxDeferrals,
    ).toBe(10);
  });

  it("a stray WORKER_BOX_SLOTS=1 never trips the N > 1 requirements (default-off promise)", () => {
    expect(loadWorkerConfig({ ...REQ, WORKER_BOX_SLOTS: "1" }).boxSlots).toBe(
      1,
    );
  });
});

describe("#371: memory-headroom admission knobs are validated at boot", () => {
  it("defaults: floor 1G, fraction 0.9, run commit = the ceiling, 8 deferrals", () => {
    const cfg = loadWorkerConfig(REQ);
    expect(cfg.headroomFloorBytes).toBe(1024 ** 3);
    expect(cfg.headroomCommitFraction).toBe(0.9);
    expect(cfg.headroomRunCommitBytes).toBe(1500 * 1024 ** 2);
    expect(cfg.admissionMaxDeferrals).toBe(8);
  });

  it("the run commit defaults to the run's own ceiling when the ceiling is on", () => {
    const cfg = loadWorkerConfig({
      ...REQ,
      WORKER_RUN_MEMORY_MAX: "5000M",
    });
    expect(cfg.headroomRunCommitBytes).toBe(5000 * 1024 ** 2);
    expect(
      loadWorkerConfig({
        ...REQ,
        WORKER_RUN_MEMORY_MAX: "5000M",
        WORKER_HEADROOM_RUN_COMMIT: "2G",
      }).headroomRunCommitBytes,
    ).toBe(2 * 1024 ** 3);
  });

  it("the documented rollback values (floor 0, fraction 1.0) load and make the check inert", () => {
    const cfg = loadWorkerConfig({
      ...REQ,
      WORKER_HEADROOM_FLOOR: "0",
      WORKER_HEADROOM_COMMIT_FRACTION: "1.0",
    });
    expect(cfg.headroomFloorBytes).toBe(0);
    expect(cfg.headroomCommitFraction).toBe(1);
  });

  it("refuses nonsense, naming the knob", () => {
    for (const bad of ["1.5G", "lots", "-1", "1 G"]) {
      expect(() => parseBytesEnv("WORKER_HEADROOM_FLOOR", bad, 1), bad).toThrow(
        /WORKER_HEADROOM_FLOOR/,
      );
    }
    for (const bad of ["0", "1.5", "abc", "-0.5"]) {
      expect(() => parseCommitFraction(bad), bad).toThrow(
        /WORKER_HEADROOM_COMMIT_FRACTION/,
      );
    }
    for (const bad of ["-1", "1.5", "x"]) {
      expect(() => parseMaxDeferrals(bad), bad).toThrow(
        /WORKER_ADMISSION_MAX_DEFERRALS/,
      );
    }
    expect(parseMaxDeferrals("0")).toBe(0);
    // The parser has no numeric cap of its own: the budget check in
    // loadWorkerConfig is the one upper bound (tested above).
    expect(parseMaxDeferrals("20")).toBe(20);
    expect(() =>
      loadWorkerConfig({ ...REQ, WORKER_HEADROOM_RUN_COMMIT: "0" }),
    ).toThrow(/WORKER_HEADROOM_RUN_COMMIT must be positive/);
  });
});

describe("#372: WORKER_GLOBAL_MAX_RUNS / WORKER_PER_ORG_MAX_RUNS — the engine caps move with the box slots", () => {
  const twoSlots = {
    ...REQ,
    WORKER_RUN_MEMORY_MAX: "5000M",
    WORKER_BOX_SLOTS: "2",
  };

  it("defaults to 1/1 — today's compile-time caps, and a stray explicit 1 never trips anything", () => {
    expect(parseSlotCount("WORKER_GLOBAL_MAX_RUNS", undefined)).toBe(1);
    expect(parseSlotCount("WORKER_GLOBAL_MAX_RUNS", " ")).toBe(1);
    const cfg = loadWorkerConfig(REQ);
    expect(cfg.globalMaxRuns).toBe(1);
    expect(cfg.perOrgMaxRuns).toBe(1);
    expect(
      loadWorkerConfig({
        ...REQ,
        WORKER_GLOBAL_MAX_RUNS: "1",
        WORKER_PER_ORG_MAX_RUNS: "1",
      }).globalMaxRuns,
    ).toBe(1);
  });

  it("accepts an integer in [1, BOX_SLOTS_MAX] and refuses everything else, naming the knob", () => {
    expect(parseSlotCount("WORKER_PER_ORG_MAX_RUNS", "3")).toBe(3);
    for (const bad of [
      "0",
      "-1",
      "1.5",
      "two",
      "1e1",
      String(BOX_SLOTS_MAX + 1),
    ]) {
      expect(() => parseSlotCount("WORKER_PER_ORG_MAX_RUNS", bad), bad).toThrow(
        /WORKER_PER_ORG_MAX_RUNS/,
      );
    }
  });

  it("an EXPLICIT GLOBAL ≠ SLOTS is refused at boot, naming BOTH knobs (epic AC 8) — in either direction", () => {
    expect(() =>
      loadWorkerConfig({ ...REQ, WORKER_GLOBAL_MAX_RUNS: "3" }),
    ).toThrow(/WORKER_GLOBAL_MAX_RUNS=3.*WORKER_BOX_SLOTS=1/s);
    expect(() =>
      loadWorkerConfig({ ...twoSlots, WORKER_GLOBAL_MAX_RUNS: "1" }),
    ).toThrow(/WORKER_GLOBAL_MAX_RUNS=1.*WORKER_BOX_SLOTS=2/s);
  });

  it("an UNSET global cap follows the slots (a box already at N = 2 keeps booting across this change); the per-org cap still defaults to 1", () => {
    const cfg = loadWorkerConfig({ ...twoSlots });
    expect(cfg.globalMaxRuns).toBe(2);
    expect(cfg.perOrgMaxRuns).toBe(1);
  });

  it("PER_ORG > GLOBAL is refused, naming both knobs", () => {
    expect(() =>
      loadWorkerConfig({
        ...twoSlots,
        WORKER_GLOBAL_MAX_RUNS: "2",
        WORKER_PER_ORG_MAX_RUNS: "3",
      }),
    ).toThrow(/WORKER_PER_ORG_MAX_RUNS=3.*WORKER_GLOBAL_MAX_RUNS=2/s);
  });

  it("the consistent raised tuple loads (2/2/2 + ceiling), and per-org = global is allowed", () => {
    const cfg = loadWorkerConfig({
      ...twoSlots,
      WORKER_GLOBAL_MAX_RUNS: "2",
      WORKER_PER_ORG_MAX_RUNS: "2",
    });
    expect(cfg.boxSlots).toBe(2);
    expect(cfg.globalMaxRuns).toBe(2);
    expect(cfg.perOrgMaxRuns).toBe(2);
    expect(
      loadWorkerConfig({
        ...twoSlots,
        WORKER_GLOBAL_MAX_RUNS: "2",
        WORKER_PER_ORG_MAX_RUNS: "1",
      }).perOrgMaxRuns,
    ).toBe(1);
  });

  it("the ceiling comes first: SLOTS > 1 without it is refused before the caps are compared", () => {
    expect(() =>
      loadWorkerConfig({
        WORKER_BATTERIES_IMAGE: REQ.WORKER_BATTERIES_IMAGE,
        WORKER_BOX_SLOTS: "2",
        WORKER_GLOBAL_MAX_RUNS: "2",
      }),
    ).toThrow(/WORKER_RUN_MEMORY_MAX is unset/);
  });
});
