// Spike 016: a days-lived agent box pushing with minutes-lived per-run tokens (spike 003), minted PER WAKE.
// Run (needs Docker + local ports, so outside the Claude sandbox; needs ../002-forge-substrate/work/seed.git):
//   node run.mjs
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";


import { mint } from "../003-push-time-policy-gate/token.mjs";

const HERE = import.meta.dirname;
const WORK = join(HERE, "work");
const SEED = join(HERE, "..", "002-forge-substrate", "work", "seed.git");
const GATE_PORT = 3317; // spike 003's gate (token verify + pre-receive), unchanged
const EDGE_PORT = 3316; // spike 016's wake-binding edge in front of it
const BOX = "spike016-agent", VOL = "spike016-vol", BOX_ID = "box-7";
const SCOPE = { repo: "bench.git", refPrefix: `refs/heads/agent/${BOX_ID}/`, paths: ["agent-work/**"] };
const run = promisify(execFile);
const docker = async (...a) => (await run("docker", a, { maxBuffer: 1 << 24 })).stdout.trim();
const dockerIn = (input, ...a) => execFileSync("docker", a, { input, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
const log = (cat, data) => events.push({ at: new Date().toISOString(), cat, ...data });
const checks = [];
const check = (name, ok, detail = {}) => { checks.push({ name, ok, detail }); log("check", { name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail).slice(0, 220)}`); };
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, p50: q(0.5), p90: q(0.9), max: s.at(-1) }; };

// ---- control plane: wake registry + broker ----------------------------------------
/** The ONE wake a box is allowed to push from. A token minted for any other wake is dead on arrival. */
const currentWake = new Map();
const issued = new Map(); // box -> token of its current wake (for revoke-on-sleep)
let wakeSeq = 0;
async function revoke(token, runId) {
  await fetch(`http://127.0.0.1:${GATE_PORT}/api/revoke`, { method: "POST", body: JSON.stringify({ token, runId }) });
}
/** Wake hook: new wake id, mint a token bound to it, deliver it to the box's tmpfs over exec stdin. */
async function onWake(boxId, ttlSec) {
  const prev = issued.get(boxId);
  const wakeId = `w${++wakeSeq}`;
  currentWake.set(boxId, wakeId);
  const t0 = performance.now();
  const token = mint({ runId: `${boxId}:${wakeId}`, ...SCOPE, ttlSec });
  const mintMs = performance.now() - t0;
  dockerIn(token, "exec", "-i", BOX, "sh", "-c", "umask 077; cat > /run/secrets/FORGE_TOKEN");
  const totalMs = Math.round(performance.now() - t0);
  issued.set(boxId, token);
  if (prev) await revoke(prev, `${boxId}:superseded`); // belt and braces; the wake binding already kills it
  log("wake", { boxId, wakeId, ttlSec, mintMs: +mintMs.toFixed(2), deliverMs: totalMs });
  return { token, wakeId, totalMs };
}
/** Sleep hook: revoke the current wake's token and clear the binding. */
async function onSleep(boxId) {
  const tok = issued.get(boxId);
  if (tok) await revoke(tok, `${boxId}:${currentWake.get(boxId)}`);
  currentWake.delete(boxId);
  log("sleep", { boxId });
}

// ---- wake-binding edge (in front of spike 003's gate) ----------------------------
function startEdge() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const isPush = url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack");
      if (isPush) {
        const h = req.headers.authorization ?? "";
        const tok = h.startsWith("Basic ") ? Buffer.from(h.slice(6), "base64").toString().split(":")[1] : null;
        if (tok) {
          // Unverified parse is fine here: the gate behind us verifies the HMAC; a forged runId fails there.
          let runId = "";
          try { runId = JSON.parse(Buffer.from(tok.split(".")[0], "base64url").toString()).runId ?? ""; } catch { /* malformed: gate refuses */ }
          const [boxId, wakeId] = runId.split(":");
          const cur = currentWake.get(boxId);
          if (cur !== wakeId) {
            const reason = cur ? `token bound to ${boxId} wake ${wakeId}; box is on wake ${cur}` : `box ${boxId} is asleep; no push credential is live`;
            log("edge", { event: "refused", reason });
            res.writeHead(403, { "content-type": "text/plain" });
            return res.end(`AGENT FORGE: ${reason}\n`);
          }
        }
      }
      const up = request({ host: "127.0.0.1", port: GATE_PORT, path: req.url, method: req.method, headers: req.headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
      up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
      req.pipe(up);
    });
    srv.listen(EDGE_PORT, "0.0.0.0", () => resolve(srv));
  });
}

