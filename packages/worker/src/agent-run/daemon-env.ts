import { HARNESS_ENV_KEY } from "./harness-manifest";

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

/**
 * Whitelisted keys that are additionally dropped when the child runs as a
 * DIFFERENT uid (#108). NODE_OPTIONS is the dangerous one: `sudo -E` carries it
 * across, and `--require <path the agent uid can write>` executes before the
 * daemon. The rest point at operator-owned 0700 directories the agent uid
 * cannot traverse, or would override the per-run HOME.
 */
export const CROSS_UID_UNSAFE_KEYS = [
  "NODE_OPTIONS",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
] as const;

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

/**
 * The per-run credential-broker handoff (#81): what the workflow passes to
 * daemon-process/daemon-env so the agent child is pointed at the loopback
 * brokers instead of carrying a raw token.
 */
export type BrokerHandoff = {
  /** git broker base url, `http://127.0.0.1:<port>` (no trailing slash). */
  gitUrl: string;
  /** gh broker unix socket — written as `http_unix_socket` by the caller. */
  ghSocketPath: string;
  /** The per-run bearer both brokers verify. */
  bearer: string;
  /** `owner/repo` for GH_REPO targeting. */
  repoFullName: string;
};

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
  broker?: BrokerHandoff | null;
  /**
   * Phase 7: a READ-ONLY (contents/metadata/pull_requests/issues: read),
   * single-repo, ≤1h GitHub App token, for task runs whose seeded packs
   * require `github-read-token` (the workflow's readTokenForRun gate decides).
   * Applied ONLY in the brokered branch, and ONLY to GITHUB_TOKEN: GH_TOKEN
   * stays the per-run bearer, and gh prefers GH_TOKEN, so gh keeps going
   * through the gh broker; git stays on the git broker. Legacy (unbrokered)
   * runs ignore it. Null/empty = today's env, byte for byte.
   */
  githubReadToken?: string | null;
  /**
   * The owner's environment variables for a task run (input.repoEnv). Applied
   * right after the whitelist pass, so every key the platform sets later
   * (HOME, PATH, gh, git, proxy, credentials) still wins; keys that steer the
   * runtime itself are dropped first (see {@link isReservedRepoEnvKey}).
   */
  repoEnv?: Record<string, string> | null;
  /**
   * The seeded harness packs' env (harnessRunEnv: manifest `env` with
   * {{packDir}} resolved, e.g. PLAYWRIGHT_BROWSERS_PATH, MCP_TIMEOUT). Applied
   * right AFTER repoEnv, and only keys under a battery prefix the repo env can
   * never set (HARNESS_ENV_KEY), so neither can shadow the other. Null/empty
   * = today's env, byte for byte.
   */
  batteryEnv?: Record<string, string> | null;
  /**
   * The seeded harness packs' PATH dirs (harnessRunEnv: manifest `pathDirs`
   * resolved and verified root-owned, e.g. gstack's `<pack>/bin` holding the
   * bun its browse CLI spawns). Handed to the daemon as
   * {@link AGENT_PATH_PREPEND_ENV}, which the daemon prepends to the agent's
   * PATH: setting PATH here would not survive agent-uid mode, where sudo's
   * `secure_path` replaces PATH even under `-E`. Null/empty = today's env,
   * byte for byte.
   */
  batteryPathDirs?: readonly string[] | null;
  /**
   * gstack was seeded: point its browse server's Chromium at the run's egress
   * proxy via BROWSE_PROXY_URL, which gstack's browse server passes to
   * chromium.launch({ proxy }). Chromium ignores HTTPS_PROXY, so without this
   * a browse call would leave the box directly. No-op without a proxy.
   */
  browseProxy?: boolean;
  /**
   * #108: the unix account the child will actually run as. Empty (the default)
   * = nothing below happens and the built env is byte-for-byte today's.
   *
   * When set, three things change, all of them because the child is a DIFFERENT
   * uid than this process:
   *  - NODE_OPTIONS is NOT forwarded. `sudo -E` carries it into the uid-300
   *    process, and a `--require` at any uid-300-writable path would execute
   *    before the daemon does (adversarial review, #108).
   *  - the operator's TMPDIR/TMP/TEMP and every XDG_* dir are dropped. macOS
   *    TMPDIR is /var/folders/<...>/T — mode 0700, owned by the operator's uid,
   *    untraversable by the agent uid; the XDG dirs would likewise point back
   *    at the operator's home and override the per-run HOME.
   *  - USER/LOGNAME name the agent account, so anything that shells out and
   *    asks who it is gets a consistent answer.
   */
  agentUser?: string;
  /**
   * The run's own TMPDIR (in the run dir beside the clone, so it inherits the
   * run's ACE).
   * Only consulted when `agentUser` is set.
   */
  runTmpDir?: string | null;
  /**
   * The run's checkout. Used only to mark it `safe.directory` for the agent uid,
   * which git otherwise refuses to operate in.
   */
  workdir?: string | null;
}

