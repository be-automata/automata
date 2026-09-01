/**
 * Pure builders for the #108 uid-drop invocations. No I/O, no platform checks —
 * every function here returns argv, so the whole mechanism is unit-testable
 * without sudo, dscl or a real uid switch.
 *
 * THE GRANT IS A UID DROP, NOT A COMMAND FENCE. sudoers(5) is explicit: "If no
 * command line arguments are specified, the user may run the command with any
 * arguments they choose." A bare command path therefore permits `node -e …` /
 * `sh -c …`, and `SETENV` (which `-E` requires) hands the caller NODE_OPTIONS
 * as well. The argv shape below is NOT a security boundary and must never be
 * documented as one. The security property is directional:
 *
 *   - the grantee is the worker's own login (the operator, uid 501), which is
 *     already strictly MORE privileged than the runas target;
 *   - the runas target is an unprivileged role account with no sudoers entry of
 *     its own, `/usr/bin/false` shell and an empty home — never ALL, never root;
 *   - the untrusted party (the agent) runs AS that account and cannot use the
 *     rule at all: /etc/sudoers.d/automata is 0440 root:wheel.
 *
 * WHY THE WRAPPER WRITES ITS OWN PGID. sudo(8) "Process model": sudo execs the
 * command in place only when the policy plugin needs no close function, which
 * requires !use_pty AND !pam_session AND !pam_setcred AND no I/O logging AND no
 * log_servers AND no command timeout — and "both pam_session and pam_setcred are
 * enabled by default on systems using PAM" (macOS uses PAM). With use_pty on
 * (the default since sudo 1.9.14) there are TWO indirections: the monitor
 * setsid()s into a new session and then setpgid()s the command into its own
 * group. A pgid recorded from `child.pid` before sudo runs therefore reaches
 * NEITHER process, and every run leaks a live agent at teardown.
 *
 * So the spawned wrapper records the pgid itself: `printf %s "$$"` survives the
 * following `exec`, and `$$` is the group leader under BOTH sudo shapes. The
 * sudoers `Defaults!` line still disables use_pty and I/O logging as belt and
 * braces, but correctness no longer depends on it. Paths reach the wrapper as
 * ENVIRONMENT VARIABLES and the daemon flags as positional `"$@"` — nothing is
 * ever interpolated into the `sh -c` string.
 */

export const SUDO_BIN = "/usr/bin/sudo";
export const KILL_BIN = "/bin/kill";
export const SH_BIN = "/bin/sh";

/**
 * The wrapper script. Deliberately tiny and deliberately parameter-free: every
 * value arrives through the environment (`AUTOMATA_PIDFILE`, `AUTOMATA_NODE`) or
 * as a positional argument (`"$@"`), so no caller-controlled string is ever
 * parsed as shell.
 *
 * The `|| exit 97` is load-bearing, not defensive noise. Without it a failed
 * pidfile write (unwritable path, ACL inheritance that did not land, a full
 * disk) still falls through to `exec`, and we get the one outcome this whole
 * mechanism exists to prevent: a live agent under the agent uid whose process
 * group NOTHING recorded. resolvePgid() would time out, teardown would signal
 * sudo's pre-wrapper group instead, and boot-reclaim would have no pidfile to
 * find. Failing before `exec` turns an unreapable orphan into a run that dies
 * loudly at start(). 97 is arbitrary but distinct from node's own exit codes,
 * so it is identifiable in a failure reason.
 */
export const PGID_WRAPPER_SCRIPT =
  'printf %s "$$" > "$AUTOMATA_PIDFILE" || exit 97; exec "$AUTOMATA_NODE" "$@"';

/** `$0` for the wrapper shell — cosmetic, but it names the process in `ps`. */
const WRAPPER_ARGV0 = "automata-daemon";

export type Invocation = {
  file: string;
  args: string[];
  /**
   * Extra environment the invocation needs. Empty in default (no-agent-user)
   * mode; the caller merges it into the child env it already builds.
   */
  env: Record<string, string>;
};

/**
 * Reject anything that is not a plain unix login name. The leading-character
 * rule is load-bearing: a name starting with `-` would be read by sudo as a
 * flag.
 */
export function assertAgentUser(agentUser: string): void {
  if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(agentUser)) {
    throw new Error(
      `WORKER_AGENT_USER must be a plain unix login name (^[a-z_][a-z0-9_-]{0,30}$), got ${JSON.stringify(
        agentUser,
      )}`,
    );
  }
}

/**
 * Build the daemon spawn invocation.
 *
 * `agentUser` empty (the default) ⇒ the command is returned UNCHANGED and `env`
 * is empty: byte-for-byte today's spawn.
 */
export function buildSpawnInvocation(opts: {
  agentUser: string;
  /** The node binary. */
  file: string;
  /** The daemon dist path plus its flags. */
  args: string[];
  /** Where the wrapper records its own pgid. Only used in agent-uid mode. */
  pidFilePath: string;
}): Invocation {
  const { agentUser, file, args, pidFilePath } = opts;
  if (!agentUser) {
    return { file, args, env: {} };
  }
  assertAgentUser(agentUser);
  return {
    file: SUDO_BIN,
    args: [
      "-n", // never prompt: a missing NOPASSWD must fail fast, not hang
      "-u",
      agentUser,
      "-E", // forward the env spawn() already built (requires SETENV in sudoers)
      "--",
      SH_BIN,
      "-c",
      PGID_WRAPPER_SCRIPT,
      WRAPPER_ARGV0,
      ...args,
    ],
    env: {
      AUTOMATA_PIDFILE: pidFilePath,
      AUTOMATA_NODE: file,
    },
  };
}

/**
 * Build the group-kill invocation.
 *
 * `agentUser` empty ⇒ null; the caller then uses `process.kill(-pgid)` exactly
 * as today. Non-empty ⇒ `/bin/kill` runs AS the agent account, so the kernel's
 * own kill(2) permission check bounds it to that uid's processes — it cannot
 * signal root or the operator. This is why the runas is the role account and
 * never root: `sudo -u root /bin/kill -9 -- -1` would be a box-killer.
 */
export function buildKillInvocation(opts: {
  agentUser: string;
  pgid: number;
}): Invocation | null {
  const { agentUser, pgid } = opts;
  if (!agentUser) {
    return null;
  }
  assertAgentUser(agentUser);
  if (!Number.isInteger(pgid) || pgid <= 0) {
    throw new Error(
      `buildKillInvocation: pgid must be a positive integer, got ${pgid}`,
    );
  }
  return {
    file: SUDO_BIN,
    // No -E: the kill path needs no environment, so it needs no SETENV grant.
    // `--` before the negative pgid so kill reads it as a target, not a flag.
    args: ["-n", "-u", agentUser, "--", KILL_BIN, "-9", "--", `-${pgid}`],
    env: {},
  };
}
