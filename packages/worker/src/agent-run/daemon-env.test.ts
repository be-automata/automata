import { describe, expect, it } from "vitest";
import { buildDaemonEnv, STRIPPED_ENV_KEYS } from "./daemon-env";

const INSTALL_TOKEN = "ghs_installationtoken123";

function build(overrides: Record<string, string | undefined> = {}) {
  return buildDaemonEnv({
    baseEnv: {
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      LANG: "en_US.UTF-8",
      // Ambient operator credentials that MUST NOT reach the agent:
      GH_TOKEN: "gho_operatorpersonaltoken",
      GITHUB_TOKEN: "gho_operatorpersonaltoken",
      GH_CONFIG_DIR: "/home/op/.config/gh",
      GH_HOST: "github.com",
      GITHUB_ACTOR: "espinozasenior",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      GIT_ASKPASS: "/usr/bin/op-askpass",
      GIT_CONFIG_GLOBAL: "/home/op/.gitconfig",
      GITHUB_ENTERPRISE_TOKEN: "ent_token",
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
  it("strips every ambient GitHub/git credential + identity var from the child env", () => {
    const env = build();
    // None of the operator's ambient credential vars survive as the operator value.
    expect(env.GITHUB_ACTOR).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.GH_HOST).toBeUndefined();
    // The operator's personal token value is nowhere in the env.
    expect(JSON.stringify(env)).not.toContain("gho_operatorpersonaltoken");
    // Every declared stripped key is either gone or overwritten (never the operator's).
    for (const key of STRIPPED_ENV_KEYS) {
      const v = env[key];
      expect(v === undefined || !String(v).startsWith("gho_")).toBe(true);
    }
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
    const b64 = Buffer.from(`x-access-token:${INSTALL_TOKEN}`).toString("base64");
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
