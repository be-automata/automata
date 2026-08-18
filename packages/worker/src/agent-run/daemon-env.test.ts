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
    it("without a delivered credential: the box key is the credential and HOME stays ambient", () => {
      const env = build();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
      expect(env.HOME).toBe("/home/op");
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
