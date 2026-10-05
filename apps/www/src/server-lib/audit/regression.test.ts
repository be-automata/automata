import { describe, expect, it } from "vitest";

import { detectRevert, findFollowupOverlaps } from "./regression";

const MERGE_SHA = "0123456789abcdef0123456789abcdef01234567";
const BOT = "automata-app[bot]";
const TARGET = {
  mergeSha: MERGE_SHA,
  prNumber: 77,
  prTitle: "[self-heal] Vulnerable dependency",
};

describe("detectRevert", () => {
  it("git's default revert message for the merge sha → reverted with the revert sha", () => {
    expect(
      detectRevert(
        [
          { sha: "c1", message: "chore: bump deps" },
          {
            sha: "c2",
            message: `Revert "Merge pull request #77 from acme/automata/fix-42"\n\nThis reverts commit ${MERGE_SHA}, reversing\nchanges made to 1111111.`,
          },
        ],
        TARGET,
      ),
    ).toEqual({ reverted: true, revertSha: "c2" });
  });

  it("an abbreviated sha of the merge commit also counts", () => {
    expect(
      detectRevert(
        [
          {
            sha: "c3",
            message: `Revert "x"\n\nThis reverts commit ${MERGE_SHA.slice(0, 12)}.`,
          },
        ],
        TARGET,
      ),
    ).toEqual({ reverted: true, revertSha: "c3" });
  });

  it('GitHub\'s revert button: Revert "<title>" with "Reverts owner/repo#N" → reverted', () => {
    expect(
      detectRevert(
        [
          {
            sha: "c4",
            message:
              'Revert "[self-heal] Vulnerable dependency" (#80)\n\nReverts acme/widgets#77',
          },
        ],
        TARGET,
      ),
    ).toEqual({ reverted: true, revertSha: "c4" });
  });

  it('a bare Revert "<title>" subject → reverted', () => {
    expect(
      detectRevert(
        [{ sha: "c5", message: 'Revert "[self-heal] Vulnerable dependency"' }],
        TARGET,
      ),
    ).toEqual({ reverted: true, revertSha: "c5" });
    expect(
      detectRevert(
        [
          {
            sha: "c6",
            message: 'Revert "[self-heal] Vulnerable dependency (#77)"',
          },
        ],
        TARGET,
      ).reverted,
    ).toBe(true);
  });

  it("an unrelated revert → not reverted", () => {
    expect(
      detectRevert(
        [
          {
            sha: "c7",
            message: `Revert "feat: dark mode"\n\nThis reverts commit ${"9".repeat(40)}.`,
          },
          {
            sha: "c8",
            message: "Revert the cache change\n\nReverts acme/widgets#770",
          },
          { sha: "c9", message: "Reverting is hard (see #77)" },
        ],
        TARGET,
      ),
    ).toEqual({ reverted: false });
  });

  it("a revert of the revert does not count", () => {
    expect(
      detectRevert(
        [
          {
            sha: "c10",
            message:
              'Revert "Revert "[self-heal] Vulnerable dependency""\n\nReverts acme/widgets#81',
          },
        ],
        TARGET,
      ),
    ).toEqual({ reverted: false });
  });

  it("no merge sha or title known → only the PR reference can match", () => {
    expect(
      detectRevert(
        [
          {
            sha: "c11",
            message: 'Revert "something"\n\nReverts acme/widgets#77',
          },
        ],
        { mergeSha: null, prNumber: 77, prTitle: null },
      ),
    ).toEqual({ reverted: true, revertSha: "c11" });
    expect(
      detectRevert([{ sha: "c12", message: 'Revert "something"' }], {
        mergeSha: null,
        prNumber: 77,
        prTitle: null,
      }),
    ).toEqual({ reverted: false });
  });
});

describe("findFollowupOverlaps", () => {
  const merged = [
    { file: "src/a.ts", ranges: [[12, 16]] as Array<[number, number]> },
  ];

  it("a human commit editing old lines 12-14 of the merged range → listed", () => {
    expect(
      findFollowupOverlaps(
        [
          {
            sha: "h1",
            authorLogin: "octocat",
            files: [
              { filename: "src/a.ts", patch: "@@ -12,3 +12,4 @@\n-x\n+y" },
            ],
          },
        ],
        merged,
        BOT,
      ),
    ).toEqual(["h1"]);
  });

  it("a bot commit → ignored", () => {
    expect(
      findFollowupOverlaps(
        [
          {
            sha: "b1",
            authorLogin: BOT,
            files: [{ filename: "src/a.ts", patch: "@@ -12,3 +12,4 @@" }],
          },
          {
            sha: "b2",
            authorLogin: "renovate[bot]",
            files: [{ filename: "src/a.ts", patch: "@@ -12,3 +12,4 @@" }],
          },
        ],
        merged,
        BOT,
      ),
    ).toEqual([]);
  });

  it("another file, non-overlapping lines or no patch → ignored", () => {
    expect(
      findFollowupOverlaps(
        [
          {
            sha: "o1",
            authorLogin: "octocat",
            files: [{ filename: "src/b.ts", patch: "@@ -12,3 +12,4 @@" }],
          },
          {
            sha: "o2",
            authorLogin: "octocat",
            files: [{ filename: "src/a.ts", patch: "@@ -20,3 +20,4 @@" }],
          },
          {
            sha: "o3",
            authorLogin: "octocat",
            files: [{ filename: "src/a.ts" }],
          },
        ],
        merged,
        BOT,
      ),
    ).toEqual([]);
  });

  it("a commit with no linked GitHub user is treated as human; each sha listed once", () => {
    expect(
      findFollowupOverlaps(
        [
          {
            sha: "u1",
            authorLogin: null,
            files: [
              { filename: "src/a.ts", patch: "@@ -16 +16 @@" },
              { filename: "src/a.ts", patch: "@@ -10,4 +10,4 @@" },
            ],
          },
        ],
        merged,
        BOT,
      ),
    ).toEqual(["u1"]);
  });
});
