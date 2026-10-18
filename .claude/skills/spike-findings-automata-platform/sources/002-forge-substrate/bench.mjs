// Spike 002 — same agent workload against two substrates.
// node bench.mjs --target bare|forgejo [--sessions 50] [--commits 5]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const TARGET = arg("target", "bare");
const SESSIONS = Number(arg("sessions", 50));
const COMMITS = Number(arg("commits", 5));
const TAG = arg("tag", "");
const WORK = join(HERE, "work", `${TARGET}-clients`);
const FJ = { base: "http://localhost:3300", user: "spike" };
const GITC = ["-c", "commit.gpgsign=false", "-c", "user.name=agent", "-c", "user.email=agent@forge.local", "-c", "credential.helper="];

const tokenFile = join(HERE, "work", "forgejo-token");
const FJ_TOKEN = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
const cloneUrl = TARGET === "bare" ? "http://localhost:3301/bench.git" : `http://${FJ.user}:${FJ_TOKEN}@localhost:3300/${FJ.user}/bench.git`;

const codes = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function timed(fn) { const t = performance.now(); const v = await fn(); return [performance.now() - t, v]; }
const git = (cwd, args) => run("git", [...GITC, ...args], { cwd, maxBuffer: 1 << 26 });

async function fj(method, path, body) {
  const res = await fetch(`${FJ.base}/api/v1${path}`, {
    method, headers: { authorization: `token ${FJ_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
}

async function merge(branch) {
  if (TARGET === "bare") {
    const res = await fetch("http://localhost:3301/api/merge", { method: "POST", body: JSON.stringify({ repo: "bench.git", branch }) });
    const out = await res.json();
    return { ok: out.status === "merged", attempts: out.attempts ?? 1, detail: out.status };
  }
  const pr = await fj("POST", `/repos/${FJ.user}/bench/pulls`, { head: branch, base: "main", title: branch });
  if (pr.status !== 201) return { ok: false, attempts: 0, detail: `pr ${pr.status} ${JSON.stringify(pr.body).slice(0, 120)}` };
  // Forgejo checks mergeability asynchronously; concurrent merges move main → retry with backoff.
  for (let attempt = 1; attempt <= 60; attempt++) {
    const m = await fj("POST", `/repos/${FJ.user}/bench/pulls/${pr.body.number}/merge`, { Do: "merge" });
    codes[`${m.status}:${typeof m.body === "object" ? (m.body?.message ?? "").slice(0, 60) : String(m.body).slice(0, 60)}`] = (codes[`${m.status}:${typeof m.body === "object" ? (m.body?.message ?? "").slice(0, 60) : String(m.body).slice(0, 60)}`] ?? 0) + 1;
    if (m.status === 200) return { ok: true, attempts: attempt, detail: "merged" };
    if (attempt === 60) return { ok: false, attempts: attempt, detail: `merge ${m.status} ${JSON.stringify(m.body).slice(0, 160)}` };
    await sleep(Math.min(200 * attempt, 2000) + Math.random() * 200);
  }
}

async function session(id) {
  const dir = join(WORK, `s${id}`);
  const branch = `agent/s${id}`;
  const out = { id, pushes: [], errors: [] };
  try {
    [out.cloneMs] = await timed(() => git(WORK, ["clone", "-q", cloneUrl, dir]));
    await git(dir, ["checkout", "-qb", branch]);
    mkdirSync(join(dir, "agent-work"), { recursive: true });
    for (let c = 0; c < COMMITS; c++) {
      writeFileSync(join(dir, "agent-work", `s${id}.txt`), `session ${id} commit ${c}\n`.repeat(c + 1));
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-qm", `s${id} c${c}`]);
      const [ms] = await timed(() => git(dir, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]));
      out.pushes.push(ms);
    }
    const [ms, m] = await timed(() => merge(branch));
    out.mergeMs = ms; out.mergeAttempts = m.attempts; out.merged = m.ok;
    if (!m.ok) out.errors.push(m.detail);
  } catch (err) {
    out.errors.push(String(err?.stderr || err).slice(0, 300));
  }
  return out;
}

function pct(xs, p) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); }

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const t0 = performance.now();
  const sessions = await Promise.all(Array.from({ length: SESSIONS }, (_, i) => session(i)));
  const wallMs = performance.now() - t0;
  const pushes = sessions.flatMap((s) => s.pushes);
  const merges = sessions.filter((s) => s.merged).map((s) => s.mergeMs);
  const clones = sessions.map((s) => s.cloneMs).filter(Boolean);
  // Verify main actually contains every merged session's file.
  const verify = join(WORK, "verify");
  await git(WORK, ["clone", "-q", cloneUrl, verify]);
  const present = sessions.filter((s) => existsSync(join(verify, "agent-work", `s${s.id}.txt`))).length;
  const summary = {
    target: TARGET, tag: TAG, sessions: SESSIONS, commitsPerSession: COMMITS, wallMs: Math.round(wallMs),
    clone: { p50: pct(clones, 50), p95: pct(clones, 95) },
    push: { n: pushes.length, p50: pct(pushes, 50), p95: pct(pushes, 95), max: pct(pushes, 100) },
    merge: { ok: merges.length, p50: pct(merges, 50), p95: pct(merges, 95), max: pct(merges, 100),
      meanAttempts: +(sessions.reduce((a, s) => a + (s.mergeAttempts ?? 0), 0) / SESSIONS).toFixed(2) },
    mergesPerSec: +(merges.length / (wallMs / 1000)).toFixed(2),
    filesOnMain: present, errors: sessions.flatMap((s) => s.errors.map((e) => `s${s.id}: ${e}`)).slice(0, 10),
    mergeResponseCodes: codes,
    errorCount: sessions.reduce((a, s) => a + s.errors.length, 0),
  };
  if (TARGET === "bare") summary.serverStats = await (await fetch("http://localhost:3301/api/stats")).json();
  mkdirSync(join(HERE, "results"), { recursive: true });
  writeFileSync(join(HERE, "results", `${TARGET}-${SESSIONS}${TAG ? "-" + TAG : ""}.json`), JSON.stringify({ summary, sessions }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
