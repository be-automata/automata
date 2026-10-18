// One turn via `docker exec` (no inbound port). remember <fact> | state
// Secrets are read from /run/secrets/<ENV_NAME> (tmpfs) into THIS turn's env only, never PID 1's.
// The turn reports secret NAMES and a short hash, never values.
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
const HOME = process.env.AGENT_HOME ?? "/home/agent";
const [cmd, a] = process.argv.slice(2);
const mem = () => (existsSync(`${HOME}/memory.jsonl`) ? readFileSync(`${HOME}/memory.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text) : []);
if (cmd === "remember") appendFileSync(`${HOME}/memory.jsonl`, JSON.stringify({ text: a, at: new Date().toISOString() }) + "\n");
const SEC = "/run/secrets";
const secrets = existsSync(SEC) ? readdirSync(SEC).sort().map((n) => ({ name: n, sha: createHash("sha256").update(readFileSync(`${SEC}/${n}`)).digest("hex").slice(0, 12) })) : [];
const hb = existsSync(`${HOME}/heartbeat`) ? JSON.parse(readFileSync(`${HOME}/heartbeat`, "utf8")) : null;
console.log(JSON.stringify({
  memory: mem(),
  session: JSON.parse(readFileSync(`${HOME}/session.json`, "utf8")).sessionId,
  bootId: hb?.bootId, boots: hb?.boots,
  rootfsScratch: existsSync("/tmp/rootfs-scratch") ? readFileSync("/tmp/rootfs-scratch", "utf8").trim() : null,
  role: process.env.AGENT_ROLE ?? null,
  secrets,
  pid1EnvHasSecretNames: readFileSync("/proc/1/environ", "utf8").split("\0").filter((kv) => /^(ANTHROPIC_API_KEY|DATABASE_URL)=/.test(kv)).map((kv) => kv.split("=")[0]),
}));
