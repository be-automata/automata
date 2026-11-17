import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Shared by the deploy-asset tests: the hygiene every deploy bash script
 * keeps, and the helper that reads a script's code lines. Test support only.
 */

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/** A script's code lines: its comments state guarantees in prose. */
export const codeOf = (script: string) =>
  script
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/** Probed once: shellcheck is a local static checker, skipped when absent. */
export const SHELLCHECK_AVAILABLE =
  spawnSync("shellcheck", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Tracked executable (git mode 100755), bash with strict mode on line 2,
 * parses with `bash -n`, shellcheck clean. `lines` is the script's text,
 * read by the caller's own `read`.
 */
export function describeBashScriptHygiene(
  relPath: string,
  read: (rel: string) => string,
): void {
  describe(`${path.basename(relPath)}: bash script hygiene`, () => {
    const scriptPath = path.join(repoRoot, relPath);

    it("is tracked as an executable bash script in strict mode", () => {
      const mode = execFileSync("git", ["ls-files", "-s", relPath], {
        cwd: repoRoot,
        encoding: "utf8",
      }).slice(0, 6);
      expect(mode).toBe("100755");
      const lines = read(relPath).split("\n");
      expect(lines[0]).toBe("#!/bin/bash");
      expect(lines[1]).toBe("set -euo pipefail");
    });

    it("parses with bash -n", () => {
      expect(() =>
        execFileSync("bash", ["-n", scriptPath], { stdio: "pipe" }),
      ).not.toThrow();
    });

    // A long script takes shellcheck seconds on a shared CI runner, past the
    // 5s default.
    it("is shellcheck clean", { timeout: 30_000 }, (ctx) => {
      if (!SHELLCHECK_AVAILABLE) ctx.skip();
      const result = spawnSync("shellcheck", ["-s", "bash", scriptPath], {
        encoding: "utf8",
      });
      expect(result.stdout + result.stderr).toBe("");
      expect(result.status).toBe(0);
    });
  });
}
