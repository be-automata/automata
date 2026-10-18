// Spike 017: a forge we own (bare repos, server-side merges, push gate) drives the knowledge self-heal loop.
// No GitHub anywhere: the trigger is the source repo's reference-transaction hook firing on update-ref.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { checkPage, generateSidecar, parseUri, pin, reconcile, type Claim, type Draft, type Sidecar, type Updater } from "../010-grounded-knowledge-claims/claims.ts";
import { jtiOf, mint, verify } from "./token.ts";

const HERE = import.meta.dirname;
export const REAL_REPO = join(HERE, "../../..");
export const FILE = "deploy/PILOT-RUNBOOK.md";
export const BASE = "75f6af8";
export const MERGES = ["1d81d00", "a13c5f3", "672bda2", "0ef37d4", "ca56092"];
export const W = join(HERE, "work");
export const SOURCE = join(W, "forge", "source.git");
export const KNOWLEDGE = join(W, "forge", "knowledge.git");
export const KCLONE = join(W, "kclone");
export const QUEUE = join(W, "heal-queue.jsonl");
export const LEDGER = join(W, "decisions.jsonl");
export const AUDIT = join(W, "gate-audit.jsonl");
const ROOT = join(W, "resolver-root");
export const PAGE = "pilot-ops-faq";

// Hermetic: merge semantics and output format never come from the host's git config (spikes 004, 014).
export const HERMETIC: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "forge", GIT_AUTHOR_EMAIL: "forge@example.invalid", GIT_COMMITTER_NAME: "forge", GIT_COMMITTER_EMAIL: "forge@example.invalid",
};
export const g = (dir: string, args: string[], input?: string, env: NodeJS.ProcessEnv = HERMETIC) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", input, env, maxBuffer: 1 << 26 }).trim();
const real = (...a: string[]) => execFileSync("git", ["-C", REAL_REPO, ...a], { encoding: "utf8", env: HERMETIC, maxBuffer: 1 << 26 });
export const runbookAt = (sha: string) => real("show", `${sha}:${FILE}`);

// ---- source forge: plumbing-only commits and server-side merges (spike 004) ----
function treeWith(repo: string, baseCommit: string | null, path: string, content: string): string {
  const blob = g(repo, ["hash-object", "-w", "--stdin"], content);
  // index-free tree edit: read the base tree into a temp index, update one path, write the tree.
  const idx = join(W, `idx-${process.pid}`);
  const env = { ...HERMETIC, GIT_INDEX_FILE: idx };
  rmSync(idx, { force: true });
  if (baseCommit) g(repo, ["read-tree", baseCommit], undefined, env);
  g(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], undefined, env);
  const tree = g(repo, ["write-tree"], undefined, env);
  rmSync(idx, { force: true });
  return tree;
}
export function commitFile(repo: string, parent: string | null, path: string, content: string, msg: string): string {
  const tree = treeWith(repo, parent, path, content);
  return g(repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", msg]);
}

const locks = new Map<string, Promise<void>>();
async function withLock<T>(key: string, fn: () => T): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  locks.set(key, prev.then(() => next));
  await prev;
  try { return fn(); } finally { release(); }
}

/** merge-tree --write-tree + commit-tree + update-ref CAS under a per-repo lock. No clone, no worktree. */
export function serverMerge(repo: string, branch: string, msg: string): Promise<{ merged: boolean; commit?: string; conflict?: string }> {
  return withLock(repo, () => {
    const base = g(repo, ["rev-parse", "refs/heads/main"]), head = g(repo, ["rev-parse", `refs/heads/${branch}`]);
    const r = spawnSync("git", ["-C", repo, "merge-tree", "--write-tree", base, head], { encoding: "utf8", env: HERMETIC });
    if (r.status !== 0) return { merged: false, conflict: r.stdout };
    const tree = r.stdout.split("\n")[0]!;
    const commit = g(repo, ["commit-tree", tree, "-p", base, "-p", head, "-m", msg]);
    g(repo, ["update-ref", "refs/heads/main", commit, base]); // CAS: fails if main moved
    return { merged: true, commit };
  });
}

