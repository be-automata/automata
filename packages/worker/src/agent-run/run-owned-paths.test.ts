import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPaths, runPathsForRepo } from "./run-owned-paths";

/**
 * #302: the worker's per-run dirs sit BESIDE the clone. Nested in it they were
 * git-excluded, yet a repo's pre-push `eslint .` still walked the run HOME,
 * failed, and taught the agent to push with `--no-verify`.
 */
describe("runPaths", () => {
  const runDir = path.join("/runs", "0b9f6c2e-1d3a-4c55-9a0e-6f1d2b3c4d5e");

  it("puts the clone and every worker dir side by side under the run dir", () => {
    const p = runPaths(runDir);
    expect(p).toEqual({
      runDir,
      repo: path.join(runDir, "repo"),
      home: path.join(runDir, "home"),
      ghConfig: path.join(runDir, "gh-config"),
      tmp: path.join(runDir, "tmp"),
      fixCheck: path.join(runDir, "fix-check"),
    });
    for (const dir of [p.home, p.ghConfig, p.tmp, p.fixCheck]) {
      expect(path.dirname(dir)).toBe(runDir);
      expect(dir.startsWith(p.repo + path.sep)).toBe(false);
    }
  });

  it("recovers the run's paths from the clone path", () => {
    expect(runPathsForRepo(runPaths(runDir).repo)).toEqual(runPaths(runDir));
  });
});
