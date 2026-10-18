// Spike 004 — server-side merge (merge-tree + CAS, no clone) vs clone-merge-push, same N branches.
// Branch mix: disjoint files, same file/different hunks, same hunk (true conflicts).
// node merge-bench.mjs [--n 50] [--concurrency 50]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work");
const LOG = join(HERE, "events.jsonl");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("n", 50);
const CONC = arg("concurrency", 50);
const C = ["-c", "commit.gpgsign=false", "-c", "user.name=agent", "-c", "user.email=agent@forge.local"];
// Hermetic git: the forge's merge output must not depend on whoever's ~/.gitconfig is on the box
// (found here: merge.ff=only broke the baseline, merge.conflictStyle=diff3 changed the payload format).
const HERMETIC = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const g = async (cwd, args, opts = {}) => (await run("git", [...C, ...args], { cwd, maxBuffer: 1 << 26, ...opts, env: { ...process.env, ...HERMETIC, ...(opts.env ?? {}) } })).stdout.trim();
const log = (category, event, data = {}) => writeFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), category, event, ...data }) + "\n", { flag: "a" });
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null; };

const SHARED_LINES = 300;
const kindOf = (i) => (i % 10 < 6 ? "disjoint" : i % 10 < 8 ? "same-file" : "same-hunk");

// ---------- fixture ----------
async function buildFixture(dir) {
  rmSync(dir, { recursive: true, force: true });
  await g(WORK, ["init", "-q", "--bare", "-b", "main", dir]);
  const wt = join(WORK, "fixture-wt");
  rmSync(wt, { recursive: true, force: true });
  await g(WORK, ["clone", "-q", dir, wt]);
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src/shared.ts"), Array.from({ length: SHARED_LINES }, (_, i) => `export const line${i} = ${i};`).join("\n") + "\n");
  await g(wt, ["add", "-A"]); await g(wt, ["commit", "-qm", "base"]); await g(wt, ["push", "-q", "origin", "HEAD:main"]);
  const expected = { merge: 0, conflict: 0 };
  let sawSameHunk = false;
  for (let i = 0; i < N; i++) {
    const kind = kindOf(i);
    await g(wt, ["checkout", "-q", "-B", `agent/c${i}`, "origin/main"]);
    if (kind === "disjoint") {
      mkdirSync(join(wt, "src/agents"), { recursive: true });
      writeFileSync(join(wt, `src/agents/c${i}.ts`), `export const c${i} = ${i};\n`);
    } else {
      const lines = readFileSync(join(wt, "src/shared.ts"), "utf8").split("\n");
      const at = kind === "same-file" ? 20 + i * 4 : 10; // same-file: distinct hunks ≥3 lines apart; same-hunk: all edit line 10
      lines[at] = `export const line${at} = ${1000 + i}; // edited by c${i}`;
      writeFileSync(join(wt, "src/shared.ts"), lines.join("\n"));
    }
    await g(wt, ["add", "-A"]);
    await g(wt, ["commit", "-qm", `c${i} ${kind}`]);
    await g(wt, ["push", "-q", "origin", `HEAD:refs/heads/agent/c${i}`]);
    if (kind === "same-hunk" && sawSameHunk) expected.conflict++; else expected.merge++;
    if (kind === "same-hunk") sawSameHunk = true;
  }
  return expected;
}

async function pool(items, conc, fn) {
  const out = []; let idx = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); } }));
  return out;
}

// ---------- strategy A: server-side ----------
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve(); let rel; const next = new Promise((r) => (rel = r));
  locks.set(key, prev.then(() => next)); await prev; try { return await fn(); } finally { rel(); }
}

