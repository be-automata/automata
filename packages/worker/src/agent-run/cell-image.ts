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

export const CELL_ENTRY_EXIT = { usage: 64, forbiddenEnv: 78 } as const;

/** Env names the entry refuses (case-insensitive), besides the AWS_ prefix. */
export const CELL_FORBIDDEN_ENV_PATTERN =
  /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i;
const CELL_FORBIDDEN_ENV_PREFIX = "AWS_";

/**
 * Names the cell may start with. Must equal the `allow` list in
 * cell-entry.sh (a test keeps them equal).
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

/** The entry's rule: a credential-shaped name, unless it is allowlisted. */
export function isForbiddenCellEnvName(name: string): boolean {
  if (CELL_ENV_ALLOWLIST.includes(name)) return false;
  return (
    CELL_FORBIDDEN_ENV_PATTERN.test(name) ||
    name.startsWith(CELL_FORBIDDEN_ENV_PREFIX)
  );
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
