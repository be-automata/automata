import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DockerProvider } from "./docker-provider";
import {
  BrokeredSandboxNotResumableError,
  CRED_BROKER_ALIAS,
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
        kind: "docker-sidecar",
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
          kind: "docker-sidecar",
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

    /**
     * Seed a BARE broker network: the dedicated `--internal`-style network only,
     * with NO sidecar and NO guest — exactly what a create leaves stranded when
     * the network create succeeds but the sidecar `docker run` is abandoned. The
     * network-only reclaim loop (docker-provider.ts) targets these.
     */
    function seedBareNetwork(guestName: string) {
      const net = credBrokerNetworkName(guestName);
      execSync(`docker network create ${net}`, { stdio: "ignore" });
      created.networks.push(net);
      return { net };
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

    it("does NOT reclaim a broker whose guest is present but not yet RUNNING (state `created`) — widened any-state presence (#114 residual TOCTOU)", () => {
      // The residual race: the running/paused-only snapshot misses a guest that
      // has been `docker create`d (exists as a container in state `created`) but
      // not yet started. Seed an aged orphan, then create — but do NOT start —
      // its guest. The widened any-state `guestExists` recheck must treat the
      // `created` guest as present and leave the whole broker intact.
      const guest = `terragon-sandbox-test-created-${tag}`;
      const { net, sidecar } = seedOrphan(guest);
      execSync(
        `docker create --name ${guest} --network ${net} ${BASE_IMAGE} tail -f /dev/null`,
        { stdio: "ignore" },
      );
      created.guests.push(guest);
      // Sanity: the guest exists but is NOT running/paused.
      const state = execSync(
        `docker inspect --format '{{.State.Status}}' ${guest}`,
        { encoding: "utf8" },
      ).trim();
      expect(state).toBe("created");

      // Even at minAgeMs 0 (age gate satisfied), the created-state guest marks
      // the broker referenced — sidecar, network, and guest must all survive.
      reclaim(0);

      expect(containerExists(sidecar)).toBe(true);
      expect(networkExists(net)).toBe(true);
      expect(containerExists(guest)).toBe(true);
    });

    it("dedicated-network reclaim is network-guard-FIRST: an endpoint attached in the window LEAVES the sidecar AND network intact (#114 Codex HIGH — final fix)", () => {
      // Network-guard-first: the reclaim disconnects ONLY the sidecar, then runs
      // a NON-force `docker network rm` as the atomic proof-of-no-guest BEFORE
      // the sidecar is ever removed. If a guest raced into the window it still
      // holds an endpoint, so the rm FAILS → the sidecar is reconnected and the
      // WHOLE reclaim is skipped. This is the fix for the old order (which force-
      // removed the sidecar first and could orphan a live guest's broker).
      // Simulate the racing guest with an extra running container attached to the
      // dedicated net (NOT name-matching the guest, so `guestExists(guest)` is
      // false and the reclaim proceeds to the destructive tail).
      const guest = `terragon-sandbox-test-netguard-${tag}`;
      const { net, sidecar } = seedOrphan(guest);
      const squatter = `terragon-sandbox-test-squatter-${tag}`;
      execSync(
        `docker run -d --name ${squatter} --network ${net} ${BASE_IMAGE} tail -f /dev/null`,
        { stdio: "ignore" },
      );
      created.guests.push(squatter);
      expect(containerExists(sidecar)).toBe(true);
      expect(networkExists(net)).toBe(true);

      // minAgeMs 0 → age gate satisfied; guestExists(guest) is false (no
      // container named `guest`), so the reclaim reaches the network-rm gate.
      reclaim(0);

      // Gate fired BEFORE the sidecar was touched: the sidecar survives (and is
      // reconnected to the net), the network survives (non-force rm refused on
      // the squatter endpoint), and the squatter is untouched — all left for a
      // later pass rather than tearing down a possibly-live guest's broker.
      expect(containerExists(sidecar)).toBe(true);
      expect(networkExists(net)).toBe(true);
      expect(containerExists(squatter)).toBe(true);
      // The reconnected sidecar is back on the dedicated net (its broker path to
      // the racing guest is restored, not left detached).
      const attached = execSync(
        `docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' ${net}`,
        { encoding: "utf8" },
      ).trim();
      expect(attached).toContain(sidecar);
      // #114 Codex HIGH: the reconnect MUST restore the broker DNS alias, not
      // just the raw endpoint. The original attach used
      // `--network-alias ${CRED_BROKER_ALIAS}` and the live (racing) guest
      // resolves the broker by that alias — reconnecting without it leaves the
      // guest on the net yet unable to resolve `${CRED_BROKER_ALIAS}`, silently
      // breaking its git. Assert the sidecar's endpoint on the dedicated net
      // carries the alias again.
      const sidecarAliases = execSync(
        `docker inspect --format '{{range .NetworkSettings.Networks}}{{range .Aliases}}{{.}} {{end}}{{end}}' ${sidecar}`,
        { encoding: "utf8" },
      ).trim();
      expect(sidecarAliases).toContain(CRED_BROKER_ALIAS);
      // End-to-end: the racing guest (squatter) can actually resolve the broker
      // by that alias over the shared dedicated net.
      const resolved = execSync(
        `docker exec ${squatter} getent hosts ${CRED_BROKER_ALIAS}`,
        { encoding: "utf8" },
      ).trim();
      expect(resolved).toContain(CRED_BROKER_ALIAS);
    });

    it("shared-egress broker (no dedicated net) is NOT auto-removed — left for same-name reclaim (#114 Codex HIGH — final fix)", () => {
      // Shared-egress brokers (createNetwork was false) live on the reused egress
      // network, so there is NO dedicated net whose non-force rm could atomically
      // prove no guest is attached. Without that gate, force-removing the sidecar
      // here could tear down a broker whose guest raced into the window — so the
      // auto-reclaim intentionally SKIPS them (they are reclaimed by the same-name
      // pre-create reclaim + explicit cleanup instead). Seed a labeled sidecar
      // with NO dedicated `credBrokerNetworkName` net (attached to the default
      // bridge), aged and guestless — it must still survive the reclaim.
      const guest = `terragon-sandbox-test-shared-${tag}`;
      const sidecar = credBrokerSidecarName(guest);
      const dedicatedNet = credBrokerNetworkName(guest);
      execSync(
        `docker run -d --name ${sidecar} --label ${CRED_BROKER_ROLE_LABEL_KEY}=${CRED_BROKER_ROLE_LABEL_VALUE} ${BASE_IMAGE} tail -f /dev/null`,
        { stdio: "ignore" },
      );
      created.sidecars.push(sidecar);
      expect(containerExists(sidecar)).toBe(true);
      // Precondition: no dedicated broker net exists for this guest name.
      expect(networkExists(dedicatedNet)).toBe(false);

      // minAgeMs 0 → age gate satisfied, no guest → the sidecar reaches
      // reclaimBrokerSidecar, which finds no dedicated net and must SKIP.
      reclaim(0);

      expect(containerExists(sidecar)).toBe(true);
    });

    // #114 network-only reclaim: a create can strand a BARE broker network (the
    // `docker network create` landed but the sidecar `docker run` was abandoned),
    // so there is no sidecar to catch it in the sidecar loop. The network-only
    // loop reclaims aged, empty, guestless bare networks — while protecting a
    // network with anything attached, a live guest, or a young pre-attach window.
    it("reclaims an AGED, UNATTACHED, guestless BARE broker network (no sidecar)", () => {
      const guest = `terragon-sandbox-test-barenet-${tag}`;
      const { net } = seedBareNetwork(guest);
      expect(networkExists(net)).toBe(true);

      // minAgeMs 0 → the freshly-seeded network clears the age gate; nothing is
      // attached and no guest exists, so it is a genuine bare orphan → removed.
      reclaim(0);

      expect(networkExists(net)).toBe(false);
    });

    it("does NOT remove a BARE broker network that still has a container attached", () => {
      const guest = `terragon-sandbox-test-barenet-attached-${tag}`;
      const { net } = seedBareNetwork(guest);
      // Attach a squatter (NOT named as the guest, so `guestExists(guest)` is
      // false and the reclaim reaches the attached-container gate). The
      // `hasAttachedContainers` check must keep the network.
      const squatter = `terragon-sandbox-test-barenet-squatter-${tag}`;
      execSync(
        `docker run -d --name ${squatter} --network ${net} ${BASE_IMAGE} tail -f /dev/null`,
        { stdio: "ignore" },
      );
      created.guests.push(squatter);
      expect(networkExists(net)).toBe(true);

      // Even at minAgeMs 0 (age gate satisfied), the attached container marks the
      // network as still in use → it must be left intact.
      reclaim(0);

      expect(networkExists(net)).toBe(true);
      expect(containerExists(squatter)).toBe(true);
    });

    it("does NOT remove a BARE broker network whose live GUEST is running", () => {
      const guest = `terragon-sandbox-test-barenet-live-${tag}`;
      const { net } = seedBareNetwork(guest);
      // A running guest with the matching name attached to the bare net: the
      // live-guest reference gate (running/paused snapshot) must skip it before
      // any attachment inspect even runs.
      execSync(
        `docker run -d --name ${guest} --network ${net} ${BASE_IMAGE} tail -f /dev/null`,
        { stdio: "ignore" },
      );
      created.guests.push(guest);
      expect(containerExists(guest)).toBe(true);

      reclaim(0);

      expect(networkExists(net)).toBe(true);
      expect(containerExists(guest)).toBe(true);
    });

    it("does NOT remove a YOUNG bare broker network (a concurrent create's pre-attach window)", () => {
      const guest = `terragon-sandbox-test-barenet-young-${tag}`;
      const { net } = seedBareNetwork(guest);
      expect(networkExists(net)).toBe(true);

      // The default threshold (boot timeout + margin) treats this just-seeded,
      // empty network as an in-flight create's pre-attach window → preserved.
      reclaim(ORPHAN_BROKER_MIN_AGE_MS);

      expect(networkExists(net)).toBe(true);
    });
  },
);
