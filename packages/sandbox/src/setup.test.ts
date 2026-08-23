import { describe, it, expect, vi } from "vitest";
import { parse as tomlParse } from "@iarna/toml";
import {
  setupSandboxOneTime,
  gitCloneRepo,
  setupSandboxEveryTime,
  setupGitCredentials,
} from "./setup";
import { CreateSandboxOptions } from "./types";
import { MockSession } from "./providers/mock-provider";
import {
  CRED_BROKER_ALIAS,
  CRED_BROKER_GIT_PORT,
} from "./providers/docker-cred-broker";

// Mock the installDaemon function
vi.mock("./daemon", () => ({
  installDaemon: vi.fn().mockResolvedValue(undefined),
  updateDaemonIfOutdated: vi.fn().mockResolvedValue(undefined),
  restartDaemonIfNotRunning: vi.fn().mockResolvedValue(undefined),
  MCP_SERVER_FILE_PATH: "/tmp/terry-mcp-server.mjs",
}));

const defaultOptions: CreateSandboxOptions = {
  threadName: "test-title",
  userName: "test-user",
  userEmail: "test@example.com",
  githubAccessToken: "test-token",
  githubRepoFullName: "owner/repo",
  repoBaseBranchName: "main",
  userId: "user-123",
  sandboxSize: "small",
  sandboxProvider: "docker",
  createNewBranch: true,
  environmentVariables: [],
  agentCredentials: null,
  autoUpdateDaemon: false,
  publicUrl: "http://localhost:3000",
  featureFlags: {},
  generateBranchName: async () => null,
  onStatusUpdate: async () => {},
  agent: null,
};