export function setup(): void {
  rmSync(W, { recursive: true, force: true });
  mkdirSync(dirname(SOURCE), { recursive: true });
  for (const r of [SOURCE, KNOWLEDGE]) execFileSync("git", ["init", "-q", "--bare", "-b", "main", r], { env: HERMETIC });
  // The self-heal trigger: a reference-transaction hook on the source repo, not a GitHub webhook.
  mkdirSync(join(SOURCE, "hooks"), { recursive: true });
  const rt = join(SOURCE, "hooks", "reference-transaction");
  writeFileSync(rt, `#!/bin/sh
[ "$1" = committed ] || exit 0
while read old new ref; do
  [ "$ref" = refs/heads/main ] && printf '{"repo":"source.git","ref":"%s","old":"%s","new":"%s"}\\n' "$ref" "$old" "$new" >> '${QUEUE}'
done
exit 0
`);
  chmodSync(rt, 0o755);
  const pr = join(KNOWLEDGE, "hooks", "pre-receive");
  writeFileSync(pr, `#!/bin/sh\nexec node '${join(HERE, "knowledge-pre-receive.mjs")}'\n`);
  chmodSync(pr, 0o755);
  writeFileSync(LEDGER, "");
  writeFileSync(QUEUE, "");
  writeFileSync(AUDIT, "");
}

export function seedSource(): string {
  const c = commitFile(SOURCE, null, FILE, runbookAt(BASE), "seed: runbook at 75f6af8");
  g(SOURCE, ["update-ref", "refs/heads/main", c, ""]);
  return c;
}

/** An agent branch carrying the runbook at a real merge, plus unrelated work on main so the merge is a true 3-way merge. */
export async function landRealMerge(sha: string, n: number): Promise<{ merged: boolean; commit?: string }> {
  const main = g(SOURCE, ["rev-parse", "refs/heads/main"]);
  const subject = real("log", "-1", "--format=%s", sha).trim();
  const branchTip = commitFile(SOURCE, main, FILE, runbookAt(sha), subject);
  g(SOURCE, ["update-ref", `refs/heads/agent/m${n}`, branchTip, ""]);
  const unrelated = commitFile(SOURCE, main, `notes/unrelated-${n}.md`, `unrelated change ${n}\n`, `unrelated ${n}`);
  g(SOURCE, ["update-ref", "refs/heads/main", unrelated, main]);
  return serverMerge(SOURCE, `agent/m${n}`, `merge agent/m${n}: ${subject}`);
}

// ---- edge + push gate (spike 003, in-process edge: token verified BEFORE any pack is sent) ----
export const revoked = new Set<string>();
export interface PushResult { ok: boolean; at: "edge" | "gate" | "accepted"; reasons: string[] }
export function edgePush(token: string, repoName: string, repoPath: string, clone: string, ref = "refs/heads/main"): PushResult {
  let claims;
  try { claims = verify(token, repoName, revoked); } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), cat: "edge", event: "refused", repo: repoName, reason }) + "\n");
    return { ok: false, at: "edge", reasons: [reason] };
  }
  const r = spawnSync("git", ["-C", clone, "push", "--porcelain", repoPath, `HEAD:${ref}`], { encoding: "utf8",
    env: { ...HERMETIC, GATE_CLAIMS: JSON.stringify(claims), LEDGER, SOURCE_REPO: SOURCE, GATE_AUDIT: AUDIT } });
  const reasons = (r.stderr.match(/^remote:\s+- .*$/gm) ?? []).map((l) => l.replace(/^remote:\s+- /, "").trim());
  return r.status === 0 ? { ok: true, at: "accepted", reasons: [] } : { ok: false, at: "gate", reasons: reasons.length ? reasons : [r.stderr.trim().slice(0, 300)] };
}
export const writerToken = (runId: string, repo = "knowledge.git", paths = ["pages/**", ".claims/**"]) => mint({ runId, repo, refPrefix: "refs/heads/main", paths });
export const revoke = (token: string) => revoked.add(jtiOf(token));

