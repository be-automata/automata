// Spike 006 — post-merge verification + server-side auto-revert + approver≠author, on the forge's task branch.
// node verify.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work");
const LOG = join(HERE, "events.jsonl");
const REPO = join(WORK, "forge.git");
const GITHUB = join(WORK, "github.git"); // local stand-in; real projection was proven in 001/005
const TASK = "agent/run-1/task";
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const ID = ["-c", "user.name=forge", "-c", "user.email=forge@forge.local"];
const g = async (args, opts = {}) => (await run("git", ["-C", REPO, ...ID, ...args], { env: { ...ENV, ...(opts.env ?? {}) }, maxBuffer: 1 << 26 })).stdout.trim();
const log = (category, event, data = {}) => writeFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), category, event, ...data }) + "\n", { flag: "a" });
const results = [];
const check = (name, ok, detail = {}) => { results.push({ name, ok, ...detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}`, JSON.stringify(detail).slice(0, 220)); };

// Provenance ledger (spike 005): commit → runId that pushed it through the gate.
const ledger = new Map();

// Write a commit on top of `parent` with files changed, as if pushed by `runId` through the gate (no worktree).
async function agentCommit(parent, files, msg, runId, authorName = "agent") {
  const idx = join(WORK, `idx-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: idx };
  await g(["read-tree", parent], { env });
  for (const [path, text] of Object.entries(files)) {
    const oid = await new Promise((res, rej) => { const p = execFile("git", ["-C", REPO, "hash-object", "-w", "--stdin"], { env: ENV }, (e, o) => (e ? rej(e) : res(o.trim()))); p.stdin.end(text); });
    await g(["update-index", "--add", "--cacheinfo", `100644,${oid},${path}`], { env });
  }
  const tree = await g(["write-tree"], { env });
  rmSync(idx, { force: true });
  const sha = await g(["-c", `user.name=${authorName}`, "commit-tree", tree, "-p", parent, "-m", msg]);
  ledger.set(sha, runId);
  return sha;
}

// ---- merge with separation of duties: approver's run must differ from every pushing run in the range ----
async function mergeInto(into, head, approverRun) {
  const base = await g(["rev-parse", `refs/heads/${into}`]);
  const range = (await g(["rev-list", head, "--not", base])).split("\n").filter(Boolean);
  const authors = [...new Set(range.map((c) => ledger.get(c) ?? "UNKNOWN"))];
  if (authors.includes(approverRun)) return { status: "refused", reason: `approver ${approverRun} authored commits in this change (separation of duties)` };
  if (authors.includes("UNKNOWN")) return { status: "refused", reason: "commits without gate provenance" };
  const tree = (await g(["merge-tree", "--write-tree", base, head])).split("\n")[0];
  const commit = await g(["commit-tree", tree, "-p", base, "-p", head, "-m", `forge: merge ${head.slice(0, 8)} (approved by ${approverRun})`]);
  await g(["update-ref", `refs/heads/${into}`, commit, base]);
  ledger.set(commit, "forge");
  log("merge", "merged", { into, commit, authors, approver: approverRun });
  return { status: "merged", commit };
}

