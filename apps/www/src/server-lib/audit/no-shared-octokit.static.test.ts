import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = [HERE, join(HERE, "../../app/api/self-heal")];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

// The gate self-heal-octokit.ts promises: the lane never uses the shared
// per-call Octokit helpers in lib/github (they mint per call and retry).
describe("self-heal lane does not import lib/github", () => {
  it("no non-test source imports @/lib/github or a module under it", () => {
    const offenders = ROOTS.flatMap(sourceFiles).filter((file) =>
      /from\s+["']@\/lib\/github(\/[^"']*)?["']/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