const turn = async (...a) => JSON.parse(await docker("exec", BOX, "node", "/app/turn.mjs", ...a));
let n = 0;
const push = () => turn("push", String(++n), BOX_ID);
async function waitHealthy(prev) {
  for (let i = 0; i < 400; i++) {
    try { const s = await turn("state"); if (s.heartbeat.bootId !== prev) return s; } catch { /* starting */ }
    await sleep(25);
  }
  throw new Error("box never healthy");
}
async function cleanup() {
  await docker("rm", "-f", BOX).catch(() => {});
  await docker("volume", "rm", "-f", VOL).catch(() => {});
}

let gate, edge;
const results = {};
try {
  await cleanup();
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(HERE, "events.jsonl"), "");
  await run("git", ["clone", "-q", "--bare", SEED, join(WORK, "bench.git")]);
  const hooks = join(WORK, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-receive"), `#!/bin/sh\nexec node "${join(HERE, "..", "003-push-time-policy-gate", "pre-receive.mjs")}"\n`);
  chmodSync(join(hooks, "pre-receive"), 0o755);
  await run("git", ["-C", join(WORK, "bench.git"), "config", "core.hooksPath", hooks]);
  gate = spawn("node", [join(HERE, "..", "003-push-time-policy-gate", "gate-server.mjs")], { env: { ...process.env, FORGE_ROOT: WORK, PORT: String(GATE_PORT), GATE_AUDIT: join(WORK, "gate-audit.jsonl") }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => gate.stdout.once("data", r));
  edge = await startEdge();

  // Provision: a long-lived box; secrets tmpfs (spike 015); repo clone lives in $HOME (durable)
  await docker("run", "-d", "--init", "--name", BOX, "-v", `${VOL}:/home/agent`, "-v", `${join(HERE, "app")}:/app:ro`,
    "--mount", "type=tmpfs,destination=/run/secrets,tmpfs-mode=0700", "node:24", "node", "/app/agent.mjs");
  let st = await waitHealthy();
  await docker("exec", BOX, "git", "clone", "-q", `http://host.docker.internal:${EDGE_PORT}/bench.git`, "/home/agent/repo");

  // 1. No wake hook yet -> no credential in the box -> push refused
  let p = await push();
  check("before any wake hook: the box holds no credential; push is refused (401)", !p.ok && /401|Authentication|could not read Username|terminal prompts disabled/i.test(p.out), { out: p.out.slice(0, 120) });

  // 2. Wake 1: fresh token -> push accepted; measure
  const w1 = await onWake(BOX_ID, 3);
  p = await push();
  check("wake 1: fresh wake-bound token pushes", p.ok, { deliverMs: w1.totalMs, pushMs: p.ms });

  // 3. Pause longer than the TTL: tmpfs (and the stale token) survive pause; the push must be refused at the edge
  await docker("pause", BOX);
  await sleep(4500);
  await docker("unpause", BOX);
  p = await push(); // the orchestrator "forgot" the wake hook: the stale token is still in tmpfs
  check("pause > TTL, no wake hook: stale token (still in tmpfs) refused - expired", !p.ok && /expired/.test(p.out), { out: p.out.slice(0, 160) });
  const w2 = await onWake(BOX_ID, 60);
  p = await push();
  check("unpause wake hook mints a fresh token -> push accepted", p.ok, { deliverMs: w2.totalMs, pushMs: p.ms });

  // 4. Exfiltrated token from wake 2 used after wake 3 (not expired, revoke 'missed'): wake binding refuses it
  const stolen = w2.token;
  issued.delete(BOX_ID); // simulate the orchestrator crashing before it could revoke the previous token
  await onWake(BOX_ID, 60);
  const direct = await run("git", ["-c", "credential.helper=", "-C", join(WORK, "bench.git"), "push", "--dry-run", `http://127.0.0.1:${EDGE_PORT}/bench.git`, "main"], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`agent:${stolen}`).toString("base64")}` } }).then(() => ({ ok: true, out: "" }), (e) => ({ ok: false, out: `${e.stdout}${e.stderr}` }));
  check("superseded wake: a still-valid token from wake 2 is refused once wake 3 exists (no revoke needed)", !direct.ok && /bound to box-7 wake w2; box is on wake w3/.test(direct.out), { out: direct.out.match(/AGENT FORGE: [^\n]*/)?.[0] });

  // 5. Sleep (stop): revoke-on-sleep; a copy of the live token is dead even though its TTL (60 s) has not passed
  const live = issued.get(BOX_ID);
  await onSleep(BOX_ID);
  await docker("stop", BOX);
  const [, liveWake] = JSON.parse(Buffer.from(live.split(".")[0], "base64url").toString()).runId.split(":");
  currentWake.set(BOX_ID, liveWake);
  const afterSleep = await run("git", ["-c", "credential.helper=", "-C", join(WORK, "bench.git"), "push", "--dry-run", `http://127.0.0.1:${EDGE_PORT}/bench.git`, "main"], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`agent:${live}`).toString("base64")}` } }).then(() => ({ ok: true, out: "" }), (e) => ({ ok: false, out: `${e.stdout}${e.stderr}` }));
  currentWake.delete(BOX_ID);
  check("revoke on sleep: the live token copied before stop is refused by the gate (revoked, TTL not reached)", !afterSleep.ok && /revoked/.test(afterSleep.out), { out: afterSleep.out.match(/AGENT FORGE: [^\n]*/)?.[0] });

  // 6. Start: tmpfs is empty (spike 015) -> no credential until the wake hook runs
  await docker("start", BOX);
  st = await waitHealthy(st.heartbeat.bootId);
  check("stop/start clears the token with the tmpfs", st.hasToken === false, st);
  await onWake(BOX_ID, 60);
  p = await push();
  check("start wake hook -> push accepted", p.ok, { pushMs: p.ms });

  // 7. Latency: N wakes, each minting + delivering a token and pushing once
  const deliver = [], pushes = [], total = [];
  for (let i = 0; i < 10; i++) {
    const w = await onWake(BOX_ID, 600);
    const r = await push();
    if (!r.ok) throw new Error(`latency push ${i} failed: ${r.out}`);
    deliver.push(w.totalMs); pushes.push(r.ms); total.push(w.totalMs + r.ms);
  }
  results.mintDeliverMs = stats(deliver); results.pushMs = stats(pushes); results.wakeToPushedMs = stats(total);
  check("latency: mint + deliver + push measured over 10 wakes", true, results.wakeToPushedMs);

  // 8. Token never lands in $HOME (volume), the repo's git config, PID 1 env or `docker inspect`
  const tokens = [...issued.values(), stolen, live].filter(Boolean);
  const pattern = tokens.map((t) => t.split(".")[1]).join("\n");
  writeFileSync(join(WORK, "needles"), pattern + "\nAuthorization\nextraHeader\n");
  // Positive control: a canary dir holding one token must be the ONLY hit, proving the detector can see a leak.
  mkdirSync(join(WORK, "canary"));
  writeFileSync(join(WORK, "canary", "tok"), tokens[0]);
  const hits = (await run("docker", ["run", "--rm", "-v", `${VOL}:/v:ro`, "-v", `${join(WORK, "needles")}:/needles:ro`, "-v", `${join(WORK, "canary")}:/canary:ro`, "alpine:3", "sh", "-c", "grep -rlF -f /needles /v /canary || true"])).stdout.trim();
  check("detector positive control: the canary token file is found", hits.split("\n").includes("/canary/tok"), { hits });
  const volHits = hits.split("\n").filter((h) => h && !h.startsWith("/canary")).join(",");
  const inspect = await docker("inspect", BOX);
  const pid1 = await docker("exec", BOX, "sh", "-c", "tr '\\0' '\\n' < /proc/1/environ");
  check("token never written to $HOME (incl. repo .git/config), PID 1 env or docker inspect",
    volHits === "" && !tokens.some((t) => inspect.includes(t) || pid1.includes(t)), { volHits });
  results.gateAudit = execFileSync("sh", ["-c", `cat "${join(WORK, "gate-audit.jsonl")}" | wc -l`], { encoding: "utf8" }).trim();
} catch (e) {
  check("runner crashed", false, { error: e instanceof Error ? e.message : String(e) });
} finally {
  await cleanup();
  edge?.close();
  gate?.kill();
  results.checks = checks;
  writeFileSync(join(HERE, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(HERE, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  rmSync(WORK, { recursive: true, force: true });
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} passed`, JSON.stringify({ ...results, checks: undefined }));
  process.exit(passed === checks.length ? 0 : 1);
}
