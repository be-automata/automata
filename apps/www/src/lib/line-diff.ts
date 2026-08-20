/**
 * Minimal line-level diff for the skills version-history panel (#54 H2 / #64
 * slice 2). No dependency: the app vendors no diff library, and a skill body is
 * small enough (a few KB of markdown) that a classic LCS is fine. Produces the
 * three row kinds a reviewer reads: unchanged context, removed (in `a` only),
 * added (in `b` only).
 */

export type DiffRow = {
  kind: "ctx" | "del" | "add";
  /** 1-based line number in `a` for ctx/del rows; null for add rows. */
  aLine: number | null;
  /** 1-based line number in `b` for ctx/add rows; null for del rows. */
  bLine: number | null;
  text: string;
};

/**
 * Longest-common-subsequence line diff. Deterministic and stable: equal lines
 * become `ctx`, lines only in `a` become `del`, lines only in `b` become
 * `add`, emitted in original order. O(n·m) memory — bounded by skill-body size.
 */
export function diffLines(a: string, b: string): DiffRow[] {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const n = aLines.length;
  const m = bLines.length;

  // lcs[i][j] = LCS length of aLines[i:] and bLines[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        aLines[i] === bLines[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      rows.push({ kind: "ctx", aLine: i + 1, bLine: j + 1, text: aLines[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ kind: "del", aLine: i + 1, bLine: null, text: aLines[i]! });
      i++;
    } else {
      rows.push({ kind: "add", aLine: null, bLine: j + 1, text: bLines[j]! });
      j++;
    }
  }
  while (i < n) {
    rows.push({ kind: "del", aLine: i + 1, bLine: null, text: aLines[i]! });
    i++;
  }
  while (j < m) {
    rows.push({ kind: "add", aLine: null, bLine: j + 1, text: bLines[j]! });
    j++;
  }
  return rows;
}

/** Convenience: counts for a compact "+X −Y" summary in the panel header. */
export function diffStat(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { added, removed };
}
