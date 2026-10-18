// Long-lived agent process (PID 1 in the box). Durable state lives under $HOME (a volume);
// in-process state (the "working set") is deliberately NOT persisted, to show what sleep loses.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const HOME = process.env.AGENT_HOME ?? "/home/agent";
mkdirSync(`${HOME}/artifacts`, { recursive: true });
const bootId = Math.random().toString(36).slice(2, 8);
const boots = existsSync(`${HOME}/boots.log`) ? readFileSync(`${HOME}/boots.log`, "utf8").trim().split("\n").length : 0;
appendFileSync(`${HOME}/boots.log`, `${new Date().toISOString()} ${bootId}\n`);
let workingSet = 0; // in-memory only
if (!existsSync(`${HOME}/session.json`)) writeFileSync(`${HOME}/session.json`, JSON.stringify({ sessionId: `sess-${bootId}`, createdAt: new Date().toISOString() }));
writeFileSync("/tmp/rootfs-scratch", `written by boot ${bootId}\n`); // rootfs, not the volume
setInterval(() => {
  workingSet++;
  writeFileSync(`${HOME}/heartbeat`, JSON.stringify({ bootId, at: Date.now(), workingSet }));
}, 100);
writeFileSync(`${HOME}/heartbeat`, JSON.stringify({ bootId, at: Date.now(), workingSet, boots: boots + 1 }));
process.on("SIGTERM", () => { appendFileSync(`${HOME}/boots.log`, `${new Date().toISOString()} ${bootId} SIGTERM workingSet=${workingSet}\n`); process.exit(0); });
