import { CONTAINER_DAEMON_BUNDLE, CONTAINER_HOME } from "./container-argv";
import { CONTAINER_FLUTTER_SHIM_DIR } from "./container-entry";

/**
 * Constants of the cell guest image (deploy/images/cell, #656 PR-F). PR-E
 * consumes them to build the cell's entrypoint and exec argv. No I/O.
 */

export const CELL_ENTRY = "/opt/automata/cell-entry.sh";
export const CELL_SEND = "/opt/automata/cell-send.sh";
export const CELL_NODE = "/usr/local/bin/node";
export const CELL_DAEMON_SOCKET = `${CONTAINER_HOME}/.automata-run/daemon.sock`;
export const CELL_CA_BUNDLE = `${CONTAINER_HOME}/.opensandbox/merged-ca-certificates.pem`;

/** Where the daemon bundle sits in the image: the box's path, baked in. */
export const CELL_DAEMON_BUNDLE = CONTAINER_DAEMON_BUNDLE;
/** The PATH-first dir PR-E writes pin shims into: the box's own constant. */
export const CELL_FLUTTER_SHIM_DIR = CONTAINER_FLUTTER_SHIM_DIR;

/**
 * Exit codes of cell-entry.sh (sysexits): 64 bad arguments, 66 HOME missing or
 * not an absolute directory, 78 a forbidden env name. cell-send.sh exits 64
 * for a bad argument and 65 for one over CELL_SEND_MAX_BYTES.
 */
export const CELL_ENTRY_EXIT = {
  usage: 64,
  noHome: 66,
  forbiddenEnv: 78,
} as const;
export const CELL_SEND_EXIT = { usage: 64, tooLarge: 65 } as const;

/**
 * Longest single argv string cell-send.sh accepts: Linux caps one argument at
 * MAX_ARG_STRLEN (128 KiB including the NUL). PR-E caps or splits a message
 * whose base64 is longer.
 */
export const CELL_SEND_MAX_BYTES = 128 * 1024 - 1;

/**
 * Env names the entry refuses (case-insensitive), the AWS_ prefix included.
 * The script holds the same text in its `forbidden=` line (a test keeps them
 * equal).
 */
export const CELL_FORBIDDEN_ENV_PATTERN_SOURCE =
  "TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|APIKEY|_KEY$|PRIVATE|PASS|AUTH|_PAT$|COOKIE|DATABASE_URL|^AWS_";
export const CELL_FORBIDDEN_ENV_PATTERN = new RegExp(
  CELL_FORBIDDEN_ENV_PATTERN_SOURCE,
  "i",
);

/**
 * Names exempt from the refusal. Must equal the `allow` list in
 * cell-entry.sh (a test keeps them equal), and none may match the pattern.
 */
export const CELL_ENV_ALLOWLIST: readonly string[] = [
  // set by OpenSandbox
  "OPENSANDBOX_ID",
  "OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT",
  // set by its bootstrap
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  // set by this image
  "OPENSANDBOX_MERGED_CA_PATH",
  "GIT_SSL_CAINFO",
  // set by the batteries image
  "DEBIAN_FRONTEND",
  "LANG",
  "LC_ALL",
  "PUB_CACHE",
  "FLUTTER_ROOT",
  "FLUTTER_SUPPRESS_ANALYTICS",
  "DART_SUPPRESS_ANALYTICS",
  "CI",
  "PATH",
  "SOMNIO_ROOT",
  "VENDOR_SKILLS_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "YTCTL",
  "PLAYWRIGHT_BROWSERS_PATH",
  "HOME",
  "GSTACK_SESSION_KIND",
  "ROBOREV_TELEMETRY_ENABLED",
  "MCP_TIMEOUT",
];

/**
 * Static, non-secret run env the operator may set (docker.sandbox_env). Not
 * exempt from the refusal; they simply do not match it.
 */
export const CELL_RUN_ENV: readonly string[] = [
  "FORCE_COLOR",
  "TOOL_FAILURE_STREAK_LIMIT",
];

/**
 * The only names the daemon starts with: the entry runs it under `env -i`
 * with these and nothing else (a test keeps the script's two lists equal to
 * the two constants above).
 */
export const CELL_DAEMON_ENV: readonly string[] = [
  ...CELL_ENV_ALLOWLIST,
  ...CELL_RUN_ENV,
];

/** The entry's rule: a credential-shaped name, unless it is allowlisted. */
export function isForbiddenCellEnvName(name: string): boolean {
  if (CELL_ENV_ALLOWLIST.includes(name)) return false;
  return CELL_FORBIDDEN_ENV_PATTERN.test(name);
}

/** The same shape cell-entry.sh accepts after `https://`. */
export const CELL_BROKER_HOST_PATTERN =
  /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$/;

/**
 * The provider entrypoint for a deployment's broker host. Throws on a host the
 * entry would refuse, so a bad host fails in the worker, not in a cell.
 */
export function cellEntrypoint(brokerHost: string): string[] {
  if (!CELL_BROKER_HOST_PATTERN.test(brokerHost)) {
    throw new Error(
      `cell broker host ${JSON.stringify(brokerHost)} is not a lowercase host[:port]`,
    );
  }
  return [CELL_ENTRY, "--url", `https://${brokerHost}`];
}
