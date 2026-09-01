import { describe, expect, it } from "vitest";
import { buildDaemonEnv, SAFE_ENV_KEYS } from "./daemon-env";

const INSTALL_TOKEN = "ghs_installationtoken123";

function build(overrides: Record<string, string | undefined> = {}) {
  return buildDaemonEnv({
    baseEnv: {
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      LANG: "en_US.UTF-8",
      // Ambient operator credentials/identity that MUST NOT reach the agent:
      GH_TOKEN: "gho_operatorpersonaltoken",
      GITHUB_TOKEN: "gho_operatorpersonaltoken",
      GH_CONFIG_DIR: "/home/op/.config/gh",
      GH_HOST: "github.com",
      GITHUB_ACTOR: "espinozasenior",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      GIT_ASKPASS: "/usr/bin/op-askpass",
      GIT_CONFIG_GLOBAL: "/home/op/.gitconfig",
      GITHUB_ENTERPRISE_TOKEN: "ent_token",
      // Unknown ambient secrets a whitelist blocks by default (a denylist would miss):
      AWS_SECRET_ACCESS_KEY: "aws_secret_xyz",
      NPM_TOKEN: "npm_secret_xyz",
      STRIPE_API_KEY: "sk_live_xyz",
      SOME_RANDOM_VAR: "whatever",
      ...overrides,
    },
    anthropicApiKey: "sk-ant-xxx",
    claudeBinDir: "/opt/claude/bin",
    installationToken: INSTALL_TOKEN,
    ghConfigDir: "/tmp/isolated-gh",
    botLogin: "automata-ai-bot[bot]",
  });
}