// ---- verify: materialize the tree (git archive, no clone/history) and run the project's tests ----
async function runTests(commit, attempt = 1) {
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  try {
    const { stdout: tarball } = await run("git", ["-C", REPO, "archive", "--format=tar", commit], { env: ENV, encoding: "buffer", maxBuffer: 1 << 26 });
    await new Promise((res, rej) => { const p = execFile("tar", ["-x", "-C", dir], (e) => (e ? rej(e) : res())); p.stdin.end(tarball); });
    try {
      await run("node", ["--test", "--test-reporter=tap"], { cwd: dir, env: { ...process.env, VERIFY_ATTEMPT: String(attempt) } });
      return { ok: true };
    } catch (e) {
      const failing = [...String(e.stdout).matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].replace(/^.*\/test\//, "test/"));
      return { ok: false, failing };
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Verify a specific merge commit; on red (after `retries` re-runs to rule out flakes), revert just that merge on the
// branch tip — even if other merges landed after it — via merge-tree with an explicit merge base. No clone.
async function verifyAndMaybeRevert(branch, mergeCommit, { retries = 1 } = {}) {
  const t0 = performance.now();
  let res = await runTests(mergeCommit, 1);
  for (let i = 1; !res.ok && i <= retries; i++) { log("verify", "retry", { mergeCommit, failing: res.failing }); res = await runTests(mergeCommit, i + 1); }
  if (res.ok) { log("verify", "green", { mergeCommit, ms: Math.round(performance.now() - t0) }); return { status: "green" }; }
  const tip = await g(["rev-parse", `refs/heads/${branch}`]);
  const parent = await g(["rev-parse", `${mergeCommit}^1`]);
  // Revert = apply (mergeCommit → parent) onto tip: merge-base mergeCommit, ours tip, theirs parent.
  const tree = (await g(["merge-tree", "--write-tree", `--merge-base=${mergeCommit}`, tip, parent])).split("\n")[0];
  const revert = await g(["commit-tree", tree, "-p", tip, "-m", `forge: auto-revert ${mergeCommit.slice(0, 8)}\n\nPost-merge verify failed: ${res.failing.join("; ")}`]);
  await g(["update-ref", `refs/heads/${branch}`, revert, tip]);
  ledger.set(revert, "forge");
  const ms = Math.round(performance.now() - t0);
  log("verify", "reverted", { mergeCommit, revert, failing: res.failing, ms });
  return { status: "reverted", revert, failing: res.failing, ms };
}

const FILES = {
  "package.json": '{ "type": "module" }\n',
  "src/lib.js": "export function calc(x) { return x * 2; }\n",
  "src/report.js": 'import { calc } from "./lib.js";\nexport const report = (x) => `value=${calc(x)}`;\n',
  "test/lib.test.mjs": 'import test from "node:test"; import assert from "node:assert";\nimport { report } from "../src/report.js";\ntest("report formats value", () => assert.equal(report(2), "value=4"));\n',
};

async function main() {
  rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true }); writeFileSync(LOG, "");
  await run("git", ["init", "-q", "--bare", "-b", "main", REPO], { env: ENV });
  await run("git", ["init", "-q", "--bare", "-b", "main", GITHUB], { env: ENV });
  const empty = await g(["hash-object", "-t", "tree", "-w", "/dev/null"]);
  const root = await g(["commit-tree", empty, "-m", "root"]);
  const base = await agentCommit(root, FILES, "base project", "seed");
  await g(["update-ref", `refs/heads/${TASK}`, base]);
  ledger.set(root, "seed");
  check("V0 baseline is green", (await runTests(base)).ok);

  // V1: a good change merges and verifies green.
  const good = await agentCommit(base, { "src/extra.js": "export const extra = 1;\n", "test/extra.test.mjs": 'import test from "node:test"; import assert from "node:assert";\nimport { extra } from "../src/extra.js";\ntest("extra", () => assert.equal(extra, 1));\n' }, "sub-c: extra", "run-sub-c");
  const m1 = await mergeInto(TASK, good, "run-lead");
  const v1 = await verifyAndMaybeRevert(TASK, m1.commit);
  check("V1 good change: merged, verify green, kept", m1.status === "merged" && v1.status === "green");

  // V2: semantic conflict. A renames calc→compute (updating callers); B, branched before A, adds a new caller of calc.
  const fork = await g(["rev-parse", `refs/heads/${TASK}`]);
  const a = await agentCommit(fork, { "src/lib.js": "export function compute(x) { return x * 2; }\n", "src/report.js": 'import { compute } from "./lib.js";\nexport const report = (x) => `value=${compute(x)}`;\n' }, "sub-a: rename calc→compute", "run-sub-a");
  const b = await agentCommit(fork, { "src/summary.js": 'import { calc } from "./lib.js";\nexport const summary = (xs) => xs.map(calc).join(",");\n', "test/summary.test.mjs": 'import test from "node:test"; import assert from "node:assert";\nimport { summary } from "../src/summary.js";\ntest("summary joins doubled values", () => assert.equal(summary([1,2]), "2,4"));\n' }, "sub-b: summary uses calc", "run-sub-b");
  const ma = await mergeInto(TASK, a, "run-lead");
  const va = await verifyAndMaybeRevert(TASK, ma.commit);
  const mb = await mergeInto(TASK, b, "run-lead");
  const textualConflict = mb.status !== "merged";
  const beforeVerify = await g(["rev-parse", `refs/heads/${TASK}`]);
  const vb = await verifyAndMaybeRevert(TASK, mb.commit);
  const after = await g(["rev-parse", `refs/heads/${TASK}`]);
  const treeEq = (await g(["rev-parse", `${after}^{tree}`])) === (await g(["rev-parse", `${ma.commit}^{tree}`]));
  check("V2 semantic conflict merges cleanly, verify catches it, auto-revert restores the green tree", va.status === "green" && !textualConflict && vb.status === "reverted" && treeEq && (await runTests(after)).ok,
    { failing: vb.failing, revertMs: vb.ms, reverted: beforeVerify !== after });

  // V3: lagged verify — a bad merge (D), then a good merge (E) lands before D's verify runs. Revert only D.
  const t3 = await g(["rev-parse", `refs/heads/${TASK}`]);
  const d = await agentCommit(t3, { "src/report.js": 'import { compute } from "./lib.js";\nexport const report = (x) => `val=${compute(x)}`;\n' }, "sub-d: change format (breaks test)", "run-sub-d");
  const e = await agentCommit(t3, { "docs/NOTES.md": "notes\n" }, "sub-e: docs", "run-sub-e");
  const md = await mergeInto(TASK, d, "run-lead");
  const me = await mergeInto(TASK, e, "run-lead");
  const vd = await verifyAndMaybeRevert(TASK, md.commit);
  const tip3 = await g(["rev-parse", `refs/heads/${TASK}`]);
  const keepsE = (await g(["ls-tree", "-r", "--name-only", tip3])).split("\n").includes("docs/NOTES.md");
  const report3 = await g(["show", `${tip3}:src/report.js`]);
  check("V3 lagged verify reverts only the bad merge, keeps the later good one", me.status === "merged" && vd.status === "reverted" && keepsE && report3.includes("value=") && (await runTests(tip3)).ok, { revertMs: vd.ms });

  // V4: the projection (local GitHub stand-in) shows the revert with its reason.
  await run("git", ["-C", REPO, "push", "-q", GITHUB, `refs/heads/${TASK}:refs/heads/spike/forge-task`], { env: ENV });
  const projected = (await run("git", ["-C", GITHUB, "log", "--format=%s", "--grep=auto-revert", "spike/forge-task"], { env: ENV })).stdout;
  check("V4 projected branch carries the auto-revert commits", projected.trim().split("\n").length === 2, { reverts: projected.trim().split("\n") });

  // V5: separation of duties via provenance (not commit author fields).
  const t5 = await g(["rev-parse", `refs/heads/${TASK}`]);
  const f = await agentCommit(t5, { "docs/F.md": "f\n" }, "sub-f", "run-sub-f");
  const self = await mergeInto(TASK, f, "run-sub-f");
  const spoof = await agentCommit(t5, { "docs/G.md": "g\n" }, "sub-g pretending", "run-sub-g", "Senior Reviewer");
  const spoofSelf = await mergeInto(TASK, spoof, "run-sub-g");
  const other = await mergeInto(TASK, f, "run-reviewer");
  check("V5 approver≠author enforced by push provenance (spoofed author name doesn't help)", self.status === "refused" && spoofSelf.status === "refused" && other.status === "merged", { reason: self.reason });

  // V6: flaky test — fails on first attempt only. One retry prevents a false revert.
  const t6 = await g(["rev-parse", `refs/heads/${TASK}`]);
  const flaky = await agentCommit(t6, { "test/flaky.test.mjs": 'import test from "node:test"; import assert from "node:assert";\ntest("flaky", () => assert.notEqual(process.env.VERIFY_ATTEMPT, "1"));\n' }, "sub-h: flaky test", "run-sub-h");
  const mh = await mergeInto(TASK, flaky, "run-lead");
  const vh = await verifyAndMaybeRevert(TASK, mh.commit, { retries: 1 });
  check("V6 flaky test retried once: no false revert (retry logged)", vh.status === "green");

  writeFileSync(join(HERE, "results.json"), JSON.stringify({ results }, null, 2));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