/**
 * #205: the git config a CREDENTIALED run proxy (N > 1) needs, for every git
 * that runs under it — the agent's (buildDaemonEnv), the self-heal check
 * runner's and the fix-check's (workflow.ts). The proxy challenges with 407
 * and audits it; libcurl's default proxy auth is "anyauth" — first request
 * bare, then retry — so every git call over the proxy would log a false deny
 * first. Basic up front: one request, no challenge. github.com itself goes to
 * the loopback broker (NO_PROXY), so this covers other remotes. [] otherwise.
 */
export function gitProxyAuthConfig(
  egressProxyUrl: string | null | undefined,
): Array<[string, string]> {
  return egressProxyUrl && proxyUrlHasCredential(egressProxyUrl)
    ? [["http.proxyAuthMethod", "basic"]]
    : [];
}

/**
 * #81: the git config that points a run's git at its loopback git broker —
 * github.com URLs rewritten onto the broker (`url.insteadOf`, which also
 * catches an ad-hoc `git push https://github.com/…`) and authenticated with
 * the per-run bearer git-broker.ts verifies. The ONE brokered git auth path:
 * the agent's env (buildDaemonEnv) and the #437 timeout salvage both use it.
 */
export function brokeredGitAuthConfig(
  broker: Pick<BrokerHandoff, "gitUrl" | "bearer">,
): Array<[string, string]> {
  return [
    [`url.${broker.gitUrl}/.insteadOf`, "https://github.com/"],
    [
      `http.${broker.gitUrl}/.extraheader`,
      `Authorization: Bearer ${broker.bearer}`,
    ],
  ];
}

/**
 * The run's bot commit identity, both ways git takes it: the
 * GIT_AUTHOR/COMMITTER_* env (wins even over a user.* the agent wrote into
 * .git/config) and the user.name/user.email config entries. One builder for
 * the agent's env (host and container) and the #437 timeout salvage.
 */
export function botGitIdentity(botLogin: string): {
  env: Record<string, string>;
  config: Array<[string, string]>;
} {
  const botEmail = `${botLogin}@users.noreply.github.com`;
  return {
    env: {
      GIT_AUTHOR_NAME: botLogin,
      GIT_AUTHOR_EMAIL: botEmail,
      GIT_COMMITTER_NAME: botLogin,
      GIT_COMMITTER_EMAIL: botEmail,
    },
    config: [
      ["user.name", botLogin],
      ["user.email", botEmail],
    ],
  };
}

