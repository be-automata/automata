// Spike 018: real Claude Code harness wake cost, per sleep mode and session size. No credentials: the
// Messages API is a local stub inside the box that replies instantly, so every millisecond measured is harness + box.
// Run (Docker, outside the sandbox): node wake.mjs [--n 10] [--label orbstack]   → exit 0/1
import { execFile, spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = import.meta.dirname;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg("--n", 10));
const LABEL = arg("--label", "local");
const BOX = "spike018-box";
const VOL = "spike018-vol";
const IMAGE = "spike018-claude";
const EVENTS = join(HERE, `events.${LABEL}.jsonl`);
const docker = async (...a) => (await run("docker", a, { maxBuffer: 1 << 26 })).stdout.trim();
const sh = (cmd) => docker("exec", BOX, "sh", "-c", cmd);
const log = (cat, data) => { appendFileSync(EVENTS, JSON.stringify({ at: new Date().toISOString(), cat, ...data }) + "\n"); console.log(cat.padEnd(10), JSON.stringify(data)); };
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, p50: q(0.5), p90: q(0.9), max: s.at(-1) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stubLog = async () => (await sh("cat $HOME/stub.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const lastMain = async () => (await stubLog()).filter((e) => e.messages > 0).at(-1);

async function claudeTurn(prompt, sid) {
  const t = performance.now();
  const out = await docker("exec", BOX, "claude", "-p", prompt, ...(sid ? ["--resume", sid] : []), "--output-format", "json");
  return { ms: Math.round(performance.now() - t), res: JSON.parse(out) };
}
async function waitHealthy(prevBoot) {
  for (let i = 0; i < 400; i++) {
    try { const hb = JSON.parse(await sh("cat $HOME/heartbeat.json")); if (hb.bootId !== prevBoot) return hb; } catch { /* still booting */ }
    await sleep(20);
  }
  throw new Error("box never healthy");
}
const boot = async () => JSON.parse(await sh("cat $HOME/heartbeat.json")).bootId;

const results = { label: LABEL, n: N, sizes: {} };
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", { name, detail }); };

try {
  await docker("rm", "-f", BOX).catch(() => {});
  await docker("volume", "rm", "-f", VOL).catch(() => {});
  await docker("run", "-d", "--init", "--name", BOX, "-v", `${VOL}:/home/agent`, IMAGE);
  await waitHealthy(undefined);
  const seed = await claudeTurn("Remember this code for later: ZEBRA-7731");
  const sid = seed.res.session_id;
  log("seed", { sid, ms: seed.ms });

  for (const size of ["small", "large"]) {
    if (size === "large") { // grow the SAME session: 20 turns × 20 KB replies ≈ 400 KB of history
      await sh("echo 20000 > $HOME/pad");
      for (let i = 0; i < 20; i++) await claudeTurn(`filler turn ${i}`, sid);
      await sh("echo 0 > $HOME/pad");
    }
    const sessBytes = Number(await sh(`wc -c < $(find $HOME/.claude/projects -name '${sid}.jsonl' | head -1)`));
    const r = { sessionBytes: sessBytes };

    // C — box running, cold CLI process per turn (how the worker runs `claude -p` today)
    const cold = [];
    for (let i = 0; i < N; i++) cold.push((await claudeTurn("What code did I ask you to remember?", sid)).ms);
    r.runningColdProcess = stats(cold);
    const reqC = await lastMain();
    r.requestBytes = reqC.bytes;
    r.requestMessages = reqC.messages;
    check(`${size}: resumed request carries the turn-1 fact`, reqC.hasFact === true, { bytes: reqC.bytes, messages: reqC.messages });

    // A — stop → event → start → healthy → cold CLI resume
    const stopStart = [], startOnly = [];
    for (let i = 0; i < N; i++) {
      const prev = await boot();
      await docker("stop", BOX);
      const t = performance.now();
      await docker("start", BOX);
      await waitHealthy(prev);
      const tH = performance.now();
      await claudeTurn("What code did I ask you to remember?", sid);
      stopStart.push(Math.round(performance.now() - t));
      startOnly.push(Math.round(tH - t));
    }
    r.stopStartToTurn = stats(stopStart);
    r.stopStartToHealthy = stats(startOnly);
    check(`${size}: after stop/start the resumed request still carries the fact`, (await lastMain()).hasFact === true, null);

    // B — live harness process (stream-json stdin) frozen by pause; event = unpause + one stdin line
    const live = spawn("docker", ["exec", "-i", BOX, "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--resume", sid]);
    let buf = "";
    const waiters = [];
    live.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { if (JSON.parse(line).type === "result") waiters.shift()?.(); } catch { /* partial */ } } });
    const send = (text) => new Promise((res) => { waiters.push(res); live.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n"); });
    await send("warm up: what code did I ask you to remember?");
    const pauseT = [], rss = [];
    for (let i = 0; i < N; i++) {
      await docker("pause", BOX);
      rss.push(await docker("stats", "--no-stream", "--format", "{{.MemUsage}}", BOX));
      await sleep(300);
      const t = performance.now();
      await docker("unpause", BOX);
      await send("What code did I ask you to remember?");
      pauseT.push(Math.round(performance.now() - t));
    }
    live.stdin.end();
    await new Promise((r2) => live.on("close", r2));
    r.pauseUnpauseLiveProcess = stats(pauseT);
    r.pausedMemUsage = rss.at(-1);
    check(`${size}: live process keeps context across pause (fact in request)`, (await lastMain()).hasFact === true, null);
    results.sizes[size] = r;
    log("size", { size, ...r });
  }
  const s = results.sizes.small, l = results.sizes.large;
  check("pause (live process) beats stop/start at both sizes", s.pauseUnpauseLiveProcess.p50 < s.stopStartToTurn.p50 && l.pauseUnpauseLiveProcess.p50 < l.stopStartToTurn.p50, null);
  check("harness startup dominates the box lifecycle on stop/start", s.stopStartToTurn.p50 - s.stopStartToHealthy.p50 > s.stopStartToHealthy.p50, { turn: s.stopStartToTurn.p50, healthy: s.stopStartToHealthy.p50 });
} finally {
  await docker("rm", "-f", BOX).catch(() => {});
  await docker("volume", "rm", "-f", VOL).catch(() => {});
  results.checks = checks;
  writeFileSync(join(HERE, `results.${LABEL}.json`), JSON.stringify(results, null, 2));
  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} passed`);
  process.exitCode = checks.length > 0 && checks.every((c) => c.ok) ? 0 : 1;
}
