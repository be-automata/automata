// Spike 013 orchestrator: drive one persistent per-scope agent box through sleep/wake modes and measure.
// Run (needs Docker; outside the Claude sandbox): node lifecycle.mjs
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = import.meta.dirname;
const NAME = "spike013-agent";
const VOL = "spike013-vol";
const IMAGE = "node:24";
const N = Number(process.env.N ?? 10);
const events = [];
const log = (cat, data) => { const e = { at: new Date().toISOString(), cat, ...data }; events.push(e); console.log(cat.padEnd(10), JSON.stringify(data)); };
const docker = async (...args) => (await run("docker", args, { maxBuffer: 1 << 24 })).stdout.trim();
const ms = async (fn) => { const t = performance.now(); const r = await fn(); return [Math.round(performance.now() - t), r]; };
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, p50: q(0.5), p90: q(0.9), max: s.at(-1) }; };
const turn = async (...args) => JSON.parse(await docker("exec", NAME, "node", "/app/turn.mjs", ...args));

async function runBox() {
  await docker("run", "-d", "--name", NAME, "--stop-timeout", "5", "-v", `${VOL}:/home/agent`, "-v", `${join(HERE, "app")}:/app:ro`, IMAGE, "node", "/app/agent.mjs");
}
/** Healthy = the agent wrote a heartbeat from the CURRENT boot. */
async function waitHealthy(prevBoot) {
  for (let i = 0; i < 400; i++) {
    try {
      const s = await turn("state");
      if (s.bootId && s.bootId !== prevBoot) return s;
    } catch { /* box still starting: exec fails until the container is up */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("box never became healthy");
}
// Single-flight wake: concurrent triggers (cron + webhook at once) must start the box ONCE.
let waking = null;
async function wake() {
  const state = await docker("inspect", "-f", "{{.State.Status}}", NAME);
  if (state === "running") return { woke: false };
  if (state === "paused") { await docker("unpause", NAME); return { woke: true, mode: "unpause" }; }
  if (!waking) {
    waking = (async () => {
      await docker("start", NAME);
      await waitHealthy(undefined);
      return { woke: true, mode: "start" };
    })().finally(() => { waking = null; });
  }
  return waking;
}
async function deliver(event, ...args) {
  const [wakeMs, w] = await ms(wake);
  const [turnMs, out] = await ms(() => turn(...args));
  return { event, wakeMs, turnMs, totalMs: wakeMs + turnMs, ...w, out };
}

async function cleanup() {
  await docker("rm", "-f", NAME).catch(() => {});
  await docker("volume", "rm", "-f", VOL).catch(() => {});
}

const results = {};
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", { name, detail }); };

try {
  await cleanup();
  // 1. Provision (cold: create container + first boot)
  const [createMs] = await ms(async () => { await runBox(); return waitHealthy(); });
  results.provisionMs = createMs;
  log("provision", { createMs });

  // 2. Durable state written by turns
  await turn("remember", "customer prefers weekly digest on Mondays");
  await turn("remember", "staging DB is read-only for agents");
  await turn("artifact", "report.md", "# weekly report v1");
  const before = await turn("state");
  log("state", before);

  // 3. Warm turns (box running)
  const warm = [];
  for (let i = 0; i < N; i++) warm.push((await ms(() => turn("recall")))[0]);
  results.warmTurn = stats(warm);

  // 4. Sleep = stop; wake = start on a cron/webhook event
  const stopT = [], wakeT = [];
  let last = before;
  for (let i = 0; i < N; i++) {
    const [stopMs] = await ms(() => docker("stop", NAME));
    stopT.push(stopMs);
    const d = await deliver(i % 2 ? "webhook" : "cron", "recall");
    wakeT.push(d.totalMs);
    last = d.out;
  }
  results.stop = stats(stopT);
  results.stopStartWakeToTurn = stats(wakeT);
  check("stop/start: memory, session, artifacts survive", JSON.stringify(last.memory) === JSON.stringify(before.memory) && last.session === before.session && last.artifacts.includes("report.md"), { memory: last.memory.length, session: last.session, artifacts: last.artifacts });
  check("stop/start: in-process working set is lost (new boot)", last.bootId !== before.bootId && last.workingSet < before.workingSet + 50, { before: before.workingSet, after: last.workingSet });
  check("stop/start: container rootfs survives (same container)", last.rootfsScratch !== null, { rootfsScratch: last.rootfsScratch });

  // 5. Pause/unpause (cgroup freezer): process memory kept, CPU zero, RAM still billed
  const pre = await turn("state");
  const pauseT = [];
  let afterPause = pre;
  for (let i = 0; i < N; i++) {
    await docker("pause", NAME);
    await new Promise((r) => setTimeout(r, 300));
    const d = await deliver("webhook", "state");
    pauseT.push(d.totalMs);
    afterPause = d.out;
  }
  results.pauseUnpauseWakeToTurn = stats(pauseT);
  check("pause/unpause: SAME process, working set preserved", afterPause.bootId === pre.bootId && afterPause.workingSet >= pre.workingSet, { bootBefore: pre.bootId, bootAfter: afterPause.bootId, ws: [pre.workingSet, afterPause.workingSet] });

  // 6. Recreate (template revision update): new container, same volume
  const recT = [];
  let afterRec = afterPause;
  for (let i = 0; i < Math.min(N, 5); i++) {
    const [t, s] = await ms(async () => { await docker("rm", "-f", NAME); await runBox(); return waitHealthy(); });
    recT.push(t);
    afterRec = s;
  }
  results.recreateToHealthy = stats(recT);
  check("recreate: volume state survives an image/template update", afterRec.memory.length === 2 && afterRec.session === before.session, { memory: afterRec.memory.length, session: afterRec.session });
  check("recreate: rootfs scratch from old container is gone (only $HOME is durable)", afterRec.rootfsScratch?.includes(afterRec.bootId) === true, { rootfsScratch: afterRec.rootfsScratch });

  // 7. Concurrent triggers while asleep: wake exactly once
  await docker("stop", NAME);
  const bootsBefore = (await (async () => { await docker("start", NAME); const s = await waitHealthy(); await docker("stop", NAME); return s.boots; })());
  const both = await Promise.all([deliver("cron", "state"), deliver("webhook", "state")]);
  const bootsAfter = (await turn("state")).boots;
  check("concurrent cron+webhook while asleep: single start", bootsAfter === bootsBefore + 1, { bootsBefore, bootsAfter, modes: both.map((b) => b.mode ?? "none") });

  // 8. CRIU checkpoint (would keep memory without holding RAM)
  try {
    await docker("checkpoint", "create", NAME, "cp1");
    results.checkpoint = "supported";
  } catch (e) {
    results.checkpoint = `unsupported: ${String(e.stderr ?? e.message).split("\n")[0].slice(0, 160)}`;
  }
  log("checkpoint", { result: results.checkpoint });
} finally {
  await cleanup();
  results.checks = checks;
  writeFileSync(join(HERE, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(HERE, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  console.log("\n" + JSON.stringify({ ...results, checks: `${checks.filter((c) => c.ok).length}/${checks.length}` }, null, 2));
}
