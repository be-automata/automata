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
  // "CLAUDE_CODE_SIMPLE" intentionally NOT whitelisted (#77): nothing in the
  // repo ever sets it, so forwarding it here only exists as a latent
  // OAuth-file-auth killer waiting for an operator's ambient env to carry
  // it. Revert: re-add the string literal to this set.
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
  /**
   * Per-run HOME (D1). REPLACES the ambient HOME so the agent CLI reads this
   * run's credential and cannot see — or clobber — the operator's own login.
   *
   * Set for EVERY run, not only credential-bearing ones: on macOS the CLI keeps
   * its OAuth in the login Keychain rather than a file, so a run left on the
   * operator's HOME can authenticate AS the operator even with no credential
   * file and no API key anywhere. A fresh HOME is the only thing that closes
   * that. Null only for callers that opt out (tests of the legacy shape).
   */
  runHome?: string | null;
  /**
   * Whether a provider credential was actually delivered into `runHome`. Drives
   * the box-key drop; distinct from `runHome` because every run now gets a HOME
   * but only some get a credential.
   */
  credentialDelivered?: boolean;
  /**
   * Extra credential env (e.g. AMP_API_KEY). Injected after the whitelist pass,
   * so it is never subject to the ambient-forwarding rules.
   */
  credentialEnv?: Record<string, string>;
  /**
   * The per-run egress filtering proxy's base url (#66 slice 2,
   * `http://127.0.0.1:<port>`). When set, HTTP(S)_PROXY (both cases) point the
   * child at it and NO_PROXY carves out loopback (the daemon socket, git
   * broker, and the proxy itself). When unset, NOTHING is injected — ambient
   * proxy vars are already stripped by the whitelist, which must stay true.
   */
  egressProxyUrl?: string | null;
  /**
   * Per-run credential brokers (#81). When set, the agent child gets NO
   * reusable GitHub credential: `GH_TOKEN`/`GITHUB_TOKEN` carry the per-run
   * bearer (gh needs a non-empty token, and the gh broker verifies exactly
   * this value), git is rewritten onto the loopback git broker via
   * `url.insteadOf` (which also catches ad-hoc `git push https://github.com/…`
   * URLs the agent types — remote surgery would miss those), and `GH_REPO`
   * restores gh's repo targeting (the insteadOf rewrite makes gh's
   * remote-based resolution fail). The installation token appears NOWHERE in
   * the returned env.
   *
   * Null (the default) = today's exact raw-token env — the rollback contract
   * (`WORKER_CREDENTIAL_BROKER=legacy-direct`).
   */
  broker?: {
    /** git broker base url, `http://127.0.0.1:<port>` (no trailing slash). */
    gitUrl: string;
    /** gh broker unix socket — written as `http_unix_socket` by the caller. */
    ghSocketPath: string;
    /** The per-run bearer both brokers verify. */
    bearer: string;
    /** `owner/repo` for GH_REPO targeting. */
    repoFullName: string;
  } | null;
}