// Structured conflict payload: everything an agent needs to resolve without a clone.
async function conflictPayload(repo, base, head, stdout) {
  const [tree, ...rest] = stdout.split("\n");
  const blank = rest.indexOf("");
  const info = rest.slice(0, blank < 0 ? rest.length : blank).map((l) => { const [meta, path] = l.split("\t"); const [mode, oid, stage] = meta.split(" "); return { mode, oid, stage: Number(stage), path }; });
  const messages = blank < 0 ? [] : rest.slice(blank + 1).filter(Boolean);
  const files = {};
  for (const e of info) {
    files[e.path] ??= { path: e.path };
    files[e.path][["", "base", "ours", "theirs"][e.stage]] = await g(repo, ["cat-file", "-p", e.oid]);
  }
  for (const f of Object.values(files)) f.withMarkers = await g(repo, ["cat-file", "-p", `${tree}:${f.path}`]);
  return { base, head, conflictTree: tree, files: Object.values(files), messages };
}

async function serverMerge(repo, branch) {
  return withLock(repo, async () => {
    const base = await g(repo, ["rev-parse", "refs/heads/main"]);
    const head = await g(repo, ["rev-parse", `refs/heads/${branch}`]);
    try {
      const tree = (await g(repo, ["merge-tree", "--write-tree", base, head])).split("\n")[0];
      const commit = await g(repo, ["commit-tree", tree, "-p", base, "-p", head, "-m", `merge ${branch}`]);
      await g(repo, ["update-ref", "refs/heads/main", commit, base]);
      return { status: "merged", commit };
    } catch (err) {
      if (err?.code !== 1 || !err.stdout) throw err;
      return { status: "conflict", payload: await conflictPayload(repo, base, head, String(err.stdout).trim()) };
    }
  });
}

