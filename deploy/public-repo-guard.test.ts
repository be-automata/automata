/**
 * T10: this repository is public, so the review-lane files ported for
 * customer repositories must never name a customer org or repo (AC14).
 *
 *   Run:  node --test deploy/public-repo-guard.test.ts
 *
 * protects=public repo hygiene for the ported skills and the cutover tools;
 * fails_when=a customer org/repo name appears in a guarded file;
 * no_claim=files outside the guarded paths (the pre-push
 *   `git diff origin/main...HEAD | grep -iE …` gate covers the rest).
 *
 * The pattern is assembled from fragments so this file does not itself
 * contain the names it guards against (the pre-push grep scans it too).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const CUSTOMER_NAMES = new RegExp(
  [
    ["ban", "gr"],
    ["track", "gr"],
    ["market", "place"],
    ["somnio-", "projects"],
  ]
    .map((parts) => parts.join(""))
    .join("|"),
  "i",
);

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Guarded paths, repo-relative. A missing optional path is skipped. */
const GUARDED: { path: string; required: boolean }[] = [
  { path: "deploy/skills", required: true },
  { path: "deploy/onboard-review-repo.ts", required: true },
  { path: "deploy/lib/onboard-review-repo-args.ts", required: true },
  { path: "deploy/lib/flatten-skill.ts", required: true },
  { path: "deploy/review-replay.ts", required: false },
  { path: "packages/review/src/review/context", required: false },
];

function filesUnder(absolute: string): string[] {
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .map((entry) => path.join(absolute, entry))
    .filter((entry) => statSync(entry).isFile());
}

describe("public repo guard", () => {
  test("the pattern matches every guarded name, case-insensitively", () => {
    for (const sample of [
      ["Ban", "gr-core"],
      ["track", "GR"],
      ["market", "place-monorepo"],
      ["somnio-", "projects/x"],
    ]) {
      assert.match(sample.join(""), CUSTOMER_NAMES);
    }
    assert.doesNotMatch("somnio-software/somnio-ai-tools", CUSTOMER_NAMES);
  });

  test("no guarded file names a customer org or repo", () => {
    const scanned: string[] = [];
    const hits: string[] = [];
    for (const guarded of GUARDED) {
      const absolute = path.join(REPO_ROOT, guarded.path);
      if (!existsSync(absolute)) {
        assert.equal(guarded.required, false, `${guarded.path} is missing`);
        continue;
      }
      for (const file of filesUnder(absolute)) {
        scanned.push(file);
        const lines = readFileSync(file, "utf8").split("\n");
        for (const [index, line] of lines.entries()) {
          if (CUSTOMER_NAMES.test(line)) {
            hits.push(`${path.relative(REPO_ROOT, file)}:${index + 1}`);
          }
        }
      }
    }
    assert.ok(scanned.length >= 8, `scanned only ${scanned.length} files`);
    assert.deepEqual(hits, []);
  });
});