export function buildDaemonEnv({
  baseEnv,
  anthropicApiKey,
  claudeBinDir,
  installationToken,
  ghConfigDir,
  botLogin,
  runHome = null,
  credentialDelivered = false,
  credentialEnv = {},
  egressProxyUrl = null,
  broker = null,
}: BuildDaemonEnvOpts): NodeJS.ProcessEnv {
  // 1. Whitelist: forward ONLY known-safe, non-secret ambient keys.
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (isForwardable(key) && baseEnv[key] !== undefined) {
      env[key] = baseEnv[key];
    }
  }

  // 2. Agent runtime. ANTHROPIC_API_KEY is an INTENTIONAL secret we inject — never
  //    forwarded from the ambient env, only set here.
  //
  //    It is injected ONLY as the last-resort box credential. When this run brought
  //    its own credential (runHome), the box key must NOT be set: it would be a
  //    second, contradictory credential for the same call, and which one the CLI
  //    honours is the CLI's precedence rule, not ours. Handing over both is how the
  //    box key silently won for users who had a subscription.
  //
  //    A sandbox never has this problem — apps/www injects no ANTHROPIC_API_KEY at
  //    all, so its daemon sees either the credential file or the proxy. This keeps
  //    the worker box to those same two clean modes.
  if (credentialDelivered) {
    delete env.ANTHROPIC_API_KEY;
  } else {
    env.ANTHROPIC_API_KEY = anthropicApiKey;
  }
  env.FORCE_COLOR = "0";
  // The run's own HOME replaces the operator's, so the agent CLI reads THIS run's
  // credential. Must come after the whitelist pass, which forwards ambient HOME.
  if (runHome) {
    env.HOME = runHome;
  }
  // Egress enforcement (#66 slice 2): route the child's HTTP(S) traffic through
  // the per-run filtering proxy. Injected AFTER the whitelist pass (like HOME)
  // so it can never be shadowed by — or confused with — an ambient proxy var
  // (those are not whitelisted and stay stripped either way). NO_PROXY keeps
  // loopback direct: the daemon socket, the git broker, and the proxy itself
  // all live there. Honesty: env-var proxying is cooperative — the PF anchor
  // (deploy/egress-pf.conf) is the bypass backstop, not this injection.
  if (egressProxyUrl) {
    env.HTTPS_PROXY = egressProxyUrl;
    env.HTTP_PROXY = egressProxyUrl;
    env.https_proxy = egressProxyUrl;
    env.http_proxy = egressProxyUrl;
    env.NO_PROXY = "127.0.0.1,localhost";
    env.no_proxy = "127.0.0.1,localhost";
  }
  // Credential env (Amp). After the whitelist so SECRET_KEY_PATTERN cannot drop it.
  for (const [key, value] of Object.entries(credentialEnv)) {
    env[key] = value;
  }
  if (claudeBinDir) {
    env.PATH = `${claudeBinDir}:${baseEnv.PATH ?? ""}`;
  }

  // 3. gh: brokered (#81) → the per-run bearer is the "token" (the gh broker
  //    verifies it; `gh auth token` prints only this useless-off-box value) and
  //    GH_REPO restores repo targeting under the insteadOf rewrite. Legacy →
  //    the installation token is the ONLY credential. Either way the isolated
  //    config dir prevents gh from falling back to the operator's stored OAuth
  //    (hosts.yml) — and, brokered, it carries the `http_unix_socket` entry.
  if (broker) {
    env.GH_TOKEN = broker.bearer;
    env.GITHUB_TOKEN = broker.bearer;
    env.GH_REPO = broker.repoFullName;
  } else {
    env.GH_TOKEN = installationToken;
    env.GITHUB_TOKEN = installationToken;
  }
  env.GH_CONFIG_DIR = ghConfigDir;

  // 4. git: neutralize host config (osxkeychain helper, operator identity), point
  //    git at its credential via GIT_CONFIG_* env, and set the bot commit identity
  //    two ways: git config AND GIT_AUTHOR/COMMITTER_* env (the latter wins even
  //    for commits the agent makes directly).
  //
  //    Brokered (#81): NO raw-token extraheader — github.com URLs are rewritten
  //    onto the loopback git broker (insteadOf) and authenticated with the
  //    per-run bearer, exactly the `Bearer <runBearer>` git-broker.ts expects.
  //    Legacy: the installation token as a Basic extraheader for github.com.
  const botEmail = `${botLogin}@users.noreply.github.com`;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_AUTHOR_NAME = botLogin;
  env.GIT_AUTHOR_EMAIL = botEmail;
  env.GIT_COMMITTER_NAME = botLogin;
  env.GIT_COMMITTER_EMAIL = botEmail;
  const gitConfig: Array<[string, string]> = broker
    ? [
        [`url.${broker.gitUrl}/.insteadOf`, "https://github.com/"],
        [
          `http.${broker.gitUrl}/.extraheader`,
          `Authorization: Bearer ${broker.bearer}`,
        ],
        ["credential.helper", ""], // reset inherited helpers (osxkeychain, gh, …)
        ["user.name", botLogin],
        ["user.email", botEmail],
      ]
    : [
        [
          "http.https://github.com/.extraheader",
          `AUTHORIZATION: basic ${Buffer.from(
            `x-access-token:${installationToken}`,
          ).toString("base64")}`,
        ],
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
