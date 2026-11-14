import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Every subpath export in the utils manifest must point at a source file that exists.
 * www and the worker import these subpaths directly (e.g. `@terragon/utils/run-lane`,
 * #373), so a typo in the map fails the consumer's build, not this package's.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const MANIFEST = "packages/utils/package.json";

function readExports(): Record<string, string> {
  const raw: unknown = JSON.parse(
    fs.readFileSync(path.join(repoRoot, MANIFEST), "utf8"),
  );
  if (typeof raw !== "object" || raw === null || !("exports" in raw)) {
    throw new Error(`${MANIFEST} has no exports map`);
  }
  const exportsMap = (raw as { exports: unknown }).exports;
  if (typeof exportsMap !== "object" || exportsMap === null) {
    throw new Error(`${MANIFEST} exports is not an object`);
  }
  return exportsMap as Record<string, string>;
}

describe(`${MANIFEST} exports`, () => {
  const exportsMap = readExports();

  it.each(Object.entries(exportsMap))(
    "%s points at an existing source file",
    (_subpath, target) => {
      expect(typeof target).toBe("string");
      const file = path.join(repoRoot, "packages", "utils", target);
      expect(fs.existsSync(file)).toBe(true);
    },
  );

  it("exports the run display-lane module shared by www and the worker (#373)", () => {
    expect(exportsMap["./run-lane"]).toBe("./src/run-lane.ts");
  });
});
