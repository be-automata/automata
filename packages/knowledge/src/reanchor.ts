// Canonical re-anchoring of a line-pinned evidence span across one diff.
//
// Rule, in order:
//   1. Diff mapping first. A span that no changed hunk touches moves by the net line delta above it.
//      No similarity is computed: the diff is the ground truth.
//   2. Similarity only inside a changed hunk. git fuses an adjacent insert and edit into one hunk, so a
//      position inside the hunk says nothing about where the old text went. Inside the hunk's mapped new
//      range, the same-width window with the highest token overlap with the old text wins.
//   3. The floor is enforced. Below the floor, or when two different windows tie for best, the caller
//      gets "review": a human locates the fact. Re-anchoring never guesses.

export interface Hunk {
  /** First old line touched (for a pure insertion: the old line the insertion follows). */
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export type LineSpan = [start: number, end: number];

export const REANCHOR_FLOOR = 0.5;

export type Reanchor =
  | { status: "shifted"; span: LineSpan; score: 1 }
  | { status: "in-hunk"; span: LineSpan; score: number }
  | {
      status: "review";
      reason: "below-floor" | "tie" | "narrowed";
      score: number;
      candidates: LineSpan[];
    }
  | { status: "deleted" };

export interface ReanchorInput {
  hunks: Hunk[];
  oldLines: string[];
  newLines: string[];
  span: LineSpan;
  floor?: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;

/** Parse the hunk headers of a single-file `git diff --no-color -U0 <from> <to> -- <path>` output. */
export function parseHunks(diffU0: string): Hunk[] {
  return [...diffU0.matchAll(HUNK_HEADER)].map((m) => ({
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
  }));
}

/**
 * A hunk touches a span when it deletes or modifies a line of it, or when it is a pure insertion
 * (`-a,0`, i.e. "after old line a") placed between two of the span's lines. An insertion above or
 * below the span only shifts it.
 */
const touches = (h: Hunk, [a, b]: LineSpan) =>
  h.oldCount > 0
    ? h.oldStart <= b && h.oldStart + h.oldCount - 1 >= a
    : h.oldStart >= a && h.oldStart < b;
const deletesOrModifies = (h: Hunk, x: number) =>
  h.oldCount > 0 && x >= h.oldStart && x <= h.oldStart + h.oldCount - 1;

/**
 * Map an old line range to its new range through the diff. A line outside every hunk shifts by the net delta
 * above it; a line inside a hunk maps to that hunk's whole new range. Returns null when every line was deleted.
 */
export function mapRange(hunks: Hunk[], a: number, b: number): LineSpan | null {
  const mapLine = (x: number): LineSpan | null => {
    let delta = 0;
    for (const h of hunks) {
      if (deletesOrModifies(h, x))
        return h.newCount > 0
          ? [h.newStart, h.newStart + h.newCount - 1]
          : null;
      const endsBefore =
        h.oldCount === 0 ? h.oldStart < x : h.oldStart + h.oldCount - 1 < x;
      if (endsBefore) delta += h.newCount - h.oldCount;
    }
    return [x + delta, x + delta];
  };
  // Every line, not just the endpoints: deleted endpoints must not drop the lines that survived between them.
  let lo = Infinity;
  let hi = -Infinity;
  for (let x = a; x <= b; x++) {
    const r = mapLine(x);
    if (r) [lo, hi] = [Math.min(lo, r[0]), Math.max(hi, r[1])];
  }
  return lo === Infinity ? null : [lo, hi];
}

const tokensOf = (text: string) =>
  new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);

const jaccard = (x: Set<string>, y: Set<string>) => {
  if (x.size === 0 && y.size === 0) return 1;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared);
};

/** Token Jaccard similarity of two texts; two empty texts count as identical. */
export function similarity(a: string, b: string): number {
  return jaccard(tokensOf(a), tokensOf(b));
}

export function reanchorSpan({
  hunks,
  oldLines,
  newLines,
  span,
  floor = REANCHOR_FLOOR,
}: ReanchorInput): Reanchor {
  const [a, b] = span;
  const mapped = mapRange(hunks, a, b);
  if (mapped === null) return { status: "deleted" };
  if (!hunks.some((h) => touches(h, span)))
    return { status: "shifted", span: mapped, score: 1 };

  const oldTokens = tokensOf(oldLines.slice(a - 1, b).join("\n"));
  const [lo, hi] = mapped;
  const width = b - a + 1;
  // Part of the span was deleted: no same-width window can hold the old text, so a human decides.
  if (hi - lo + 1 < width)
    return {
      status: "review",
      reason: "narrowed",
      score: 0,
      candidates: [mapped],
    };
  const windowScore = (start: number) =>
    jaccard(
      oldTokens,
      tokensOf(newLines.slice(start - 1, start + width - 1).join("\n")),
    );
  // The narrowed check above guarantees at least one window, so the first one seeds `best`.
  let best: { span: LineSpan; score: number } = {
    span: [lo, lo + width - 1],
    score: windowScore(lo),
  };
  const tied: LineSpan[] = [];
  for (let start = lo + 1; start + width - 1 <= hi; start++) {
    const window: LineSpan = [start, start + width - 1];
    const score = windowScore(start);
    if (score > best.score) {
      best = { span: window, score };
      tied.length = 0;
    } else if (score === best.score) {
      tied.push(window);
    }
  }
  const score = Math.round(best.score * 100) / 100;
  if (tied.length > 0)
    return {
      status: "review",
      reason: "tie",
      score,
      candidates: [best.span, ...tied],
    };
  if (best.score < floor)
    return {
      status: "review",
      reason: "below-floor",
      score,
      candidates: [best.span],
    };
  return { status: "in-hunk", span: best.span, score };
}
