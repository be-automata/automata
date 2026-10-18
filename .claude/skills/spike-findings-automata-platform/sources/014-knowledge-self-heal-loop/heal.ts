// Spike 014: replay REAL merged commits of deploy/PILOT-RUNBOOK.md through the spike-010 claim engine.
// The oracle is `git diff -U0`: a claim must be flagged iff its pinned span intersects a changed hunk.
// Run: node --experimental-strip-types --no-warnings heal.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { checkPage, generateSidecar, parseUri, pin, reconcile, resolve, type Claim, type Draft, type Sidecar, type Updater } from "../010-grounded-knowledge-claims/claims.ts";

const HERE = import.meta.dirname;
const REPO = join(HERE, "../../..");
const FILE = "deploy/PILOT-RUNBOOK.md";
const BASE = "75f6af8";
const MERGES = ["1d81d00", "a13c5f3", "672bda2", "0ef37d4", "ca56092"];
const ROOT = join(HERE, "work", "root");

const git = (...a: string[]) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 26 });
const writeSnapshot = (sha: string) => {
  const p = join(ROOT, "repo", FILE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, git("show", `${sha}:${FILE}`));
};

/** Paragraph blocks (blank-line separated; a fenced code block is one block). */
function blocks(text: string): { start: number; end: number; text: string }[] {
  const lines = text.split("\n");
  const out: { start: number; end: number; text: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trim() === "") { i++; continue; }
    const start = i;
    if (lines[i]!.startsWith("```")) {
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) i++;
      i++;
    } else {
      while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```")) i++;
    }
    const end = Math.min(i, lines.length);
    out.push({ start: start + 1, end, text: lines.slice(start, end).join("\n") });
  }
  return out;
}
// Strip list markers first: "3. As an org owner…" must not yield the statement "3.".
const firstSentence = (t: string) => t.replace(/[`*>#|]/g, "").replace(/\s+/g, " ").trim().replace(/^(\d+[.)]|[-+])\s+/, "").split(/(?<=[.!?:])\s/)[0]!.slice(0, 140);
/** Below this overlap the "model" is guessing: route to a human instead of proposing a rewrite. */
const REANCHOR_FLOOR = 0.5;
const tokens = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []);
const jaccard = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };

/** Old-file line ranges touched by a commit (deletions/modifications; pure insertions touch nothing old). */
function changedOldRanges(from: string, to: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of git("diff", "--no-color", "-U0", from, to, "--", FILE).matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const a = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]);
    if (n > 0) out.push([a, a + n - 1]);
  }
  return out;
}
const rangeOf = (uri: string) => { const r = /L(\d+)-L(\d+)$/.exec(parseUri(uri).anchor)!; return [Number(r[1]), Number(r[2])] as const; };

/**
 * The "model": for each stale paragraph, find the best-matching paragraph in the new file.
 * Deterministic stand-in for an LLM re-anchoring step; one batched call per merge.
 */
function reanchorUpdater(newText: string, proposals: Map<string, { uri: string; score: number }>): Updater {
  const candidates = blocks(newText);
  const u: Updater = {
    calls: 0,
    rework(items) {
      u.calls++;
      return items.map(({ claim }) => {
        const want = tokens(claim.statement);
        let best = { score: 0, blk: candidates[0]! };
        for (const blk of candidates) { const s = jaccard(want, tokens(firstSentence(blk.text))); if (s > best.score) best = { score: s, blk }; }
        proposals.set(claim.id, { uri: `repo://${FILE}#L${best.blk.start}-L${best.blk.end}`, score: best.score });
        return { id: claim.id, statement: firstSentence(best.blk.text) };
      });
    },
  };
  return u;
}

export interface StepReport {
  sha: string; subject: string; pr: string | null;
  claims: number; flagged: number; oracleTouched: number;
  falsePositives: string[]; falseNegatives: string[]; ambiguous: string[];
  llmCalls: number; ops: (Draft["ops"][number] & { score?: number; commit: string })[];
  driftAfterApprove: number;
}