// Agent resolves from the payload alone (no clone): keep both sides, commit a merge of [head, base] via a temp index.
async function agentResolve(repo, branch, payload, i) {
  const idx = join(WORK, `idx-${i}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  await g(repo, ["read-tree", payload.conflictTree], { env });
  for (const f of payload.files) {
    const resolved = f.withMarkers.replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n?/g, "$1$2");
    const oid = await new Promise((res, rej) => {
      const p = execFile("git", ["hash-object", "-w", "--stdin"], { cwd: repo }, (e, out) => (e ? rej(e) : res(out.trim())));
      p.stdin.end(resolved);
    });
    await g(repo, ["update-index", "--cacheinfo", `100644,${oid},${f.path}`], { env });
  }
  const tree = await g(repo, ["write-tree"], { env });
  const commit = await g(repo, ["commit-tree", tree, "-p", payload.head, "-p", payload.base, "-m", `c${i}: resolve conflict`]);
  await g(repo, ["update-ref", `refs/heads/${branch}`, commit, payload.head]);
  rmSync(idx, { force: true });
}

// ---------- strategy B: clone-merge-push (what Forgejo / CI bots do) ----------
async function cloneMergePush(repo, branch, i) {
  const wt = join(WORK, "clones", `w${i}`);
  rmSync(wt, { recursive: true, force: true });
  await g(WORK, ["clone", "-q", "--no-checkout", repo, wt]);
  for (let attempt = 1; attempt <= 100; attempt++) {
    await g(wt, ["fetch", "-q", "origin", "main", branch]);
    await g(wt, ["checkout", "-q", "-B", "main", "origin/main"]);
    // --no-ff explicitly: user-level merge.ff=only would otherwise abort every merge (found in spike 004).
    try { await g(wt, ["merge", "-q", "--no-ff", "--no-edit", `origin/${branch}`]); }
    catch (err) {
      const unmerged = await g(wt, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
      await g(wt, ["merge", "--abort"]).catch(() => {});
      if (!unmerged) throw err; // not a conflict — surface it instead of miscounting
      return { status: "conflict", attempts: attempt };
    }
    try { await g(wt, ["push", "-q", "origin", "main"]); return { status: "merged", attempts: attempt }; }
    catch { /* non-fast-forward: someone merged first; refetch and retry */ }
  }
  return { status: "gave-up", attempts: 100 };
}

async function bench(name, fn) {
  const repo = join(WORK, `${name}.git`);
  const expected = await buildFixture(repo);
  const t0 = performance.now();
  const rows = await pool(Array.from({ length: N }, (_, i) => i), CONC, async (i) => {
    const s = performance.now(); const r = await fn(repo, `agent/c${i}`, i);
    return { i, kind: kindOf(i), ms: performance.now() - s, ...r };
  });
  const wallMs = performance.now() - t0;
  const merged = rows.filter((r) => r.status === "merged");
  const out = { name, n: N, concurrency: CONC, expected, wallMs: Math.round(wallMs), merged: merged.length,
    conflicts: rows.filter((r) => r.status === "conflict").length, other: rows.filter((r) => !["merged", "conflict"].includes(r.status)).length,
    p50: pct(rows.map((r) => r.ms), 50), p95: pct(rows.map((r) => r.ms), 95), mergesPerSec: +(merged.length / (wallMs / 1000)).toFixed(2),
    meanAttempts: rows[0]?.attempts ? +(rows.reduce((a, r) => a + (r.attempts ?? 1), 0) / N).toFixed(2) : 1,
    byKind: Object.fromEntries(["disjoint", "same-file", "same-hunk"].map((k) => [k, { merged: rows.filter((r) => r.kind === k && r.status === "merged").length, conflict: rows.filter((r) => r.kind === k && r.status === "conflict").length }])) };
  log("bench", name, out);
  return { out, rows, repo };
}

async function main() {
  rmSync(WORK, { recursive: true, force: true }); mkdirSync(join(WORK, "clones"), { recursive: true });
  writeFileSync(LOG, "");
  const A = await bench("server-side", (repo, br) => serverMerge(repo, br));
  console.log(JSON.stringify(A.out));
  const B = await bench("clone-merge-push", (repo, br, i) => cloneMergePush(repo, br, i));
  console.log(JSON.stringify(B.out));

  // Agent fix loop on A's conflicts: resolve from payload, resubmit, verify.
  const conflicted = A.rows.filter((r) => r.status === "conflict");
  const sample = conflicted[0]?.payload;
  const t0 = performance.now();
  let fixed = 0, rounds = 0;
  let pending = conflicted.map((r) => ({ i: r.i, payload: r.payload }));
  while (pending.length && rounds < 20) {
    rounds++;
    const next = [];
    for (const p of pending) {
      await agentResolve(A.repo, `agent/c${p.i}`, p.payload, p.i);
      const r = await serverMerge(A.repo, `agent/c${p.i}`);
      if (r.status === "merged") fixed++; else next.push({ i: p.i, payload: r.payload });
    }
    pending = next;
  }
  const finalShared = await g(A.repo, ["show", "main:src/shared.ts"]);
  const markersOnMain = /^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m.test(finalShared);
  const allEditsPresent = !markersOnMain && conflicted.every((r) => finalShared.includes(`edited by c${r.i}`)) && A.rows.filter((r) => r.kind !== "disjoint").every((r) => finalShared.includes(`edited by c${r.i}`));
  const fix = { conflicts: conflicted.length, fixed, rounds, ms: Math.round(performance.now() - t0), allEditsPresentOnMain: allEditsPresent, markersOnMain,
    payloadBytes: sample ? JSON.stringify(sample).length : 0, payloadKeys: sample ? Object.keys(sample.files[0]) : [] };
  log("fix-loop", "done", fix);
  console.log(JSON.stringify(fix));
  writeFileSync(join(HERE, "results.json"), JSON.stringify({ serverSide: A.out, cloneMergePush: B.out, fixLoop: fix,
    samplePayload: sample ? { ...sample, files: sample.files.map((f) => ({ ...f, base: f.base?.split("\n").slice(8, 12), ours: f.ours?.split("\n").slice(8, 12), theirs: f.theirs?.split("\n").slice(8, 12), withMarkers: f.withMarkers.split("\n").slice(8, 16) })) } : null }, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
