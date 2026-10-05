import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../../../..");
/** The www lane, its routes, the worker's agent-run (the fix run's box side) and shared self-heal. */
const ROOTS = [
  HERE,
  join(HERE, "../../app/api/self-heal"),
  join(REPO_ROOT, "packages/worker/src/agent-run"),
  join(REPO_ROOT, "packages/shared/src/self-heal"),
];

/**
 * Any merge or auto-merge API: Octokit REST, GraphQL, the merge_method
 * option, or a raw REST path (PUT /pulls/{n}/merge, POST /repos/{r}/merges).
 */
const MERGE_API =
  /pulls\.merge|enablePullRequestAutoMerge|merge_method|mergePullRequest|auto_merge|\.merge\(\{|\/pulls\/[^"'\s]*\/merge\b|\/merges\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Comment lines say what the lane never does; they are not calls. */
function codeLines(source: string): string[] {
  return source.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line));
}

// HUMAN-MERGE-GATE (T-09-12-3): the self-heal lane marks a draft ready at
// most; a person merges. No file in the lane may call a merge API.
describe("self-heal lane never merges", () => {
  it("scans the lane (sanity: the evaluator, the opener, the lifecycle, the worker fix step and shared self-heal are in scope)", () => {
    const files = ROOTS.flatMap(sourceFiles).map((f) =>
      f.replace(REPO_ROOT, ""),
    );
    expect(files).toEqual(
      expect.arrayContaining([
        "/apps/www/src/server-lib/audit/evaluate-fix-ci.ts",
        "/apps/www/src/server-lib/audit/open-fix-pr.ts",
        "/apps/www/src/server-lib/audit/fix-pr-lifecycle.ts",
        "/apps/www/src/server-lib/audit/hunks.ts",
        "/apps/www/src/server-lib/audit/fix-pr-expiry.ts",
        "/apps/www/src/app/api/self-heal/fix-check/route.ts",
        "/packages/worker/src/agent-run/workflow.ts",
        "/packages/worker/src/agent-run/self-heal-fix-check.ts",
        "/packages/worker/src/agent-run/git-broker.ts",
        "/packages/shared/src/self-heal/fix-paths.ts",
      ]),
    );
    // Tests are excluded (they assert the absence of these calls).
    expect(files.some((f) => /\.test\.tsx?$/.test(f))).toBe(false);
  });

  it("no non-test source calls a merge or auto-merge API", () => {
    const offenders = ROOTS.flatMap(sourceFiles).flatMap((file) =>
      codeLines(readFileSync(file, "utf8"))
        .filter((line) => MERGE_API.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("the pattern catches each merge API form", () => {
    for (const line of [
      "await octokit.rest.pulls.merge({ owner, repo, pull_number });",
      "mutation { enablePullRequestAutoMerge(input: $input) { clientMutationId } }",
      "mutation { mergePullRequest(input: $input) { clientMutationId } }",
      'body: { merge_method: "squash" }',
      "auto_merge: true",
      "await octokit.rest.repos.merge({ owner, repo, base, head });",
      "await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', args);",
      "await fetch(`${api}/repos/${repo}/pulls/${n}/merge`, { method: 'PUT' });",
      'await octokit.request("POST /repos/{owner}/{repo}/merges", args);',
      "await fetch(`${api}/repos/${repo}/merges`, { method: 'POST' });",
    ]) {
      expect(MERGE_API.test(line), line).toBe(true);
    }
  });

  it("the pattern does not flag look-alikes the lane legitimately uses", () => {
    for (const line of [
      'const MERGE_BASE_SCRIPT = \'git merge-base "$2" "$1"\';',
      "await octokit.rest.pulls.get({ owner, repo, pull_number });",
      "const url = `/repos/${repo}/pulls/${n}/files`;",
      "mergedAt: pr.merged_at,",
    ]) {
      expect(MERGE_API.test(line), line).toBe(false);
    }
  });
});
