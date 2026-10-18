// Spike 008 — forge merges at burst rate → knowledge self-heal (spike 010 engine, 014 loop).
// Strategies: per-event (one reconcile per merge) vs coalesced cursor (one reconcile per wake), naive vs line-mapped.
// Run: node --experimental-strip-types --no-warnings bus.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { checkPage, generateSidecar, pin, reconcile, stubUpdater, type Claim, type Sidecar } from "../010-grounded-knowledge-claims/claims.ts";

const HERE = import.meta.dirname;
const WORK = join(HERE, "work");
const REPO = join(WORK, "forge.git");
const DOC = "docs/PRICING.md";
const LOG = join(HERE, "events.jsonl");
const N = Number(process.env.MERGES ?? 300);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (args: string[], input?: string) =>
  execFileSync("git", ["-C", REPO, "-c", "user.name=forge", "-c", "user.email=f@f", "-c", "color.ui=never", ...args], { encoding: "utf8", env: ENV, input, maxBuffer: 1 << 26 }).trim();
const log = (category: string, event: string, data: object) => appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), category, event, ...data }) + "\n");

// ---------- fixture: a pricing doc; every fact is identifiable by a letter id (oracle) ----------
let rnd = 7;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const idOf = (i: number) => String.fromCharCode(65 + Math.floor(i / 26) % 26) + String.fromCharCode(65 + (i % 26));
const para = (id: string, price: number) => `Fact ${id}: the ${id.toLowerCase()} plan costs ${price} dollars per seat per month, billed monthly.`;

function writeCommit(parent: string, files: Record<string, string>, msg: string): string {
  const idx = join(WORK, "idx");
  const env = { ...ENV, GIT_INDEX_FILE: idx };
  execFileSync("git", ["-C", REPO, "read-tree", parent], { env });
  for (const [p, text] of Object.entries(files)) {
    const oid = git(["hash-object", "-w", "--stdin"], text);
    execFileSync("git", ["-C", REPO, "update-index", "--add", "--cacheinfo", `100644,${oid},${p}`], { env });
  }
  const tree = execFileSync("git", ["-C", REPO, "write-tree"], { env, encoding: "utf8" }).trim();
  return git(["commit-tree", tree, "-p", parent, "-m", msg]);
}

interface Para { id: string; price: number }
function build(): { base: string; merges: string[]; finalParas: Para[] } {
  rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", REPO], { env: ENV });
  let paras: Para[] = Array.from({ length: 40 }, (_, i) => ({ id: idOf(i), price: 10 + i }));
  const docText = (ps: Para[]) => ps.map((p) => para(p.id, p.price)).join("\n\n") + "\n";
  const empty = git(["hash-object", "-t", "tree", "-w", "/dev/null"]);
  const root = git(["commit-tree", empty, "-m", "root"]);
  const base = writeCommit(root, { [DOC]: docText(paras), "src/app.ts": "export {};\n" }, "base");
  let tip = base, next = 40;
  const merges: string[] = [];
  for (let i = 0; i < N; i++) {
    const r = rand();
    let files: Record<string, string>, msg: string;
    if (r < 0.85) { files = { [`src/m${i}.ts`]: `export const m${i} = ${i};\n` }; msg = `merge ${i}: code`; }
    else if (r < 0.93) { // insert a new fact somewhere → later facts shift (relocation)
      const at = Math.floor(rand() * paras.length);
      paras = [...paras.slice(0, at), { id: idOf(next++), price: 99 }, ...paras.slice(at)];
      files = { [DOC]: docText(paras) }; msg = `merge ${i}: doc insert`;
    } else { // change one fact's price (a real update the model must make)
      const k = Math.floor(rand() * Math.min(paras.length, 12)); // concentrate on a few facts → repeat edits in a burst
      paras = paras.map((p, j) => (j === k ? { ...p, price: p.price + 1 + Math.floor(rand() * 9) } : p));
      files = { [DOC]: docText(paras) }; msg = `merge ${i}: doc price change`;
    }
    tip = writeCommit(tip, files, msg);
    merges.push(tip);
  }
  return { base, merges, finalParas: paras };
}

