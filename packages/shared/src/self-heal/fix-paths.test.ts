import { describe, expect, it } from "vitest";

import {
  FIX_BRANCH_PREFIX,
  FIX_COMPANION_FILES,
  FIX_DENY_PATHS,
  allowedFilesFor,
  denyExceptionsFor,
  isDeniedPath,
} from "./fix-paths";

describe("fix-path constants", () => {
  it("pins the branch prefix and the deny list", () => {
    expect(FIX_BRANCH_PREFIX).toBe("automata/fix-");
    expect([...FIX_DENY_PATHS]).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      ".claude/**",
      "deploy/**",
      "packages/worker/deploy/**",
      ".github/**",
    ]);
    expect([...FIX_COMPANION_FILES.lockfiles]).toEqual([
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
    ]);
    expect([...FIX_COMPANION_FILES.root]).toEqual(["VERSION", "CHANGELOG.md"]);
  });
});

describe("denyExceptionsFor", () => {
  it("returns the exact workflow files a ci.* rule lists", () => {
    expect(
      denyExceptionsFor({
        ruleId: "ci.action-unpinned",
        planFiles: [".github/workflows/ci.yml", "src/a.ts"],
      }),
    ).toEqual([".github/workflows/ci.yml"]);
  });

  it("returns nothing for a non-ci rule", () => {
    expect(
      denyExceptionsFor({
        ruleId: "dep.vulnerable",
        planFiles: [".github/workflows/ci.yml", "src/a.ts"],
      }),
    ).toEqual([]);
  });

  it("never excepts anything outside .github/workflows/<file>", () => {
    expect(
      denyExceptionsFor({
        ruleId: "ci.workflow-permissions-missing",
        planFiles: [
          ".github/CODEOWNERS",
          ".github/workflows/nested/x.yml",
          ".github/workflows/../../AGENTS.md",
          "./.github/workflows/release.yml",
        ],
      }),
    ).toEqual([".github/workflows/release.yml"]);
  });

  it("tolerates a null plan_files column", () => {
    expect(
      denyExceptionsFor({ ruleId: "ci.action-unpinned", planFiles: null }),
    ).toEqual([]);
  });
});

describe("isDeniedPath", () => {
  const depCtx = {
    ruleId: "dep.vulnerable",
    planFiles: [
      "AGENTS.md",
      "CLAUDE.md",
      ".claude/settings.json",
      "deploy/x.ts",
      "packages/worker/deploy/linux/a.sh",
      ".github/workflows/ci.yml",
      "src/a.ts",
    ],
  };

  it.each([
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/settings.json",
    "deploy/x.ts",
    "packages/worker/deploy/linux/a.sh",
    ".github/workflows/ci.yml",
  ])("%s is denied even when listed in planFiles", (path) => {
    expect(isDeniedPath(path, depCtx)).toBe(true);
  });

  it("allows the listed workflow for a ci.* rule", () => {
    expect(
      isDeniedPath(".github/workflows/ci.yml", {
        ruleId: "ci.action-unpinned",
        planFiles: [".github/workflows/ci.yml"],
      }),
    ).toBe(false);
  });

  it("a ci.* rule still cannot touch an unlisted workflow or other .github files", () => {
    const ctx = {
      ruleId: "ci.action-unpinned",
      planFiles: [".github/workflows/ci.yml"],
    };
    expect(isDeniedPath(".github/workflows/release.yml", ctx)).toBe(true);
    expect(isDeniedPath(".github/CODEOWNERS", ctx)).toBe(true);
  });

  it("the ci.* exception never reaches the instruction or deploy paths", () => {
    const ctx = {
      ruleId: "ci.action-unpinned",
      planFiles: ["AGENTS.md", "deploy/x.ts", ".claude/settings.json"],
    };
    expect(isDeniedPath("AGENTS.md", ctx)).toBe(true);
    expect(isDeniedPath("deploy/x.ts", ctx)).toBe(true);
    expect(isDeniedPath(".claude/settings.json", ctx)).toBe(true);
  });

  it("an ordinary source file is allowed", () => {
    expect(isDeniedPath("src/a.ts", depCtx)).toBe(false);
    expect(isDeniedPath("apps/www/src/deploy-helper.ts", depCtx)).toBe(false);
  });

  it("normalises spellings that would dodge a literal match", () => {
    expect(isDeniedPath("./AGENTS.md", depCtx)).toBe(true);
    expect(isDeniedPath("/deploy/x.ts", depCtx)).toBe(true);
    expect(isDeniedPath("deploy//x.ts", depCtx)).toBe(true);
    expect(isDeniedPath("Deploy/x.ts", depCtx)).toBe(true);
    expect(isDeniedPath(".GitHub/workflows/ci.yml", depCtx)).toBe(true);
    expect(isDeniedPath("deploy", depCtx)).toBe(true);
  });

  it("denies agent instruction files at any depth", () => {
    expect(isDeniedPath("apps/www/CLAUDE.md", depCtx)).toBe(true);
    expect(isDeniedPath("packages/x/AGENTS.md", depCtx)).toBe(true);
    expect(isDeniedPath("apps/www/.claude/settings.json", depCtx)).toBe(true);
  });

  it("fails closed on traversal and empty paths", () => {
    expect(isDeniedPath("src/../AGENTS.md", depCtx)).toBe(true);
    expect(isDeniedPath("src/../src/a.ts", depCtx)).toBe(true);
    expect(isDeniedPath("", depCtx)).toBe(true);
  });
});

describe("allowedFilesFor", () => {
  it("adds the lockfiles when a package.json is listed, plus VERSION and CHANGELOG.md", () => {
    expect(allowedFilesFor(["package.json", "src/a.ts"])).toEqual([
      "package.json",
      "src/a.ts",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "VERSION",
      "CHANGELOG.md",
    ]);
  });

  it("a nested package.json gets its sibling and the workspace-root lockfiles", () => {
    expect(allowedFilesFor(["packages/x/package.json"])).toEqual([
      "packages/x/package.json",
      "packages/x/pnpm-lock.yaml",
      "packages/x/package-lock.json",
      "packages/x/yarn.lock",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "VERSION",
      "CHANGELOG.md",
    ]);
  });

  it("without a package.json only the root companions are added; duplicates collapse", () => {
    expect(allowedFilesFor(["./src/a.ts", "src/a.ts", "VERSION"])).toEqual([
      "src/a.ts",
      "VERSION",
      "CHANGELOG.md",
    ]);
  });

  it("tolerates a null plan_files column", () => {
    expect(allowedFilesFor(null)).toEqual(["VERSION", "CHANGELOG.md"]);
  });
});