export function replay(): { steps: StepReport[]; baseClaims: number } {
  rmSync(ROOT, { recursive: true, force: true });
  writeSnapshot(BASE);
  const baseText = git("show", `${BASE}:${FILE}`);
  const seed = blocks(baseText).filter((b) => tokens(b.text).size >= 4).map((b, i) => ({
    id: `p${String(i + 1).padStart(3, "0")}`, statement: firstSentence(b.text), evidence: [`repo://${FILE}#L${b.start}-L${b.end}`],
  }));
  const pageOf = (cs: { statement: string }[]) => cs.map((c) => c.statement).join("\n\n") + "\n";
  let sc: Sidecar = generateSidecar(ROOT, "pilot-ops-faq", pageOf(seed), seed);
  let prev = BASE;
  const steps: StepReport[] = [];
  for (const sha of MERGES) {
    writeSnapshot(sha);
    const subject = git("log", "-1", "--format=%s", sha).trim();
    const md = pageOf(sc.claims);
    const before = sc.claims;
    const report = checkPage(ROOT, md, sc);
    // Oracle: claims whose pinned (old) span intersects a deleted/modified hunk.
    const hunks = changedOldRanges(prev, sha);
    const touched = new Set(before.filter((c) => { const [a, b] = rangeOf(c.evidence[0]!.uri); return hunks.some(([x, y]) => x <= b && y >= a); }).map((c) => c.id));
    // "ambiguous" = identical spans appeared; the engine refuses to guess. Reported separately, not as a false positive.
    const isAmbiguous = (id: string) => report.claims.find((c) => c.id === id)!.evidence.some((e) => e.kind === "ambiguous");
    const flagged = new Set(report.claims.filter((c) => c.status !== "fresh" && c.status !== "relocated").map((c) => c.id));
    const judgement = [...flagged].filter(isAmbiguous);
    const proposals = new Map<string, { uri: string; score: number }>();
    const draft = reconcile(ROOT, md, sc, reanchorUpdater(git("show", `${sha}:${FILE}`), proposals));
    for (const o of draft.ops) {
      const p = proposals.get(o.claimId);
      if (o.op === "update" && p && p.score < REANCHOR_FLOOR) {
        Object.assign(o, { op: "review", id: `review:${o.claimId}`, after: undefined, why: `re-anchor confidence ${p.score.toFixed(2)} < ${REANCHOR_FLOOR}: a human must locate this fact` });
      }
    }
    // Human approves every proposal (the queue page lets a real human decide; here we measure the loop).
    const claims: Claim[] = [];
    for (const c of sc.claims) {
      const op = draft.ops.find((o) => o.claimId === c.id);
      if (op?.op === "retract") continue;
      if (op?.op === "update") {
        const p = proposals.get(c.id)!; // set by the updater for every id it returned
        claims.push({ id: c.id, statement: op.after ?? c.statement, evidence: [pin(ROOT, p.uri)] });
      } else if (op?.op === "repin") {
        const st = report.claims.find((r) => r.id === c.id)!.evidence[0]!;
        claims.push({ ...c, evidence: [pin(ROOT, st.kind === "relocated" ? st.newUri : c.evidence[0]!.uri)] });
      } else claims.push(c);
    }
    sc = { page: sc.page, pageVersion: generateSidecar(ROOT, sc.page, pageOf(claims), []).pageVersion, claims };
    const after = checkPage(ROOT, pageOf(sc.claims), sc);
    steps.push({
      sha, subject: subject.replace(/\s*\(#\d+\)$/, ""), pr: /\(#(\d+)\)$/.exec(subject)?.[1] ?? null,
      claims: report.claims.length, flagged: flagged.size, oracleTouched: touched.size,
      falsePositives: [...flagged].filter((id) => !touched.has(id) && !isAmbiguous(id)),
      ambiguous: judgement,
      // A touched claim may legitimately stay unflagged only if its normalized text did not change (whitespace-only hunk).
      falseNegatives: [...touched].filter((id) => !flagged.has(id)).filter((id) => {
        const c = before.find((x) => x.id === id)!; // touched ids come from `before`
        const [a, b] = rangeOf(c.evidence[0]!.uri);
        const oldSpan = git("show", `${prev}:${FILE}`).split("\n").slice(a - 1, b).join(" ").replace(/\s+/g, " ").trim();
        const now = resolve(ROOT, report.claims.find((r) => r.id === id)!.evidence[0]!.kind === "relocated"
          ? (report.claims.find((r) => r.id === id)!.evidence[0] as { newUri: string }).newUri : c.evidence[0]!.uri);
        return !("text" in now) || now.text.replace(/\s+/g, " ").trim() !== oldSpan;
      }),
      llmCalls: draft.llmCalls,
      ops: draft.ops.map((o) => ({ ...o, commit: sha, ...(proposals.has(o.claimId) ? { score: Math.round(proposals.get(o.claimId)!.score * 100) / 100 } : {}) })),
      driftAfterApprove: after.claims.filter((c) => c.status !== "fresh").length,
    });
    prev = sha;
  }
  return { steps, baseClaims: seed.length };
}
