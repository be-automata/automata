import type { AgentCommandResult } from "./agent-command";

/**
 * Worker-driven git in an agent-written checkout (the self-heal fix check,
 * the #437 timeout salvage). The checkout's .git is the agent's: its local
 * config and info files can steer git — run commands (filter drivers,
 * receivepack/uploadpack, sshCommand), redirect a push (pushInsteadOf,
 * pushurl, a longer insteadOf than the broker's) or re-point history and
 * objects. Two defences, used together:
 *
 *   - hardenGitEnv: command-scope overrides for what can be named up front
 *     (hooks, fsmonitor, every global/system/HOME config source);
 *   - checkLocalGitConfig: everything else — any local key outside an
 *     allowlist refuses the checkout, since overrides cannot cover keys
 *     nobody listed.
 */

const EXIT_UNSAFE_GITDIR = 3;

// The checkout must be a plain .git directory, and none of the info files
// that re-point attributes, history or the object store may exist. Prints the
// local config's key names (includes not followed: `include.*` is itself a
// key, and refused).
const GUARD_SCRIPT =
  `test -d .git && test ! -L .git || exit ${EXIT_UNSAFE_GITDIR}; ` +
  `test ! -e .git/info/attributes && test ! -e .git/info/grafts && test ! -e .git/commondir || exit ${EXIT_UNSAFE_GITDIR}; ` +
  "exec git config --local --no-includes --name-only --list";

/**
 * Local config keys a clean clone (plus the agent's own commits and pushes)
 * can legitimately carry; single-level push.* / pull.* keys (an agent's
 * `push.autoSetupRemote`) only steer push/pull. Anything else — filter.*,
 * include.*, url.*, remote.<name>.(pushurl|receivepack|…), core.worktree,
 * diff/alias/extensions keys — could steer the commands that follow.
 */
const ALLOWED_LOCAL_CONFIG =
  /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|remote\.origin\.(url|fetch)|branch\.[^\s]+\.(remote|merge)|user\.(name|email)|(push|pull)\.[a-z]+)$/;

/**
 * Run the guard (through the caller's runner, in the checkout):
 * `safe` — a plain .git whose local keys are all allowed; `unsafe` — a local
 * key outside the allowlist (the agent wrote it); `error` — anything else
 * (an unsafe or unreadable .git, a killed or truncated guard).
 */
export async function checkLocalGitConfig(
  git: (script: string) => Promise<AgentCommandResult>,
): Promise<"safe" | "unsafe" | "error"> {
  const r = await git(GUARD_SCRIPT);
  if (r.timedOut || r.truncated || r.exitCode !== 0) return "error";
  const keys = r.stdout.split("\n").filter((k) => k.length > 0);
  return keys.some((k) => !ALLOWED_LOCAL_CONFIG.test(k.toLowerCase()))
    ? "unsafe"
    : "safe";
}

/**
 * Env every git in an untrusted checkout runs with, on top of the caller's.
 * No config, attributes or ignore file may come from anywhere but the
 * (guarded) local .git: system and global config are off, HOME and
 * XDG_CONFIG_HOME point at /dev/null (so even a sudo that resets HOME to the
 * agent account's persistent home hands git nothing), and the attributes and
 * excludes files are pinned to /dev/null at command scope, which wins over
 * the agent-writable .git/config.
 */
export function hardenGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...env,
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  let count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const add = (key: string, value: string): void => {
    out[`GIT_CONFIG_KEY_${count}`] = key;
    out[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  };
  add("core.hooksPath", "/dev/null");
  add("core.fsmonitor", "false");
  add("core.attributesFile", "/dev/null");
  add("core.excludesFile", "/dev/null");
  out.GIT_CONFIG_COUNT = String(count);
  return out;
}
