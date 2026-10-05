/**
 * Score a self-heal benchmark (R6, phase 9) and print the BenchReport JSON.
 *
 * Usage:
 *   pnpm exec tsx deploy/self-heal-bench/score.ts \
 *     --manifest <manifest.json> \
 *     --loop <loop-1.json>,<loop-2.json>,<loop-3.json> \
 *     --audit-only <audit-1.json>,...,<audit-5.json> \
 *     --verification <verify-1.json>,<verify-2.json>,<verify-3.json> \
 *     [--costs <n1>,<n2>,<n3>] [--section-scores <sections.json>]
 *   calibration only:
 *   pnpm exec tsx deploy/self-heal-bench/score.ts --manifest <manifest.json> \
 *     --audit-only <audit-1.json>,...,<audit-5.json> [--section-scores <sections.json>]
 *
 * --loop and --audit-only take collect.ts outputs; --verification takes
 * verify-fixes.ts outputs, one per loop export and in the same order. For the
 * calibration phase (no loop runs yet) omit both --loop and --verification:
 * the report then carries only the calibration and null loop rates.
 * --costs is one total per loop run in a single unit (reported only, never a
 * threshold). --section-scores is a JSON array with one entry per complete
 * audit-only run, oldest first: the `sections` array of that run's
 * audit-findings block ([{ "id": "sensitive-files", "score": 85 }, ...]).
 *
 * Prints the report to stdout (scoreBench + calibrateConsensus from
 * packages/shared/src/self-heal/bench/score.ts; every metric is defined in
 * that file's docblock). Warnings (unexpected run counts) go to stderr.
 */
import { readFileSync } from "node:fs";

import { parseFixtureManifest } from "../../packages/shared/src/self-heal/bench/fixture-manifest";
import {
  parseExportSnapshot,
  parseVerificationResult,
  scoreBench,
  type SectionScoreEntry,
} from "../../packages/shared/src/self-heal/bench/score";

const USAGE =
  "Usage: pnpm exec tsx deploy/self-heal-bench/score.ts --manifest <file> --audit-only <1,..,5> [--loop <a,b,c> --verification <a,b,c>] [--costs <n,n,n>] [--section-scores <file>]";
const EXPECTED_LOOP_RUNS = 3;
const EXPECTED_AUDIT_ONLY_RUNS = 5;
const FLAGS = [
  "--manifest",
  "--loop",
  "--audit-only",
  "--verification",
  "--costs",
  "--section-scores",
];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`cannot read JSON from ${path}: ${message}`);
  }
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseSectionScores(value: unknown): SectionScoreEntry[][] {
  if (!Array.isArray(value)) fail("--section-scores must hold a JSON array");
  return value.map((run, i) => {
    if (!Array.isArray(run)) fail(`section scores entry ${i} is not an array`);
    return run.map((entry, j): SectionScoreEntry => {
      if (typeof entry !== "object" || entry === null) {
        fail(`section scores [${i}][${j}] is not an object`);
      }
      const e = entry as { id?: unknown; score?: unknown };
      if (typeof e.id !== "string") fail(`section scores [${i}][${j}].id`);
      return typeof e.score === "number"
        ? { id: e.id, score: e.score }
        : { id: e.id };
    });
  });
}

function main(): void {
  const argv = process.argv.slice(2);
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const value = argv[i + 1];
    if (!FLAGS.includes(flag) || value === undefined) {
      fail(`bad argument: ${flag}\n${USAGE}`);
    }
    values[flag] = value;
  }
  const manifestPath = values["--manifest"];
  const loopPaths = list(values["--loop"]);
  const auditPaths = list(values["--audit-only"]);
  const verificationPaths = list(values["--verification"]);
  if (!manifestPath || auditPaths.length === 0) fail(USAGE);
  if (loopPaths.length !== verificationPaths.length) {
    fail("--loop and --verification need the same number of files");
  }

  const manifest = parseFixtureManifest(readJson(manifestPath));
  const loopRuns = loopPaths.map((p) => parseExportSnapshot(readJson(p)));
  const auditOnlyRuns = auditPaths.map((p) => parseExportSnapshot(readJson(p)));
  const verification = verificationPaths.map((p) =>
    parseVerificationResult(readJson(p)),
  );
  const costs =
    values["--costs"] === undefined
      ? undefined
      : list(values["--costs"]).map((c) => {
          const n = Number(c);
          if (!Number.isFinite(n) || n < 0) fail(`bad cost: ${c}`);
          return n;
        });
  if (costs !== undefined && costs.length !== loopRuns.length) {
    fail(`--costs needs one value per loop run (${loopRuns.length})`);
  }
  const sectionScores =
    values["--section-scores"] === undefined
      ? undefined
      : parseSectionScores(readJson(values["--section-scores"]));

  const report = scoreBench({
    manifest,
    loopRuns,
    auditOnlyRuns,
    verification,
    ...(costs !== undefined && { costs }),
    ...(sectionScores !== undefined && { sectionScores }),
  });

  if (loopRuns.length > 0 && loopRuns.length !== EXPECTED_LOOP_RUNS) {
    console.error(
      `warning: ${loopRuns.length} loop runs (the procedure uses ${EXPECTED_LOOP_RUNS})`,
    );
  }
  if (report.calibration.runIds.length !== EXPECTED_AUDIT_ONLY_RUNS) {
    console.error(
      `warning: ${report.calibration.runIds.length} complete audit-only runs (the procedure uses ${EXPECTED_AUDIT_ONLY_RUNS})`,
    );
  }
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  fail(
    `score failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
