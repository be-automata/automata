import { describe, expect, it } from "vitest";

import { parseHunkRanges, rangesOverlap } from "./hunks";

describe("parseHunkRanges", () => {
  const patch = "@@ -10,3 +12,5 @@ function a() {\n-x\n+y\n+z";

  it("reads the new side of one hunk", () => {
    expect(parseHunkRanges(patch, "new")).toEqual([[12, 16]]);
  });

  it("reads the old side of one hunk", () => {
    expect(parseHunkRanges(patch, "old")).toEqual([[10, 12]]);
  });

  it("a zero count is no range on that side", () => {
    const added = "@@ -0,0 +1,3 @@\n+a\n+b\n+c";
    expect(parseHunkRanges(added, "old")).toEqual([]);
    expect(parseHunkRanges(added, "new")).toEqual([[1, 3]]);
    const removed = "@@ -1,2 +0,0 @@\n-a\n-b";
    expect(parseHunkRanges(removed, "new")).toEqual([]);
  });

  it("a missing count means one line", () => {
    expect(parseHunkRanges("@@ -1 +1 @@\n-a\n+b", "new")).toEqual([[1, 1]]);
    expect(parseHunkRanges("@@ -1 +1 @@\n-a\n+b", "old")).toEqual([[1, 1]]);
  });

  it("reads every hunk in order", () => {
    const multi = [
      "@@ -1,2 +1,3 @@",
      " a",
      "+b",
      " c",
      "@@ -40,4 +41,2 @@ section",
      "-d",
      "-e",
      " f",
      " g",
    ].join("\n");
    expect(parseHunkRanges(multi, "new")).toEqual([
      [1, 3],
      [41, 42],
    ]);
    expect(parseHunkRanges(multi, "old")).toEqual([
      [1, 2],
      [40, 43],
    ]);
  });

  it("an empty, missing or headerless patch has no ranges", () => {
    expect(parseHunkRanges("", "new")).toEqual([]);
    expect(parseHunkRanges(undefined, "new")).toEqual([]);
    expect(
      parseHunkRanges("+a line that looks like @@ -1 +1 @@", "new"),
    ).toEqual([]);
  });
});

describe("rangesOverlap", () => {
  it("edge-touching ranges overlap", () => {
    expect(rangesOverlap([1, 5], [5, 9])).toBe(true);
    expect(rangesOverlap([5, 9], [1, 5])).toBe(true);
  });

  it("containment overlaps", () => {
    expect(rangesOverlap([1, 10], [3, 4])).toBe(true);
  });

  it("disjoint ranges do not overlap", () => {
    expect(rangesOverlap([1, 4], [5, 9])).toBe(false);
    expect(rangesOverlap([10, 12], [1, 9])).toBe(false);
  });
});
