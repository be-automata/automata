import { isReservedRepoEnvKey } from "./daemon-env";

/**
 * The owner's repo env for a cell run (#706, OD-1: it lives in the agent's
 * process env, as on the box). It reaches the agent through the `env` block of
 * the `~/.claude/settings.json` the worker copies in, never through the create
 * call, an exec argv or a log line.
 *
 * A settings `env` block beats the process env, the opposite of the box, where
 * the platform writes its own keys after the repo env. So on top of the box's
 * rule (`isReservedRepoEnvKey`) a cell also drops every name its own runtime
 * sets for the agent: the daemon's (`DAEMON_TOKEN`, the Claude adapter's bash
 * timeouts) and OpenSandbox's (`OPENSANDBOX_*`: the MITM CA path, the
 * transparent-proxy switch). Pure.
 */

/** The box's run env file name rule (container-policy.ts `ENV_NAME`). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Set by the daemon on the agent (daemon.ts childEnv, claude-adapter.ts bashTimeoutEnv). */
const CELL_RESERVED_KEYS = new Set([
  "DAEMON_TOKEN",
  "BASH_MAX_TIMEOUT_MS",
  "BASH_DEFAULT_TIMEOUT_MS",
]);
const CELL_RESERVED_PREFIXES = ["OPENSANDBOX_"];

export function isReservedCellRepoEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    !ENV_NAME.test(key) ||
    isReservedRepoEnvKey(key) ||
    CELL_RESERVED_KEYS.has(upper) ||
    CELL_RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

export interface CellRepoEnv {
  /** The names and values the agent gets. */
  env: Record<string, string>;
  /** The identifier names dropped (reserved, or a NUL in the value), sorted. Never values. */
  dropped: string[];
  /** How many names were dropped for not being an identifier (not listed: a name is free text). */
  invalidNames: number;
}

export function cellRepoEnv(
  repoEnv: Record<string, string> | undefined,
): CellRepoEnv {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  let invalidNames = 0;
  for (const [key, value] of Object.entries(repoEnv ?? {})) {
    if (!ENV_NAME.test(key)) invalidNames += 1;
    else if (isReservedCellRepoEnvKey(key) || value.includes("\0")) {
      dropped.push(key);
    } else env[key] = value;
  }
  return { env, dropped: dropped.sort(), invalidNames };
}
