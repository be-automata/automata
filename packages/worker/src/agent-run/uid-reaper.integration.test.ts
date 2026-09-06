import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reapAgentUidEscapees } from "./uid-reaper";

/**
 * Linux-only kernel drill (#184 AC13): a real `sudo -u automata-it-agent
 * setsid sleep 3600` process is killed by the REAL sudo kill invocation
 * (`buildKillAllAsAgentInvocation`), not a mock. `HOST_UID_IT` gates it so
 * it never runs outside CI (or a developer box that has provisioned the
 * account and passwordless sudo) — the account only exists on the
 * `worker-e2e` GitHub Actions runner (`.github/workflows/ci.yml`).
 *
 * Never imports anything that reads the production namespace root: this
 * drives `reapAgentUidEscapees` directly with `agentUser:
 * "automata-it-agent"`, entirely separate from any real worker box lock.
 */

const AGENT_USER = "automata-it-agent";
const execFileAsync = promisify(execFile);

async function countAgentUserProcs(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-u", AGENT_USER]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  } catch (e) {
    // pgrep exits 1 when no processes match — that is "zero", not a failure.
    const err = e as { code?: number };
    if (err.code === 1) return 0;
    throw e;
  }
}

async function pollUntil(
  predicate: () => Promise<boolean>,
  boundMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start >= boundMs) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function killBackstop(): Promise<void> {
  try {
    await execFileAsync("sudo", [
      "-n",
      "-u",
      AGENT_USER,
      "/bin/kill",
      "-9",
      "--",
      "-1",
    ]);
  } catch {
    // Best-effort backstop only — ESRCH (nothing left) is expected and fine.
  }
}

describe.skipIf(!process.env.HOST_UID_IT || process.platform !== "linux")(
  "uid-reaper against a real kernel (#184 AC13, linux CI only)",
  () => {
    beforeEach(async () => {
      const child = spawn(
        "sudo",
        ["-n", "-u", AGENT_USER, "setsid", "sleep", "3600"],
        { detached: true, stdio: "ignore" },
      );
      child.unref();

      const spawned = await pollUntil(
        async () => (await countAgentUserProcs()) >= 1,
        2000,
      );
      expect(spawned).toBe(true);
    }, 15_000);

    afterEach(async () => {
      await killBackstop();
    }, 15_000);

    it("kills every process under the agent uid and confirms zero residual", async () => {
      const log = (): void => {
        // Intentionally silent — the assertions below are the signal.
      };

      const result = await reapAgentUidEscapees({
        agentUser: AGENT_USER,
        phase: "admission",
        log,
      });

      expect(result.error).toBeUndefined();
      expect(result.failed).toBe(0);
      expect(result.killed).toBeGreaterThanOrEqual(1);
      expect(result.residual).toBe(0);

      const cleared = await pollUntil(
        async () => (await countAgentUserProcs()) === 0,
        2000,
      );
      expect(cleared).toBe(true);
    }, 15_000);
  },
);
