/**
 * The guard every worker-driven git in an agent-written checkout runs first
 * (the self-heal fix check, the #437 timeout salvage). The checkout's .git
 * is the agent's: its local config and info files can steer git — run
 * commands (filter drivers, receivepack/uploadpack, sshCommand), redirect a
 * push (pushInsteadOf, pushurl, a longer insteadOf than the broker's) or
 * re-point history and objects. Command-scope overrides cannot cover keys
 * nobody listed, so the guard refuses any local key outside an allowlist.
 */

/** The guard script's exit code for a .git that is not a plain directory, or carries steering info files. */
export const EXIT_UNSAFE_GITDIR = 3;

/**
 * The checkout must be a plain .git directory, and none of the info files
 * that re-point attributes, history or the object store may exist. Prints
 * the local config's key names (includes not followed: `include.*` is itself
 * a key, and refused).
 */
export const GIT_LOCAL_CONFIG_GUARD_SCRIPT =
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
export const ALLOWED_LOCAL_GIT_CONFIG =
  /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|remote\.origin\.(url|fetch)|branch\.[^\s]+\.(remote|merge)|user\.(name|email)|(push|pull)\.[a-z]+)$/;

/** The guard's stdout → the key names outside the allowlist (lowercased). */
export function disallowedLocalGitConfigKeys(guardStdout: string): string[] {
  return guardStdout
    .split("\n")
    .filter((k) => k.length > 0)
    .map((k) => k.toLowerCase())
    .filter((k) => !ALLOWED_LOCAL_GIT_CONFIG.test(k));
}
