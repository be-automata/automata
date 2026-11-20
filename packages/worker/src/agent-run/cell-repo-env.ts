import { CELL_DAEMON_ENV } from "./cell-image";
import { ENV_NAME } from "./container-policy";
import { isReservedRepoEnvKey } from "./daemon-env";

/**
 * The owner's repo env for a cell run (#706, OD-1: it lives in the agent's
 * process env, as on the box). It reaches the agent through the `env` block of
 * the `~/.claude/settings.json` the worker copies in, never through the create
 * call, an exec argv or a log line.
 *
 * A settings `env` block beats the process env, the opposite of the box, where
 * the platform writes its own keys after the repo env. So on top of the box's
 * rule (`isReservedRepoEnvKey`) a cell also drops the names its own runtime
 * sets for the agent: the daemon's (`DAEMON_TOKEN`, the Claude adapter's bash
 * timeouts), OpenSandbox's (`OPENSANDBOX_*`: the MITM CA path, the
 * transparent-proxy switch) and every name the entry starts the daemon with
 * (`CELL_DAEMON_ENV`: where the battery skills load from, among others),
 * except the build-tool settings an owner may set on the box too
 * (`CELL_OWNER_OVERRIDABLE`). Pure.
 */

/** Names in `CELL_DAEMON_ENV` an owner may still set: build-tool settings with no platform role. */
export const CELL_OWNER_OVERRIDABLE: readonly string[] = [
  "CI",
  "DEBIAN_FRONTEND",
  "PUB_CACHE",
  "FLUTTER_ROOT",
  "FLUTTER_SUPPRESS_ANALYTICS",
  "DART_SUPPRESS_ANALYTICS",
];

/** Upper-cased: the daemon's own agent env (daemon.ts childEnv, claude-adapter.ts bashTimeoutEnv) and the entry's. */
const CELL_RESERVED_KEYS = new Set([
  "DAEMON_TOKEN",
  "BASH_MAX_TIMEOUT_MS",
  "BASH_DEFAULT_TIMEOUT_MS",
  ...CELL_DAEMON_ENV.filter((n) => !CELL_OWNER_OVERRIDABLE.includes(n)).map(
    (n) => n.toUpperCase(),
  ),
]);
const CELL_RESERVED_PREFIXES = ["OPENSANDBOX_"];

/** Case-insensitive, as the box. Name shape is checked by `cellRepoEnv`. */
export function isReservedCellRepoEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
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