// ---- knowledge writer: page + sidecar live in the knowledge repo, the queue/ledger outside GitHub ----
const pageOf = (cs: { statement: string }[]) => cs.map((c) => c.statement).join("\n\n") + "\n";
const writeSnapshot = (text: string) => { const p = join(ROOT, "repo", FILE); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
export function readSidecar(): Sidecar { return JSON.parse(readFileSync(join(KCLONE, ".claims", `${PAGE}.json`), "utf8")) as Sidecar; }
function writeState(sc: Sidecar): void {
  mkdirSync(join(KCLONE, "pages"), { recursive: true }); mkdirSync(join(KCLONE, ".claims"), { recursive: true });
  writeFileSync(join(KCLONE, "pages", `${PAGE}.md`), pageOf(sc.claims));
  writeFileSync(join(KCLONE, ".claims", `${PAGE}.json`), JSON.stringify(sc, null, 1) + "\n");
}
export function commitState(sc: Sidecar, subject: string, trailers: { ops: string[]; source: string; by: string }): string {
  writeState(sc);
  g(KCLONE, ["add", "-A"]);
  const msg = `${subject}\n\nKnowledge-Op: ${trailers.ops.join(", ")}\nSource-Commit: ${trailers.source}\nApproved-By: ${trailers.by}\n`;
  g(KCLONE, ["commit", "-q", "--allow-empty", "-F", "-"], msg);
  return g(KCLONE, ["rev-parse", "HEAD"]);
}
export function approve(opId: string, sourceCommit: string, by: string): void {
  appendFileSync(LEDGER, JSON.stringify({ opId, sourceCommit, decision: "approved", by, at: new Date().toISOString() }) + "\n");
}

export function seedKnowledge(seed: { id: string; statement: string; lineStart: number; lineEnd: number }[], sourceSeed: string): PushResult {
  execFileSync("git", ["init", "-q", "-b", "main", KCLONE], { env: HERMETIC });
  writeSnapshot(runbookAt(BASE));
  const init = seed.map((c) => ({ id: c.id, statement: c.statement, evidence: [`repo://${FILE}#L${c.lineStart}-L${c.lineEnd}`] }));
  const sc = generateSidecar(ROOT, PAGE, pageOf(init), init);
  const ops = [`seed:${PAGE}`];
  approve(`seed:${PAGE}`, sourceSeed, "ops-lead");
  commitState(sc, `knowledge: seed ${PAGE} (${sc.claims.length} claims)`, { ops, source: sourceSeed, by: "ops-lead" });
  const t = writerToken("seed");
  const r = edgePush(t, "knowledge.git", KNOWLEDGE, KCLONE);
  revoke(t);
  return r;
}

// ---- the heal worker: consume ref-transaction events, reconcile, commit, push through the gate ----
export interface Hunk { a: number; n: number; c: number; m: number }
export const hunksOf = (from: string, to: string): Hunk[] =>
  [...g(SOURCE, ["diff", "--no-color", "-U0", from, to, "--", FILE]).matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((m) => ({ a: Number(m[1]), n: m[2] === undefined ? 1 : Number(m[2]), c: Number(m[3]), m: m[4] === undefined ? 1 : Number(m[4]) }));
function mapRange(hs: Hunk[], a: number, b: number): [number, number] | null {
  const map = (x: number): [number, number] | null => {
    let d = 0;
    for (const h of hs) {
      if (h.n > 0 && x >= h.a && x <= h.a + h.n - 1) return h.m > 0 ? [h.c, h.c + h.m - 1] : null;
      if ((h.n === 0 && h.a < x) || (h.n > 0 && h.a + h.n - 1 < x)) d += h.m - h.n;
    }
    return [x + d, x + d];
  };
  const e = [map(a), map(b)].filter((r): r is [number, number] => r !== null);
  return e.length ? [Math.min(...e.map((r) => r[0])), Math.max(...e.map((r) => r[1]))] : null;
}
const rangeOf = (uri: string) => { const r = /L(\d+)-L(\d+)$/.exec(parseUri(uri).anchor)!; return [Number(r[1]), Number(r[2])] as const; };

/** Deterministic stand-in for the update model (spike 019 proves the real one): new statement = mapped new span. */
function spanUpdater(newText: string, hs: Hunk[], proposals: Map<string, string | null>): Updater {
  const lines = newText.split("\n");
  const u: Updater = { calls: 0, rework(items) {
    u.calls++;
    return items.map(({ claim }) => {
      const [a, b] = rangeOf(claim.evidence[0]!.uri);
      const m = mapRange(hs, a, b);
      proposals.set(claim.id, m ? `repo://${FILE}#L${m[0]}-L${Math.min(m[1], m[0] + 3)}` : null);
      return { id: claim.id, statement: m ? lines.slice(m[0] - 1, Math.min(m[1], m[0] + 3)).join(" ").replace(/\s+/g, " ").trim().slice(0, 240) : claim.statement };
    });
  } };
  return u;
}

export interface HealReport {
  event: { old: string; new: string }; flagged: string[]; oracle: string[]; falsePositives: string[]; falseNegatives: string[]; ambiguous: string[];
  ops: Draft["ops"]; llmCalls: number; commits: { sha: string; by: string; ops: number }[]; push: PushResult | null; diffMatchesReal: boolean;
}

export function runbookChanged(event: { old: string; new: string }): boolean {
  return spawnSync("git", ["-C", SOURCE, "diff", "--quiet", event.old, event.new, "--", FILE], { env: HERMETIC }).status === 1;
}

export function heal(event: { old: string; new: string }, realPrev: string, realSha: string, approver = "ops-lead"): HealReport {
  // The ref transaction's OLD value is the base (for a merge: its first parent). The oracle is the forge's own diff,
  // sanity-checked against the real repo's diff for the same merge.
  const firstParent = event.old;
  const hs = hunksOf(firstParent, event.new);
  const realDiff = real("diff", "--no-color", "-U0", realPrev, realSha, "--", FILE).replace(/^(diff|index|---|\+\+\+) .*\n/gm, "");
  const forgeDiff = g(SOURCE, ["diff", "--no-color", "-U0", firstParent, event.new, "--", FILE]).replace(/^(diff|index|---|\+\+\+) .*\n/gm, "") + "\n";
  const newText = g(SOURCE, ["show", `${event.new}:${FILE}`]) + "\n";
  writeSnapshot(newText);
  const sc = readSidecar();
  const md = pageOf(sc.claims);
  const report = checkPage(ROOT, md, sc);
  const oracle = sc.claims.filter((c) => { const [a, b] = rangeOf(c.evidence[0]!.uri); return hs.some((h) => h.n > 0 && h.a <= b && h.a + h.n - 1 >= a); }).map((c) => c.id);
  const isAmb = (id: string) => report.claims.find((c) => c.id === id)!.evidence.some((e) => e.kind === "ambiguous");
  const flagged = report.claims.filter((c) => c.status !== "fresh" && c.status !== "relocated").map((c) => c.id);
  const proposals = new Map<string, string | null>();
  const draft = reconcile(ROOT, md, sc, spanUpdater(newText, hs, proposals));
  const commits: HealReport["commits"] = [];
  const repins = draft.ops.filter((o) => o.op === "repin");
  const content = draft.ops.filter((o) => o.op === "update" && proposals.get(o.claimId));
  let state: Claim[] = sc.claims;
  if (repins.length) {
    state = state.map((c) => {
      if (!repins.some((o) => o.claimId === c.id)) return c;
      const st = report.claims.find((r) => r.id === c.id)!.evidence[0]!;
      return { ...c, evidence: [pin(ROOT, st.kind === "relocated" ? st.newUri : c.evidence[0]!.uri)] };
    });
    commits.push({ sha: commitState({ ...sc, claims: state }, `knowledge: repin ${repins.length} claims after ${event.new.slice(0, 8)}`, { ops: repins.map((o) => o.id), source: event.new, by: "auto:repin" }), by: "auto:repin", ops: repins.length });
  }
  if (content.length) {
    for (const o of content) approve(o.id, event.new, approver); // the queue decision (simulated human)
    state = state.map((c) => { const o = content.find((x) => x.claimId === c.id); return o ? { id: c.id, statement: o.after!, evidence: [pin(ROOT, proposals.get(c.id)!)] } : c; });
    const pageVersion = generateSidecar(ROOT, PAGE, pageOf(state), []).pageVersion;
    commits.push({ sha: commitState({ page: PAGE, pageVersion, claims: state }, `knowledge: ${content.length} approved update(s) after ${event.new.slice(0, 8)}`, { ops: content.map((o) => o.id), source: event.new, by: approver }), by: approver, ops: content.length });
  }
  let push: PushResult | null = null;
  if (commits.length) {
    const t = writerToken(`heal-${event.new.slice(0, 8)}`);
    push = edgePush(t, "knowledge.git", KNOWLEDGE, KCLONE);
    revoke(t); // revoke on run end: a leaked token is useless afterwards
  }
  return { event, flagged, oracle, ambiguous: flagged.filter(isAmb), falsePositives: flagged.filter((id) => !oracle.includes(id) && !isAmb(id)), falseNegatives: oracle.filter((id) => !flagged.includes(id) && !report.claims.find((c) => c.id === id)!.evidence.every((e) => e.kind === "fresh" || e.kind === "relocated")),
    ops: draft.ops, llmCalls: draft.llmCalls, commits, push, diffMatchesReal: realDiff === forgeDiff };
}

export const drainQueue = (): { old: string; new: string; ref: string }[] => {
  if (!existsSync(QUEUE)) return [];
  const evs = readFileSync(QUEUE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { old: string; new: string; ref: string });
  writeFileSync(QUEUE, "");
  return evs;
};