/** GIT_CONFIG_* entries appended after whatever GIT_CONFIG_COUNT `env` carries — a new object; `env` is not mutated (nothing to add ⇒ `env` itself). */
export function appendGitConfig(
  env: NodeJS.ProcessEnv,
  entries: ReadonlyArray<[string, string]>,
): NodeJS.ProcessEnv {
  if (entries.length === 0) return env;
  const out: NodeJS.ProcessEnv = { ...env };
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  let count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  for (const [key, value] of entries) {
    out[`GIT_CONFIG_KEY_${count}`] = key;
    out[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  out.GIT_CONFIG_COUNT = String(count);
  return out;
}

/** Whether a proxy URL carries a credential in its userinfo (#205, N > 1). */
export function proxyUrlHasCredential(url: string): boolean {
  try {
    const u = new URL(url);
    return Boolean(u.username || u.password);
  } catch {
    return false;
  }
}

/**
 * gstack's browse server hands BROWSE_PROXY_URL to chromium.launch({ proxy })
 * — a `server` string Chromium takes NO credentials from, and which lands in
 * Chromium's argv (readable by every account via `ps`). #205: at N > 1 the
 * run proxy's URL carries the per-run credential in its userinfo, so the
 * browse URL is the credential-less form and the credential travels as
 * BROWSE_PROXY_USER / BROWSE_PROXY_PASS, which gstack maps to Playwright's
 * proxy.username / proxy.password (its policy: creds in the URL OR the env,
 * never both). A credential-less proxy (N = 1) sets the URL alone, as before.
 */
export function buildBrowseProxyEnv(egressProxyUrl: string): NodeJS.ProcessEnv {
  const u = new URL(egressProxyUrl);
  if (!u.username && !u.password) {
    return { BROWSE_PROXY_URL: egressProxyUrl };
  }
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  u.username = "";
  u.password = "";
  return {
    BROWSE_PROXY_URL: u.toString().replace(/\/$/, ""),
    BROWSE_PROXY_USER: user,
    BROWSE_PROXY_PASS: pass,
  };
}

/**
 * The proxy subset of the run env: HTTP(S)_PROXY (both cases), a loopback
 * NO_PROXY and node's env-proxy switch. Shared by the daemon env and the
 * self-heal check env so both route through the same per-run egress proxy.
 * Returns `base` plus the proxy keys (a copy; `base` is not mutated).
 */
export function buildRunProxyEnv(
  egressProxyUrl: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...base,
    HTTPS_PROXY: egressProxyUrl,
    HTTP_PROXY: egressProxyUrl,
    https_proxy: egressProxyUrl,
    http_proxy: egressProxyUrl,
    // #367: the proxy refuses every loopback target, so IPv6 loopback must
    // stay direct too (node's env-proxy switch, curl and friends match both
    // the bare and the bracketed spelling).
    NO_PROXY: "127.0.0.1,localhost,::1,[::1]",
    no_proxy: "127.0.0.1,localhost,::1,[::1]",
    // Belt-and-braces for the AGENT CLI child (a separate node process whose
    // HTTP client we do not own): node's built-in env proxy support, which
    // exists only on node >=22.21.0 / >=24.0.0. The DAEMON does not depend on
    // it (packages/daemon/src/proxy-fetch.ts proxies explicitly), so its
    // absence on an older runtime is inert.
    NODE_USE_ENV_PROXY: "1",
  };
}

/**
 * Keys a task run's repo environment may not set: every ambient key the
 * whitelist forwards (the operator's runtime: locale, editors and pagers git
 * and gh exec, node flags, npm dirs, NODE_EXTRA_CA_CERTS), the TLS trust
 * stores other clients read (a CA added there undermines the egress proxy),
 * shell init hooks, and the keys the platform owns (identity, credentials,
 * git, gh, the agent CLI's switches — CLAUDE_CODE_SIMPLE alone disables
 * file-based auth — and proxy routing). Matched case-insensitively.
 */
const RESERVED_REPO_ENV_KEYS = new Set([
  ...[...SAFE_ENV_KEYS].map((key) => key.toUpperCase()),
  "LOGNAME",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "NODE_USE_ENV_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GITHUB_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);
const RESERVED_REPO_ENV_PREFIXES = [
  "LD_",
  "DYLD_",
  "GIT_",
  "GH_",
  "ANTHROPIC_",
  "CLAUDE_",
  "AUTOMATA_",
  "TERRAGON_",
  "XDG_",
  // The harness battery packs' env (batteryEnv; HARNESS_ENV_KEY) and the
  // browse proxy: a repo value would redirect a pack (its Chromium, its MCP
  // timeout) or route browse around the egress proxy. CLAUDE_FLOW_ is
  // already under CLAUDE_; listed so the battery set reads whole.
  "GSTACK_",
  "PLAYWRIGHT_",
  "MCP_",
  "CLAUDE_FLOW_",
  "BROWSE_",
];

/**
 * Dirs the daemon prepends to the agent's PATH (packages/daemon/src/daemon.ts
 * withAgentPathPrepend), `:`-joined. Under the reserved AUTOMATA_ prefix, so a
 * repo env can never set it.
 */
export const AGENT_PATH_PREPEND_ENV = "AUTOMATA_AGENT_PATH_PREPEND";

export function isReservedRepoEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    RESERVED_REPO_ENV_KEYS.has(upper) ||
    RESERVED_REPO_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
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
  githubReadToken = null,
  repoEnv = null,
  batteryEnv = null,
  batteryPathDirs = null,
  browseProxy = false,
  agentUser = "",
  runTmpDir = null,
  workdir = null,
}: BuildDaemonEnvOpts): NodeJS.ProcessEnv {
  // 1. Whitelist: forward ONLY known-safe, non-secret ambient keys.
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (isForwardable(key) && baseEnv[key] !== undefined) {
      env[key] = baseEnv[key];
    }
  }

  // 1b. #108: keys that are safe to forward to a child of OUR uid but not to a
  // child of a different one. See BuildDaemonEnvOpts.agentUser.
  if (agentUser) {
    for (const key of CROSS_UID_UNSAFE_KEYS) {
      delete env[key];
    }
    if (runTmpDir) {
      env.TMPDIR = runTmpDir;
    }
    env.USER = agentUser;
    env.LOGNAME = agentUser;
  }

  // 1c. The owner's repo environment (task runs). Before everything the
  // platform sets below, so none of it can be shadowed; reserved keys dropped.
  for (const [key, value] of Object.entries(repoEnv ?? {})) {
    if (!isReservedRepoEnvKey(key)) {
      env[key] = value;
    }
  }

  // 1d. The seeded harness packs' env, after repoEnv. Battery-prefixed keys
  // only (defense in depth: the manifest guard already enforces it).
  for (const [key, value] of Object.entries(batteryEnv ?? {})) {
    if (HARNESS_ENV_KEY.test(key)) {
      env[key] = value;
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
    Object.assign(env, buildRunProxyEnv(egressProxyUrl, {}));
    // #108 F5: the DAEMON's own control-plane callback moves onto the proxy
    // ONLY in agent-uid mode, where the PF anchor makes the direct route
    // unusable. A run that merely carries an egress policy (#66 slice 2, live
    // since before this ticket) keeps the direct callback it has always had —
    // routing it through the proxy would hand it new syscalls, new timeout and
    // error behaviour, and a new dependency on the allowlist carrying the
    // callback host, none of which anyone opted into. Consumed by
    // packages/daemon/src/proxy-fetch.ts (CALLBACK_VIA_PROXY_ENV).
    if (agentUser) {
      env.AUTOMATA_DAEMON_CALLBACK_VIA_PROXY = "1";
    }
    if (browseProxy) {
      Object.assign(env, buildBrowseProxyEnv(egressProxyUrl));
    }
  }
  // Credential env (Amp). After the whitelist so SECRET_KEY_PATTERN cannot drop it.
  for (const [key, value] of Object.entries(credentialEnv)) {
    env[key] = value;
  }
  if (claudeBinDir) {
    env.PATH = `${claudeBinDir}:${baseEnv.PATH ?? ""}`;
  }
  // The seeded packs' runtimes (gstack's bun). Absolute dirs only, never one
  // that could split into more PATH entries than it names.
  const pathDirs = (batteryPathDirs ?? []).filter(
    (dir) => dir.startsWith("/") && !dir.includes(":"),
  );
  if (pathDirs.length > 0) {
    env[AGENT_PATH_PREPEND_ENV] = pathDirs.join(":");
  }

  // 3. gh: brokered (#81) → the per-run bearer is the "token" (the gh broker
  //    verifies it; `gh auth token` prints only this useless-off-box value) and
  //    GH_REPO restores repo targeting under the insteadOf rewrite. Legacy →
  //    the installation token is the ONLY credential. Either way the isolated
  //    config dir prevents gh from falling back to the operator's stored OAuth
  //    (hosts.yml) — and, brokered, it carries the `http_unix_socket` entry.
  if (broker) {
    env.GH_TOKEN = broker.bearer;
    // Phase 7: only a brokered task run with a requiring pack carries a real
    // (read-only) token, and only here — for tools such as the vendored
    // dora_metrics.py that call api.github.com directly with GITHUB_TOKEN.
    env.GITHUB_TOKEN = githubReadToken ? githubReadToken : broker.bearer;
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
  const identity = botGitIdentity(botLogin);
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  Object.assign(env, identity.env);
  const gitAuthConfig: Array<[string, string]> = broker
    ? brokeredGitAuthConfig(broker)
    : [
        [
          "http.https://github.com/.extraheader",
          `AUTHORIZATION: basic ${Buffer.from(
            `x-access-token:${installationToken}`,
          ).toString("base64")}`,
        ],
      ];
  const gitConfig: Array<[string, string]> = [
    ...gitAuthConfig,
    ["credential.helper", ""], // reset inherited helpers (osxkeychain, gh, …)
    ...identity.config,
    // #108 agent-uid mode: the WORKER clones the checkout, the AGENT runs in it,
    // and git refuses a repository owned by someone else —
    //
    //   fatal: detected dubious ownership in repository at '<workdir>'
    //
    // Every git command then fails, including the `git diff origin/main...HEAD`
    // a review agent opens with, so the agent reports it cannot review rather
    // than producing a verdict. Observed in production the first time a run got
    // far enough to try.
    //
    // Scoped to THIS run's workdir, never `*`: the agent should be trusted with
    // the checkout it was given and nothing else on the box. Harmless when
    // agentUser is empty, where owner and runner are the same uid anyway — but
    // still omitted there, so the default-mode env stays byte-for-byte.
    ...(agentUser && workdir
      ? ([["safe.directory", workdir]] as Array<[string, string]>)
      : []),
    ...gitProxyAuthConfig(egressProxyUrl),
  ];
  env.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });

  return env;
}
