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
});
