import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The box runs the worker as `node --import tsx` (run-worker.sh), not through
 * Vitest. Under Node, a workspace package without `"type": "module"` loads as
 * CommonJS, and a named value import from it fails at link time:
 * `does not provide an export named …`. Vitest resolves the same import
 * fine, so only a real Node load catches it. Prod 2026-11-19: the first cell
 * run died this way on `@terragon/types/cell` (#656 UAT).
 */
describe("cell executor under node --import tsx", () => {
  it("loads with every named value import resolved", () => {
    const script = [
      'const ced = await import("./src/agent-run/cell-executor-default.ts");',
      'const cell = await import("@terragon/types/cell");',
      'const sandbox = await import("@terragon/sandbox/opensandbox-cell");',
      "console.log(JSON.stringify({",
      '  executor: typeof ced.loadCellConfigFromEnv === "function",',
      '  placeholder: typeof cell.CELL_DAEMON_TOKEN_PLACEHOLDER === "string",',
      '  provider: typeof sandbox.createOpenSandboxCellProvider === "function",',
      "}));",
    ].join("\n");
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: WORKER_ROOT, encoding: "utf8", timeout: 60_000 },
    );
    const last = out.trim().split("\n").at(-1) ?? "";
    expect(JSON.parse(last)).toEqual({
      executor: true,
      placeholder: true,
      provider: true,
    });
  }, 90_000);
});
