// Long-lived agent (spike 015). Deliberately has NO SIGTERM handler, like most harnesses:
// only the template's init: true (docker --init) makes `docker stop` fast and graceful.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const HOME = process.env.AGENT_HOME ?? "/home/agent";
mkdirSync(`${HOME}/artifacts`, { recursive: true });
const bootId = Math.random().toString(36).slice(2, 8);
appendFileSync(`${HOME}/boots.log`, `${new Date().toISOString()} ${bootId}\n`);
const boots = readFileSync(`${HOME}/boots.log`, "utf8").trim().split("\n").length;
if (!existsSync(`${HOME}/session.json`)) writeFileSync(`${HOME}/session.json`, JSON.stringify({ sessionId: `sess-${bootId}` }));
writeFileSync("/tmp/rootfs-scratch", `written by boot ${bootId}\n`); // container rootfs, not the volume
const beat = () => writeFileSync(`${HOME}/heartbeat`, JSON.stringify({ bootId, boots, at: Date.now() }));
beat();
setInterval(beat, 100);
