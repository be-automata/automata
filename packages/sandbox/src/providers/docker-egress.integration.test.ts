import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import { DockerProvider } from "./docker-provider";
import { egressNetworkName, egressSidecarName } from "./docker-egress";
import type { CreateSandboxOptions, ISandboxSession } from "../types";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Opt-in (like the provider suites): needs a docker daemon + the test base
// image. Run with: SANDBOX_PROVIDER=docker pnpm -C packages/sandbox vitest docker-egress.integration
describe(
  "docker egress enforcement (integration)",
  { skip: process.env.SANDBOX_PROVIDER !== "docker", timeout: TIMEOUT_MS },
  () => {
    vi.setConfig({ testTimeout: TIMEOUT_MS });
    let sandbox: ISandboxSession;
    let containerName: string;

    const options: CreateSandboxOptions = {
      threadName: "egress-test",
      agent: null,
      agentCredentials: null,
      userName: "test-user",
      userEmail: "test@example.com",
      githubAccessToken: "test-token",
      githubRepoFullName: "org/repo",
      repoBaseBranchName: "main",
      userId: "user-123",
      sandboxProvider: "docker",
      sandboxSize: "small",
      createNewBranch: true,
      environmentVariables: [],
      autoUpdateDaemon: false,
      publicUrl: "http://localhost:3000",
      featureFlags: {},
      // github.com allowlisted so git-over-https works through the sidecar.
      egressPolicy: { level: "domain", allowlist: ["github.com"] },
      generateBranchName: async () => null,
      onStatusUpdate: async () => {},
    };

    beforeAll(async () => {
      const provider = new DockerProvider();
      sandbox = await provider.getOrCreateSandbox(null, options);
      containerName = execSync(
        `docker inspect --format '{{.Name}}' ${sandbox.sandboxId}`,
        { encoding: "utf8" },
      )
        .trim()
        .replace(/^\//, "");
    }, TIMEOUT_MS);

    afterAll(async () => {
      try {
        await sandbox?.shutdown();
      } catch {}
      await DockerProvider.cleanupTestContainers();
    });

    it("starts the sidecar on the internal network", () => {
      const sidecar = execSync(
        `docker ps --filter "name=${egressSidecarName(containerName)}" --format "{{.Names}}"`,
        { encoding: "utf8" },
      ).trim();
      expect(sidecar).toBe(egressSidecarName(containerName));
      const network = execSync(
        `docker network inspect --format '{{.Internal}}' ${egressNetworkName(containerName)}`,
        { encoding: "utf8" },
      ).trim();
      expect(network).toBe("true");
    });

    it("allows an allowlisted host through the proxy", async () => {
      // Application-level success, not just connect(): git actually completes
      // the ls-remote through the sidecar CONNECT tunnel.
      const result = await sandbox.runCommand(
        "git ls-remote https://github.com/octocat/Hello-World.git HEAD",
        { cwd: "/", timeoutMs: 60_000 },
      );
      expect(result).toContain("HEAD");
    });

    it("blocks a non-allowlisted host (proxy 403) and logs a deny event", async () => {
      await expect(
        sandbox.runCommand(
          "git ls-remote https://gitlab.com/gitlab-org/gitlab.git HEAD",
          { cwd: "/", timeoutMs: 60_000 },
        ),
      ).rejects.toThrow();
      const logs = execSync(
        `docker logs ${egressSidecarName(containerName)} 2>&1`,
        { encoding: "utf8" },
      );
      expect(logs).toContain('"destinationHost":"gitlab.com"');
      expect(logs).toContain('"action":"deny"');
      expect(logs).toContain('"action":"allow"');
    });

    it("has no direct route out (internal network, env-unset cannot bypass)", async () => {
      // Even with the proxy env cleared, the internal network offers no path
      // to the internet — application-level failure expected.
      await expect(
        sandbox.runCommand(
          "env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy git ls-remote https://github.com/octocat/Hello-World.git HEAD",
          { cwd: "/", timeoutMs: 60_000 },
        ),
      ).rejects.toThrow();
    });

    it("tears down sidecar + network on shutdown", async () => {
      await sandbox.shutdown();
      const sidecar = execSync(
        `docker ps -a --filter "name=${egressSidecarName(containerName)}" --format "{{.Names}}"`,
        { encoding: "utf8" },
      ).trim();
      expect(sidecar).toBe("");
      const network = execSync(
        `docker network ls --filter "name=${egressNetworkName(containerName)}" --format "{{.Name}}"`,
        { encoding: "utf8" },
      ).trim();
      expect(network).toBe("");
    });
  },
);
