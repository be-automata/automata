// Deterministic value extraction and comparison for the ENG-04 value check.
//
// extractValues is a heuristic: it returns canonical standalone numeric tokens (plain numbers, money,
// percents, durations, versions) and ignores numbers inside identifiers (SUP-12, v2, ag_session),
// hex SHAs and line anchors (#L1-L3). A conflict it produces is only a proposal to the page owner,
// never an automatic edit. It is injectable through ReconcileOptions (11-04), so a model-extracted or
// typed-value variant can replace it without touching reconcile.
//
// The input is untrusted repository text: at most MAX_VALUE_TEXT characters are scanned, with one
// linear regex (a single character class under one quantifier).

export type ValueExtractor = (text: string) => string[];

export type ValueAgreement = "agree" | "conflict" | "unknown";

export const MAX_VALUE_TEXT = 8192;

const CANDIDATE = /[0-9][0-9_.,]*/g;
const WORD_CHAR = /^[A-Za-z0-9_]$/;
const BEFORE_BLOCKER = /^[A-Za-z0-9_.#]$/;
const DIGITS = /^[0-9]+$/;
/** Pure-digit tokens this long are ids (issue numbers, timestamps), not values. */
const MIN_ID_DIGITS = 12;

const isDigits = (s: string) => DIGITS.test(s);

/** `1,200` / `12,345,678.5`: a comma-grouped number whose commas are thousands separators. */
function isThousands(candidate: string): boolean {
  const groups = candidate.split(",");
  const [head, ...tail] = groups;
  if (head === undefined || tail.length === 0) return false;
  if (!isDigits(head) || head.length > 3) return false;
  return tail.every((group, i) => {
    const last = i === tail.length - 1;
    const dot = last ? group.indexOf(".") : -1;
    const intPart = dot === -1 ? group : group.slice(0, dot);
    const frac = dot === -1 ? "" : group.slice(dot + 1);
    if (intPart.length !== 3 || !isDigits(intPart)) return false;
    return dot === -1 || isDigits(frac);
  });
}

/** Canonical form of one comma-free token, or null when it is not a value. */
function canonical(piece: string): string | null {
  const token = piece.split("_").join("");
  const parts = token.split(".");
  if (!parts.every(isDigits)) return null; // empty part: "1..2", ".5"
  if (parts.length > 2) return token; // a version: kept verbatim
  const [rawInt = "", rawFrac = ""] = parts;
  if (parts.length === 1 && rawInt.length >= MIN_ID_DIGITS) return null;
  let from = 0;
  while (from < rawInt.length - 1 && rawInt.charAt(from) === "0") from++;
  const intPart = rawInt.slice(from);
  let to = rawFrac.length;
  while (to > 0 && rawFrac.charAt(to - 1) === "0") to--;
  const frac = rawFrac.slice(0, to);
  return frac === "" ? intPart : `${intPart}.${frac}`;
}

function trimTrailing(candidate: string): string {
  let end = candidate.length;
  while (end > 0 && ".,_".includes(candidate.charAt(end - 1))) end--;
  return candidate.slice(0, end);
}

/** Standalone numeric value tokens of `text`, canonical, sorted and unique. */
export function extractValues(text: string): string[] {
  const scanned = text.slice(0, MAX_VALUE_TEXT);
  const found = new Set<string>();
  for (const match of scanned.matchAll(CANDIDATE)) {
    const candidate = trimTrailing(match[0]);
    const start = match.index;
    const end = start + candidate.length;
    // Boundaries are read on the original text, so a number cut by the scan limit is dropped.
    const before = text.charAt(start - 1);
    const after = text.charAt(end);
    if (BEFORE_BLOCKER.test(before)) continue;
    if (before === "-" && WORD_CHAR.test(text.charAt(start - 2))) continue;
    if (WORD_CHAR.test(after)) continue;
    const pieces = isThousands(candidate)
      ? [candidate.split(",").join("")]
      : candidate.split(",");
    for (const piece of pieces) {
      if (piece === "") continue;
      const value = canonical(piece);
      if (value !== null) found.add(value);
    }
  }
  return [...found].sort();
}

const isSubset = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  [...a].every((v) => b.has(v));

/**
 * Whether the value sets of several pins agree. Empty sets carry no information. Fewer than two
 * non-empty sets: unknown. Any pair where neither set contains the other: conflict (incomparable,
 * not disjoint: {29, 3} vs {35, 3} disagree although they share 3). Otherwise: agree.
 */
export function compareValueSets(
  sets: readonly (readonly string[])[],
): ValueAgreement {
  const nonEmpty = sets.filter((s) => s.length > 0).map((s) => new Set(s));
  if (nonEmpty.length < 2) return "unknown";
  for (const [i, a] of nonEmpty.entries()) {
    for (const b of nonEmpty.slice(i + 1)) {
      if (!isSubset(a, b) && !isSubset(b, a)) return "conflict";
    }
  }
  return "agree";
}
