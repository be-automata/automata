import {
  CONTAINER_HOME,
  CONTAINER_SOCKET_DIR,
  CONTAINER_WORKSPACE,
  type ContainerLanePolicy,
} from "./container-argv";
import {
  botGitIdentity,
  brokeredGitAuthConfig,
  buildRunProxyEnv,
  isReservedRepoEnvKey,
} from "./daemon-env";
import { mergeForegroundOnlySettings } from "./foreground-only-hook";

/**
 * The per-run policy a container gets copied in before it starts (ADR-013
 * Decision 4): the run env file and the user-level Claude settings. Pure: the
 * caller (container-daemon-process.ts) writes what these return into the
 * run's HOME staging dir and `docker cp`s it into the created container.
 */

/** The env file's one line format: `export NAME='value'` (single-quoted, `'` escaped). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** gh's isolated config dir inside the container (its config.yml names the broker socket). */
export const CONTAINER_GH_CONFIG_DIR = `${CONTAINER_HOME}/.config/gh`;

/**
 * The gh broker's socket inside the container (C3, #430). gh speaks HTTP over
 * a unix socket itself (`http_unix_socket`), so it needs no TCP bridge.
 */
export const CONTAINER_GH_BROKER_SOCKET = `${CONTAINER_SOCKET_DIR}/gh-broker.sock`;

/**
 * The git broker handoff (C3, #430): a unix socket bridged to loopback inside
 * the container. Non-review lanes only.
 */
export interface ContainerBrokerEnv {
  /** The loopback URL the entry's socat bridge serves, e.g. `http://127.0.0.1:3129`. */
  gitUrl: string;
  bearer: string;
  repoFullName: string;
}

export interface ContainerRunEnvOpts {
  policy: ContainerLanePolicy;
  botLogin: string;
  /** The box's ANTHROPIC_API_KEY: injected only when no credential was delivered (daemon-env rule). */
  anthropicApiKey: string;
  credentialDelivered: boolean;
  /** Extra env a delivered credential needs (Amp). Secret. */
  credentialEnv: Record<string, string>;
  /** The owner's repo env + the box's test-service env (reserved keys dropped). */
  repoEnv: Record<string, string>;
  /** The in-container proxy URL (`http://[cred@]127.0.0.1:3128`), or null. */
  egressProxyUrl?: string | null;
  /** The brokered GitHub handoff, or null. Refused on a review. */
  broker?: ContainerBrokerEnv | null;
}

/** A policy violation in the env a container would receive (ADR-013 I4). */
export class ContainerPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerPolicyError";
  }
}

/** GitHub credential carriers that must never reach a review container. */
const GITHUB_CREDENTIAL_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/**
 * The daemon's env inside the container, for the run env file. Mirrors
 * daemon-env.ts's rules (box key only when nothing was delivered; repo env
 * cannot shadow a reserved key; bot identity through git env) with container
 * paths, and WITHOUT the legacy raw-token arm: a container never receives the
 * installation token. With no broker (every lane in C2, and a review always)
 * there is no GitHub credential in the env at all.
 */
