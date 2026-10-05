/**
 * Unified-diff hunk ranges (R5). A merged fix PR records the new-side line
 * ranges it touched per file, so the 30-day regression check can tell
 * whether a later finding lands on lines the fix changed.
 *
 * Ranges are inclusive [first, last] line numbers. A hunk whose count on the
 * requested side is 0 (a pure addition seen from the old side, a pure
 * deletion seen from the new side) contributes no range; a missing count
 * means one line ("@@ -1 +1 @@").
 */

export type LineRange = [number, number];

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;

export function parseHunkRanges(
  patch: string | null | undefined,
  side: "new" | "old",
): LineRange[] {
  if (!patch) return [];
  const ranges: LineRange[] = [];
  for (const match of patch.matchAll(HUNK_HEADER_RE)) {
    const startText = side === "new" ? match[3] : match[1];
    const countText = side === "new" ? match[4] : match[2];
    const start = Number(startText);
    const count = countText === undefined ? 1 : Number(countText);
    if (!Number.isInteger(start) || !Number.isInteger(count) || count <= 0) {
      continue;
    }
    ranges.push([start, start + count - 1]);
  }
  return ranges;
}

/** Inclusive ranges: sharing one line counts as an overlap. */
export function rangesOverlap(a: LineRange, b: LineRange): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}
