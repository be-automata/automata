import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { preflightHostGhAuth } from "./gh-preflight";

const BROKER = {
  gitUrl: "http://127.0.0.1:4100",
  ghSocketPath: "/tmp/automata-agent-run/w-1/thr-gh.sock",
  bearer: "run-bearer-abc",
  repoFullName: "acme/repo",
};

type Seen = { env: NodeJS.ProcessEnv; cwd: string; config: string | null };

function recordingExec(seen: Seen[], fail?: string) {
  return async (
    _command: string,
    _args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
  ) => {
    const dir = opts.env.GH_CONFIG_DIR ?? "";
    let config: string | null = null;
    try {
      config = fs.readFileSync(`${dir}/config.yml`, "utf8");
    } catch {
      config = null;
    }
    seen.push({ env: opts.env, cwd: opts.cwd, config });
    if (fail) {
      throw Object.assign(new Error("exit 1"), { stderr: fail });
    }
    return { stdout: "", stderr: "" };
  };
}

describe("preflightHostGhAuth (ADR-002 F3 on the host, ADR-013)", () => {
  // card: protects=the host preflight runs gh with the per-run bearer through the gh broker's socket (config.yml), never the installation token, in the run's clone, and removes its private config dir afterwards; fails_when=GH_TOKEN carries the installation token, the broker socket is not configured, the cwd is not the clone, or the dir outlives the check; no_claim=a real gh binary or a live broker (broker-integration tests)
  it("brokered: gh gets the bearer and the broker socket; the config dir is gone after", async () => {
    const seen: Seen[] = [];
    await preflightHostGhAuth({
      workdir: "/runs/thr/repo",
      installationToken: "ghs_installation",
      botLogin: "automata-ai-bot[bot]",
      broker: BROKER,
      egressProxyUrl: null,
      exec: recordingExec(seen),
    });
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call?.cwd).toBe("/runs/thr/repo");
    expect(call?.env.GH_TOKEN).toBe("run-bearer-abc");
    expect(JSON.stringify(call?.env)).not.toContain("ghs_installation");
    expect(call?.config).toContain(BROKER.ghSocketPath);
    expect(fs.existsSync(call?.env.GH_CONFIG_DIR ?? "/nonexistent")).toBe(
      false,
    );
  });

  // card: protects=a failing gh auth check blocks the run with its detail (fail-closed bot identity); fails_when=a failed check resolves; no_claim=the workflow's NonRetryable wrapping (workflow.ts nonRetryablePreflight)
  it("a failed check throws the gh detail and still removes the config dir", async () => {
    const seen: Seen[] = [];
    await expect(
      preflightHostGhAuth({
        workdir: "/runs/thr/repo",
        installationToken: "ghs_installation",
        botLogin: "automata-ai-bot[bot]",
        broker: BROKER,
        egressProxyUrl: null,
        exec: recordingExec(seen, "not logged in"),
      }),
    ).rejects.toThrow(/gh auth precondition failed.*not logged in/);
    expect(fs.existsSync(seen[0]?.env.GH_CONFIG_DIR ?? "/nonexistent")).toBe(
      false,
    );
  });
});
