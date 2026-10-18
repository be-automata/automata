// Spike 019: replay the same 5 real merges as spike 014, but with model-seeded ATOMIC claims,
// diff-mapped re-anchoring, and a real model writing the update proposals.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { checkPage, generateSidecar, parseUri, pin, reconcile, resolve, type Claim, type Draft, type Sidecar, type Updater } from "../010-grounded-knowledge-claims/claims.ts";
import { askSync, jsonArray, type ModelResult } from "./model.ts";
import { accept, gapPrompt, proseLines, runsOf, support, SUPPORT_FLOOR, type SeedClaim, type Sentinel } from "./seed.ts";

const HERE = import.meta.dirname;
const REPO = join(HERE, "../../..");
export const FILE = "deploy/PILOT-RUNBOOK.md";
export const BASE = "75f6af8";
export const MERGES = ["1d81d00", "a13c5f3", "672bda2", "0ef37d4", "ca56092"];
const ROOT = join(HERE, "work", "root");
const HERMETIC = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export const git = (...a: string[]) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 26, env: HERMETIC });
const show = (sha: string) => git("show", `${sha}:${FILE}`);
const writeSnapshot = (sha: string) => { const p = join(ROOT, "repo", FILE); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, show(sha)); };

export interface Hunk { a: number; n: number; c: number; m: number }
export function hunks(from: string, to: string): Hunk[] {
  return [...git("diff", "--no-color", "-U0", from, to, "--", FILE).matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((m) => ({ a: Number(m[1]), n: m[2] === undefined ? 1 : Number(m[2]), c: Number(m[3]), m: m[4] === undefined ? 1 : Number(m[4]) }));
}
/**
 * Re-anchor through the merge's own diff instead of a similarity search: an old line outside every hunk
 * shifts by the net delta above it; an old line inside a hunk maps to that hunk's new range.
 */
export function mapRange(hs: Hunk[], a: number, b: number): [number, number] | null {
  const map = (x: number): [number, number] | null => {
    let delta = 0;
    for (const h of hs) {
      if (h.n > 0 && x >= h.a && x <= h.a + h.n - 1) return h.m > 0 ? [h.c, h.c + h.m - 1] : null;
      if ((h.n === 0 && h.a < x) || (h.n > 0 && h.a + h.n - 1 < x)) delta += h.m - h.n;
    }
    return [x + delta, x + delta];
  };
  const ends = [map(a), map(b)].filter((r): r is [number, number] => r !== null);
  return ends.length ? [Math.min(...ends.map((r) => r[0])), Math.max(...ends.map((r) => r[1]))] : null;
}
const rangeOf = (uri: string) => { const r = /L(\d+)-L(\d+)$/.exec(parseUri(uri).anchor)!; return [Number(r[1]), Number(r[2])] as const; };

export interface Proposal { uri: string | null; score: number; note: string }
const updatePrompt = (items: { id: string; statement: string; old: string; start: number; window: string[] }[]) =>
  `Each item below is an atomic fact that a merge changed. You get the fact, its OLD evidence text, and the NEW version of that region with line numbers ("L<n>| ").
For each item, rewrite the fact so it is true of the NEW text (keep it to ONE fact, quote identifiers verbatim in backticks) and give the tightest NEW line range (at most 4 lines) that states it.
If the fact no longer exists in the new text, return "s": null.
Output ONLY a JSON array: [{"id":"<id>","s":"<statement or null>","a":<first line>,"b":<last line>}]

${JSON.stringify(items.map((i) => ({ id: i.id, fact: i.statement, old: i.old, new: i.window.map((l, k) => `L${i.start + k}| ${l}`).join("\n") })), null, 1)}`;

/** One batched real-model call per merge, only for claims whose evidence changed coherently. */
function modelUpdater(prevText: string, newText: string, hs: Hunk[], proposals: Map<string, Proposal>, calls: ModelResult[]): Updater {
  const newLines = newText.split("\n"), oldLines = prevText.split("\n");
  const u: Updater = {
    calls: 0,
    rework(items) {
      u.calls++;
      const batch = items.map(({ claim }) => {
        const [a, b] = rangeOf(claim.evidence[0]!.uri);
        const mapped = mapRange(hs, a, b);
        const [x, y] = mapped ? [Math.max(1, mapped[0] - 1), Math.min(newLines.length, mapped[1] + 1)] : [1, 0];
        return { id: claim.id, statement: claim.statement, old: oldLines.slice(a - 1, b).join("\n"), start: x, window: newLines.slice(x - 1, y), lo: x, hi: y };
      });
      const res = askSync(updatePrompt(batch));
      calls.push(res);
      const out = new Map((jsonArray(res.text) as { id: string; s: string | null; a: number; b: number }[]).map((r) => [r.id, r]));
      return batch.map((it) => {
        const r = out.get(it.id);
        const valid = r && typeof r.s === "string" && Number.isInteger(r.a) && Number.isInteger(r.b) && r.a >= it.lo && r.b <= it.hi && r.b >= r.a && r.b - r.a < 4;
        if (!r || !valid) { proposals.set(it.id, { uri: null, score: 0, note: r?.s === null ? "model: fact no longer exists" : "model output invalid or out of window" }); return { id: it.id, statement: it.statement }; }
        const sup = support(r.s!, newLines.slice(r.a - 1, r.b).join("\n"));
        proposals.set(it.id, { uri: `repo://${FILE}#L${r.a}-L${r.b}`, score: sup.missingQuoted.length ? 0 : sup.score, note: sup.missingQuoted.length ? `quoted identifier not in new span: ${sup.missingQuoted.join(", ")}` : "" });
        return { id: it.id, statement: r.s!.replace(/\s+/g, " ").trim() };
      });
    },
  };
  return u;
}

export interface StepReport {
  sha: string; subject: string; pr: string | null;
  claims: number; flagged: number; oracleTouched: number;
  falsePositives: string[]; falseNegatives: string[]; ambiguous: string[];
  llmCalls: number; autoRepins: number; forApproval: number; pendingReview: number;
  sentinelReviews: { id: string; old: string; now: string }[]; uncoveredChangedLines: number[];
  added: { claims: number; sentinels: number; modelCalls: number; costUsd: number; rejected: number };
  ops: (Draft["ops"][number] & { score?: number; commit: string })[];
  driftAfterApprove: number;
}

export function replay(seed: SeedClaim[], sentinelsIn: Sentinel[] = [], incremental = true): { steps: StepReport[]; baseClaims: number; updateCalls: ModelResult[]; addCalls: ModelResult[] } {
  const addCalls: ModelResult[] = [];
  rmSync(ROOT, { recursive: true, force: true });
  writeSnapshot(BASE);
  const pageOf = (cs: { statement: string }[]) => cs.map((c) => c.statement).join("\n\n") + "\n";
  const initial = seed.map((c) => ({ id: c.id, statement: c.statement, evidence: [`repo://${FILE}#L${c.lineStart}-L${c.lineEnd}`] }));
  let sc: Sidecar = generateSidecar(ROOT, "pilot-ops-faq", pageOf(initial), initial);
  const pending = new Set<string>(); // claims parked in the review queue: off the page until a human re-grounds them
  const updateCalls: ModelResult[] = [];
  let sentinels = sentinelsIn.map((w) => ({ ...w }));
  let prev = BASE;
  const steps: StepReport[] = [];
  for (const sha of MERGES) {
    writeSnapshot(sha);
    const subject = git("log", "-1", "--format=%s", sha).trim();
    const md = pageOf(sc.claims);
    const before = sc.claims;
    const report = checkPage(ROOT, md, sc);
    const hs = hunks(prev, sha);
    const touched = new Set(before.filter((c) => { const [a, b] = rangeOf(c.evidence[0]!.uri); return hs.some((h) => h.n > 0 && h.a <= b && h.a + h.n - 1 >= a); }).map((c) => c.id));
    const isAmbiguous = (id: string) => report.claims.find((c) => c.id === id)!.evidence.some((e) => e.kind === "ambiguous");
    const flagged = new Set(report.claims.filter((c) => c.status !== "fresh" && c.status !== "relocated").map((c) => c.id));
    // Coverage oracle: every changed old prose line must belong to a claim or a sentinel.
    const prevLines = show(prev).split("\n"), newLines = show(sha).split("\n");
    const prose = new Set(proseLines(prevLines));
    const covered = new Set<number>();
    for (const c of before) { const [a, b] = rangeOf(c.evidence[0]!.uri); for (let i = a; i <= b; i++) covered.add(i); }
    for (const w of sentinels) for (let i = w.lineStart; i <= w.lineEnd; i++) covered.add(i);
    const changedOld = hs.flatMap((h) => Array.from({ length: h.n }, (_, k) => h.a + k));
    const uncoveredChangedLines = changedOld.filter((n) => prose.has(n) && !covered.has(n));
    const sentinelReviews = sentinels.filter((w) => hs.some((h) => h.n > 0 && h.a <= w.lineEnd && h.a + h.n - 1 >= w.lineStart)).map((w) => {
      const m = mapRange(hs, w.lineStart, w.lineEnd);
      return { id: w.id, old: prevLines.slice(w.lineStart - 1, w.lineEnd).join(" "), now: m ? newLines.slice(m[0] - 1, m[1]).join(" ") : "(deleted)" };
    });
    sentinels = sentinels.flatMap((w) => { const m = mapRange(hs, w.lineStart, w.lineEnd); return m ? [{ ...w, lineStart: m[0], lineEnd: m[1] }] : []; });
    const proposals = new Map<string, Proposal>();
    const draft = reconcile(ROOT, md, sc, modelUpdater(show(prev), show(sha), hs, proposals, updateCalls));
    for (const o of draft.ops) {
      const p = proposals.get(o.claimId);
      if (o.op === "update" && p && (p.uri === null || p.score < SUPPORT_FLOOR)) {
        Object.assign(o, { op: "review", id: `review:${o.claimId}`, after: undefined, why: p.uri === null ? p.note : `proposal support ${p.score.toFixed(2)} < ${SUPPORT_FLOOR}${p.note ? ` (${p.note})` : ""}: a human must locate this fact` });
      } else if (o.op === "update" && o.after === o.before) {
        // The span changed but the fact did not (another fact shares the line): the page text stays
        // identical. Still a model judgement, so it is queued, but as a one-click re-verify.
        Object.assign(o, { op: "reverify", id: `reverify:${o.claimId}`, why: "evidence line changed, the fact itself did not: confirm and re-pin" });
      }
    }
    // A human approves every update (the queue lets a real human decide); review ops stay pending.
    const claims: Claim[] = [];
    for (const c of sc.claims) {
      const op = draft.ops.find((o) => o.claimId === c.id);
      if (op?.op === "retract") continue;
      if (op?.op === "update" || (op?.op as string | undefined) === "reverify") claims.push({ id: c.id, statement: op?.after ?? c.statement, evidence: [pin(ROOT, proposals.get(c.id)!.uri!)] });
      else if (op?.op === "repin") {
        const st = report.claims.find((r) => r.id === c.id)!.evidence[0]!;
        claims.push({ ...c, evidence: [pin(ROOT, st.kind === "relocated" ? st.newUri : c.evidence[0]!.uri)] });
      } else if (op?.op === "review") pending.add(c.id); // parked in the queue until a human re-grounds it
      else claims.push(c);
    }
    // Incremental seeding: text a merge INSERTS has no claim yet, so a later edit to it would drift
    // silently. One batched call extracts its facts; each new claim is an "add" op a human approves.
    const added = { claims: 0, sentinels: 0, modelCalls: 0, costUsd: 0, rejected: 0 };
    if (incremental) {
      const cov = new Set<number>();
      for (const c of claims) { const [a, b] = rangeOf(c.evidence[0]!.uri); for (let i = a; i <= b; i++) cov.add(i); }
      for (const w of sentinels) for (let i = w.lineStart; i <= w.lineEnd; i++) cov.add(i);
      const newProse = new Set(proseLines(newLines));
      const fresh = hs.flatMap((h) => Array.from({ length: h.m }, (_, k) => h.c + k)).filter((n) => newProse.has(n) && !cov.has(n));
      const runs = runsOf(fresh).map(([a, b]) => { const lo = Math.max(1, a - 1), hi = Math.min(newLines.length, b + 1); return { lo, hi, lines: newLines.slice(lo - 1, hi) }; });
      if (runs.length) {
        const res = askSync(gapPrompt(runs));
        addCalls.push(res);
        const got = { claims: [] as SeedClaim[], rejected: [] as { reason: string }[], calls: [], sentinels: [] };
        const seen = new Set(claims.map((c) => c.statement));
        const items = jsonArray(res.text);
        for (const r of runs) accept(items.filter((x) => { const a = (x as { a?: unknown }).a; return typeof a === "number" && a >= r.lo && a <= r.hi; }), newLines, r.lo, r.hi, got as never, seen, "gap");
        for (const c of got.claims) {
          const id = `${sha.slice(0, 4)}-${c.id}`;
          claims.push({ id, statement: c.statement, evidence: [pin(ROOT, `repo://${FILE}#L${c.lineStart}-L${c.lineEnd}`)] });
          draft.ops.push({ id: `add:${id}`, claimId: id, op: "add" as never, auto: false, before: "", after: c.statement, why: "new text inserted by this merge states a new fact", evidence: [`repo://${FILE}#L${c.lineStart}-L${c.lineEnd}`] });
        }
        const cov2 = new Set(cov);
        for (const c of got.claims) for (let i = c.lineStart; i <= c.lineEnd; i++) cov2.add(i);
        const leftover = runsOf(fresh.filter((n) => !cov2.has(n))).map(([a, b], i) => ({ id: `${sha.slice(0, 4)}-w${i + 1}`, lineStart: a, lineEnd: b }));
        sentinels = [...sentinels, ...leftover];
        Object.assign(added, { claims: got.claims.length, sentinels: leftover.length, modelCalls: 1, costUsd: res.costUsd, rejected: got.rejected.length });
      }
    }
    sc = { page: sc.page, pageVersion: generateSidecar(ROOT, sc.page, pageOf(claims), []).pageVersion, claims };
    const after = checkPage(ROOT, pageOf(sc.claims), sc);
    steps.push({
      sha, subject: subject.replace(/\s*\(#\d+\)$/, ""), pr: /\(#(\d+)\)$/.exec(subject)?.[1] ?? null,
      claims: report.claims.length, flagged: flagged.size, oracleTouched: touched.size,
      falsePositives: [...flagged].filter((id) => !touched.has(id) && !isAmbiguous(id)),
      ambiguous: [...flagged].filter(isAmbiguous),
      falseNegatives: [...touched].filter((id) => !flagged.has(id)).filter((id) => {
        const c = before.find((x) => x.id === id)!;
        const [a, b] = rangeOf(c.evidence[0]!.uri);
        const oldSpan = show(prev).split("\n").slice(a - 1, b).join(" ").replace(/\s+/g, " ").trim();
        const ev = report.claims.find((r) => r.id === id)!.evidence[0]!;
        const now = resolve(ROOT, ev.kind === "relocated" ? ev.newUri : c.evidence[0]!.uri);
        return !("text" in now) || now.text.replace(/\s+/g, " ").trim() !== oldSpan;
      }),
      llmCalls: draft.llmCalls,
      autoRepins: draft.ops.filter((o) => o.auto).length,
      forApproval: draft.ops.filter((o) => !o.auto).length,
      pendingReview: pending.size,
      sentinelReviews, uncoveredChangedLines, added,
      ops: draft.ops.map((o) => ({ ...o, commit: sha, ...(proposals.has(o.claimId) ? { score: Math.round(proposals.get(o.claimId)!.score * 100) / 100 } : {}) })),
      driftAfterApprove: after.claims.filter((c) => c.status !== "fresh").length,
    });
    prev = sha;
  }
  return { steps, baseClaims: seed.length, updateCalls, addCalls };
}
