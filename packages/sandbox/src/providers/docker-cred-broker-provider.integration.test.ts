import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DockerProvider } from "./docker-provider";
import {
  BrokeredSandboxNotResumableError,
  CRED_BROKER_ROLE_LABEL_KEY,
  CRED_BROKER_ROLE_LABEL_VALUE,
  ORPHAN_BROKER_MIN_AGE_MS,
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

// #114 (MED) pre-create reclaim: an uncatchable pre-id create timeout can leave
// a stale same-name broker sidecar/network behind (guest `docker run` abandoned
// after the sidecar is already up). The next brokered create must RECLAIM that
// orphan rather than fail on the `docker run -d --name` collision. Drives the
// wired setUpCredentialBroker with a pre-seeded same-name orphan and proves the
// stale sidecar is force-removed and replaced by a fresh, ready one.
describe(
  "docker cred-broker pre-create reclaim (integration)",
  { skip: process.env.SANDBOX_PROVIDER !== "docker", timeout: TIMEOUT_MS },
  () => {
    vi.setConfig({ testTimeout: TIMEOUT_MS });

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
    // TEST_CONTAINER_PREFIX ("terragon-sandbox-test") so cleanupTestContainers
    // sweeps whatever this test leaves behind.
    const containerName = `terragon-sandbox-test-reclaim-${randomBytes(4).toString("hex")}`;
    const sidecarName = credBrokerSidecarName(containerName);
    const networkName = credBrokerNetworkName(containerName);
    const BASE_IMAGE = "ghcr.io/terragon-labs/containers-test";

    const provider = new DockerProvider();

    afterAll(async () => {
      // setUpCredentialBroker is transactional but leaves the freshly-created
      // sidecar/network up on success; tear them down explicitly.
      try {
        execSync(`docker rm -f ${sidecarName}`, { stdio: "ignore" });
      } catch {}
      try {
        execSync(`docker network rm ${networkName}`, { stdio: "ignore" });
      } catch {}
      await DockerProvider.cleanupTestContainers();
    });

    it("force-removes a stale same-name sidecar and stands up a fresh ready one", async () => {
      // Seed the orphan: a same-name sidecar attached to a same-name network,
      // exactly what a pre-id create timeout would strand.
      execSync(`docker network create ${networkName}`, { stdio: "ignore" });
      execSync(
        `docker run -d --name ${sidecarName} --network ${networkName} ${BASE_IMAGE} tail -f /dev/null`,
        { stdio: "ignore" },
      );
      const orphanId = execSync(
        `docker inspect --format '{{.Id}}' ${sidecarName}`,
        { encoding: "utf8" },
      ).trim();

      // The next brokered create (via the private setup step) must reclaim it,
      // not throw on the name collision. Resolving at all proves the readiness
      // barrier passed against the FRESH sidecar.
      await (
        provider as unknown as {
          setUpCredentialBroker: (
            containerName: string,
            broker: NonNullable<CreateSandboxOptions["credentialBroker"]>,
            opts: {
              networkName: string;
              createNetwork: boolean;
              connectBridge: boolean;
            },
          ) => Promise<void>;
        }
      ).setUpCredentialBroker(
        containerName,
        {
          installationToken: INJECTED_TOKEN,
          runBearer: RUN_BEARER,
          repoFullName: REPO,
        },
        { networkName, createNetwork: true, connectBridge: false },
      );

      // A sidecar with the same NAME is up again, but it's a DIFFERENT container
      // (the orphan was force-removed and replaced) — the reclaim happened.
      const freshId = execSync(
        `docker inspect --format '{{.Id}}' ${sidecarName}`,
        { encoding: "utf8" },
      ).trim();
      expect(freshId).not.toBe(orphanId);
      const running = execSync(
        `docker inspect --format '{{.State.Running}}' ${sidecarName}`,
        { encoding: "utf8" },
      ).trim();
      expect(running).toBe("true");
    });
  },
);

// #114 (bounded MED) SAFE auto-reclaim of DIFFERENT-name orphans: a pre-id
// create timeout can strand a broker sidecar/network under the abandoned run's
// name (a DIFFERENT name than any later create's fresh nanoid), so the same-name
// reclaim never catches it. reclaimOrphanedBrokerResources sweeps AGED +
// UNREFERENCED broker orphans on every brokered create — while NEVER touching a
// concurrent live sandbox's broker (young, or with a running/paused guest). This
// drives the private reclaim directly with a controllable age threshold to prove
// both halves without waiting 10 real minutes.
describe(
  "docker cred-broker orphan auto-reclaim (integration)",
  { skip: process.env.SANDBOX_PROVIDER !== "docker", timeout: TIMEOUT_MS },
  () => {
    vi.setConfig({ testTimeout: TIMEOUT_MS });

    const BASE_IMAGE = "ghcr.io/terragon-labs/containers-test";
    const provider = new DockerProvider();

    // A running-container name that the reclaim must treat as the in-flight
    // create and never touch. All names TEST_CONTAINER_PREFIX-scoped so
    // cleanupTestContainers sweeps them.
    const tag = randomBytes(4).toString("hex");
    const CURRENT = `terragon-sandbox-test-current-${tag}`;

    // Names created across the cases, torn down in afterAll.
    const created: {
      sidecars: string[];
      networks: string[];
      guests: string[];
    } = { sidecars: [], networks: [], guests: [] };

    const reclaim = (minAgeMs: number) =>
      (
        provider as unknown as {
          reclaimOrphanedBrokerResources: (
            currentContainerName: string,
            minAgeMs?: number,
          ) => void;
        }
      ).reclaimOrphanedBrokerResources(CURRENT, minAgeMs);

    /** Seed an orphan broker: sidecar + dedicated network, NO guest. */
    function seedOrphan(guestName: string) {
      const net = credBrokerNetworkName(guestName);
      const sidecar = credBrokerSidecarName(guestName);
      execSync(`docker network create ${net}`, { stdio: "ignore" });
      // Stamp the same role label the real sidecar carries — the reclaim selects
      // candidates by this label, not by the `-cred-broker` name suffix (#114).
      execSync(
        `docker run -d --name ${sidecar} --label ${CRED_BROKER_ROLE_LABEL_KEY}=${CRED_BROKER_ROLE_LABEL_VALUE} --network ${net} ${BASE_IMAGE} tail -f /dev/null`,
        { stdio: "ignore" },
      );
      created.networks.push(net);
      created.sidecars.push(sidecar);
      return { net, sidecar };
    }

    /** Seed a LIVE broker: sidecar + network + a RUNNING guest attached. */
    function seedLive(guestName: string) {
      const net = credBrokerNetworkName(guestName);
      const sidecar = credBrokerSidecarName(guestName);
      execSync(`docker network create ${net}`, { stdio: "ignore" });
      // Stamp the same role label the real sidecar carries — the reclaim selects
      // candidates by this label, not by the `-cred-broker` name suffix (#114).
      execSync(
        `docker run -d --name ${sidecar} --label ${CRED_BROKER_ROLE_LABEL_KEY}=${CRED_BROKER_ROLE_LABEL_VALUE} --network ${net} ${BASE_IMAGE} tail -f /dev/null`,
        { stdio: "ignore" },
      );
      execSync(
        `docker run -d --name ${guestName} --network ${net} ${BASE_IMAGE} tail -f /dev/null`,
        { stdio: "ignore" },
      );
      created.networks.push(net);
      created.sidecars.push(sidecar);
      created.guests.push(guestName);
      return { net, sidecar, guestName };
    }

    const containerExists = (name: string) =>
      execSync(`docker ps -a --filter "name=^${name}$" --format "{{.Names}}"`, {
        encoding: "utf8",
      }).trim() === name;
    const networkExists = (name: string) =>
      execSync(
        `docker network ls --filter "name=^${name}$" --format "{{.Name}}"`,
        { encoding: "utf8" },
      ).trim() === name;

    afterAll(async () => {
      for (const s of created.sidecars) {
        try {
          execSync(`docker rm -f ${s}`, { stdio: "ignore" });
        } catch {}
      }
      for (const g of created.guests) {
        try {
          execSync(`docker rm -f ${g}`, { stdio: "ignore" });
        } catch {}
      }
      for (const n of created.networks) {
        try {
          execSync(`docker network rm ${n}`, { stdio: "ignore" });
        } catch {}
      }
      await DockerProvider.cleanupTestContainers();
    });

    it("reclaims an AGED + UNREFERENCED orphan with a DIFFERENT name than the current run", () => {
      const guest = `terragon-sandbox-test-orphan-${tag}`;
      const { net, sidecar } = seedOrphan(guest);
      expect(containerExists(sidecar)).toBe(true);
      expect(networkExists(net)).toBe(true);

      // minAgeMs 0 → the freshly-seeded orphan already clears the age gate; with
      // no live guest it is a genuine orphan and must be swept.
      reclaim(0);

      expect(containerExists(sidecar)).toBe(false);
      expect(networkExists(net)).toBe(false);
    });

    it("does NOT touch a concurrent LIVE sandbox's broker (running guest attached), even when aged", () => {
      const guest = `terragon-sandbox-test-live-${tag}`;
      const { net, sidecar, guestName } = seedLive(guest);
      expect(containerExists(sidecar)).toBe(true);
      expect(containerExists(guestName)).toBe(true);

      // Even with minAgeMs 0, the running guest marks the broker as referenced —
      // the reclaim must leave the sidecar, network, AND guest alone.
      reclaim(0);

      expect(containerExists(sidecar)).toBe(true);
      expect(networkExists(net)).toBe(true);
      expect(containerExists(guestName)).toBe(true);
    });

    it("does NOT touch a YOUNG unreferenced broker (a concurrent create's pre-attach window)", () => {
      const guest = `terragon-sandbox-test-young-${tag}`;
      const { net, sidecar } = seedOrphan(guest);
      expect(containerExists(sidecar)).toBe(true);

      // The default threshold (boot timeout + margin) treats this just-seeded,
      // guestless broker as an in-flight create — it must be preserved.
      reclaim(ORPHAN_BROKER_MIN_AGE_MS);

      expect(containerExists(sidecar)).toBe(true);
      expect(networkExists(net)).toBe(true);
    });

    it("does NOT misclassify a live GUEST whose name ends in -cred-broker (#114 HIGH 1 — label-based selection)", () => {
      // A guest's nanoid name CAN legitimately end in the sidecar suffix. Under
      // the old suffix-based classification this running guest would be treated
      // as a sidecar and force-removed. Selection is now by the role LABEL, which
      // this guest does NOT carry — it must be left running, even at minAgeMs 0.
      const collidingGuest = `terragon-sandbox-test-collide-${tag}-cred-broker`;
      execSync(
        `docker run -d --name ${collidingGuest} ${BASE_IMAGE} tail -f /dev/null`,
        { stdio: "ignore" },
      );
      created.guests.push(collidingGuest);
      expect(containerExists(collidingGuest)).toBe(true);

      reclaim(0);

      expect(containerExists(collidingGuest)).toBe(true);
    });
  },
);
