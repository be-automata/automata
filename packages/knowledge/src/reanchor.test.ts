import { describe, expect, it } from "vitest";

import {
  mapRange,
  parseHunks,
  reanchorSpan,
  similarity,
  type Hunk,
} from "./reanchor";

const hunk = (
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
): Hunk => ({ oldStart, oldCount, newStart, newCount });

describe("parseHunks", () => {
  it("reads -U0 hunk headers, defaulting omitted counts to 1", () => {
    const diff = [
      "diff --git a/f b/f",
      "@@ -3 +3 @@ ctx",
      "-old",
      "+new",
      "@@ -10,0 +11,2 @@",
      "+a",
      "+b",
      "@@ -20,3 +22,0 @@",
    ].join("\n");
    expect(parseHunks(diff)).toEqual([
      hunk(3, 1, 3, 1),
      hunk(10, 0, 11, 2),
      hunk(20, 3, 22, 0),
    ]);
  });
});

describe("mapRange", () => {
  it("shifts a line below an insertion by the inserted count", () => {
    expect(mapRange([hunk(2, 0, 3, 2)], 5, 6)).toEqual([7, 8]);
  });

  it("leaves a line above the change untouched", () => {
    expect(mapRange([hunk(10, 1, 10, 3)], 2, 3)).toEqual([2, 3]);
  });

  it("maps a modified line to its hunk's whole new range", () => {
    expect(mapRange([hunk(4, 1, 4, 3)], 4, 4)).toEqual([4, 6]);
  });

  it("returns null when every line was deleted", () => {
    expect(mapRange([hunk(4, 2, 3, 0)], 4, 5)).toBeNull();
  });
});

describe("mapRange keeps surviving interior lines", () => {
  it("maps lines 6-9 when the endpoints 5 and 10 of span 5-10 were deleted", () => {
    // Line 5 deleted (-5 +4,0) and line 10 deleted (-10 +8,0): lines 6-9 shift up by one.
    expect(mapRange([hunk(5, 1, 4, 0), hunk(10, 1, 8, 0)], 5, 10)).toEqual([
      5, 8,
    ]);
  });
});

describe("similarity", () => {
  it("is token Jaccard, case-insensitive", () => {
    expect(similarity("Rollout THE thing", "rollout the thing")).toBe(1);
    expect(similarity("a b", "c d")).toBe(0);
    expect(similarity("a b c", "a b d")).toBe(0.5);
  });
});

describe("reanchorSpan", () => {
  const oldLines = [
    "intro",
    "Fact AC: the ac plan costs 25 dollars",
    "Fact AD: the ad plan costs 30 dollars",
    "outro",
  ];

  it("shifts a span no hunk touches by the diff alone (no similarity)", () => {
    const newLines = ["new first line", ...oldLines];
    expect(
      reanchorSpan({
        hunks: [hunk(0, 0, 1, 1)],
        oldLines,
        newLines,
        span: [3, 3],
      }),
    ).toEqual({ status: "shifted", span: [4, 4], score: 1 });
  });

  it("re-anchors to the edited line, not the inserted neighbour, when git fuses insert + edit into one hunk", () => {
    // Old line 2 is edited (25 -> 26) and a new fact is inserted right before it: one fused hunk -2 +2,2.
    const newLines = [
      "intro",
      "Fact BX: the bx plan costs 99 dollars",
      "Fact AC: the ac plan costs 26 dollars",
      ...oldLines.slice(2),
    ];
    const r = reanchorSpan({
      hunks: [hunk(2, 1, 2, 2)],
      oldLines,
      newLines,
      span: [2, 2],
    });
    expect(r).toMatchObject({ status: "in-hunk", span: [3, 3] });
  });

  it("returns review when the best match is below the floor", () => {
    // -2 +2,2 is not one-for-one, so the windows are scored: 0 and 0.25, both below 0.5.
    const newLines = [
      "intro",
      "Completely different sentence here",
      "the new plan",
      ...oldLines.slice(2),
    ];
    const r = reanchorSpan({
      hunks: [hunk(2, 1, 2, 2)],
      oldLines,
      newLines,
      span: [2, 2],
    });
    expect(r).toMatchObject({ status: "review", reason: "below-floor" });
  });

  it("enforces a custom floor", () => {
    const newLines = [
      "intro",
      "Fact AC: the ac plan costs 26 dollars",
      "unrelated remark",
      ...oldLines.slice(2),
    ];
    expect(
      reanchorSpan({
        hunks: [hunk(2, 1, 2, 2)],
        oldLines,
        newLines,
        span: [2, 2],
        floor: 0.95,
      }),
    ).toMatchObject({ status: "review", reason: "below-floor" });
  });

  it("returns review on a tie between two different windows (never guesses)", () => {
    const newLines = [
      "intro",
      "Fact AC: the ac plan costs 26 dollars",
      "Fact AC: the ac plan costs 27 dollars",
      ...oldLines.slice(2),
    ];
    const r = reanchorSpan({
      hunks: [hunk(2, 1, 2, 2)],
      oldLines,
      newLines,
      span: [2, 2],
    });
    expect(r).toMatchObject({
      status: "review",
      reason: "tie",
      candidates: [
        [2, 2],
        [3, 3],
      ],
    });
  });

  it("returns deleted when the hunk removed the span", () => {
    const newLines = ["intro", ...oldLines.slice(2)];
    expect(
      reanchorSpan({
        hunks: [hunk(2, 1, 1, 0)],
        oldLines,
        newLines,
        span: [2, 2],
      }),
    ).toEqual({ status: "deleted" });
  });

  it("returns review when part of a multi-line span was deleted (narrowed)", () => {
    const newLines = [
      "intro",
      "Fact AC: the ac plan costs 25 dollars",
      "outro",
    ];
    const r = reanchorSpan({
      hunks: [hunk(2, 2, 2, 1)],
      oldLines,
      newLines,
      span: [2, 3],
    });
    expect(r).toMatchObject({ status: "review", reason: "narrowed" });
  });

  it("treats an insertion between two lines of the span as touching it", () => {
    const newLines = [
      "intro",
      "Fact AC: the ac plan costs 25 dollars",
      "inserted remark",
      "Fact AD: the ad plan costs 30 dollars",
      "outro",
    ];
    const r = reanchorSpan({
      hunks: [hunk(2, 0, 3, 1)],
      oldLines,
      newLines,
      span: [2, 3],
    });
    expect(r.status).not.toBe("shifted");
  });

  it("searches the union of mapped ranges for a span straddling two hunks", () => {
    const old = ["a", "Fact one alpha", "Fact two beta", "z"];
    const now = ["a", "Fact one alpha!", "Fact two beta!", "z"];
    const r = reanchorSpan({
      hunks: [hunk(2, 1, 2, 1), hunk(3, 1, 3, 1)],
      oldLines: old,
      newLines: now,
      span: [2, 3],
    });
    expect(r).toMatchObject({ status: "in-hunk", span: [2, 3] });
  });
});

