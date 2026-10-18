// Model-seeded ATOMIC claims: one fact per claim, each pinned to the tightest line range that states it.
// The model is untrusted: every claim is validated against the text before it is pinned.
import { ask, jsonArray, type ModelResult } from "./model.ts";

export const CHUNK_LINES = 200;
export const MAX_SPAN = 4;
export const SUPPORT_FLOOR = 0.5;

const STOP = new Set("the and for with that this are not from into only each its must when then than also has have but any all can was were will been one two per via use used uses run runs".split(" "));
export const tokens = (t: string) => new Set((t.toLowerCase().match(/[a-z0-9_.:/-]{3,}/g) ?? []).map((x) => x.replace(/[.:]+$/, "")).filter((x) => x.length >= 3 && !STOP.has(x)));
/** Identifiers the statement quotes verbatim must appear verbatim in the evidence: the hallucination check. */
const quoted = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/** Fraction of the statement's content tokens present in the span, or 0 if any quoted identifier is absent. */
// Markdown bold and shell line continuations are formatting, not content.
const flat = (t: string) => t.replace(/\\\n/g, " ").replace(/\*\*/g, "").replace(/\s+/g, " ");
export function support(statement: string, span: string): { score: number; missingQuoted: string[] } {
  const f = flat(span);
  const missingQuoted = quoted(statement).filter((q) => !f.includes(flat(q).trim()));
  const st = tokens(statement.replace(/`/g, " ")), sp = tokens(span);
  let hit = 0;
  for (const x of st) if (sp.has(x) || [...sp].some((y) => y.includes(x) || x.includes(y))) hit++;
  const score = st.size ? hit / st.size : 0;
  return { score: missingQuoted.length ? 0 : score, missingQuoted };
}

export interface SeedClaim { id: string; statement: string; lineStart: number; lineEnd: number; support: number; pass?: "seed" | "gap"; repairedFrom?: string }

/**
 * Deterministic span repair: the model often points one line off ("It defaults true" sits below the line
 * naming the env var) or at the first line of a wrapped command. Widen to the smallest window within
 * +-2 lines (<= MAX_SPAN) that contains every quoted identifier and clears the support floor.
 */
function repair(lines: string[], s: string, a: number, b: number, lo: number, hi: number): [number, number] | null {
  let best: [number, number] | null = null;
  for (let x = Math.max(lo, a - 2); x <= a; x++) for (let y = b; y <= Math.min(hi, b + 2); y++) {
    if (y - x + 1 > MAX_SPAN || (best && y - x >= best[1] - best[0])) continue;
    const sup = support(s, lines.slice(x - 1, y).join("\n"));
    if (!sup.missingQuoted.length && sup.score >= SUPPORT_FLOOR) best = [x, y];
  }
  return best;
}
export interface Rejected { statement: string; a: unknown; b: unknown; reason: string }
export interface Sentinel { id: string; lineStart: number; lineEnd: number }
export interface SeedReport { claims: SeedClaim[]; rejected: Rejected[]; calls: ModelResult[]; sentinels: Sentinel[]; gapClaims?: number }

export const seedPrompt = (start: number, lines: string[]) => `Below are lines ${start}-${start + lines.length - 1} of an operations runbook, each prefixed by its line number as "L<n>| ".
Extract the atomic facts a support, marketing or engineering teammate might ask about. Each claim states exactly ONE verifiable fact (a value, a name, a label, a command, a rule, an ordering, a default, a limit).
Rules:
- The evidence is the TIGHTEST contiguous line range that states the fact: usually one line, never more than ${MAX_SPAN}.
- Quote identifiers, labels, env vars, file paths, commands and numbers in backticks, exactly as written in the evidence.
- One fact per claim; never merge facts. Never infer anything that is not written.
- Skip headings, code-fence markers, blank lines and pure navigation text.
Output ONLY a JSON array: [{"s":"<statement>","a":<first line>,"b":<last line>}]

${lines.map((l, i) => `L${start + i}| ${l}`).join("\n")}`;

/** A prose line a reader could learn a fact from (not a fence, heading, table rule or blank). */
export function proseLines(lines: string[]): number[] {
  let fence = false;
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (l.startsWith("```")) { fence = !fence; return; }
    if (/^#/.test(l) || /^\s*\|?\s*:?-{3,}/.test(l)) return;
    if (tokens(l).size >= 4) out.push(i + 1);
  });
  return out;
}
export const runsOf = (ns: number[]) => ns.reduce<[number, number][]>((rs, n) => {
  const last = rs.at(-1);
  if (last && n === last[1] + 1) last[1] = n; else rs.push([n, n]);
  return rs;
}, []);

/** Validate untrusted model output against the text; accepted claims must lie inside [lo, hi]. */
export function accept(items: unknown[], lines: string[], lo: number, hi: number, out: SeedReport, seen: Set<string>, pass: "seed" | "gap"): void {
  for (const raw of items) {
    const r = raw as { s?: unknown; a?: unknown; b?: unknown };
    const s = typeof r.s === "string" ? r.s.replace(/\s+/g, " ").trim() : "";
    const reject = (reason: string) => out.rejected.push({ statement: s, a: r.a, b: r.b, reason: `${pass}: ${reason}` });
    if (!s) { reject("no statement"); continue; }
    if (!Number.isInteger(r.a) || !Number.isInteger(r.b)) { reject("non-integer span"); continue; }
    let a = r.a as number, b = r.b as number;
    if (a < lo || b > hi || b < a) { reject(`span L${a}-L${b} outside window L${lo}-L${hi}`); continue; }
    if (b - a + 1 > MAX_SPAN) { reject(`span of ${b - a + 1} lines exceeds ${MAX_SPAN}`); continue; }
    let span = lines.slice(a - 1, b).join("\n");
    let sup = support(s, span);
    let repairedFrom: string | undefined;
    if (sup.missingQuoted.length || sup.score < SUPPORT_FLOOR) {
      const fixed = repair(lines, s, a, b, lo, hi);
      if (fixed) { repairedFrom = `L${a}-L${b}`; [a, b] = fixed; span = lines.slice(a - 1, b).join("\n"); sup = support(s, span); }
    }
    if (tokens(span).size < 3) { reject("trivial span (fence/blank/heading)"); continue; }
    if (sup.missingQuoted.length) { reject(`quoted identifier not in span: ${sup.missingQuoted.join(", ")}`); continue; }
    if (sup.score < SUPPORT_FLOOR) { reject(`unsupported by span (support ${sup.score.toFixed(2)})`); continue; }
    if (seen.has(s)) { reject("duplicate statement"); continue; }
    seen.add(s);
    out.claims.push({ id: `a${String(out.claims.length + 1).padStart(3, "0")}`, statement: s, lineStart: a, lineEnd: b, support: Math.round(sup.score * 100) / 100, pass, ...(repairedFrom ? { repairedFrom } : {}) });
  }
}

export const gapPrompt = (runs: { lo: number; hi: number; lines: string[] }[]) => `A first extraction pass found no claim in the excerpts below from an operations runbook (each line prefixed "L<n>| "; excerpts are separated by "---").
Extract the atomic facts they state, with the same rules: ONE verifiable fact per claim (including procedural facts such as WHO does a step and WHERE), the tightest contiguous evidence range inside one excerpt (at most ${MAX_SPAN} lines), identifiers quoted verbatim in backticks, nothing inferred. Return [] for an excerpt that states no fact (pure narrative, navigation, table rows without their header).
Output ONLY a JSON array: [{"s":"<statement>","a":<first line>,"b":<last line>}]

${runs.map((r) => r.lines.map((l, k) => `L${r.lo + k}| ${l}`).join("\n")).join("\n---\n")}`;

export async function seedAtomic(baseText: string): Promise<SeedReport> {
  const lines = baseText.split("\n");
  const chunks: { start: number; lines: string[] }[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) chunks.push({ start: i + 1, lines: lines.slice(i, i + CHUNK_LINES) });
  const calls = await Promise.all(chunks.map((c) => ask(seedPrompt(c.start, c.lines))));
  const out: SeedReport = { claims: [], rejected: [], calls, sentinels: [] };
  const seen = new Set<string>();
  calls.forEach((res, ci) => { const c = chunks[ci]!; accept(jsonArray(res.text), lines, c.start, c.start + c.lines.length - 1, out, seen, "seed"); });

  // Gap pass: one batched call over prose lines the first pass left unclaimed (with one line of context).
  const covered = () => { const s = new Set<number>(); for (const c of out.claims) for (let i = c.lineStart; i <= c.lineEnd; i++) s.add(i); return s; };
  let cov = covered();
  const gapRuns = runsOf(proseLines(lines).filter((n) => !cov.has(n))).map(([a, b]) => {
    const lo = Math.max(1, a - 1), hi = Math.min(lines.length, b + 1);
    return { lo, hi, lines: lines.slice(lo - 1, hi) };
  });
  if (gapRuns.length) {
    const gap = await ask(gapPrompt(gapRuns));
    out.calls = [...calls, gap];
    const before = out.claims.length;
    for (const r of gapRuns) accept(jsonArray(gap.text).filter((x) => { const a = (x as { a?: unknown }).a; return typeof a === "number" && a >= r.lo && a <= r.hi; }), lines, r.lo, r.hi, out, seen, "gap");
    out.gapClaims = out.claims.length - before;
  }
  // Whatever prose is still unclaimed becomes a watched sentinel: no page text, but a change to it
  // raises a review instead of drifting silently.
  cov = covered();
  out.sentinels = runsOf(proseLines(lines).filter((n) => !cov.has(n))).map(([a, b], i) => ({ id: `w${String(i + 1).padStart(3, "0")}`, lineStart: a, lineEnd: b }));
  return out;
}
