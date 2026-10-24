import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { armGrowthTriggers } from "./growth-triggers-io";

/**
 * #373 AC 1 at the boot site. hello/worker.ts runs main() on import, so it cannot be
 * unit-tested; armGrowthTriggers' own null-when-unset contract is covered by
 * growth-triggers-io.test.ts. This pins the wiring around it: where it is armed, that
 * the unconfigured path prints nothing, and that a configured-but-unarmable box refuses
 * to start rather than booting without the alerts it was told to send.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const BOOT_FILE = "packages/worker/src/hello/worker.ts";
const boot = fs.readFileSync(path.join(repoRoot, BOOT_FILE), "utf8");

/** The `try { armGrowthTriggers(…) } catch { … }` statement, braces balanced. */
function armStatement(): string {
  const call = boot.indexOf("armGrowthTriggers(process.env");
  expect(call).toBeGreaterThan(-1);
  const start = boot.lastIndexOf("try {", call);
  const catchAt = boot.indexOf("} catch", call);
  const end = boot.indexOf("\n  }\n", catchAt);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(catchAt);
  return boot.slice(start, end);
}

describe(`#373 growth triggers are wired in ${BOOT_FILE}`, () => {
  it("imports the evaluator from the I/O module", () => {
    expect(boot).toMatch(
      /import \{ armGrowthTriggers \} from "\.\.\/agent-run\/growth-triggers-io";/,
    );
  });

  it("arms after the #215 liveness watchdog and before the maintenance loop", () => {
    const liveness = boot.indexOf("startEngineLivenessWatchdog({");
    const arm = boot.indexOf("armGrowthTriggers(process.env");
    const maintenance = boot.indexOf("startMaintenanceLoop(");
    expect(liveness).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(liveness);
    expect(maintenance).toBeGreaterThan(arm);
  });

  it("prints nothing on its own when unconfigured (the boot log stays unchanged)", () => {
    const tryBlock = armStatement().split("} catch")[0] ?? "";
    expect(tryBlock).not.toMatch(/console\.(log|warn|info)/);
  });

  it("a configured box that cannot arm refuses to start", () => {
    const statement = armStatement();
    expect(statement).toMatch(
      /FATAL: growth triggers are configured but cannot be armed — refusing to start/,
    );
    expect(statement).toMatch(/process\.exit\(1\)/);
  });

  it("never logs the webhook URL at the boot site", () => {
    expect(armStatement()).not.toMatch(/WORKER_ALERT_WEBHOOK_URL/);
  });

  it("what arm throws — the error the FATAL line prints — cannot carry the webhook URL", () => {
    const secretUrl =
      "https://hooks.example.test/services/T000/B000/SECRET-BOOT-PATH";
    let thrown: unknown;
    try {
      armGrowthTriggers(
        { WORKER_ALERT_WEBHOOK_URL: secretUrl },
        {
          resolveEngine: () => {
            throw new Error(
              `cannot reach the engine configured next to ${secretUrl}`,
            );
          },
          boxId: "box-boot",
          snapshotDir: "/nonexistent/growth-boot",
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.message).not.toContain(secretUrl);
    expect(String(err.stack)).not.toContain(secretUrl);
    expect(err.cause).toBeUndefined();
    expect(err.message).toBe(
      "growth triggers: cannot resolve the engine target (Error)",
    );
  });
});
