/**
 * Write the self-heal benchmark fixture (R6, phase 9) to a directory.
 *
 * Usage:
 *   pnpm exec tsx deploy/self-heal-bench/generate-fixture.ts <outDir>
 *
 * Writes, from SEED_CATALOG (packages/shared/src/self-heal/bench):
 *   <outDir>/repo/           the fixture repo: push it as the initial commit
 *                            of a PRIVATE fixture repo
 *   <outDir>/hidden-tests/   one node:test script per seed; never push these
 *   <outDir>/manifest.json   the seed manifest score.ts and verify-fixes read
 *
 * The output is byte-identical on every run (no clock, no randomness). The
 * command refuses an outDir that exists and is not empty.
 *
 * SAFETY: the fixture declares deliberately vulnerable npm versions and fake
 * secrets. Push it only to a PRIVATE repo; never run the benchmark against
 * the public pilot repo. Nothing is installed here: generate the root
 * lockfile once inside the fixture repo checkout
 * (`npm install --package-lock-only --ignore-scripts`), never in this repo.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { findManifestError } from "../../packages/shared/src/self-heal/bench/fixture-manifest";
import { renderFixture } from "../../packages/shared/src/self-heal/bench/render-fixture";
import { SEED_CATALOG } from "../../packages/shared/src/self-heal/bench/seed-catalog";
import { fail, writeJson } from "./cli";

const USAGE =
  "Usage: pnpm exec tsx deploy/self-heal-bench/generate-fixture.ts <outDir>";

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
}

function main(): void {
  const [outArg, extra] = process.argv.slice(2);
  if (!outArg || extra !== undefined) fail(USAGE);
  const outDir = resolve(outArg);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    fail(`refusing to write into a non-empty directory: ${outDir}`);
  }

  const problem = findManifestError(SEED_CATALOG);
  if (problem !== null) fail(`SEED_CATALOG is invalid: ${problem}`);

  const fixture = renderFixture(SEED_CATALOG);
  mkdirSync(outDir, { recursive: true });
  writeTree(join(outDir, "repo"), fixture.repoFiles);
  writeTree(outDir, fixture.hiddenTests);
  writeJson(join(outDir, "manifest.json"), SEED_CATALOG);

  const count = (kind: string) =>
    SEED_CATALOG.seeds.filter((s) => s.kind === kind).length;
  console.log(
    `wrote ${Object.keys(fixture.repoFiles).length} repo files, ` +
      `${Object.keys(fixture.hiddenTests).length} hidden tests and manifest.json ` +
      `(${count("seeded")} seeded, ${count("rubric")} rubric, ${count("decoy")} decoy) to ${outDir}`,
  );
  console.log(
    "Next: push repo/ to a PRIVATE fixture repo, then generate its root lockfile once there.",
  );
}

main();
