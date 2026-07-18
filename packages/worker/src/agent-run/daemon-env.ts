/**
 * Builds the environment for the agent/daemon child process on the execution box
 * (ADR-002 customer-box model). The worker runs on the operator's own machine, so
 * `process.env` carries the operator's AMBIENT GitHub credentials — GH_TOKEN, a gh
 * config dir with their personal OAuth (hosts.yml), an ssh-agent socket, git
 * credential helpers (osxkeychain). If inherited, the agent posts PRs/reviews and
 * pushes as the OPERATOR (a real identity leak: the C8 review posted as the human,
 * not the App bot) — exactly what the customer-box model must prevent.
 *
 * The rule: the agent acts ONLY with the short-lived installation token the control
 * plane handed it (input.installationToken). This function returns a sanitized env:
 * ambient GitHub/git credential vars are STRIPPED, and the installation token is
 * wired as THE credential for both `gh` (GH_TOKEN + an isolated empty GH_CONFIG_DIR
 * so gh can't read the operator's hosts.yml) and `git` (an HTTP extraheader injected
 * via GIT_CONFIG_* env, with host git config neutralized and credential helpers
 * disabled). Commit identity is set to the bot, never the operator.
 *
 * Pure (no I/O) so it is unit-testable; the caller provides the isolated
 * ghConfigDir path (a fresh empty directory it created).
 */

/** Exact ambient var names stripped from the child env (credential/identity bearing). */
export const STRIPPED_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "GH_ACTOR",
  "GITHUB_ACTOR",
  "GITHUB_USER",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
] as const;

/** Regexes for families of ambient vars to strip (GIT_CONFIG_* injection, tokens). */
const STRIPPED_ENV_PATTERNS = [
  /^GIT_CONFIG_KEY_\d+$/,
  /^GIT_CONFIG_VALUE_\d+$/,
  /^(GH|GITHUB)_.*TOKEN$/,
];

function isStrippedKey(key: string): boolean {
  if ((STRIPPED_ENV_KEYS as readonly string[]).includes(key)) {
    return true;
  }
  return STRIPPED_ENV_PATTERNS.some((re) => re.test(key));
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
  // 1. Start from a sanitized copy — drop every ambient credential/identity var.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!isStrippedKey(key)) {
      env[key] = value;
    }
  }

  // 2. Agent runtime.
  env.ANTHROPIC_API_KEY = anthropicApiKey;
  if (claudeBinDir) {
    env.PATH = `${claudeBinDir}:${baseEnv.PATH ?? ""}`;
  }

  // 3. gh: the installation token is the only credential; an isolated empty config
  //    dir prevents gh from falling back to the operator's stored OAuth (hosts.yml).
  env.GH_TOKEN = installationToken;
  env.GITHUB_TOKEN = installationToken;
  env.GH_CONFIG_DIR = ghConfigDir;

  // 4. git: neutralize host config (osxkeychain helper, operator identity) and inject
  //    the installation token as an HTTP extraheader for github.com, plus the bot
  //    commit identity, via GIT_CONFIG_* env (no file needed → pure).
  const authHeader = `AUTHORIZATION: basic ${Buffer.from(
    `x-access-token:${installationToken}`,
  ).toString("base64")}`;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  const gitConfig: Array<[string, string]> = [
    ["http.https://github.com/.extraheader", authHeader],
    ["credential.helper", ""], // reset inherited helpers (osxkeychain, gh, …)
    ["user.name", botLogin],
    ["user.email", `${botLogin}@users.noreply.github.com`],
  ];
  env.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });

  return env;
}
