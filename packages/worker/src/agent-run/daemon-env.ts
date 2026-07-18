/**
 * Builds the environment for the agent/daemon child process on the execution box
 * (ADR-002 customer-box model). The worker runs on the operator's own machine, so
 * `process.env` carries the operator's AMBIENT credentials — GitHub tokens, a gh
 * config dir with their personal OAuth, an ssh-agent socket, git credential helpers,
 * and (on a real customer box) AWS creds, npm tokens, arbitrary API keys. If
 * inherited, the agent acts as the OPERATOR (the C8 review posted as the human, not
 * the App bot) and can reach any of those ambient secrets — what the customer-box
 * model must prevent.
 *
 * WHITELIST model (ported from orch-agents src/shared/safe-env.ts): only known-safe
 * keys are forwarded; everything else — including unknown secrets — is dropped by
 * default. This is strictly safer than a scrub-list. Defense-in-depth: even a
 * whitelisted key is rejected if it looks secret (SECRET_KEY_PATTERN / INPUT_ /
 * scrub set), catching future whitelist mistakes. The run's own credentials are then
 * INJECTED explicitly: the installation token as the sole gh/git credential (with an
 * isolated empty GH_CONFIG_DIR so gh can't fall back to the operator's hosts.yml),
 * and the bot commit identity.
 *
 * Pure (no I/O) so it is unit-testable; the caller provides the isolated
 * ghConfigDir path (a fresh empty directory it created).
 */

/** Only these ambient keys are forwarded to the child (whitelist). */
export const SAFE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_ENV",
  "NODE_PATH",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "TMPDIR",
  "TMP",
  "TEMP",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "COLORTERM",
  "TERM_PROGRAM",
  "FORCE_COLOR",
  "npm_config_prefix",
  "npm_config_cache",
  // claude-code runtime toggles (non-secret).
  "CLAUDE_CODE_SIMPLE",
]);

/** Defense-in-depth: a whitelisted key is still dropped if it looks like a secret. */
const SECRET_KEY_PATTERN = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i;

/** CI/OIDC keys always scrubbed regardless of the pattern. */
const EXPLICIT_SCRUB_KEYS = new Set([
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
]);

function isForwardable(key: string): boolean {
  if (!SAFE_ENV_KEYS.has(key)) {
    return false;
  }
  if (
    SECRET_KEY_PATTERN.test(key) ||
    key.startsWith("INPUT_") ||
    EXPLICIT_SCRUB_KEYS.has(key)
  ) {
    return false; // defense-in-depth
  }
  return true;
}

export interface BuildDaemonEnvOpts {
  baseEnv: NodeJS.ProcessEnv;
  anthropicApiKey: string;
  claudeBinDir: string;
  installationToken: string;
  /** Isolated EMPTY dir for gh config (no operator hosts.yml). Caller creates it. */
  ghConfigDir: string;
  /** Bot login the run's git commits are authored as (never the operator). */
  botLogin: string;
}

export function buildDaemonEnv({
  baseEnv,
  anthropicApiKey,
  claudeBinDir,
  installationToken,
  ghConfigDir,
  botLogin,
}: BuildDaemonEnvOpts): NodeJS.ProcessEnv {
  // 1. Whitelist: forward ONLY known-safe, non-secret ambient keys.
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (isForwardable(key) && baseEnv[key] !== undefined) {
      env[key] = baseEnv[key];
    }
  }

  // 2. Agent runtime (ANTHROPIC_API_KEY is an INTENTIONAL secret we inject — it is
  //    never forwarded from the ambient env, only set here).
  env.ANTHROPIC_API_KEY = anthropicApiKey;
  env.FORCE_COLOR = "0";
  if (claudeBinDir) {
    env.PATH = `${claudeBinDir}:${baseEnv.PATH ?? ""}`;
  }

  // 3. gh: the installation token is the ONLY credential; an isolated empty config
  //    dir prevents gh from falling back to the operator's stored OAuth (hosts.yml).
  env.GH_TOKEN = installationToken;
  env.GITHUB_TOKEN = installationToken;
  env.GH_CONFIG_DIR = ghConfigDir;

  // 4. git: neutralize host config (osxkeychain helper, operator identity), inject the
  //    installation token as an HTTP extraheader for github.com via GIT_CONFIG_* env,
  //    and set the bot commit identity two ways: git config AND GIT_AUTHOR/COMMITTER_*
  //    env (the latter wins even for commits the agent makes directly).
  const authHeader = `AUTHORIZATION: basic ${Buffer.from(
    `x-access-token:${installationToken}`,
  ).toString("base64")}`;
  const botEmail = `${botLogin}@users.noreply.github.com`;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_AUTHOR_NAME = botLogin;
  env.GIT_AUTHOR_EMAIL = botEmail;
  env.GIT_COMMITTER_NAME = botLogin;
  env.GIT_COMMITTER_EMAIL = botEmail;
  const gitConfig: Array<[string, string]> = [
    ["http.https://github.com/.extraheader", authHeader],
    ["credential.helper", ""], // reset inherited helpers (osxkeychain, gh, …)
    ["user.name", botLogin],
    ["user.email", botEmail],
  ];
  env.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });

  return env;
}