describe("reanchorSpan: one-for-one replacement by position", () => {
  const oldLines = ["a", "RATE = 120", "BURST = 20", "z"];

  it("re-anchors a replaced line in place even with no shared token", () => {
    const newLines = ["a", "completely different", "BURST = 20", "z"];
    expect(
      reanchorSpan({
        hunks: [hunk(2, 1, 2, 1)],
        oldLines,
        newLines,
        span: [2, 2],
      }),
    ).toEqual({
      status: "in-hunk",
      span: [2, 2],
      score: 1,
      match: "positional",
    });
  });

  it("re-anchors a short value edit (similarity 0.33) at the default floor", () => {
    const newLines = ["a", "RATE = 150", "BURST = 20", "z"];
    expect(similarity("RATE = 120", "RATE = 150")).toBeCloseTo(1 / 3);
    expect(
      reanchorSpan({
        hunks: [hunk(2, 1, 2, 1)],
        oldLines,
        newLines,
        span: [2, 2],
      }),
    ).toMatchObject({ status: "in-hunk", span: [2, 2], match: "positional" });
  });

  it("follows the hunk's new start when lines were inserted above", () => {
    const newLines = ["# header", "a", "RATE = 150", "BURST = 20", "z"];
    expect(
      reanchorSpan({
        hunks: [hunk(0, 0, 1, 1), hunk(2, 1, 3, 1)],
        oldLines,
        newLines,
        span: [2, 2],
      }),
    ).toMatchObject({ status: "in-hunk", span: [3, 3], match: "positional" });
  });

  it("covers a multi-line span replaced by the same number of lines", () => {
    const newLines = ["a", "RATE = 150", "BURST = 25", "z"];
    expect(
      reanchorSpan({
        hunks: [hunk(2, 2, 2, 2)],
        oldLines,
        newLines,
        span: [2, 3],
      }),
    ).toMatchObject({ status: "in-hunk", span: [2, 3], match: "positional" });
  });

  it("does not apply when the hunk replaces more lines than the span (scored, floor enforced)", () => {
    // A 3-line rewrite covering the 1-line pin: windows score 0, 0.25 and 0 -> below the floor.
    const newLines = ["x", "RATE limit", "y", "z"];
    expect(
      reanchorSpan({
        hunks: [hunk(1, 3, 1, 3)],
        oldLines,
        newLines,
        span: [2, 2],
      }),
    ).toMatchObject({
      status: "review",
      reason: "below-floor",
      candidates: [[2, 2]],
    });
  });

  it("does not apply when the hunk changes the line count", () => {
    const newLines = ["a", "RATE = 150", "RATE_NOTE = 1", "BURST = 20", "z"];
    expect(
      reanchorSpan({
        hunks: [hunk(2, 1, 2, 2)],
        oldLines,
        newLines,
        span: [2, 2],
      }),
    ).toMatchObject({ status: "review", reason: "below-floor" });
  });

  it("does not apply to a same-size hunk that starts at a different line", () => {
    // -2,2 +2,2 rewrites lines 2-3; the pin is line 3 only, so it is scored.
    const newLines = ["a", "other words", "unrelated", "z"];
    expect(
      reanchorSpan({
        hunks: [hunk(2, 2, 2, 2)],
        oldLines,
        newLines,
        span: [3, 3],
      }),
    ).toMatchObject({ status: "review" });
  });

  it("keeps the similarity match label for a scored in-hunk result", () => {
    const old = ["a", "Fact one alpha beta gamma", "z"];
    const now = ["a", "inserted line", "Fact one alpha beta delta", "z"];
    expect(
      reanchorSpan({
        hunks: [hunk(2, 1, 2, 2)],
        oldLines: old,
        newLines: now,
        span: [2, 2],
      }),
    ).toMatchObject({ status: "in-hunk", span: [3, 3], match: "similarity" });
  });
});
