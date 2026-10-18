// Spike 003 scenarios — node scenarios.mjs (needs ../002-forge-substrate/work/seed.git)
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { mint } from "./token.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work");
const SEED = join(HERE, "..", "002-forge-substrate", "work", "seed.git");
const AUDIT = join(HERE, "events.jsonl");
const PORT = 3303;
const URL_ = `http://localhost:${PORT}/bench.git`;
const results = [];
const check = (name, ok, detail = {}) => { results.push({ name, ok, ...detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}`, JSON.stringify(detail).slice(0, 220)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = ["-c", "commit.gpgsign=false", "-c", "user.name=agent", "-c", "user.email=agent@forge.local", "-c", "credential.helper="];

function authEnv(token) {
  // Credential travels in env-scoped git config, never argv (ps-visible).
  if (!token) return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`agent:${token}`).toString("base64")}` };
}
async function git(cwd, args, token) {
  try {
    const { stdout, stderr } = await run("git", [...BASE, ...args], { cwd, env: authEnv(token), maxBuffer: 1 << 26 });
    return { ok: true, out: stdout + stderr };
  } catch (e) { return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? "") }; }
}

let server;
async function startServer(scanner) {
  if (server) { server.kill(); await sleep(300); }
  server = spawn("node", [join(HERE, "gate-server.mjs")], { env: { ...process.env, FORGE_ROOT: WORK, PORT: String(PORT), GATE_AUDIT: AUDIT, GATE_SCANNER: scanner }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => server.stdout.once("data", r));
}

async function freshClone(name) {
  const dir = join(WORK, "clients", name);
  rmSync(dir, { recursive: true, force: true });
  await git(join(WORK, "clients"), ["clone", "-q", URL_, dir]);
  return dir;
}
async function commit(dir, files, msg) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    if (text === null) rmSync(join(dir, f)); else writeFileSync(join(dir, f), text);
  }
  await git(dir, ["add", "-A"]);
  return git(dir, ["commit", "-qm", msg]);
}
const reason = (out) => (out.match(/remote:\s+- (.*)/g) ?? out.match(/AGENT FORGE: [^\n]*/g) ?? [out.trim().split("\n").pop()]).map((s) => s.replace(/^remote:\s+- /, "")).slice(0, 3);

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(join(WORK, "clients"), { recursive: true });
  writeFileSync(AUDIT, "");
  await run("git", ["clone", "-q", "--bare", SEED, join(WORK, "bench.git")]);
  const hooks = join(WORK, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-receive"), `#!/bin/sh\nexec node "${join(HERE, "pre-receive.mjs")}"\n`);
  chmodSync(join(hooks, "pre-receive"), 0o755);
  await run("git", ["-C", join(WORK, "bench.git"), "config", "core.hooksPath", hooks]);
  await startServer("regex");

  const scope = { repo: "bench.git", refPrefix: "refs/heads/agent/run-1/", paths: ["agent-work/**", "src/**", "agents/**"] };
  const tok = mint({ runId: "run-1", ...scope });
  const push = (dir, ref, token = tok, extra = []) => git(dir, ["push", ...extra, "origin", `HEAD:${ref}`], token);
  const R = "refs/heads/agent/run-1/task";

  let d = await freshClone("g1");
  await commit(d, { "agent-work/a.txt": "hello\n" }, "ok change");
  let p = await push(d, R);
  check("G1 in-scope push accepted", p.ok, { msg: (p.out.match(/AGENT FORGE: [^\n]*/) ?? [""])[0] });

  d = await freshClone("g2");
  await commit(d, { "agent-work/cfg.txt": `AWS_ACCESS_KEY_ID=AKIA${randomBytes(8).toString("hex").toUpperCase()}\n` }, "leak");
  p = await push(d, R + "-g2");
  check("G2 secret (AWS key) rejected", !p.ok && /secret/.test(p.out), { reasons: reason(p.out) });

  d = await freshClone("g3");
  await commit(d, { ".github/workflows/pwn.yml": "on: push\n" }, "ci tamper");
  p = await push(d, R + "-g3");
  check("G3 out-of-scope path rejected", !p.ok && /outside allowed paths/.test(p.out), { reasons: reason(p.out) });

  d = await freshClone("g4");
  await commit(d, { "agent-work/b.txt": "x\n" }, "to main");
  p = await push(d, "refs/heads/main");
  check("G4 push to main (outside ref scope) rejected", !p.ok && /ref scope/.test(p.out), { reasons: reason(p.out) });

  d = await freshClone("g5");
  await commit(d, { "agents/bot/agent.yaml": "name: bot\nversion: latest\n" }, "bad manifest");
  p = await push(d, R + "-g5");
  check("G5 invalid OpenGAP manifest rejected (no description, bad semver, no SOUL.md)", !p.ok && /semver/.test(p.out) && /SOUL\.md/.test(p.out) && /description/.test(p.out), { reasons: reason(p.out) });

  d = await freshClone("g6");
  await commit(d, { "agents/bot/agent.yaml": "name: bot\nversion: 1.2.0\ndescription: helper\n", "agents/bot/SOUL.md": "# Bot\n" }, "good manifest");
  p = await push(d, R + "-g6");
  check("G6 valid OpenGAP manifest accepted", p.ok);

  d = await freshClone("g7");
  await commit(d, { "agent-work/c.txt": "x\n" }, "late");
  p = await push(d, R + "-g7", mint({ runId: "run-1", ...scope, ttlSec: -5 }));
  check("G7 expired token refused at the edge", !p.ok && /expired/.test(p.out), { reasons: reason(p.out) });

  const tok8 = mint({ runId: "run-8", ...scope, refPrefix: "refs/heads/agent/run-8/" });
  await fetch(`http://localhost:${PORT}/api/revoke`, { method: "POST", body: JSON.stringify({ token: tok8, runId: "run-8" }) });
  d = await freshClone("g8");
  await commit(d, { "agent-work/d.txt": "x\n" }, "replay");
  p = await push(d, "refs/heads/agent/run-8/x", tok8);
  check("G8 replayed token after run end refused", !p.ok && /revoked/.test(p.out), { reasons: reason(p.out) });

  p = await push(d, R + "-g9", mint({ runId: "run-1", ...scope, repo: "other.git" }));
  check("G9 token for another repo refused", !p.ok && /not bench\.git/.test(p.out), { reasons: reason(p.out) });

  const [body, sig] = tok.split(".");
  const widened = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), paths: ["**"], refPrefix: "refs/heads/" })).toString("base64url");
  p = await push(d, "refs/heads/main", `${widened}.${sig}`);
  check("G10 tampered claims (widened scope) refused", !p.ok && /bad signature/.test(p.out), { reasons: reason(p.out) });

  d = await freshClone("g11");
  await git(d, ["fetch", "-q", "origin", R]);
  await git(d, ["checkout", "-q", "-B", "rw", "FETCH_HEAD"]);
  await git(d, ["reset", "-q", "--hard", "HEAD~1"]);
  await commit(d, { "agent-work/rewrite.txt": "x\n" }, "rewrite");
  p = await push(d, R, tok, ["--force"]);
  check("G11 force-push (history rewrite) refused", !p.ok && /non-fast-forward/.test(p.out), { reasons: reason(p.out) });

  d = await freshClone("g12");
  await commit(d, { "agent-work/e.txt": "x\n" }, "anon");
  p = await push(d, R + "-g12", null);
  check("G12 anonymous push refused", !p.ok, { tail: p.out.trim().split("\n").pop().slice(0, 100) });

  // G13: secret added then removed inside the same push — net diff is clean, history is not.
  d = await freshClone("g13");
  await commit(d, { "agent-work/k.txt": `token=ghp_${randomBytes(20).toString("hex")}\n` }, "oops");
  await commit(d, { "agent-work/k.txt": "token=<redacted>\n" }, "remove");
  p = await push(d, R + "-g13");
  check("G13 secret added+removed within one push is still rejected", !p.ok && /secret/.test(p.out), { reasons: reason(p.out) });

  // Latency: 20 accepted pushes per scanner.
  const lat = {};
  for (const scanner of ["regex", "gitleaks"]) {
    await startServer(scanner);
    for (let i = 0; i < 20; i++) {
      d = await freshClone(`lat-${scanner}-${i}`);
      await commit(d, { [`src/f${i}.ts`]: `export const v${i} = ${i};\n`.repeat(50) }, `lat ${i}`);
      await push(d, `${R}-lat-${scanner}-${i}`);
    }
    const rows = readFileSync(AUDIT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.category === "gate" && e.scanner === scanner && e.refs[0]?.includes("-lat-"));
    const ms = rows.map((r) => r.gateMs).sort((a, b) => a - b);
    lat[scanner] = { n: ms.length, p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.floor(ms.length * 0.95)], accepted: rows.filter((r) => r.event === "accepted").length };
  }
  check("G14 gate latency p95 < 200 ms (regex scanner)", lat.regex.p95 < 200 && lat.regex.accepted === 20, lat.regex);
  check("G15 gate latency with gitleaks recorded", lat.gitleaks.accepted === 20, lat.gitleaks);

  server.kill();
  writeFileSync(join(HERE, "results.json"), JSON.stringify({ results, latency: lat }, null, 2));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
}
main().catch((e) => { console.error(e); server?.kill(); process.exitCode = 1; });