// ---------- the knowledge side ----------
const ROOT = join(WORK, "kroot");
const snapshot = (sha: string) => { const p = join(ROOT, "repo", DOC); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, git(["show", `${sha}:${DOC}`]) + "\n"); };
const pageOf = (cs: Claim[]) => cs.map((c) => c.statement).join("\n\n") + "\n";
const rangeOf = (uri: string) => { const m = /#L(\d+)-L(\d+)$/.exec(uri)!; return [Number(m[1]), Number(m[2])] as const; };

function seed(base: string): Sidecar {
  snapshot(base);
  const lines = git(["show", `${base}:${DOC}`]).split("\n");
  const claims = lines.map((l, i) => ({ l, n: i + 1 })).filter((x) => x.l.startsWith("Fact "))
    .map((x) => ({ id: x.l.slice(5, 7), statement: x.l, evidence: [`repo://${DOC}#L${x.n}-L${x.n}`] }));
  return generateSidecar(ROOT, "pricing", pageOf(claims as unknown as Claim[]), claims);
}

// Translate a claim's old line span through `git diff -U0 from to` (blame-style), so evidence points at the
// descendant span before the engine checks it. Without this, a coalesced range that both inserts and edits
// can pin a claim onto its neighbour.
const tokens = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
const jaccard = (a: string, b: string) => { const x = tokens(a), y = tokens(b); let i = 0; for (const t of x) if (y.has(t)) i++; return i / (x.size + y.size - i || 1); };
const REANCHOR_FLOOR = 0.5;
export const reanchorStats = { inHunk: 0, belowFloor: 0 };

function mapLines(from: string, to: string, sc: Sidecar, contentAware = false): Sidecar {
  const oldLines = git(["show", `${from}:${DOC}`]).split("\n");
  const newLines = git(["show", `${to}:${DOC}`]).split("\n");
  const hunks = [...git(["diff", "-U0", "--no-color", from, to, "--", DOC]).matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((m) => ({ os: Number(m[1]), ol: m[2] === undefined ? 1 : Number(m[2]), ns: Number(m[3]), nl: m[4] === undefined ? 1 : Number(m[4]) }));
  const map = (line: number): number => {
    let shift = 0;
    for (const h of hunks) {
      const oEnd = h.ol === 0 ? h.os : h.os + h.ol - 1;
      if (h.ol === 0 ? line > h.os : line > oEnd) shift += h.nl - h.ol;
      else if (h.ol > 0 && line >= h.os && line <= oEnd) {
        // Inside a changed hunk, position is meaningless when an insert and an edit fuse into one hunk.
        // Content-aware: pick the most similar new line in the hunk (014's re-anchor), floor-gated.
        if (!contentAware) return h.ns + Math.min(line - h.os, Math.max(0, h.nl - 1));
        reanchorStats.inHunk++;
        const before = oldLines[line - 1] ?? "";
        let best = h.ns, bestScore = -1;
        for (let n = h.ns; n < h.ns + h.nl; n++) { const sc2 = jaccard(before, newLines[n - 1] ?? ""); if (sc2 > bestScore) { bestScore = sc2; best = n; } }
        if (bestScore < REANCHOR_FLOOR) reanchorStats.belowFloor++;
        return best;
      }
    }
    return line + shift;
  };
  return { ...sc, claims: sc.claims.map((c) => {
    const [a, b] = rangeOf(c.evidence[0]!.uri);
    return { ...c, evidence: [{ ...c.evidence[0]!, uri: `repo://${DOC}#L${map(a)}-L${map(b)}` }] };
  }) };
}

// One reconcile step at `sha`, then a human approves everything (as in 014) so the next step starts clean.
function step(sc: Sidecar, sha: string, llm: ReturnType<typeof stubUpdater>) {
  snapshot(sha);
  const draft = reconcile(ROOT, pageOf(sc.claims), sc, llm);
  const report = checkPage(ROOT, pageOf(sc.claims), sc);
  const claims: Claim[] = sc.claims.map((c) => {
    const op = draft.ops.find((o) => o.claimId === c.id);
    const ev = report.claims.find((r) => r.id === c.id)!.evidence[0]!;
    const uri = ev.kind === "relocated" ? ev.newUri : c.evidence[0]!.uri;
    if (op?.op === "update") return { id: c.id, statement: op.after ?? c.statement, evidence: [pin(ROOT, uri)] };
    if (op?.op === "repin") return { ...c, evidence: [pin(ROOT, uri)] };
    return c;
  });
  return { sc: { page: sc.page, pageVersion: generateSidecar(ROOT, sc.page, pageOf(claims), []).pageVersion, claims }, ops: draft.ops };
}

function score(sc: Sidecar, finalParas: Para[]) {
  const truth = new Map(finalParas.map((p) => [p.id, para(p.id, p.price)]));
  const wrong = sc.claims.filter((c) => truth.get(c.id) !== c.statement).map((c) => ({ id: c.id, claim: c.statement.slice(0, 60), truth: truth.get(c.id)?.slice(0, 60) }));
  return { claims: sc.claims.length, wrong: wrong.length, sample: wrong.slice(0, 3) };
}

// ---------- strategies ----------
interface Mode { name: string; coalesce: number; mapLines: boolean; contentAware?: boolean; crashAt?: number }
function runStrategy(mode: Mode, base: string, merges: string[], finalParas: Para[]) {
  const llm = stubUpdater();
  let sc = seed(base);
  let cursor = base, engineRuns = 0, fastSkips = 0, wakes = 0;
  const queue = new Map<string, { op: string; claimId: string; merges: string[] }>(); // approval queue, keyed for idempotency
  const t0 = performance.now();
  let crashed = false;
  // Producer at 40 merges/s, consumer wakes every `coalesce` merges (1 = per-event).
  for (let i = mode.coalesce - 1; i < merges.length + mode.coalesce - 1; i += mode.coalesce) {
    const tip = merges[Math.min(i, merges.length - 1)]!;
    if (tip === cursor) continue;
    wakes++;
    const touched = git(["log", "--format=%h", `${cursor}..${tip}`, "--", DOC]).split("\n").filter(Boolean);
    if (!touched.length) { cursor = tip; fastSkips++; continue; } // fast path: no doc change in range, zero engine work
    const input = mode.mapLines ? mapLines(cursor, tip, sc, mode.contentAware ?? false) : sc;
    const res = step(input, tip, llm);
    engineRuns++;
    for (const o of res.ops) if (o.op !== "repin") queue.set(`${o.op}:${o.claimId}@${tip}`, { op: o.op, claimId: o.claimId, merges: touched });
    if (mode.crashAt === engineRuns && !crashed) { crashed = true; i -= mode.coalesce; continue; } // crash before cursor commit → same range again
    sc = res.sc; cursor = tip; // cursor advance (CAS in production)
  }
  const ms = Math.round(performance.now() - t0);
  const out = { strategy: mode.name, wakes, engineRuns, fastSkips, modelCalls: llm.calls, queueItems: queue.size,
    cursorAtTip: cursor === merges[merges.length - 1], processMs: ms, ...score(sc, finalParas) };
  log("strategy", mode.name, out);
  return out;
}

const { base, merges, finalParas } = build();
writeFileSync(LOG, "");
const docMerges = Number(git(["log", "--format=%h", `${base}..${merges[merges.length - 1]}`, "--", DOC]).split("\n").filter(Boolean).length);
console.log(`fixture: ${merges.length} merges, ${docMerges} touch ${DOC}, ${finalParas.length} facts at tip`);
const modes: Mode[] = [
  { name: "per-event", coalesce: 1, mapLines: false },
  { name: "coalesced-20 naive", coalesce: 20, mapLines: false },
  { name: "coalesced-20 + line-map", coalesce: 20, mapLines: true },
  { name: "coalesced-20 + content re-anchor", coalesce: 20, mapLines: true, contentAware: true },
  { name: "coalesced-40 + content re-anchor + crash", coalesce: 40, mapLines: true, contentAware: true, crashAt: 2 },
  { name: "coalesced-300 (one wake) + content re-anchor", coalesce: 300, mapLines: true, contentAware: true },
];
const rows = modes.map((m) => runStrategy(m, base, merges, finalParas));
console.table(rows.map(({ sample, ...r }) => r));
console.log("re-anchor stats:", JSON.stringify(reanchorStats));
for (const r of rows) if (r.wrong) console.log(r.strategy, "wrong sample:", JSON.stringify(r.sample));
writeFileSync(join(HERE, "results.json"), JSON.stringify({ merges: merges.length, docMerges, facts: finalParas.length, rows }, null, 2));
