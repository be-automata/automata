// One turn, delivered by the orchestrator via exec (no inbound port needed).
// remember <fact> | recall | artifact <name> <text> | state
import { appendFileSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
const HOME = process.env.AGENT_HOME ?? "/home/agent";
const [cmd, a, ...rest] = process.argv.slice(2);
const mem = () => (existsSync(`${HOME}/memory.jsonl`) ? readFileSync(`${HOME}/memory.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
if (cmd === "remember") appendFileSync(`${HOME}/memory.jsonl`, JSON.stringify({ id: mem().length + 1, text: a, at: new Date().toISOString() }) + "\n");
if (cmd === "artifact") writeFileSync(`${HOME}/artifacts/${a}`, rest.join(" "));
const hb = existsSync(`${HOME}/heartbeat`) ? JSON.parse(readFileSync(`${HOME}/heartbeat`, "utf8")) : null;
console.log(JSON.stringify({
  memory: mem().map((m) => m.text),
  session: JSON.parse(readFileSync(`${HOME}/session.json`, "utf8")).sessionId,
  artifacts: readdirSync(`${HOME}/artifacts`),
  bootId: hb?.bootId, workingSet: hb?.workingSet,
  rootfsScratch: existsSync("/tmp/rootfs-scratch") ? readFileSync("/tmp/rootfs-scratch", "utf8").trim() : null,
  boots: readFileSync(`${HOME}/boots.log`, "utf8").trim().split("\n").filter((l) => !l.includes("SIGTERM")).length,
}));
