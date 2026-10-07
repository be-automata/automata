import { describe, expect, it } from "vitest";

import {
  evaluateFixDiff,
  GUARD_REASONS,
  hasSuppressionMarker,
  type FixDiffFile,
} from "./suppression-guard";

const PLAN = ["src/a.ts", "package.json"];

function mod(
  filename: string,
  patch: string | undefined,
  over: Partial<FixDiffFile> = {},
): FixDiffFile {
  const lines = (patch ?? "").split("\n");
  return {
    filename,
    status: "modified",
    additions: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .length,
    deletions: lines.filter((l) => l.startsWith("-") && !l.startsWith("---"))
      .length,
    ...(patch !== undefined ? { patch } : {}),
    ...over,
  };
}

function run(
  files: FixDiffFile[],
  over: Partial<Parameters<typeof evaluateFixDiff>[0]> = {},
) {
  return evaluateFixDiff({
    files,
    planFiles: PLAN,
    ruleId: "dep.vulnerable",
    subject: "lodash",
    maxDiffLines: 300,
    ...over,
  });
}

const CLEAN = "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;";

describe("evaluateFixDiff (R4, R5, FENCE-01)", () => {
  it("a clean in-plan modification passes", () => {
    const result = run([mod("src/a.ts", CLEAN)]);
    expect(result).toEqual({
      ok: true,
      rejections: [],
      flags: [],
      diffLines: 2,
    });
  });

  it.each([
    ["+ // eslint-disable-next-line", "+// eslint-disable-next-line no-eval"],
    ["@ts-ignore", "+  // @ts-ignore"],
    ["@ts-nocheck", "+// @ts-nocheck"],
    ["@ts-expect-error", "+  // @ts-expect-error wrong types"],
    ["# nosec", "+password = x  # nosec"],
    ["noqa", "+import os  # noqa: F401"],
    ["istanbul ignore", "+/* istanbul ignore next */"],
    ["c8 ignore", "+/* c8 ignore next */"],
    ["NOSONAR", "+foo(); // NOSONAR"],
    ["nolint", "+x := 1 //nolint:errcheck"],
  ])("an added %s → suppression_comment", (_label, line) => {
    const result = run([mod("src/a.ts", `@@ -1 +1,2 @@\n ok\n${line}`)]);
    expect(result.ok).toBe(false);
    expect(result.rejections).toEqual(["suppression_comment"]);
  });

  it("removing a suppression is fine", () => {
    const result = run([
      mod("src/a.ts", "@@ -1,2 +1 @@\n-// @ts-ignore\n code();", {
        additions: 0,
        deletions: 1,
      }),
      mod("package.json", '@@ -1 +1 @@\n-"a": "1"\n+"a": "2"'),
    ]);
    expect(result.ok).toBe(true);
  });

  it("the +++ header line is not scanned", () => {
    const result = run([
      mod("src/a.ts", "+++ b/src/eslint-disable.ts\n@@ -1 +1 @@\n-a\n+b", {
        additions: 1,
        deletions: 1,
      }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("modifying an existing test → test_edit", () => {
    const result = run([mod("src/a.test.ts", CLEAN)], {
      planFiles: ["src/a.ts", "src/a.test.ts"],
    });
    expect(result.rejections).toEqual(["test_edit"]);
  });

  it("adding a new test is allowed and flagged", () => {
    const result = run([
      mod("src/a.ts", CLEAN),
      mod("src/new.test.ts", "@@ -0,0 +1 @@\n+it('x', () => {});", {
        status: "added",
      }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.flags).toEqual(["new_test_file"]);
  });

  it("deleting a test → test_edit", () => {
    const result = run([
      {
        filename: "tests/old_test.py",
        status: "removed",
        additions: 0,
        deletions: 4,
      },
    ]);
    expect(result.rejections).toEqual(["test_edit"]);
  });

  it("renaming a test away → test_edit", () => {
    const result = run([
      {
        filename: "src/a.ts",
        previous_filename: "src/a.spec.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      },
    ]);
    expect(result.rejections).toContain("test_edit");
  });

  it("a workflow edit for a non-ci rule → ci_edit + denied_path", () => {
    const result = run([mod(".github/workflows/ci.yml", CLEAN)], {
      planFiles: [".github/workflows/ci.yml"],
    });
    expect(result.rejections).toEqual(["ci_edit", "denied_path"]);
  });

  it("a ci.* rule may edit exactly its planned workflow", () => {
    const result = run([mod(".github/workflows/ci.yml", CLEAN)], {
      ruleId: "ci.action-unpinned",
      planFiles: [".github/workflows/ci.yml"],
    });
    expect(result.ok).toBe(true);
  });

  it("a ci.* rule may not edit a workflow its plan does not list", () => {
    const result = run([mod(".github/workflows/release.yml", CLEAN)], {
      ruleId: "ci.action-unpinned",
      planFiles: [".github/workflows/ci.yml"],
    });
    expect(result.rejections).toEqual(["ci_edit", "denied_path"]);
  });

  it("an audit config edit → audit_config_edit", () => {
    const result = run([mod("eslint.config.js", CLEAN)]);
    expect(result.rejections).toEqual(["audit_config_edit"]);
  });

  it("a nested audit config edit → audit_config_edit, even when planned", () => {
    const result = run([mod("packages/x/.eslintrc.json", CLEAN)], {
      planFiles: ["packages/x/.eslintrc.json"],
    });
    expect(result.rejections).toEqual(["audit_config_edit"]);
  });

  it.each([
    ["AGENTS.md listed in planFiles", "AGENTS.md", ["AGENTS.md"]],
    ["deploy/x.ts", "deploy/x.ts", PLAN],
    ["packages/worker/deploy/a.sh", "packages/worker/deploy/a.sh", PLAN],
    ["a nested CLAUDE.md", "packages/a/CLAUDE.md", ["packages/a/CLAUDE.md"]],
    [".claude/settings.json", ".claude/settings.json", PLAN],
  ])("%s → denied_path", (_label, filename, planFiles) => {
    const result = run([mod(filename, CLEAN)], { planFiles });
    expect(result.rejections).toEqual(["denied_path"]);
  });

  it("a rename out of a denied path → denied_path", () => {
    const result = run([
      {
        filename: "src/a.ts",
        previous_filename: "deploy/a.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      },
    ]);
    expect(result.rejections).toEqual(["denied_path"]);
  });

  it("removing the subject → deleted_flagged_code", () => {
    const result = run(
      [
        {
          filename: "src/a.ts",
          status: "removed",
          additions: 0,
          deletions: 30,
        },
      ],
      { subject: "src/a.ts" },
    );
    expect(result.rejections).toEqual(["deleted_flagged_code"]);
  });

  describe("files.sensitive-committed", () => {
    const secret = (filename: string): FixDiffFile => ({
      filename,
      status: "removed",
      additions: 0,
      deletions: 5,
    });
    const sensitive = {
      ruleId: "files.sensitive-committed",
      planFiles: [".htpasswd"],
      subject: ".htpasswd",
    };

    it("removing the committed secret file passes", () => {
      const result = run([secret(".htpasswd")], sensitive);
      expect(result.ok).toBe(true);
    });

    it("emptying the secret file instead → deleted_flagged_code", () => {
      const result = run(
        [mod(".htpasswd", "@@ -1,2 +0,0 @@\n-admin:x\n-ops:y")],
        sensitive,
      );
      expect(result.rejections).toEqual(["deleted_flagged_code"]);
    });

    it("removing another planned file → deleted_flagged_code", () => {
      const result = run([secret("src/a.ts"), secret(".htpasswd")], {
        ...sensitive,
        planFiles: [".htpasswd", "src/a.ts"],
      });
      expect(result.rejections).toEqual(["deleted_flagged_code"]);
    });

    it("a secret file under a denied path stays denied", () => {
      const result = run([secret("deploy/id_ed25519")], {
        ruleId: "files.sensitive-committed",
        planFiles: ["deploy/id_ed25519"],
        subject: "deploy/id_ed25519",
      });
      expect(result.rejections).toEqual(["denied_path"]);
    });
  });

  it("a plan file whose only change removes comments is fine", () => {
    const result = run([
      mod("src/a.ts", "@@ -1,3 +1 @@\n-// old note\n-\n- * more\n code();", {
        additions: 0,
        deletions: 3,
      }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("a plan file with only deletions → deleted_flagged_code", () => {
    const patch = `@@ -1,12 +0,0 @@\n${Array.from({ length: 12 }, (_, i) => `-line ${i}`).join("\n")}`;
    const result = run([mod("src/a.ts", patch)]);
    expect(result.rejections).toEqual(["deleted_flagged_code"]);
  });

  it("a file outside the plan → out_of_plan_file", () => {
    const result = run([mod("src/a.ts", CLEAN), mod("src/other.ts", CLEAN)]);
    expect(result.rejections).toEqual(["out_of_plan_file"]);
  });

  it("package.json + its lockfile pass, the lockfile is not counted", () => {
    const result = run([
      mod("package.json", '@@ -1 +1 @@\n-"a": "1"\n+"a": "2"'),
      {
        filename: "pnpm-lock.yaml",
        status: "modified",
        additions: 900,
        deletions: 800,
      },
    ]);
    expect(result).toEqual({
      ok: true,
      rejections: [],
      flags: [],
      diffLines: 2,
    });
  });

  it("VERSION and CHANGELOG.md are companions", () => {
    const result = run([
      mod("src/a.ts", CLEAN),
      mod("VERSION", "@@ -1 +1 @@\n-1.0.0\n+1.0.1"),
      mod("CHANGELOG.md", "@@ -1 +1,2 @@\n+## 1.0.1\n # Changelog", {
        additions: 1,
        deletions: 0,
      }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.diffLines).toBe(5);
  });

  it("400 changed lines with a 300 cap → diff_too_large", () => {
    const result = run([
      mod("src/a.ts", "@@ -1 +1 @@\n-a\n+b", {
        additions: 200,
        deletions: 200,
      }),
    ]);
    expect(result.rejections).toEqual(["diff_too_large"]);
    expect(result.diffLines).toBe(400);
  });

  it("a modified text file without a patch → patch_unavailable", () => {
    const result = run([
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
      },
    ]);
    expect(result.rejections).toEqual(["patch_unavailable"]);
  });

  it("a truncated compare (file cap reached) → patch_unavailable", () => {
    const result = run([mod("src/a.ts", CLEAN)], { truncated: true });
    expect(result.rejections).toEqual(["patch_unavailable"]);
  });

  it("several violations → every reason, deduplicated, in a stable order", () => {
    const result = run(
      [
        mod("src/other.ts", "@@ -1 +1,2 @@\n a\n+// @ts-ignore", {
          additions: 120,
          deletions: 100,
        }),
        mod("src/more.ts", "@@ -1 +1,2 @@\n a\n+# noqa", {
          additions: 100,
          deletions: 0,
        }),
        mod("AGENTS.md", CLEAN),
        mod("src/a.test.ts", CLEAN),
      ],
      { planFiles: ["src/a.test.ts"] },
    );
    expect(result.rejections).toEqual([
      "suppression_comment",
      "test_edit",
      "out_of_plan_file",
      "denied_path",
      "diff_too_large",
    ]);
    const order = result.rejections.map((r) => GUARD_REASONS.indexOf(r));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("hasSuppressionMarker", () => {
  it("flags a marker on an added line only", () => {
    expect(
      hasSuppressionMarker({
        filename: "src/a.ts",
        patch: "@@ -1 +1 @@\n+// eslint-disable-next-line\n x",
      }),
    ).toBe(true);
    expect(
      hasSuppressionMarker({
        filename: "src/a.ts",
        patch: "@@ -1 +1 @@\n-// eslint-disable-next-line\n x",
      }),
    ).toBe(false);
  });

  it("skips lockfiles, missing patches and untrustworthy paths", () => {
    const patch = "@@ -1 +1 @@\n+// @ts-ignore";
    expect(hasSuppressionMarker({ filename: "pnpm-lock.yaml", patch })).toBe(
      false,
    );
    expect(hasSuppressionMarker({ filename: "src/a.ts" })).toBe(false);
    expect(hasSuppressionMarker({ filename: "../a.ts", patch })).toBe(false);
  });
});
