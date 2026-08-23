import { describe, it, expect, vi, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { CreateSandboxOptions } from "./types";

const TIMEOUT_MS = 5 * 60 * 1000;

// Shared holder so the hoisted ./setup mock can hand the container NAME (the key
// the broker sidecar/network derive from) back to the test.
const holder = vi.hoisted(() => ({
  containerName: null as string | null,
}));

// #114: force a SETUP failure right after the provider CREATE has stood up the
// guest + cred-broker sidecar + dedicated network + `:ro` secret file. This
// exercises the source-level teardown in getOrCreateSandbox (sandbox.ts): a
// setup throw on a CREATE must sweep those resources so an orphaned broker
// sidecar never keeps holding the installation token.
vi.mock("./setup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./setup")>();
  return {
    ...actual,
    setupSandboxEveryTime: vi.fn(
      async ({ session }: { session: { sandboxId: string } }) => {
        // The guest exists here — capture its name before we blow up so the test
        // can assert the derived sidecar/network are gone after teardown.
        try {
          holder.containerName = execSync(
            `docker inspect --format '{{.Name}}' ${session.sandboxId}`,
            { encoding: "utf8" },
          )
            .trim()
            .replace(/^\//, "");
        } catch {
          // ignore — the assertion on a null name will fail loudly instead
        }
        throw new Error("injected setup failure");
      },
    ),
    setupSandboxOneTime: vi.fn(async () => {}),
  };
});

import { getOrCreateSandbox } from "./sandbox";
import { DockerProvider } from "./providers/docker-provider";
import {
  credBrokerNetworkName,
  credBrokerSidecarName,
} from "./providers/docker-cred-broker";

// Opt-in provider E2E (mirrors docker-cred-broker-provider.integration.test.ts):
// needs a docker daemon + the test base image. Run:
//   SANDBOX_PROVIDER=docker pnpm -C packages/sandbox vitest sandbox-cred-broker-teardown.integration
describe(
  "brokered CREATE setup-failure teardown (integration)",
  { skip: process.env.SANDBOX_PROVIDER !== "docker", timeout: TIMEOUT_MS },
  () => {
    vi.setConfig({ testTimeout: TIMEOUT_MS });

    const INJECTED_TOKEN = `ghs_sentinel_${randomBytes(8).toString("hex")}`;
    const RUN_BEARER = randomBytes(32).toString("hex");
    const REPO = "octocat/Hello-World";

    const brokeredOptions: CreateSandboxOptions = {
      threadName: "cred-broker-teardown-test",
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

    afterAll(async () => {
      await DockerProvider.cleanupTestContainers();
    });

    it("a setup failure on a brokered CREATE leaves NO orphaned guest, sidecar, or network", async () => {
      let capturedSandboxId: string | null = null;
      const options: CreateSandboxOptions = {
        ...brokeredOptions,
        onStatusUpdate: async ({ sandboxId }) => {
          if (sandboxId) {
            capturedSandboxId = sandboxId;
          }
        },
      };

      await expect(getOrCreateSandbox(null, options)).rejects.toThrow(
        "injected setup failure",
      );

      // The provider published the fresh guest id (create succeeded) and the
      // broker sidecar name was captured mid-setup.
      expect(capturedSandboxId).toBeTruthy();
      expect(holder.containerName).toBeTruthy();
      const containerName = holder.containerName!;

      // Guest container is gone (teardown ran, not just abandoned).
      const guest = execSync(
        `docker ps -a --filter "id=${capturedSandboxId}" --format "{{.ID}}"`,
        { encoding: "utf8" },
      ).trim();
      expect(guest).toBe("");

      // Cred-broker sidecar is gone — no process still holding the token.
      const sidecar = execSync(
        `docker ps -a --filter "name=${credBrokerSidecarName(containerName)}" --format "{{.Names}}"`,
        { encoding: "utf8" },
      ).trim();
      expect(sidecar).toBe("");

      // Dedicated broker network is gone.
      const network = execSync(
        `docker network ls --filter "name=${credBrokerNetworkName(containerName)}" --format "{{.Name}}"`,
        { encoding: "utf8" },
      ).trim();
      expect(network).toBe("");
    });
  },
);
