import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DockerProvider } from "./docker-provider";
import {
  BrokeredSandboxNotResumableError,
  credBrokerNetworkName,
  credBrokerSidecarName,
} from "./docker-cred-broker";
import { setupGitCredentials, runSetupScript } from "../setup";
import type { CreateSandboxOptions, ISandboxSession } from "../types";

const TIMEOUT_MS = 5 * 60 * 1000;

// Opt-in provider E2E (mirrors docker-egress.integration.test.ts): drives the
// WIRED DockerProvider with a credentialBroker shape and proves the installation
// token is ABSENT from the guest on the CREATE path AND the setup-script path,
// and that a brokered RESUME fails closed BEFORE any unpause/reconnect —
// PAUSED (stays paused) AND RUNNING (no reconnect, so the raw-token resume
// setup never runs). Needs a docker daemon + the test base image. Run:
//   SANDBOX_PROVIDER=docker pnpm -C packages/sandbox vitest docker-cred-broker-provider.integration
describe(
  "docker cred-broker provider wiring (integration)",
  { skip: process.env.SANDBOX_PROVIDER !== "docker", timeout: TIMEOUT_MS },
  () => {
    vi.setConfig({ testTimeout: TIMEOUT_MS });

    // GitHub 401s on an invalid injected token (no anonymous fallback when creds
    // are present), so the git-through-broker assertion needs a real token; the
    // token-absence assertions run regardless with the sentinel.
    const realToken = (() => {
      const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (fromEnv) return fromEnv;
      try {
        return execSync("gh auth token", { encoding: "utf8" }).trim() || null;
      } catch {
        return null;
      }
    })();
    const INJECTED_TOKEN =
      realToken ?? `ghs_sentinel_${randomBytes(8).toString("hex")}`;
    const RUN_BEARER = randomBytes(32).toString("hex");
    const REPO = "octocat/Hello-World";

    const provider = new DockerProvider();
    let sandbox: ISandboxSession;
    let containerName: string;

    const baseOptions: CreateSandboxOptions = {
      threadName: "cred-broker-test",
      agent: null,
      agentCredentials: null,
      userName: "test-user",
      userEmail: "test@example.com",
      githubAccessToken: INJECTED_TOKEN,
      githubRepoFullName: REPO,
      repoBaseBranchName: "master",
      userId: "user-123",
      sandboxProvider: "docker",
      sandboxSize: "small",
      createNewBranch: false,
      environmentVariables: [],
      autoUpdateDaemon: false,
      publicUrl: "http://localhost:3000",
      featureFlags: {},
      credentialBroker: {
        installationToken: INJECTED_TOKEN,
        runBearer: RUN_BEARER,
        repoFullName: REPO,
      },
      credentialBrokerMode: "brokered",
      generateBranchName: async () => null,
      onStatusUpdate: async () => {},
    };

    beforeAll(async () => {
      sandbox = await provider.getOrCreateSandbox(null, baseOptions);
      containerName = execSync(
        `docker inspect --format '{{.Name}}' ${sandbox.sandboxId}`,
        { encoding: "utf8" },
      )
        .trim()
        .replace(/^\//, "");
      // Apply the brokered guest git wiring (the create-path setup step).
      await setupGitCredentials(sandbox, baseOptions);
      // The repo working dir normally comes from the clone in setupSandboxOneTime;
      // this focused provider test skips that, so init a git repo there (the
      // setup-script runner runs `git status` in it).
      await sandbox.runCommand("git init /root/repo", { cwd: "/" });
    }, TIMEOUT_MS);

    afterAll(async () => {
      try {
        await sandbox?.shutdown();
      } catch {}
      await DockerProvider.cleanupTestContainers();
    });

    it("stands up the cred-broker sidecar on a dedicated network", () => {
      const sidecar = execSync(
        `docker ps --filter "name=${credBrokerSidecarName(containerName)}" --format "{{.Names}}"`,
        { encoding: "utf8" },
      ).trim();
      expect(sidecar).toBe(credBrokerSidecarName(containerName));
      const network = execSync(
        `docker network ls --filter "name=${credBrokerNetworkName(containerName)}" --format "{{.Name}}"`,
        { encoding: "utf8" },
      ).trim();
      expect(network).toBe(credBrokerNetworkName(containerName));
    });

    it.skipIf(!realToken)(
      "guest git reaches github.com through the broker with only a bearer",
      async () => {
        const out = await sandbox.runCommand(
          `git ls-remote https://github.com/${REPO}.git HEAD`,
          { cwd: "/", timeoutMs: 60_000 },
        );
        expect(out).toContain("HEAD");
      },
    );

    it("the installation token is ABSENT from the guest (git config + credentials)", async () => {
      const config = await sandbox.runCommand("git config --global --list", {
        cwd: "/",
      });
      expect(config).toContain(`Authorization: Bearer ${RUN_BEARER}`);
      expect(config).not.toContain(INJECTED_TOKEN);
      expect(config).not.toContain("x-access-token");

      const creds = await sandbox
        .runCommand("cat ~/.git-credentials 2>&1 || true", { cwd: "/" })
        .catch(() => "");
      expect(creds).not.toContain(INJECTED_TOKEN);
    });

    it("the token is NOT visible via docker inspect of the sidecar (.Config.Env)", () => {
      const inspected = execSync(
        `docker inspect --format '{{json .Config.Env}}' ${credBrokerSidecarName(containerName)}`,
        { encoding: "utf8" },
      );
      expect(inspected).not.toContain(INJECTED_TOKEN);
      expect(inspected).not.toContain(RUN_BEARER);
    });

    it("the setup-script path env carries only the bearer, never the token", async () => {
      // The Docker provider's runCommand doesn't stream stdout to callbacks, so
      // have the script persist what IT sees to a guest file, then read it back.
      const marker = "/tmp/setup-env-check.txt";
      await runSetupScript({
        session: sandbox,
        options: {
          environmentVariables: [],
          githubAccessToken: INJECTED_TOKEN,
          agentCredentials: null,
          credentialBroker: baseOptions.credentialBroker,
          setupScript: `echo "GH_TOKEN=[$GH_TOKEN] GH_REPO=[$GH_REPO]" > ${marker}`,
        },
      });
      const captured = await sandbox.runCommand(`cat ${marker}`, { cwd: "/" });
      expect(captured).toContain(`GH_TOKEN=[${RUN_BEARER}]`);
      expect(captured).toContain(`GH_REPO=[${REPO}]`);
      expect(captured).not.toContain(INJECTED_TOKEN);
      expect(captured).not.toContain("x-access-token");
    });

    it("brokered RESUME of a PAUSED guest fails closed BEFORE any unpause", async () => {
      execSync(`docker pause ${sandbox.sandboxId}`, { stdio: "ignore" });
      try {
        await expect(
          provider.getOrCreateSandbox(sandbox.sandboxId, baseOptions),
        ).rejects.toBeInstanceOf(BrokeredSandboxNotResumableError);
        // The guest was NOT unpaused by the refused resume.
        const status = execSync(
          `docker inspect --format '{{.State.Status}}' ${sandbox.sandboxId}`,
          { encoding: "utf8" },
        ).trim();
        expect(status).toBe("paused");
      } finally {
        execSync(`docker unpause ${sandbox.sandboxId}`, { stdio: "ignore" });
      }
    });

    it("brokered RESUME of a RUNNING guest ALSO fails closed (no reconnect, no raw-token resume setup)", async () => {
      // #114 CRITICAL: reconnecting to a running brokered guest would let the
      // control plane run setupSandboxEveryTime → setupGitCredentials WITHOUT
      // the create-only broker shape, writing the raw token to
      // ~/.git-credentials. The provider must refuse a running brokered guest
      // too, not just a paused one.
      const before = execSync(
        `docker inspect --format '{{.State.Status}}' ${sandbox.sandboxId}`,
        { encoding: "utf8" },
      ).trim();
      expect(before).toBe("running");
      await expect(
        provider.getOrCreateSandbox(sandbox.sandboxId, baseOptions),
      ).rejects.toBeInstanceOf(BrokeredSandboxNotResumableError);
      // The guest is still running (untouched) and, crucially, no raw token was
      // written: the refused resume never reached setupGitCredentials, and the
      // guest still carries only the brokered bearer git-config from create.
      const after = execSync(
        `docker inspect --format '{{.State.Status}}' ${sandbox.sandboxId}`,
        { encoding: "utf8" },
      ).trim();
      expect(after).toBe("running");
      const creds = await sandbox
        .runCommand("cat ~/.git-credentials 2>&1 || true", { cwd: "/" })
        .catch(() => "");
      expect(creds).not.toContain(INJECTED_TOKEN);
      const config = await sandbox.runCommand("git config --global --list", {
        cwd: "/",
      });
      expect(config).toContain(`Authorization: Bearer ${RUN_BEARER}`);
      expect(config).not.toContain(INJECTED_TOKEN);
    });

    it("shutdown tears down the guest, sidecar, and network", async () => {
      await sandbox.shutdown();
      const sidecar = execSync(
        `docker ps -a --filter "name=${credBrokerSidecarName(containerName)}" --format "{{.Names}}"`,
        { encoding: "utf8" },
      ).trim();
      expect(sidecar).toBe("");
      const network = execSync(
        `docker network ls --filter "name=${credBrokerNetworkName(containerName)}" --format "{{.Name}}"`,
        { encoding: "utf8" },
      ).trim();
      expect(network).toBe("");
    });
  },
);