describe("sandbox-setup", () => {
  describe("setupSandboxOneTime", () => {
    it("should create a new branch when createNewBranch is true", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");

      const options = { ...defaultOptions, repoBaseBranchName: "develop" };
      await setupSandboxOneTime(session, options);

      // Should have git clone with branch specification and blobless flags
      expect(runCommandSpy).toHaveBeenCalledWith(
        "git clone --filter=blob:none --no-recurse-submodules --branch 'develop' https://github.com/owner/repo.git repo",
        { cwd: "." },
      );

      // Should create new branch with generated name (terragon/[6-char-id]-[6-char-id] in test env)
      const runCommandCalls = runCommandSpy.mock.calls;
      const checkoutNewBranchCall = runCommandCalls.find((call) =>
        call[0].match(/git checkout -b 'terragon\/[a-z0-9]{6}-[a-z0-9]{6}'/),
      );
      expect(checkoutNewBranchCall).toBeDefined();

      // Verify order: clone -> create new branch
      const cloneIndex = runCommandCalls.findIndex((call) =>
        call[0].includes("git clone"),
      );
      const checkoutNewBranchIndex = runCommandCalls.findIndex((call) =>
        call[0].match(/git checkout -b 'terragon\/[a-z0-9]{6}-[a-z0-9]{6}'/),
      );
      expect(checkoutNewBranchIndex).toBeGreaterThan(cloneIndex);
    });

    it("should not checkout base branch if not specified", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");

      const options = { ...defaultOptions, repoBaseBranchName: "" };
      await setupSandboxOneTime(session, options);

      const runCommandCalls = runCommandSpy.mock.calls;

      // Should not have checkout base branch command (empty string)
      expect(
        runCommandCalls.find((call) => call[0] === "git checkout "),
      ).toBeUndefined();

      // But should still create new branch with hash
      expect(
        runCommandCalls.find((call) =>
          call[0].match(/git checkout -b 'terragon\/[a-z0-9]{6}-[a-z0-9]{6}'/),
        ),
      ).toBeDefined();
    });

    it("should not create new branch if createNewBranch is false", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");

      const options = { ...defaultOptions, createNewBranch: false };
      await setupSandboxOneTime(session, options);

      // Should clone with branch specification and blobless flags (no separate checkout needed)
      expect(runCommandSpy).toHaveBeenCalledWith(
        "git clone --filter=blob:none --no-recurse-submodules --branch 'main' https://github.com/owner/repo.git repo",
        { cwd: "." },
      );

      const runCommandCalls = runCommandSpy.mock.calls;

      // Should not create new branch
      expect(
        runCommandCalls.find((call) =>
          call[0].includes("git checkout -b 'terragon/"),
        ),
      ).toBeUndefined();
    });
  });

  describe("gitCloneRepo", () => {
    it("should clone repo", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");
      const options = { ...defaultOptions, repoBaseBranchName: "feature/test" };
      await gitCloneRepo(session, options);
      // Should clone the repo with branch specification and blobless flags
      expect(runCommandSpy).toHaveBeenCalledWith(
        "git clone --filter=blob:none --no-recurse-submodules --branch 'feature/test' https://github.com/owner/repo.git repo",
        { cwd: "." },
      );
    });

    it("should not checkout branch if not specified", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");
      const options = { ...defaultOptions, repoBaseBranchName: "" };
      await gitCloneRepo(session, options);

      // Should clone the repo without branch specification but with blobless flags
      expect(runCommandSpy).toHaveBeenCalledWith(
        "git clone --filter=blob:none --no-recurse-submodules https://github.com/owner/repo.git repo",
        { cwd: "." },
      );
    });
  });

  describe("setupGitCredentials (#114 broker branch)", () => {
    it("legacy: writes ~/.git-credentials with the token and the store helper", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockResolvedValue("");
      await setupGitCredentials(session, defaultOptions);
      const calls = runCommandSpy.mock.calls.map((c) => c[0]);
      expect(calls.some((c) => c.includes("credential.helper store"))).toBe(
        true,
      );
      expect(calls.some((c) => c.includes("~/.git-credentials"))).toBe(true);
    });

    it("brokered: routes github.com through the broker, scrubs residue, writes NO ~/.git-credentials, and never exposes the token", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockResolvedValue("");
      const broker = {
        kind: "docker-sidecar" as const,
        installationToken: "ghs_installation_token_secret",
        runBearer: "run-bearer-abc123",
        repoFullName: "owner/repo",
      };
      await setupGitCredentials(session, {
        ...defaultOptions,
        credentialBroker: broker,
      });
      const script = runCommandSpy.mock.calls.map((c) => c[0]).join("\n");
      const brokerUrl = `http://${CRED_BROKER_ALIAS}:${CRED_BROKER_GIT_PORT}/`;
      expect(script).toContain(
        `url.'${brokerUrl}'.insteadOf https://github.com/`,
      );
      expect(script).toContain(
        `extraheader 'Authorization: Bearer ${broker.runBearer}'`,
      );
      // Residue removal + no store helper + no credentials file write.
      expect(script).toContain("rm -f ~/.git-credentials");
      expect(script).not.toContain("credential.helper store");
      expect(script).not.toMatch(/echo.*> ~\/\.git-credentials/);
      // The installation token appears NOWHERE in the guest commands.
      expect(script).not.toContain(broker.installationToken);
      expect(script).not.toContain("x-access-token");
    });

    it("e2b-native brokered: scrubs residue, writes NO ~/.git-credentials and NO broker wiring (E2B injects at egress)", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockResolvedValue("");
      const broker = {
        kind: "e2b-native" as const,
        installationToken: "ghs_installation_token_secret",
        repoFullName: "owner/repo",
      };
      await setupGitCredentials(session, {
        ...defaultOptions,
        credentialBroker: broker,
      });
      const script = runCommandSpy.mock.calls.map((c) => c[0]).join("\n");
      // Defensive scrub only — no credentials file, no docker-broker insteadOf.
      expect(script).toContain("rm -f ~/.git-credentials");
      expect(script).not.toContain("credential.helper store");
      expect(script).not.toMatch(/echo.*> ~\/\.git-credentials/);
      expect(script).not.toContain("insteadOf");
      expect(script).not.toContain(CRED_BROKER_ALIAS);
      // The installation token appears NOWHERE in the guest commands.
      expect(script).not.toContain(broker.installationToken);
      expect(script).not.toContain("x-access-token");
    });

    it("daytona-native brokered: writes the VERBATIM `Authorization: token $GH_TOKEN` extraheader (no base64, no ~/.git-credentials)", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockResolvedValue("");
      const broker = {
        kind: "daytona-native" as const,
        installationToken: "ghs_installation_token_secret",
        repoFullName: "owner/repo",
        secretName: "gh-inst-thread_abc123",
      };
      await setupGitCredentials(session, {
        ...defaultOptions,
        credentialBroker: broker,
      });
      const script = runCommandSpy.mock.calls.map((c) => c[0]).join("\n");
      // Verbatim-token extraheader for BOTH github hosts, shell-expanded from the
      // sandbox-level placeholder ($GH_TOKEN). This is the inverse of e2b (which
      // UNSETS the extraheader): daytona must SET it so git sends the placeholder
      // verbatim in the Authorization header for substitution.
      expect(script).toContain(
        `git config --global http.https://github.com/.extraheader "Authorization: token $GH_TOKEN"`,
      );
      expect(script).toContain(
        `git config --global http.https://api.github.com/.extraheader "Authorization: token $GH_TOKEN"`,
      );
      // NEVER base64 (Basic auth would defeat substitution).
      expect(script).not.toMatch(/Authorization: Basic/i);
      expect(script).not.toContain("base64");
      // NO ~/.git-credentials written, no store helper, no docker-broker wiring.
      expect(script).toContain("rm -f ~/.git-credentials");
      expect(script).not.toContain("credential.helper store");
      expect(script).not.toMatch(/echo.*> ~\/\.git-credentials/);
      expect(script).not.toContain("insteadOf");
      // The installation token appears NOWHERE in the guest commands (only the
      // placeholder reference $GH_TOKEN, resolved server-side by Daytona).
      expect(script).not.toContain(broker.installationToken);
      expect(script).not.toContain("x-access-token");
    });
  });

  describe("setupSandboxEveryTime", () => {
    it("should create AGENTS.md for codex agent with customSystemPrompt", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async (cmd) => {
          if (cmd === "cd && pwd") return "/home/user";
          return "";
        });
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      const customPrompt = "This is a custom system prompt for Codex";
      const options = {
        ...defaultOptions,
        agent: "codex" as const,
        customSystemPrompt: customPrompt,
      };

      await setupSandboxEveryTime({
        session,
        options,
        isCreatingSandbox: false,
      });

      // Should ensure ~/.codex directory exists
      expect(runCommandSpy).toHaveBeenCalledWith("mkdir -p /home/user/.codex", {
        cwd: "/",
      });
      // Should write custom system prompt to ~/.codex/AGENTS.md for codex agent
      expect(writeTextFileSpy).toHaveBeenCalledWith(
        "/home/user/.codex/AGENTS.md",
        customPrompt,
      );
      // Should set proper permissions
      expect(runCommandSpy).toHaveBeenCalledWith(
        "chmod 644 /home/user/.codex/AGENTS.md",
        { cwd: "/" },
      );
    });

    it("should write codex config using publicUrl", async () => {
      const session = new MockSession("mock-sandbox");
      vi.spyOn(session, "runCommand").mockImplementation(async (cmd) => {
        if (cmd === "cd && pwd") return "/home/user";
        return "";
      });
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      const options = {
        ...defaultOptions,
        agent: "codex" as const,
        publicUrl: "https://fallback.example.com",
      };

      await setupSandboxEveryTime({
        session,
        options,
        isCreatingSandbox: false,
      });

      const configCall = writeTextFileSpy.mock.calls.find(
        ([path]) => path === "/home/user/.codex/config.toml",
      );

      expect(configCall).toBeDefined();
      const configContents = configCall?.[1];
      expect(typeof configContents).toBe("string");
      const parsed = tomlParse(configContents as string) as any;
      expect(parsed.model_providers.terry).toEqual({
        name: "terry",
        base_url: "https://fallback.example.com/api/proxy/openai/v1",
        wire_api: "responses",
        env_http_headers: { "X-Daemon-Token": "DAEMON_TOKEN" },
      });
    });
    it("should create AGENT.md for amp agent with customSystemPrompt", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async (cmd) => {
          if (cmd === "cd && pwd") return "/home/user";
          return "";
        });
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      const customPrompt = "This is a custom system prompt for Amp";
      const options = {
        ...defaultOptions,
        agent: "amp" as const,
        customSystemPrompt: customPrompt,
      };

      await setupSandboxEveryTime({
        session,
        options,
        isCreatingSandbox: false,
      });

      // Should create ~/.config directory
      expect(runCommandSpy).toHaveBeenCalledWith(
        "mkdir -p /home/user/.config",
        {
          cwd: "/",
        },
      );
      // Should write custom system prompt to ~/.config/AGENTS.md for amp agent
      expect(writeTextFileSpy).toHaveBeenCalledWith(
        "/home/user/.config/AGENTS.md",
        customPrompt,
      );
      // Should set proper permissions
      expect(runCommandSpy).toHaveBeenCalledWith(
        "chmod 644 /home/user/.config/AGENTS.md",
        { cwd: "/" },
      );
    });

    it("should write the mode-aware auto-approve plugin for opencode agent (#88 AC2)", async () => {
      const session = new MockSession("mock-sandbox");
      vi.spyOn(session, "runCommand").mockImplementation(async (cmd) => {
        if (cmd === "cd && pwd") return "/home/user";
        return "";
      });
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      const options = {
        ...defaultOptions,
        agent: "opencode" as const,
      };

      await setupSandboxEveryTime({
        session,
        options,
        isCreatingSandbox: false,
      });

      const pluginCall = writeTextFileSpy.mock.calls.find(
        ([path]) =>
          path === "/home/user/.config/opencode/plugin/auto-approve.ts",
      );
      expect(pluginCall).toBeDefined();
      const pluginContents = pluginCall?.[1] as string;
      // #88 AC2: the written plugin file is mode-aware — it must reference
      // the TERRAGON_REVIEW_MODE marker, not the old unconditional "allow".
      expect(pluginContents).toContain("TERRAGON_REVIEW_MODE");
      expect(pluginContents).toContain('"deny"');
      expect(pluginContents).toContain('"allow"');
    });

    it("should create CLAUDE.md for claudeCode agents with customSystemPrompt", async () => {
      const session = new MockSession("mock-sandbox");
      vi.spyOn(session, "runCommand").mockImplementation(async (cmd) => {
        if (cmd === "cd && pwd") return "/home/user";
        return "";
      });
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      const customPrompt = "This is a custom system prompt for Claude";
      const options = {
        ...defaultOptions,
        agent: "claudeCode" as const,
        customSystemPrompt: customPrompt,
      };

      await setupSandboxEveryTime({
        session,
        options,
        isCreatingSandbox: false,
      });
      // Should write custom system prompt to ~/.claude/CLAUDE.md for non-amp agents
      expect(writeTextFileSpy).toHaveBeenCalledWith(
        "/home/user/.claude/CLAUDE.md",
        customPrompt,
      );
    });
  });

  describe("environment setup script", () => {
    it("should run environment setup script when provided", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");
      const writeTextFileSpy = vi
        .spyOn(session, "writeTextFile")
        .mockImplementation(async () => {});

      const customSetupScript = `#!/bin/bash
echo "Running custom setup"
npm install
npm run build`;

      const options = {
        ...defaultOptions,
        setupScript: customSetupScript,
      };

      await setupSandboxOneTime(session, options);

      // Should write the custom setup script to a temporary file
      expect(writeTextFileSpy).toHaveBeenCalledWith(
        "/tmp/terragon-setup-custom.sh",
        customSetupScript,
      );

      // Should make the script executable
      expect(runCommandSpy).toHaveBeenCalledWith(
        "chmod +x /tmp/terragon-setup-custom.sh",
      );

      // Should execute the custom setup script
      const executeScriptCall = runCommandSpy.mock.calls.find((call) =>
        call[0].includes("bash -x /tmp/terragon-setup-custom.sh"),
      );
      expect(executeScriptCall).toBeDefined();
      expect(executeScriptCall?.[1]).toMatchObject({
        timeoutMs: expect.any(Number),
        env: expect.any(Object),
      });
    });

    it("should run repository setup script when no environment script provided", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");

      const options = {
        ...defaultOptions,
        setupScript: null, // No environment script
      };

      await setupSandboxOneTime(session, options);

      // Should check for and run terragon-setup.sh from the repository
      const repoSetupScriptCall = runCommandSpy.mock.calls.find((call) =>
        call[0].includes("if [ -f terragon-setup.sh ]"),
      );
      expect(repoSetupScriptCall).toBeDefined();
      expect(repoSetupScriptCall?.[0]).toContain("chmod +x terragon-setup.sh");
      expect(repoSetupScriptCall?.[0]).toContain("bash -x ./terragon-setup.sh");
    });

    it("should skip setup script when skipSetupScript is true", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");

      const options = {
        ...defaultOptions,
        skipSetupScript: true,
      };

      await setupSandboxOneTime(session, options);

      // Should not run any setup script
      const setupScriptCalls = runCommandSpy.mock.calls.filter(
        (call) =>
          call[0].includes("terragon-setup") || call[0].includes("setup.sh"),
      );
      expect(setupScriptCalls).toHaveLength(0);
    });

    it("should pass environment variables to setup script", async () => {
      const session = new MockSession("mock-sandbox");
      const runCommandSpy = vi
        .spyOn(session, "runCommand")
        .mockImplementation(async () => "");
      vi.spyOn(session, "writeTextFile").mockImplementation(async () => {});

      const envVars = [
        { key: "API_KEY", value: "secret123" },
        { key: "DATABASE_URL", value: "postgres://localhost" },
      ];

      const options = {
        ...defaultOptions,
        setupScript: "echo $API_KEY",
        environmentVariables: envVars,
      };

      await setupSandboxOneTime(session, options);

      // Find the setup script execution call
      const setupScriptCall = runCommandSpy.mock.calls.find((call) =>
        call[0].includes("bash -x /tmp/terragon-setup-custom.sh"),
      );

      expect(setupScriptCall?.[1]?.env).toEqual({
        API_KEY: "secret123",
        DATABASE_URL: "postgres://localhost",
        TERRAGON: "true",
        GH_TOKEN: "test-token",
        TERM: "xterm",
        CI: "true",
      });
    });

    it("should capture setup script output", async () => {
      const session = new MockSession("mock-sandbox");

      vi.spyOn(session, "runCommand").mockImplementation(
        async (cmd, options) => {
          if (cmd.includes("bash -x /tmp/terragon-setup-custom.sh")) {
            // Simulate output callbacks
            options?.onStdout?.("Installing dependencies...\n");
            options?.onStdout?.("Dependencies installed!\n");
            options?.onStderr?.("Warning: peer dependency\n");
          }
          return "";
        },
      );
      vi.spyOn(session, "writeTextFile").mockImplementation(async () => {});

      // Spy on console.log to capture the output
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      const options = {
        ...defaultOptions,
        setupScript: "npm install",
      };

      await setupSandboxOneTime(session, options);

      // Check that output was logged
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "Setup script output:",
        expect.stringContaining("Installing dependencies"),
      );

      consoleLogSpy.mockRestore();
    });

    it("should handle setup script errors gracefully", async () => {
      const session = new MockSession("mock-sandbox");

      vi.spyOn(session, "runCommand").mockImplementation(async (cmd) => {
        if (cmd.includes("bash -x /tmp/terragon-setup-custom.sh")) {
          throw new Error("Command failed with exit code 1");
        }
        return "";
      });
      vi.spyOn(session, "writeTextFile").mockImplementation(async () => {});

      const options = {
        ...defaultOptions,
        setupScript: "exit 1",
      };

      // Should throw an error with setup script failure message
      await expect(setupSandboxOneTime(session, options)).rejects.toThrow(
        "Setup script failed",
      );
    });
  });
});
