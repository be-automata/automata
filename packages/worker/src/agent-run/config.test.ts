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
    expect(loadWorkerConfig({ CLAUDE_BIN: "/x/bin" }).claudeBinDir).toBe("/x/bin");
  });

  it("ignores a non-positive or non-numeric poll interval", () => {
    expect(loadWorkerConfig({ WORKER_POLL_INTERVAL_MS: "0" }).pollIntervalMs).toBe(
      7000,
    );
    expect(
      loadWorkerConfig({ WORKER_POLL_INTERVAL_MS: "nope" }).pollIntervalMs,
    ).toBe(7000);
  });
});
