import { describe, expect, it } from "vitest";

import { MalformedDiffError, parseUnifiedDiff } from "./diff";

const lines = (...l: string[]) => l.join("\n");

describe("parseUnifiedDiff", () => {
  it("returns [] for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("multi-file: one modified entry per file with its own hunks", () => {
    const diff = lines(
      "diff --git a/billing.ts b/billing.ts",
      "index 1111111..2222222 100644",
      "--- a/billing.ts",
      "+++ b/billing.ts",
      "@@ -2 +2 @@",
      "-export const TRIAL_DAYS = 14;",
      "+export const TRIAL_DAYS = 30;",
      "diff --git a/ratelimit.py b/ratelimit.py",
      "index 3333333..4444444 100644",
      "--- a/ratelimit.py",
      "+++ b/ratelimit.py",
      "@@ -1,0 +2,2 @@",
      "+BURST = 10",
      "+WINDOW = 60",
      "",
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: "billing.ts",
        status: "modified",
        hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }],
      },
      {
        path: "ratelimit.py",
        status: "modified",
        hunks: [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 2 }],
      },
    ]);
  });

  it("pure rename: path from rename to, oldPath from rename from, no hunks", () => {
    const diff = lines(
      "diff --git a/docs/old.md b/docs/new.md",
      "similarity index 100%",
      "rename from docs/old.md",
      "rename to docs/new.md",
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: "docs/new.md",
        oldPath: "docs/old.md",
        status: "renamed",
        hunks: [],
      },
    ]);
  });

  it("rename with edits: status renamed and hunks parsed", () => {
    const diff = lines(
      "diff --git a/src/limits.ts b/src/rate-limits.ts",
      "similarity index 88%",
      "rename from src/limits.ts",
      "rename to src/rate-limits.ts",
      "index 5555555..6666666 100644",
      "--- a/src/limits.ts",
      "+++ b/src/rate-limits.ts",
      "@@ -4 +4 @@ export const LIMITS = {",
      "-  perMinute: 60,",
      "+  perMinute: 120,",
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: "src/rate-limits.ts",
        oldPath: "src/limits.ts",
        status: "renamed",
        hunks: [{ oldStart: 4, oldCount: 1, newStart: 4, newCount: 1 }],
      },
    ]);
  });

  it("delete: path is the old path, new side /dev/null", () => {
    const diff = lines(
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "index 7777777..0000000",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-a",
      "-b",
      "-c",
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: "gone.ts",
        status: "deleted",
        hunks: [{ oldStart: 1, oldCount: 3, newStart: 0, newCount: 0 }],
      },
    ]);
  });

  it("add: old side /dev/null", () => {
    const diff = lines(
      "diff --git a/new.yaml b/new.yaml",
      "new file mode 100644",
      "index 0000000..8888888",
      "--- /dev/null",
      "+++ b/new.yaml",
      "@@ -0,0 +1,2 @@",
      "+limits:",
      "+  perMinute: 120",
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: "new.yaml",
        status: "added",
        hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }],
      },
    ]);
  });

  it("empty add: equal-halves fallback on the diff --git line", () => {
    const diff = lines(
      "diff --git a/empty.txt b/empty.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "empty.txt", status: "added", hunks: [] },
    ]);
  });

  it("empty delete: equal-halves fallback keeps paths with spaces", () => {
    const diff = lines(
      "diff --git a/old notes.txt b/old notes.txt",
      "deleted file mode 100644",
      "index e69de29..0000000",
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "old notes.txt", status: "deleted", hunks: [] },
    ]);
  });

  it("quoted path: a/ and b/ prefixes stripped inside the quotes", () => {
    const diff = lines(
      'diff --git "a/my file.md" "b/my file.md"',
      '--- "a/my file.md"',
      '+++ "b/my file.md"',
      "@@ -1 +1 @@",
      "-x",
      "+y",
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: "my file.md",
        status: "modified",
        hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }],
      },
    ]);
  });

  it("unquoted path with a space: git's trailing tab is stripped", () => {
    const diff = lines(
      "diff --git a/my file.md b/my file.md",
      "--- a/my file.md\t",
      "+++ b/my file.md\t",
      "@@ -1 +1 @@",
    );
    expect(parseUnifiedDiff(diff)[0]?.path).toBe("my file.md");
  });

  it("octal escape: UTF-8 bytes decode to non-ASCII", () => {
    const diff = lines(
      'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
      '--- "a/caf\\303\\251.md"',
      '+++ "b/caf\\303\\251.md"',
      "@@ -1 +1 @@",
    );
    expect(parseUnifiedDiff(diff)[0]?.path).toBe("café.md");
  });

  it.each([
    ['"b/say \\"hi\\".md"', 'say "hi".md'],
    ['"b/back\\\\slash.md"', "back\\slash.md"],
    ['"b/tab\\there.md"', "tab\there.md"],
    ['"b/new\\nline.md"', "new\nline.md"],
  ])("escape %s decodes to %j", (quoted, expected) => {
    const diff = lines(
      "diff --git a/x b/x",
      "--- /dev/null",
      `+++ ${quoted}`,
      "@@ -0,0 +1 @@",
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: expected,
        status: "added",
        hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }],
      },
    ]);
  });

  it("quoted rename from/to lines are unquoted", () => {
    const diff = lines(
      'diff --git "a/old name.md" "b/new name.md"',
      "similarity index 100%",
      'rename from "old name.md"',
      'rename to "new name.md"',
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: "new name.md",
        oldPath: "old name.md",
        status: "renamed",
        hunks: [],
      },
    ]);
  });

  it("no-newline marker lines are ignored", () => {
    const diff = lines(
      "diff --git a/config.yaml b/config.yaml",
      "--- a/config.yaml",
      "+++ b/config.yaml",
      "@@ -3 +3 @@",
      "-perMinute: 60",
      "\\ No newline at end of file",
      "+perMinute: 120",
      "\\ No newline at end of file",
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: "config.yaml",
        status: "modified",
        hunks: [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 }],
      },
    ]);
  });

  it("binary: entry omitted, neighbours kept", () => {
    const diff = lines(
      "diff --git a/logo.png b/logo.png",
      "index 9999999..aaaaaaa 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
    );
    expect(parseUnifiedDiff(diff).map((f) => f.path)).toEqual(["README.md"]);
  });

  it("mode-only: entry omitted", () => {
    const diff = lines(
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
    );
    expect(parseUnifiedDiff(diff)).toEqual([]);
  });

  it("body line starting +@@ is content, not a hunk header", () => {
    const diff = lines(
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,0 +1,2 @@",
      "+@@ -9 +9 @@",
      "+--- a/fake.md",
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: "notes.md",
        status: "modified",
        hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 2 }],
      },
    ]);
  });

  it("ANSI escape anywhere: refused, naming --no-color", () => {
    const diff = lines(
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "\u001b[36m@@ -1 +1 @@\u001b[m",
    );
    expect(() => parseUnifiedDiff(diff)).toThrow(MalformedDiffError);
    expect(() => parseUnifiedDiff(diff)).toThrow(/--no-color/);
  });

  it("malformed section: unequal halves and no ---/+++/rename lines", () => {
    const diff = lines("diff --git a/x.txt b/y.txt", "new file mode 100644");
    expect(() => parseUnifiedDiff(diff)).toThrow(MalformedDiffError);
  });

  it("malformed section: hunks without ---/+++ lines", () => {
    const diff = lines("diff --git a/x.txt b/x.txt", "@@ -1 +1 @@");
    expect(() => parseUnifiedDiff(diff)).toThrow(MalformedDiffError);
  });

  it("malformed: text before the first diff --git header", () => {
    expect(() => parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b")).toThrow(
      MalformedDiffError,
    );
  });

  it("malformed: a/ b/ prefixes missing (diff.noprefix)", () => {
    const diff = lines(
      "diff --git f.ts f.ts",
      "--- f.ts",
      "+++ f.ts",
      "@@ -1 +1 @@",
    );
    expect(() => parseUnifiedDiff(diff)).toThrow(MalformedDiffError);
  });

  it("malformed: unterminated quoted path", () => {
    const diff = lines(
      "diff --git a/f b/f",
      '--- "a/f',
      '+++ "b/f',
      "@@ -1 +1 @@",
    );
    expect(() => parseUnifiedDiff(diff)).toThrow(MalformedDiffError);
  });

  it("malformed: copy detection (-C) is refused", () => {
    const diff = lines(
      "diff --git a/a.ts b/b.ts",
      "similarity index 100%",
      "copy from a.ts",
      "copy to b.ts",
    );
    expect(() => parseUnifiedDiff(diff)).toThrow(/-M, not -C/);
  });

  it("malformed: an unparseable hunk header is refused, not dropped as mode-only", () => {
    const diff = lines(
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3 +3 @",
      "-x",
      "+y",
    );
    expect(() => parseUnifiedDiff(diff)).toThrow(/unparseable hunk header/);
  });

  it("malformed: context lines (-U3) are refused", () => {
    const diff = lines(
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-x",
      "+y",
      " keep",
    );
    expect(() => parseUnifiedDiff(diff)).toThrow(/-U0/);
  });

  it("MalformedDiffError carries its name and reason", () => {
    try {
      parseUnifiedDiff("\u001b[m");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MalformedDiffError);
      if (!(e instanceof MalformedDiffError)) return;
      expect(e.name).toBe("MalformedDiffError");
      expect(e.reason).toMatch(/--no-color/);
    }
  });

  it("CRLF header lines are tolerated", () => {
    const diff = [
      "diff --git a/billing.ts b/billing.ts\r",
      "index 1111111..2222222 100644\r",
      "--- a/billing.ts\r",
      "+++ b/billing.ts\r",
      "@@ -2 +2 @@\r",
      "-a\r",
      "+b\r",
      "diff --git a/docs/old.md b/docs/new.md\r",
      "similarity index 100%\r",
      "rename from docs/old.md\r",
      "rename to docs/new.md\r",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: "billing.ts",
        status: "modified",
        hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }],
      },
      {
        path: "docs/new.md",
        oldPath: "docs/old.md",
        status: "renamed",
        hunks: [],
      },
    ]);
  });
});