describe("buildDaemonEnv — credential isolation (ADR-002 customer box)", () => {
  it("whitelists: only known-safe keys are forwarded; every ambient secret/unknown var is dropped", () => {
    const env = build();
    // Ambient GitHub/git identity + credential vars: gone.
    expect(env.GITHUB_ACTOR).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.GH_HOST).toBeUndefined();
    // The strength of the whitelist: UNKNOWN ambient secrets a denylist would miss.
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.STRIPE_API_KEY).toBeUndefined();
    expect(env.SOME_RANDOM_VAR).toBeUndefined();
    // None of the ambient secret VALUES appear anywhere in the child env.
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain("gho_operatorpersonaltoken");
    expect(serialized).not.toContain("aws_secret_xyz");
    expect(serialized).not.toContain("sk_live_xyz");
    // Only whitelisted keys or the explicitly-injected run keys survive.
    const injected = new Set([
      "ANTHROPIC_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_CONFIG_DIR",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_COUNT",
      "GIT_TERMINAL_PROMPT",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ]);
    for (const key of Object.keys(env)) {
      const ok =
        SAFE_ENV_KEYS.has(key) ||
        injected.has(key) ||
        /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key);
      expect(ok, `unexpected key leaked into child env: ${key}`).toBe(true);
    }
  });

  describe("D1 — which model credential the run gets", () => {
    it("legacy shape (no runHome): the box key is the credential and HOME stays ambient", () => {
      const env = build();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
      expect(env.HOME).toBe("/home/op");
    });

    it("a credits-only run STILL gets a fresh HOME — an inherited one leaks the box owner's Keychain login", () => {
      // The failure this pins has no file and no env var to find: on macOS the
      // agent CLI reads its OAuth from the login Keychain, so a run left on the
      // operator's HOME authenticates AS the operator and spends their
      // subscription — on a run that was routed to the proxy. Verified on Claude
      // Code 2.1.234: a fresh HOME yields "Not logged in".
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
        anthropicApiKey: "sk-ant-boxkey",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        runHome: "/tmp/run-42/home",
        credentialDelivered: false,
      });
      expect(env.HOME).toBe("/tmp/run-42/home");
      expect(env.HOME).not.toBe("/home/op");
    });

    it("with a delivered credential: HOME is the run's own, and the box key is GONE", () => {
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
        anthropicApiKey: "sk-ant-boxkey",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        runHome: "/tmp/run-42/home",
        credentialDelivered: true,
      });
      // The agent CLI reads $HOME/.claude/.credentials.json. Pointing HOME at the
      // run dir is what makes it read THIS run's credential instead of the
      // operator's login — and what stops one run clobbering another's.
      expect(env.HOME).toBe("/tmp/run-42/home");
      // Two credentials for one call means the CLI's precedence rule picks who
      // pays. That ambiguity is exactly how the box key silently won for users
      // who had a subscription, so the box key must not be present at all.
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain("sk-ant-boxkey");
    });

    it("injects credential env (Amp) past the secret-pattern filter that would drop it", () => {
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
        anthropicApiKey: "",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        credentialEnv: { AMP_API_KEY: "sgamp_user_test" },
      });
      // AMP_API_KEY matches SECRET_KEY_PATTERN, so ambient forwarding would drop
      // it. It is injected explicitly, after the whitelist pass.
      expect(env.AMP_API_KEY).toBe("sgamp_user_test");
    });
  });

  it("CLAUDE_CODE_SIMPLE never reaches the child env, review-lane or not (#77)", () => {
    // Nothing in the repo sets this var; forwarding it is the documented
    // OAuth-file-auth killer this whitelist exists to fence. Pinned with
    // teeth: even if an operator's ambient env carries it, it must not
    // survive the whitelist pass, in either credential mode.
    const reviewLane = build({ CLAUDE_CODE_SIMPLE: "1" });
    expect(reviewLane.CLAUDE_CODE_SIMPLE).toBeUndefined();

    const nonReviewLane = buildDaemonEnv({
      baseEnv: { PATH: "/usr/bin", HOME: "/home/op", CLAUDE_CODE_SIMPLE: "1" },
      anthropicApiKey: "sk-ant-boxkey",
      claudeBinDir: "",
      installationToken: INSTALL_TOKEN,
      ghConfigDir: "/tmp/isolated-gh",
      botLogin: "automata-ai-bot[bot]",
      runHome: "/tmp/run-42/home",
      credentialDelivered: true,
    });
    expect(nonReviewLane.CLAUDE_CODE_SIMPLE).toBeUndefined();
  });

  describe("#66 slice 2 — egress proxy env injection", () => {
    const PROXY_URL = "http://127.0.0.1:54321";
    // Operator boxes can carry an ambient corporate proxy — it must NEVER
    // reach the child (it would re-route run traffic through operator infra
    // and, when a policy is set, shadow the enforcing per-run proxy).
    const ambientProxies = {
      HTTPS_PROXY: "http://corp-proxy.internal:3128",
      HTTP_PROXY: "http://corp-proxy.internal:3128",
      https_proxy: "http://corp-proxy.internal:3128",
      http_proxy: "http://corp-proxy.internal:3128",
      NO_PROXY: "corp.internal",
      no_proxy: "corp.internal",
    };

    it("sets all 6 proxy vars when egressProxyUrl is set (and they point at the run proxy, not ambient)", () => {
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op", ...ambientProxies },
        anthropicApiKey: "sk-ant-xxx",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        egressProxyUrl: PROXY_URL,
      });
      expect(env.HTTPS_PROXY).toBe(PROXY_URL);
      expect(env.HTTP_PROXY).toBe(PROXY_URL);
      expect(env.https_proxy).toBe(PROXY_URL);
      expect(env.http_proxy).toBe(PROXY_URL);
      // Loopback carve-out: daemon socket, git broker, and the proxy itself.
      expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
      expect(env.no_proxy).toBe("127.0.0.1,localhost");
      expect(JSON.stringify(env)).not.toContain("corp-proxy.internal");
      // #108 D1: belt-and-braces for the agent CLI child (node >=22.21/>=24).
      expect(env.NODE_USE_ENV_PROXY).toBe("1");
      // #108 F5: a policy-bearing run WITHOUT agentUser keeps the DIRECT daemon
      // callback it has always had. This is the pre-existing #66 shape.
      expect(env.AUTOMATA_DAEMON_CALLBACK_VIA_PROXY).toBeUndefined();
    });

    it("opts the daemon callback onto the proxy ONLY in agent-uid mode (#108 F5)", () => {
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
        anthropicApiKey: "sk-ant-xxx",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        egressProxyUrl: PROXY_URL,
        agentUser: "_automata-agent",
        runHome: "/tmp/run-home",
      });
      expect(env.AUTOMATA_DAEMON_CALLBACK_VIA_PROXY).toBe("1");
    });

    it("never opts in without a proxy, even in agent-uid mode (#108 F5)", () => {
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
        anthropicApiKey: "sk-ant-xxx",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        agentUser: "_automata-agent",
        runHome: "/tmp/run-home",
      });
      expect(env.AUTOMATA_DAEMON_CALLBACK_VIA_PROXY).toBeUndefined();
    });

    it("injects NOTHING when unset — and ambient proxy vars stay stripped by the whitelist", () => {
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op", ...ambientProxies },
        anthropicApiKey: "sk-ant-xxx",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
      });
      for (const key of Object.keys(ambientProxies)) {
        expect(env[key], key).toBeUndefined();
      }
      // The default-off proof for #108 D1: no proxy, no node proxy hint.
      expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
      expect(env.AUTOMATA_DAEMON_CALLBACK_VIA_PROXY).toBeUndefined();
    });
  });

  describe("#108 — agent-uid mode drops what is unsafe across a uid boundary", () => {
    const AMBIENT = {
      PATH: "/usr/bin",
      HOME: "/home/op",
      USER: "operator",
      NODE_OPTIONS: "--require /Users/op/evil.js",
      TMPDIR: "/var/folders/j0/abc/T/",
      TMP: "/var/folders/j0/abc/T/",
      TEMP: "/var/folders/j0/abc/T/",
      XDG_CONFIG_HOME: "/home/op/.config",
      XDG_DATA_HOME: "/home/op/.local/share",
      XDG_CACHE_HOME: "/home/op/.cache",
      XDG_RUNTIME_DIR: "/run/user/501",
    };

    const base = {
      anthropicApiKey: "sk-ant-xxx",
      claudeBinDir: "",
      installationToken: INSTALL_TOKEN,
      ghConfigDir: "/tmp/isolated-gh",
      botLogin: "automata-ai-bot[bot]",
    };

    it("agentUser empty: forwards NODE_OPTIONS, TMPDIR, USER and the XDG dirs exactly as today", () => {
      const env = buildDaemonEnv({ baseEnv: AMBIENT, ...base });
      expect(env.NODE_OPTIONS).toBe("--require /Users/op/evil.js");
      expect(env.TMPDIR).toBe("/var/folders/j0/abc/T/");
      expect(env.TMP).toBe("/var/folders/j0/abc/T/");
      expect(env.TEMP).toBe("/var/folders/j0/abc/T/");
      expect(env.USER).toBe("operator");
      expect(env.XDG_CONFIG_HOME).toBe("/home/op/.config");
      expect(env.XDG_RUNTIME_DIR).toBe("/run/user/501");
      expect(env.LOGNAME).toBeUndefined();
    });

    it("agentUser set: NODE_OPTIONS is dropped (sudo -E would carry a --require across)", () => {
      const env = buildDaemonEnv({
        baseEnv: AMBIENT,
        ...base,
        agentUser: "_automata-agent",
      });
      expect(env.NODE_OPTIONS).toBeUndefined();
    });

    it("agentUser set: the operator TMPDIR/TMP/TEMP and every XDG_* var are dropped", () => {
      const env = buildDaemonEnv({
        baseEnv: AMBIENT,
        ...base,
        agentUser: "_automata-agent",
      });
      for (const key of [
        "TMP",
        "TEMP",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_RUNTIME_DIR",
      ]) {
        expect(env[key], key).toBeUndefined();
      }
      expect(env.TMPDIR).toBeUndefined(); // no runTmpDir given
    });

    it("agentUser set: TMPDIR points into the run workdir when one is given", () => {
      const env = buildDaemonEnv({
        baseEnv: AMBIENT,
        ...base,
        agentUser: "_automata-agent",
        runTmpDir: "/usr/local/automata/runs/thr_1/tmp",
      });
      expect(env.TMPDIR).toBe("/usr/local/automata/runs/thr_1/tmp");
    });

    it("agentUser set: USER and LOGNAME name the agent account, not the operator", () => {
      const env = buildDaemonEnv({
        baseEnv: AMBIENT,
        ...base,
        agentUser: "_automata-agent",
      });
      expect(env.USER).toBe("_automata-agent");
      expect(env.LOGNAME).toBe("_automata-agent");
    });

    it("agentUser set: HOME is still the per-run HOME (the #50 seed is unaffected)", () => {
      const env = buildDaemonEnv({
        baseEnv: AMBIENT,
        ...base,
        agentUser: "_automata-agent",
        runHome: "/usr/local/automata/runs/thr_1/home",
      });
      expect(env.HOME).toBe("/usr/local/automata/runs/thr_1/home");
    });
  });

  describe("#81 — brokered credentials: the agent env NEVER carries the installation token", () => {
    const BROKER = {
      gitUrl: "http://127.0.0.1:45678",
      ghSocketPath: "/tmp/automata-agent-run/w-1/thr_1-gh.sock",
      bearer: "runbearer0123456789abcdef",
      repoFullName: "be-automata/automata",
    };

    function buildBrokered() {
      return buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
        anthropicApiKey: "sk-ant-xxx",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        broker: BROKER,
      });
    }

    it("the DoD assertion: no env value equals or contains the installation token (raw or base64)", () => {
      const serialized = JSON.stringify(buildBrokered());
      expect(serialized).not.toContain(INSTALL_TOKEN);
      const b64 = Buffer.from(`x-access-token:${INSTALL_TOKEN}`).toString(
        "base64",
      );
      expect(serialized).not.toContain(b64);
    });

    it("GH_TOKEN/GITHUB_TOKEN are the per-run bearer, GH_REPO restores gh targeting, config dir unchanged", () => {
      const env = buildBrokered();
      // The bearer doubles as gh's non-empty token placeholder; `gh auth token`
      // prints only this useless-off-box value.
      expect(env.GH_TOKEN).toBe(BROKER.bearer);
      expect(env.GITHUB_TOKEN).toBe(BROKER.bearer);
      // The insteadOf rewrite breaks gh's remote-based repo resolution (spike
      // E4); GH_REPO is the verified mitigation.
      expect(env.GH_REPO).toBe(BROKER.repoFullName);
      expect(env.GH_CONFIG_DIR).toBe("/tmp/isolated-gh");
    });

    it("git config rewrites github.com onto the broker with the Bearer extraheader — and NO github.com extraheader", () => {
      const env = buildBrokered();
      const count = Number(env.GIT_CONFIG_COUNT);
      const entries = new Map<string, string>();
      for (let i = 0; i < count; i++) {
        entries.set(env[`GIT_CONFIG_KEY_${i}`]!, env[`GIT_CONFIG_VALUE_${i}`]!);
      }
      // insteadOf also rewrites ad-hoc URLs the agent types — remote surgery
      // on the clone would miss those.
      expect(entries.get(`url.${BROKER.gitUrl}/.insteadOf`)).toBe(
        "https://github.com/",
      );
      // Exactly the `Bearer ${runBearer}` git-broker.ts expects.
      expect(entries.get(`http.${BROKER.gitUrl}/.extraheader`)).toBe(
        `Authorization: Bearer ${BROKER.bearer}`,
      );
      expect(entries.has("http.https://github.com/.extraheader")).toBe(false);
      // Neutralization + bot identity survive brokering.
      expect(entries.get("credential.helper")).toBe("");
      expect(entries.get("user.name")).toBe("automata-ai-bot[bot]");
    });

    it("broker: null is the verbatim legacy env — the rollback contract", () => {
      const env = build();
      expect(env.GH_TOKEN).toBe(INSTALL_TOKEN);
      expect(env.GH_REPO).toBeUndefined();
      expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    });
  });

  it("defense-in-depth: a secret-looking key is never forwarded even if whitelisted", () => {
    // Sanity: no whitelisted key matches the secret pattern (would be dropped).
    const secretish = [...SAFE_ENV_KEYS].filter((k) =>
      /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(k),
    );
    expect(secretish).toEqual([]);
  });

  it("wires the installation token as THE gh credential with an isolated config dir", () => {
    const env = build();
    expect(env.GH_TOKEN).toBe(INSTALL_TOKEN);
    expect(env.GITHUB_TOKEN).toBe(INSTALL_TOKEN);
    // Isolated empty gh config dir → gh cannot fall back to the operator's hosts.yml.
    expect(env.GH_CONFIG_DIR).toBe("/tmp/isolated-gh");
  });

  it("wires the installation token as the git push credential and neutralizes host git config", () => {
    const env = build();
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    // The injected git config carries the installation-token extraheader + bot identity.
    const count = Number(env.GIT_CONFIG_COUNT);
    expect(count).toBeGreaterThan(0);
    const keys: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < count; i++) {
      keys.push(env[`GIT_CONFIG_KEY_${i}`]!);
      values.push(env[`GIT_CONFIG_VALUE_${i}`]!);
    }
    expect(keys).toContain("http.https://github.com/.extraheader");
    expect(keys).toContain("credential.helper");
    expect(keys).toContain("user.name");
    // The extraheader encodes x-access-token:<installationToken> (base64 Basic).
    const b64 = Buffer.from(`x-access-token:${INSTALL_TOKEN}`).toString(
      "base64",
    );
    expect(values.some((v) => v.includes(b64))).toBe(true);
    // credential.helper is reset to empty (disables inherited osxkeychain/gh helpers).
    const helperIdx = keys.indexOf("credential.helper");
    expect(values[helperIdx]).toBe("");
    // Commit identity is the bot, never the operator.
    expect(values[keys.indexOf("user.name")]).toBe("automata-ai-bot[bot]");
  });

  it("preserves non-credential env the agent needs (PATH augmented, HOME/LANG kept)", () => {
    const env = build();
    expect(env.HOME).toBe("/home/op");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(env.PATH).toBe("/opt/claude/bin:/usr/bin:/bin");
  });

  it("does not leak a stale GIT_CONFIG_KEY_* injection from the base env", () => {
    // An ambient GIT_CONFIG_COUNT/KEY/VALUE (operator injection) must be dropped so
    // it cannot shadow ours.
    const env = build({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "osxkeychain",
    });
    // Our injection replaces it: KEY_0 is our extraheader, not the operator's helper.
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
  });
});