export function buildContainerRunEnv(
  opts: ContainerRunEnvOpts,
): Record<string, string> {
  const { policy } = opts;
  const broker = opts.broker ?? null;
  if (broker && !policy.githubCredential) {
    throw new ContainerPolicyError(
      `lane ${policy.lane} may not receive a GitHub credential (ADR-013 I4): no broker handoff for a review container`,
    );
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.repoEnv)) {
    if (!isReservedRepoEnvKey(key) && ENV_NAME.test(key)) {
      env[key] = value;
    }
  }
  if (!opts.credentialDelivered && opts.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = opts.anthropicApiKey;
  }
  for (const [key, value] of Object.entries(opts.credentialEnv)) {
    env[key] = value;
  }
  env.FORCE_COLOR = "0";
  if (opts.egressProxyUrl) {
    for (const [k, v] of Object.entries(
      buildRunProxyEnv(opts.egressProxyUrl, {}),
    )) {
      if (v !== undefined) env[k] = v;
    }
    // The daemon's control-plane callback has no other route out of a
    // `--network none` container.
    env.AUTOMATA_DAEMON_CALLBACK_VIA_PROXY = "1";
  }
  if (broker) {
    env.GH_TOKEN = broker.bearer;
    env.GITHUB_TOKEN = broker.bearer;
    env.GH_REPO = broker.repoFullName;
  }
  env.GH_CONFIG_DIR = CONTAINER_GH_CONFIG_DIR;

  const identity = botGitIdentity(opts.botLogin);
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  Object.assign(env, identity.env);
  const gitConfig: Array<[string, string]> = [
    ...(broker ? brokeredGitAuthConfig(broker) : []),
    ["credential.helper", ""],
    ...identity.config,
    // The clone is owned by the worker's uid on the host, never the
    // container's: scoped to the one checkout the run was given.
    ["safe.directory", CONTAINER_WORKSPACE],
  ];
  env.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });

  if (!policy.githubCredential) {
    assertNoGithubCredential(env);
  }
  return env;
}

/** Throws when `env` carries anything that can authenticate to GitHub. */
export function assertNoGithubCredential(env: Record<string, string>): void {
  for (const key of GITHUB_CREDENTIAL_KEYS) {
    if (env[key] !== undefined) {
      throw new ContainerPolicyError(
        `a review container's env may not carry ${key} (ADR-013 I4)`,
      );
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (
      /^GIT_CONFIG_VALUE_\d+$/.test(key) &&
      /authorization:|x-access-token|ghs_|ghp_|github_pat_/i.test(value)
    ) {
      throw new ContainerPolicyError(
        `a review container's git config may not carry a credential (${key}, ADR-013 I4)`,
      );
    }
    if (/^(ghs|ghp|gho|ghu|ghr)_[A-Za-z0-9]{20,}$|^github_pat_/.test(value)) {
      throw new ContainerPolicyError(
        `a review container's env value of ${key} looks like a GitHub token (ADR-013 I4)`,
      );
    }
  }
}

/**
 * The env file (`export NAME='value'` per line), sourced by the entry step
 * with `set -a` and deleted before the daemon starts. Values are
 * single-quoted with `'` escaped, so no value is ever evaluated by the shell.
 */
export function serializeRunEnvFile(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key)) {
      throw new ContainerPolicyError(
        `env name ${JSON.stringify(key)} is not a shell identifier`,
      );
    }
    if (value.includes("\0")) {
      throw new ContainerPolicyError(`env ${key} carries a NUL byte`);
    }
    lines.push(`export ${key}='${value.replace(/'/g, `'\\''`)}'`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The user-level `~/.claude/settings.json` a container starts with:
 *
 *   - the lane's share of `settings.batteries.json` (the hooks gstack and GSD
 *     registered at image build), for every non-review lane — a review keeps
 *     none, as the host model kept its review HOME hook-free;
 *   - the foreground-only PreToolUse guard, for every non-review lane;
 *   - the lane's `permissions.deny` rules (a review denies risky skills).
 *
 * Hook arrays are concatenated per event, never replaced; nothing from
 * `batteries` other than `hooks` is taken (the image carries no policy, I1).
 * Pure: `batteries` is the parsed file (or null when absent/unparseable).
 */
export function composeContainerSettings(
  policy: ContainerLanePolicy,
  batteries: unknown,
): Record<string, unknown> {
  let settings: Record<string, unknown> = {};
  if (policy.batteriesHooks && isPlainObject(batteries)) {
    const hooks = batteries.hooks;
    if (isPlainObject(hooks)) {
      const copied: Record<string, unknown[]> = {};
      for (const [event, entries] of Object.entries(hooks)) {
        if (Array.isArray(entries)) copied[event] = [...entries];
      }
      settings = { hooks: copied };
    }
  }
  if (policy.foregroundOnly) {
    settings = mergeForegroundOnlySettings(settings);
  }
  if (policy.denyRules.length > 0) {
    settings = {
      ...settings,
      permissions: { deny: [...policy.denyRules] },
    };
  }
  return settings;
}
