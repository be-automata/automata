import { describe, it, expect } from "vitest";
import { getEnv, E2B_BROKERED_GH_TOKEN_PLACEHOLDER } from "./env";

describe("getEnv", () => {
  it("should set GH_TOKEN from githubAccessToken by default", () => {
    const env = getEnv({
      githubAccessToken: "default-token",
      userEnv: [],
      agentCredentials: null,
    });

    expect(env.GH_TOKEN).toBe("default-token");
  });

  it("should allow user-defined GH_TOKEN to override default", () => {
    const env = getEnv({
      githubAccessToken: "default-token",
      userEnv: [{ key: "GH_TOKEN", value: "custom-token" }],
      agentCredentials: null,
    });

    expect(env.GH_TOKEN).toBe("custom-token");
  });

  it("should set TERRAGON to true", () => {
    const env = getEnv({
      githubAccessToken: "token",
      userEnv: [],
      agentCredentials: null,
    });

    expect(env.TERRAGON).toBe("true");
  });

  it("should include user environment variables", () => {
    const env = getEnv({
      githubAccessToken: "token",
      userEnv: [
        { key: "API_KEY", value: "secret" },
        { key: "DATABASE_URL", value: "postgres://..." },
      ],
      agentCredentials: null,
    });

    expect(env.API_KEY).toBe("secret");
    expect(env.DATABASE_URL).toBe("postgres://...");
  });

  it("should include agent credentials as environment variable", () => {
    const env = getEnv({
      githubAccessToken: "token",
      userEnv: [],
      agentCredentials: {
        type: "env-var",
        key: "ANTHROPIC_API_KEY",
        value: "sk-ant-...",
      },
    });

    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-...");
  });

  it("should apply overrides last", () => {
    const env = getEnv({
      githubAccessToken: "token",
      userEnv: [{ key: "TEST_VAR", value: "user-value" }],
      agentCredentials: null,
      overrides: { TEST_VAR: "override-value" },
    });

    expect(env.TEST_VAR).toBe("override-value");
  });

  it("should allow overrides to override GH_TOKEN", () => {
    const env = getEnv({
      githubAccessToken: "default-token",
      userEnv: [{ key: "GH_TOKEN", value: "user-token" }],
      agentCredentials: null,
      overrides: { GH_TOKEN: "override-token" },
    });

    expect(env.GH_TOKEN).toBe("override-token");
  });

  describe("credential broker (#114)", () => {
    const broker = {
      kind: "docker-sidecar" as const,
      installationToken: "ghs_installation_token_secret",
      runBearer: "run-bearer-abc123",
      repoFullName: "be-automata/automata",
    };

    it("sets GH_TOKEN/GITHUB_TOKEN to the bearer and GH_REPO, never the token", () => {
      const env = getEnv({
        githubAccessToken: broker.installationToken,
        userEnv: [],
        agentCredentials: null,
        credentialBroker: broker,
      });
      expect(env.GH_TOKEN).toBe(broker.runBearer);
      expect(env.GITHUB_TOKEN).toBe(broker.runBearer);
      expect(env.GH_REPO).toBe(broker.repoFullName);
      // The installation token appears NOWHERE.
      expect(JSON.stringify(env)).not.toContain(broker.installationToken);
    });

    it("RESERVES GH_TOKEN in brokered mode — a user GH_TOKEN can NOT shadow the bearer", () => {
      const env = getEnv({
        githubAccessToken: broker.installationToken,
        userEnv: [{ key: "GH_TOKEN", value: "user-token" }],
        agentCredentials: null,
        credentialBroker: broker,
      });
      expect(env.GH_TOKEN).toBe(broker.runBearer);
      expect(env.GITHUB_TOKEN).toBe(broker.runBearer);
    });

    it("still applies our trusted overrides after the reserved broker keys", () => {
      const env = getEnv({
        githubAccessToken: broker.installationToken,
        userEnv: [],
        agentCredentials: null,
        credentialBroker: broker,
        overrides: { GH_TOKEN: "override-token" },
      });
      expect(env.GH_TOKEN).toBe("override-token");
    });
  });

  describe("E2B native credential broker (#114)", () => {
    const e2bBroker = {
      kind: "e2b-native" as const,
      installationToken: "ghs_installation_token_secret",
      repoFullName: "be-automata/automata",
    };

    it("sets GH_TOKEN/GITHUB_TOKEN to the inert placeholder, never the token", () => {
      const env = getEnv({
        githubAccessToken: e2bBroker.installationToken,
        userEnv: [],
        agentCredentials: null,
        credentialBroker: e2bBroker,
      });
      expect(env.GH_TOKEN).toBe(E2B_BROKERED_GH_TOKEN_PLACEHOLDER);
      expect(env.GITHUB_TOKEN).toBe(E2B_BROKERED_GH_TOKEN_PLACEHOLDER);
      // No per-run bearer and no GH_REPO on the E2B path.
      expect(env.GH_REPO).toBeUndefined();
      // The installation token appears NOWHERE.
      expect(JSON.stringify(env)).not.toContain(e2bBroker.installationToken);
    });

    it("RESERVES GH_TOKEN — a user GH_TOKEN can NOT shadow the placeholder", () => {
      const env = getEnv({
        githubAccessToken: e2bBroker.installationToken,
        userEnv: [{ key: "GH_TOKEN", value: "user-token" }],
        agentCredentials: null,
        credentialBroker: e2bBroker,
      });
      expect(env.GH_TOKEN).toBe(E2B_BROKERED_GH_TOKEN_PLACEHOLDER);
      expect(env.GITHUB_TOKEN).toBe(E2B_BROKERED_GH_TOKEN_PLACEHOLDER);
    });

    it("the placeholder is clearly non-secret (not a real-looking token)", () => {
      // Guards against someone swapping in a value that could be mistaken for a
      // credential; it must never start with a GitHub token prefix.
      expect(E2B_BROKERED_GH_TOKEN_PLACEHOLDER).not.toMatch(/^gh[a-z]_/);
    });
  });
});
