// Spike 005 — end-to-end forge pipeline against real GitHub (spike/forge-* on be-automata/astro-web).
// node scenarios.mjs   |   node scenarios.mjs --cleanup
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work");
const AUDIT = join(HERE, "events.jsonl");
const PORT = 3305;
const BASE_URL = `http://localhost:${PORT}`;
const GH_REPO = "be-automata/astro-web";
const REMOTE = `https://github.com/${GH_REPO}.git`;
const RUN = `run-${Date.now().toString(36)}`;
const PREFIX = `refs/heads/agent/${RUN}/`;
const TASK = `agent/${RUN}/task`;
const results = [];
const check = (name, ok, detail = {}) => { results.push({ name, ok, ...detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}`, JSON.stringify(detail).slice(0, 240)); };
const HERM = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
// Hermetic env drops the global credential helper too, so GitHub access names gh explicitly.
const CRED = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
const ID = ["-c", "user.name=agent", "-c", "user.email=agent@forge.local", "-c", "commit.gpgsign=false", ...CRED];

function authEnv(token) {
  return { ...process.env, ...HERM, ...(token ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`agent:${token}`).toString("base64")}` } : {}) };
}
async function git(cwd, args, token) {
  try { const { stdout, stderr } = await run("git", [...ID, ...args], { cwd, env: authEnv(token), maxBuffer: 1 << 26 }); return { ok: true, out: stdout + stderr }; }
  catch (e) { return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
}
async function api(path, body) {
  const res = await fetch(`${BASE_URL}/api/${path}`, { method: "POST", body: JSON.stringify(body) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
const ghTip = async (branch) => (await run("git", ["ls-remote", REMOTE, `refs/heads/${branch}`])).stdout.split("\t")[0];
const events = () => readFileSync(AUDIT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function cleanup() {
  const prs = JSON.parse((await run("gh", ["api", `repos/${GH_REPO}/pulls?state=open&per_page=100`])).stdout);
  for (const pr of prs.filter((p) => p.head.ref.startsWith("spike/forge-"))) { await run("gh", ["api", "-X", "PATCH", `repos/${GH_REPO}/pulls/${pr.number}`, "-f", "state=closed"]); console.log("closed PR", pr.number); }
  const br = (await run("gh", ["api", `repos/${GH_REPO}/branches?per_page=100`, "--jq", ".[].name"])).stdout.split("\n");
  for (const b of br.filter((x) => x.startsWith("spike/forge-"))) { await run("gh", ["api", "-X", "DELETE", `repos/${GH_REPO}/git/refs/heads/${b}`]); console.log("deleted", b); }
}

async function commit(dir, files, msg) {
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); }
  await git(dir, ["add", "-A"]); return git(dir, ["commit", "-qm", msg]);
}

let server;
async function main() {
  if (process.argv.includes("--cleanup")) return cleanup();
  rmSync(WORK, { recursive: true, force: true }); mkdirSync(join(WORK, "clients"), { recursive: true }); writeFileSync(AUDIT, "");
  await run("git", [...CRED, "clone", "-q", "--bare", "--single-branch", "--branch", "main", REMOTE, join(WORK, "app.git")], { env: { ...process.env, ...HERM } });
  mkdirSync(join(WORK, "hooks"));
  writeFileSync(join(WORK, "hooks", "pre-receive"), `#!/bin/sh\nexec node "${join(HERE, "pre-receive.mjs")}"\n`);
  chmodSync(join(WORK, "hooks", "pre-receive"), 0o755);
  await run("git", ["-C", join(WORK, "app.git"), "config", "core.hooksPath", join(WORK, "hooks")]);
  server = spawn("node", [join(HERE, "forge.mjs")], { env: { ...process.env, FORGE_ROOT: WORK, PORT: String(PORT), GATE_AUDIT: AUDIT }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => server.stdout.once("data", r));
  const t0 = Date.now();

  const token = await api("mint", { runId: RUN, repo: "app.git", refPrefix: PREFIX, paths: ["src/**", "agent-work/**"] });
  const clone = async (name) => { const d = join(WORK, "clients", name); await git(join(WORK, "clients"), ["clone", "-q", `${BASE_URL}/app.git`, d]); return d; };

  // P1: lead creates the task branch; two sub-agents push sub-branches. Every push goes through the gate.
  const lead = await clone("lead");
  await git(lead, ["checkout", "-qb", TASK]);
  await commit(lead, { "agent-work/PLAN.md": "plan\n" }, "lead: plan");
  const p1 = await git(lead, ["push", "-q", "origin", `HEAD:${TASK}`], token);
  const subs = [];
  for (const s of ["a", "b"]) {
    const d = await clone(`sub-${s}`);
    await git(d, ["fetch", "-q", "origin", TASK]); await git(d, ["checkout", "-qb", `sub-${s}`, "FETCH_HEAD"]);
    await commit(d, { [`src/feature-${s}.ts`]: `export const ${s} = "${s}";\n` }, `sub-${s}: feature`);
    subs.push(await git(d, ["push", "-q", "origin", `HEAD:agent/${RUN}/sub-${s}`], token));
  }
  check("P1 lead + 2 sub-agent pushes accepted by the gate", p1.ok && subs.every((x) => x.ok));

  // P2: fan-in server-side (no clone).
  const ma = await api("merge", { token, repo: "app.git", branch: `agent/${RUN}/sub-a`, into: TASK });
  const mb = await api("merge", { token, repo: "app.git", branch: `agent/${RUN}/sub-b`, into: TASK });
  const outside = await api("merge", { token, repo: "app.git", branch: `agent/${RUN}/sub-a`, into: "main" });
  check("P2 sub-agents merged into task server-side; merge into main refused", ma.status === "merged" && mb.status === "merged" && outside.status === "refused", { outside: outside.reason });

  // P3: project task to GitHub with provenance check.
  const pr3 = await api("project", { token, repo: "app.git", branch: TASK });
  check("P3 task projected to GitHub (draft PR), provenance ok", pr3.status === "projected" && (await ghTip(pr3.branch)) === pr3.sha, { branch: pr3.branch });
  const dst = pr3.branch;

  // P4: human pushes a review fix on GitHub; agent keeps working on the forge.
  const human = join(WORK, "clients", "human");
  await run("gh", ["repo", "clone", GH_REPO, human, "--", "-q", "--branch", dst, "--single-branch"]);
  await commit(human, { "REVIEW_NOTE.md": "human review fix\n" }, "human: review fix");
  await git(human, ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", "-q", "origin", "HEAD"]);
  const humanSha = (await git(human, ["rev-parse", "HEAD"])).out.trim();
  await git(lead, ["pull", "-q", "--no-rebase", "origin", TASK], token);
  await commit(lead, { "agent-work/PLAN.md": "plan\nstep 2\n" }, "lead: step 2");
  const p4push = await git(lead, ["push", "-q", "origin", `HEAD:${TASK}`], token);
  const pr4 = await api("project", { token, repo: "app.git", branch: TASK });
  check("P4 human push detected as divergence; GitHub keeps human commit", p4push.ok && pr4.status === "diverged" && (await ghTip(dst)) === humanSha, { imported: pr4.imported?.length });

  // P5: reconcile server-side, re-project (fast-forward).
  const rc = await api("reconcile", { token, repo: "app.git", branch: TASK });
  const pr5 = await api("project", { token, repo: "app.git", branch: TASK });
  const tip5 = await ghTip(dst);
  const keeps = (await git(join(WORK, "app.git"), ["merge-base", "--is-ancestor", humanSha, rc.commit])).ok;
  check("P5 reconcile + projection fast-forwards GitHub, human commit kept", rc.status === "reconciled" && pr5.status === "projected" && tip5 === rc.commit && keeps);

  // P6: the lead's clone is stale (pre-reconcile). git's own client refuses the non-ff push before the server sees it
  // ("fetch first"); the agent follows git's standard recovery: fetch + rebase + push.
  await commit(lead, { "agent-work/PLAN.md": "plan\nstep 2\nstep 3\n" }, "lead: step 3");
  const stale = await git(lead, ["push", "origin", `HEAD:${TASK}`], token);
  const clientSide = /fetch first|rejected/.test(stale.out);
  // P6b: an agent that forces anyway is refused server-side by the gate, with the forge's recovery hint.
  const forced = await git(lead, ["push", "--force", "origin", `HEAD:${TASK}`], token);
  const guidance = (forced.out.match(/Recover with: ([^\n]*)/) ?? [])[1]?.trim();
  await git(lead, ["fetch", "-q", "origin"], token);
  const rb = await git(lead, ["rebase", `origin/${TASK}`]);
  const recovered = rb.ok ? await git(lead, ["push", "-q", "origin", `HEAD:${TASK}`], token) : rb;
  const pr6 = await api("project", { token, repo: "app.git", branch: TASK });
  check("P6 stale push refused by git client; agent recovers via fetch+rebase; projection ff", !stale.ok && clientSide && recovered.ok && pr6.status === "projected", { recovered: recovered.ok, rebase: rb.out.trim().slice(0, 80) });
  check("P6b forced push refused server-side with forge recovery hint", !forced.ok && !!guidance, { guidance: guidance?.slice(0, 100) });

  // P7: a secret pushed by an agent never reaches GitHub.
  const before7 = await ghTip(dst);
  await commit(lead, { "src/config.ts": `export const key = "ghp_${randomBytes(20).toString("hex")}";\n` }, "lead: oops");
  const p7 = await git(lead, ["push", "origin", `HEAD:${TASK}`], token);
  await git(lead, ["reset", "-q", "--hard", "HEAD~1"]);
  const pr7 = await api("project", { token, repo: "app.git", branch: TASK });
  check("P7 secret rejected at push; GitHub unchanged", !p7.ok && /secret/.test(p7.out) && (await ghTip(dst)) === before7, { projection: pr7.status });

  // P8: a commit that bypassed the gate (written straight into the bare repo) is never projected.
  const repo = join(WORK, "app.git");
  const tip = (await git(repo, ["rev-parse", `refs/heads/${TASK}`])).out.trim();
  const tree = (await git(repo, ["rev-parse", `${tip}^{tree}`])).out.trim();
  const rogue = (await git(repo, ["commit-tree", tree, "-p", tip, "-m", "rogue: bypassed the gate"])).out.trim();
  await git(repo, ["update-ref", `refs/heads/${TASK}`, rogue, tip]);
  const before8 = await ghTip(dst);
  const pr8 = await api("project", { token, repo: "app.git", branch: TASK });
  check("P8 gate-bypassing commit refused by provenance check; GitHub unchanged", pr8.status === "refused-provenance" && pr8.unknown?.includes(rogue) && (await ghTip(dst)) === before8, { unknown: pr8.unknown?.map((c) => c.slice(0, 12)) });
  await git(repo, ["update-ref", `refs/heads/${TASK}`, tip, rogue]); // roll back the rogue ref

  // P9: one audit trail — every commit on the GitHub branch (beyond main) has a provenance record.
  await git(repo, ["fetch", "-q", REMOTE, `+refs/heads/${dst}:refs/forge/check`]);
  const onGithub = (await git(repo, ["rev-list", "refs/forge/check", "--not", "refs/heads/main"])).out.split("\n").filter(Boolean);
  const ev = events();
  const known = new Map(); for (const e of ev) for (const c of e.commits ?? []) known.set(c, `${e.category}/${e.event}`);
  const sources = {}; for (const c of onGithub) { const k = known.get(c) ?? "UNKNOWN"; sources[k] = (sources[k] ?? 0) + 1; }
  const runEvents = ev.filter((e) => e.runId === RUN).length;
  check("P9 every commit on GitHub traces to gate/forge/import provenance", !sources.UNKNOWN && onGithub.length > 0, { onGithub: onGithub.length, sources, runEvents });

  server.kill();
  writeFileSync(join(HERE, "results.json"), JSON.stringify({ run: RUN, repo: GH_REPO, durationMs: Date.now() - t0, results }, null, 2));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
main().catch((e) => { console.error(e); server?.kill(); process.exitCode = 1; });
