// One turn via `docker exec`. push <n>: commit agent-work/f<n>.txt and push to the forge.
// The push credential is read from tmpfs (/run/secrets/FORGE_TOKEN) into THIS git child's env-scoped
// config only: never argv, never the repo's .git/config, never $HOME.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const [cmd, n, box] = process.argv.slice(2);
const REPO = "/home/agent/repo";
const TOKEN_FILE = "/run/secrets/FORGE_TOKEN";
const ID = ["-c", "user.name=agent", "-c", "user.email=agent@forge.local", "-c", "commit.gpgsign=false", "-c", "credential.helper="];
const git = (args, env = {}) => execFileSync("git", [...ID, ...args], { cwd: REPO, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
if (cmd === "push") {
  mkdirSync(`${REPO}/agent-work`, { recursive: true });
  writeFileSync(`${REPO}/agent-work/f${n}.txt`, `turn ${n}\n`);
  git(["add", "-A"]);
  git(["commit", "-qm", `turn ${n}`]);
  const env = {};
  if (existsSync(TOKEN_FILE)) {
    const tok = readFileSync(TOKEN_FILE, "utf8").trim();
    Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`agent:${tok}`).toString("base64")}` });
  }
  const t = performance.now();
  try {
    const out = git(["push", "origin", `HEAD:refs/heads/agent/${box}/work`], env);
    console.log(JSON.stringify({ ok: true, ms: Math.round(performance.now() - t), out: out.trim() }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, ms: Math.round(performance.now() - t), out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim().split("\n").slice(-3).join(" | ") }));
  }
}
if (cmd === "state") console.log(JSON.stringify({ heartbeat: JSON.parse(readFileSync("/home/agent/heartbeat", "utf8")), hasToken: existsSync(TOKEN_FILE) }));
