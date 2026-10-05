import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = [HERE, join(HERE, "../../app/api/self-heal")];

/** Any merge or auto-merge API: REST, GraphQL or the merge_method option. */
const MERGE_API =
  /pulls\.merge|enablePullRequestAutoMerge|merge_method|mergePullRequest|auto_merge|\.merge\(\{/;

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
  it("scans the lane (sanity: the evaluator and the opener are in scope)", () => {
    const files = ROOTS.flatMap(sourceFiles).map((f) => f.replace(HERE, ""));
    expect(files).toEqual(
      expect.arrayContaining(["/evaluate-fix-ci.ts", "/open-fix-pr.ts"]),
    );
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
    ]) {
      expect(MERGE_API.test(line)).toBe(true);
    }
  });
});
