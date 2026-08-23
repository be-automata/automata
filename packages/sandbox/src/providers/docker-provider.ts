import {
  BackgroundCommandOptions,
  CreateSandboxOptions,
  ISandboxProvider,
  ISandboxSession,
} from "../types";
import { execSync, spawn } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { nanoid } from "nanoid/non-secure";
import {
  EGRESS_NETWORK_PREFIX,
  buildEgressSidecarRunCommand,
  buildSandboxEgressRunFlags,
  egressNetworkName,
  egressSidecarName,
} from "./docker-egress";
import { EGRESS_PROXY_SCRIPT } from "../egress-proxy-standalone.generated";
import {
  BrokeredSandboxNotResumableError,
  CRED_BROKER_ALIAS,
  CRED_BROKER_GIT_PORT,
  CRED_BROKER_NETWORK_PREFIX,
  CRED_BROKER_SIDECAR_SUFFIX,
  ORPHAN_BROKER_MIN_AGE_MS,
  buildCredBrokerSecretsFileContent,
  buildCredBrokerSidecarRunCommand,
  buildSandboxCredBrokerRunFlags,
  credBrokerNetworkName,
  credBrokerSidecarName,
  isAgedUnreferencedBroker,
} from "./docker-cred-broker";
import { CRED_BROKER_SCRIPT } from "../cred-broker-standalone.generated";

/** Host path of one sandbox's `:ro` secret file — derived from the container
 * name (no per-session persistence needed; create→teardown lifetime, exactly
 * like the egress sidecar/network names). */
function credBrokerSecretHostPath(containerName: string): string {
  return path.join(os.tmpdir(), `automata-cred-secret-${containerName}.json`);
}

const HOME_DIR = "root";
const DEFAULT_DIR = `/${HOME_DIR}`;
const REPO_DIR = "repo";
const BASE_IMAGE = "ghcr.io/terragon-labs/containers-test";
const SLEEP_MS = 60 * 60 * 1000; // 1 hour

const CONTAINER_PREFIX = "terragon-sandbox";
const TEST_CONTAINER_PREFIX = `${CONTAINER_PREFIX}-test`;

class DockerSession implements ISandboxSession {
  public readonly sandboxProvider: "docker" = "docker";
  private hibernationTimeout?: NodeJS.Timeout;

  /**
   * `created` is present only on the CREATE path: the provider already knows
   * the container name and whether egress was configured, so teardown needs
   * no `docker inspect` and can skip egress teardown outright when no policy
   * was set. A session rehydrated from a bare sandboxId (resume path) falls
   * back to the inspect-based recovery in shutdown().
   */
  constructor(
    private containerId: string,
    private readonly created?: {
      containerName: string;
      egressConfigured: boolean;
      /** #114: the cred-broker sidecar + (broker-only) dedicated network +
       * host secret file were stood up for this container and must be torn
       * down with it. */
      credBrokerConfigured?: boolean;
      /** Whether the cred-broker used a DEDICATED (broker-only) network that
       * teardown must remove; false when it shared the egress internal net. */
      credBrokerDedicatedNetwork?: boolean;
    },
  ) {}

  get homeDir(): string {
    return HOME_DIR;
  }

  get repoDir(): string {
    return REPO_DIR;
  }

  get sandboxId(): string {
    return this.containerId;
  }

  async hibernate(): Promise<void> {
    // For debugging purposes, don't pause the container when hibernate is called
    // We automatically pause the container using the hibernation timeout instead.
    console.log("Hibernate called, but not pausing container");
  }

  async hibernateForced(): Promise<void> {
    console.log("Hibernate forced called, pausing container");
    try {
      execSync(`docker pause ${this.containerId}`, { stdio: "ignore" });
    } catch (error) {
      console.error(`Failed to pause container ${this.containerId}:`, error);
    }
  }

  private resetHibernationTimer(): void {
    if (this.hibernationTimeout) {
      clearTimeout(this.hibernationTimeout);
    }
    this.hibernationTimeout = setTimeout(() => {
      this.hibernateForced().catch(console.error);
    }, SLEEP_MS);
  }

  async runCommand(
    command: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      timeoutMs?: number;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    },
  ): Promise<string> {
    this.resetHibernationTimer();
    try {
      const envFlags = options?.env
        ? Object.entries(options.env)
            .map(([key, value]) => `-e ${key}="${value}"`)
            .join(" ")
        : "";

      const workDir = options?.cwd || REPO_DIR;
      const workDirPath = workDir.startsWith("/")
        ? workDir
        : path.join(DEFAULT_DIR, workDir);
      // Properly escape the command to prevent shell interpolation on the host
      // eg. if we run a command like `docker exec "ls ${which claude}"`, we don't want
      // which claude to run before getting pass to docker.
      const escapedCommand = command
        .replace(/\\/g, "\\\\") // Escape backslashes first
        .replace(/"/g, '\\"') // Escape double quotes
        .replace(/\$/g, "\\$") // Escape dollar signs to prevent variable expansion
        .replace(/`/g, "\\`"); // Escape backticks
      const dockerCommand = `docker exec ${envFlags} -w ${workDirPath} ${this.containerId} bash -c "${escapedCommand}"`;
      const result = execSync(dockerCommand, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 10,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: options?.timeoutMs || 0,
      });
      return result;
    } catch (error: any) {
      console.error("Error running Docker command:", error.message);
      if (error instanceof Error && error.message.includes("ETIMEDOUT")) {
        throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
      }
      if (error.status) {
        throw new Error(
          `Command failed with exit code ${error.status}\n\nstdout:\n ${error.stdout || "(empty)"}\nstderr:\n ${error.stderr || "(empty)"}`,
        );
      }
      throw error;
    }
  }

  async runBackgroundCommand(
    command: string,
    options?: BackgroundCommandOptions,
  ): Promise<void> {
    this.resetHibernationTimer();

    try {
      const envArgs: string[] = [];
      if (options?.env) {
        Object.entries(options.env).forEach(([key, value]) => {
          envArgs.push("-e", `${key}=${value}`);
        });
      }

      const dockerArgs = [
        "exec",
        ...envArgs,
        "-w",
        path.resolve(path.join(DEFAULT_DIR, REPO_DIR)),
        this.containerId,
        "bash",
        "-c",
        command,
      ];

      const child = spawn("docker", dockerArgs, { stdio: "pipe" });
      if (options?.onOutput) {
        child.stdout?.on("data", (data) => {
          options.onOutput!(data.toString());
        });
        child.stderr?.on("data", (data) => {
          options.onOutput!(data.toString());
        });
      }
    } catch (error) {
      console.error("Error running background Docker command:", error);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.hibernationTimeout) {
      clearTimeout(this.hibernationTimeout);
    }
    // The egress sidecar + internal network (derived from the container NAME,
    // #66 spec §3.5) must go with the container. On the CREATE path the name
    // and whether egress was configured are already known — no `docker
    // inspect`, and no teardown execs at all when no policy was set. A
    // rehydrated-from-sandboxId session (resume path) recovers the name via
    // inspect and best-efforts the teardown.
    let containerName: string | null = null;
    let tearDownEgress = true;
    // #114: on the CREATE path we know exactly whether a cred broker was set up
    // and whether it used a dedicated network. A rehydrated (resume) session is
    // never brokered (brokered sandboxes are non-resumable), so best-effort
    // idempotent teardown there is a safe no-op.
    let tearDownCredBroker = true;
    let credBrokerDedicatedNetwork = true;
    if (this.created) {
      containerName = this.created.containerName;
      tearDownEgress = this.created.egressConfigured;
      tearDownCredBroker = this.created.credBrokerConfigured ?? false;
      credBrokerDedicatedNetwork =
        this.created.credBrokerDedicatedNetwork ?? false;
    } else {
      try {
        containerName = execSync(
          `docker inspect --format '{{.Name}}' ${this.containerId}`,
          { encoding: "utf8" },
        )
          .trim()
          .replace(/^\//, "");
      } catch {
        // Container already gone — nothing to derive teardown names from.
      }
    }
    try {
      execSync(`docker rm -f ${this.containerId}`, { stdio: "ignore" });
    } catch (error) {
      console.error(`Failed to remove container ${this.containerId}:`, error);
      throw error;
    }
    if (containerName && tearDownEgress) {
      for (const command of [
        `docker rm -f ${egressSidecarName(containerName)}`,
        `docker network rm ${egressNetworkName(containerName)}`,
      ]) {
        try {
          execSync(command, { stdio: "ignore" });
        } catch {
          // No egress sidecar/network for this sandbox — nothing to remove.
        }
      }
    }
    // #114: tear down the cred-broker sidecar + (dedicated) network + host
    // secret file. All names derive from the container name — no per-session
    // persistence. Best-effort/idempotent.
    if (containerName && tearDownCredBroker) {
      const commands = [`docker rm -f ${credBrokerSidecarName(containerName)}`];
      if (credBrokerDedicatedNetwork) {
        commands.push(
          `docker network rm ${credBrokerNetworkName(containerName)}`,
        );
      }
      for (const command of commands) {
        try {
          execSync(command, { stdio: "ignore" });
        } catch {
          // No cred-broker sidecar/network for this sandbox — nothing to remove.
        }
      }
      await fs.unlink(credBrokerSecretHostPath(containerName)).catch(() => {});
    }
  }

  async readTextFile(filePath: string): Promise<string> {
    this.resetHibernationTimer();

    try {
      const result = execSync(
        `docker exec ${this.containerId} cat "${filePath}"`,
        { encoding: "utf8" },
      );
      return result;
    } catch (error) {
      console.error(`Failed to read file ${filePath}:`, error);
      throw error;
    }
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    this.resetHibernationTimer();

    try {
      // Create a temporary file to avoid shell escaping issues
      const tempFile = `/tmp/docker-write-${nanoid()}`;
      await fs.writeFile(tempFile, content);
      try {
        // Copy file to container
        execSync(`docker cp "${tempFile}" ${this.containerId}:"${filePath}"`, {
          stdio: "ignore",
        });
      } finally {
        // Clean up temp file
        await fs.unlink(tempFile).catch(() => {});
      }
    } catch (error) {
      console.error(`Failed to write file ${filePath}:`, error);
      throw error;
    }
  }

  async writeFile(filePath: string, content: Uint8Array): Promise<void> {
    this.resetHibernationTimer();

    try {
      // Create a temporary file to avoid shell escaping issues
      const tempFile = `/tmp/docker-write-${nanoid()}`;
      await fs.writeFile(tempFile, content);
      try {
        // Copy file to container
        execSync(`docker cp "${tempFile}" ${this.containerId}:"${filePath}"`, {
          stdio: "ignore",
        });
      } finally {
        // Clean up temp file
        await fs.unlink(tempFile).catch(() => {});
      }
    } catch (error) {
      console.error(`Failed to write binary file ${filePath}:`, error);
      throw error;
    }
  }
}

export class DockerProvider implements ISandboxProvider {
  constructor() {}

  async getSandboxOrNull(sandboxId: string): Promise<ISandboxSession | null> {
    // Try to resume existing container
    try {
      const inspectResult = execSync(`docker inspect ${sandboxId}`, {
        encoding: "utf8",
      });
      const containerInfo = JSON.parse(inspectResult)[0];
      if (containerInfo.State.Status === "paused") {
        execSync(`docker unpause ${sandboxId}`, { stdio: "ignore" });
      } else if (containerInfo.State.Status === "exited") {
        execSync(`docker start ${sandboxId}`, { stdio: "ignore" });
      }
      return new DockerSession(sandboxId);
    } catch (error) {
      console.warn(`Failed to resume container ${sandboxId}:`, error);
    }
    return null;
  }

  async getOrCreateSandbox(
    sandboxId: string | null,
    options: CreateSandboxOptions,
  ): Promise<ISandboxSession> {
    if (sandboxId) {
      // #114 fail-closed resume for brokered Docker sandboxes. A brokered guest
      // is NEVER resumed in place — RUNNING or paused/exited. Reconnecting to a
      // running guest is unsafe too: the control plane's resume setup
      // (setupSandboxEveryTime → setupGitCredentials) runs WITHOUT the
      // create-only broker shape, so it takes the legacy branch and writes the
      // raw installation token to ~/.git-credentials (and can restart the
      // daemon with it) — re-leaking the token the broker exists to withhold.
      // Unpausing a stale guest is doubly unsafe (races the surviving sidecar,
      // can't scrub a stopped daemon's env). So we refuse BEFORE any
      // unpause/start/reconnect and let the control plane recreate (fresh,
      // fail-closed). The signal is the NON-secret persisted provenance, never
      // the secret. Defense in depth: the control plane already routes brokered
      // resumes straight to recreate without calling resume here.
      if (options.credentialBrokerMode === "brokered") {
        throw new BrokeredSandboxNotResumableError(sandboxId);
      }
      const sandbox = await this.getSandboxOrNull(sandboxId);
      if (sandbox) {
        return sandbox;
      }
      throw new Error(`Sandbox ${sandboxId} not found`);
    }
    // Convert environment variables array to docker env flags
    const envFlags = options.environmentVariables
      ? options.environmentVariables
          .map(({ key, value }) => `-e ${key}="${value}"`)
          .join(" ")
      : "";

    // Generate unique container name with environment-aware prefix and timestamp
    const isTest = process.env.NODE_ENV === "test";
    const prefix = isTest ? TEST_CONTAINER_PREFIX : CONTAINER_PREFIX;
    const now = new Date();
    const dateStr = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const timeStr = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const containerName = `${prefix}-${dateStr}-${timeStr}-${nanoid()}`;
    // Egress enforcement (#66 spec §3.5): with a policy shape present, the
    // sandbox is pinned to an `--internal` network whose only way out is the
    // filtering proxy sidecar. Without one, the docker run below is exactly
    // today's path. ONE try/catch spans setup + docker run: on any failure the
    // partially-created egress resources are swept by the (idempotent,
    // best-effort) teardown before rethrowing.
    // Hoisted so the catch knows whether the broker owns a dedicated network
    // (vs. sharing the egress net) to teardown in the correct order.
    let credBrokerDedicatedNetwork = false;
    try {
      let egressFlags = "";
      if (options.egressPolicy) {
        egressFlags = await this.setUpEgressEnforcement(
          containerName,
          options.egressPolicy,
        );
      }
      // #114 credential broker: stand up a per-run cred-broker sidecar so the
      // guest never holds the installation token (git is routed through it via
      // the brokered git-config set in setup.ts). Network composition:
      //  - egress ALSO on: the sidecar joins the egress `--internal` network;
      //    the guest is already pinned there, so we just add the broker alias
      //    to its NO_PROXY (git's plain-HTTP call bypasses the egress proxy).
      //  - broker only: a DEDICATED user-defined (non-internal) network shared
      //    by guest + sidecar; the guest keeps normal internet (the broker
      //    fences the TOKEN, not egress).
      let credBrokerConfigured = false;
      let credGuestFlags = "";
      if (options.credentialBroker) {
        const usesEgressNetwork = egressFlags !== "";
        const brokerNetwork = usesEgressNetwork
          ? egressNetworkName(containerName)
          : credBrokerNetworkName(containerName);
        await this.setUpCredentialBroker(
          containerName,
          options.credentialBroker,
          {
            networkName: brokerNetwork,
            createNetwork: !usesEgressNetwork,
            connectBridge: usesEgressNetwork,
          },
        );
        credBrokerConfigured = true;
        credBrokerDedicatedNetwork = !usesEgressNetwork;
        if (usesEgressNetwork) {
          // Re-emit the egress guest flags with the broker alias in NO_PROXY.
          egressFlags = buildSandboxEgressRunFlags(
            egressNetworkName(containerName),
            [CRED_BROKER_ALIAS],
          );
        } else {
          credGuestFlags = buildSandboxCredBrokerRunFlags(brokerNetwork);
        }
      }
      // Exactly one of these pins the guest's network (egress net or the
      // dedicated broker net); both empty = today's default-bridge path.
      const networkFlags = egressFlags || credGuestFlags;
      // Create and start container
      const createCommand = networkFlags
        ? `docker run -d --name ${containerName} ${networkFlags} ${envFlags} -w ${DEFAULT_DIR} ${BASE_IMAGE} tail -f /dev/null`
        : `docker run -d --name ${containerName} ${envFlags} -w ${DEFAULT_DIR} ${BASE_IMAGE} tail -f /dev/null`;
      const containerId = execSync(createCommand, { encoding: "utf8" }).trim();
      return new DockerSession(containerId, {
        containerName,
        egressConfigured: egressFlags !== "",
        credBrokerConfigured,
        credBrokerDedicatedNetwork,
      });
    } catch (error) {
      console.error("Failed to create Docker sandbox:", error);
      // Order matters: remove the cred-broker sidecar FIRST so it detaches
      // from the (possibly shared) egress network. Otherwise, when the broker
      // shares the egress network (credBrokerDedicatedNetwork=false), the
      // egress `docker network rm` below fails on a still-attached container
      // and silently orphans the `--internal` network. When the broker owns no
      // network of its own, the egress teardown reclaims the shared one; only a
      // dedicated broker network is removed by the broker teardown itself.
      if (options.credentialBroker) {
        this.tearDownCredentialBroker(containerName, {
          removeNetwork: credBrokerDedicatedNetwork,
        });
      }
      if (options.egressPolicy) {
        this.tearDownEgressEnforcement(containerName);
      }
      throw error;
    }
  }

  /**
   * Create the internal network + proxy sidecar for one sandbox (#66 §3.5)
   * and return the extra `docker run` flags for the sandbox container.
   *
   * Audit v1: the sidecar logs every allow/deny as a JSON line to its stdout
   * (`docker logs <name>-egress`); control-plane audit POSTs from this plane
   * are a documented follow-up (docs/egress-enforcement.md).
   */
  private async setUpEgressEnforcement(
    containerName: string,
    egressPolicy: NonNullable<CreateSandboxOptions["egressPolicy"]>,
  ): Promise<string> {
    const networkName = egressNetworkName(containerName);
    const sidecarName = egressSidecarName(containerName);
    // Materialize the standalone proxy script (generated string module — the
    // single matcher source in this package) for the read-only bind mount.
    // Content-addressed + write-once: every create with the same embedded
    // script reuses ONE stable temp file (no per-create mkdtemp litter, no
    // cleanup needed).
    const scriptHash = createHash("sha256")
      .update(EGRESS_PROXY_SCRIPT)
      .digest("hex")
      .slice(0, 16);
    const scriptHostPath = path.join(
      os.tmpdir(),
      `automata-egress-${scriptHash}.cjs`,
    );
    try {
      await fs.writeFile(scriptHostPath, EGRESS_PROXY_SCRIPT, {
        mode: 0o444,
        flag: "wx", // write only if missing — the content-addressed name guarantees equality
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    try {
      // `docker network create --internal` — the internal net has no route out.
      execSync(`docker network create --internal ${networkName}`, {
        stdio: "ignore",
      });
    } catch (error) {
      // Idempotent: an already-existing network is fine, anything else is not.
      const exists = execSync(
        `docker network ls --filter name=^${networkName}$ --format '{{.Name}}'`,
        { encoding: "utf8" },
      ).trim();
      if (exists !== networkName) {
        throw error;
      }
    }
    execSync(
      buildEgressSidecarRunCommand({
        sidecarName,
        networkName,
        baseImage: BASE_IMAGE,
        scriptHostPath,
        policy: egressPolicy,
      }),
      { stdio: "ignore" },
    );
    // The sidecar (and only the sidecar) also gets a route out.
    execSync(`docker network connect bridge ${sidecarName}`, {
      stdio: "ignore",
    });
    return buildSandboxEgressRunFlags(networkName);
  }

  /**
   * Stand up the per-run credential-broker sidecar for one sandbox (#114):
   * materialize the broker script + a `0o400` `:ro` secret file (installation
   * token + per-run bearer — NEVER on argv/`-e`), attach the sidecar to the
   * given network under its alias, wait for its git listener (readiness
   * barrier), and clean up transactionally on any failure. The token lives only
   * inside the sidecar container (its mounted secret file / heap).
   */
  private async setUpCredentialBroker(
    containerName: string,
    broker: NonNullable<CreateSandboxOptions["credentialBroker"]>,
    opts: {
      networkName: string;
      createNetwork: boolean;
      connectBridge: boolean;
    },
  ): Promise<void> {
    const sidecarName = credBrokerSidecarName(containerName);
    const secretsHostPath = credBrokerSecretHostPath(containerName);
    // Content-addressed, write-once script mount (mirror the egress sidecar).
    const scriptHash = createHash("sha256")
      .update(CRED_BROKER_SCRIPT)
      .digest("hex")
      .slice(0, 16);
    const scriptHostPath = path.join(
      os.tmpdir(),
      `automata-cred-broker-${scriptHash}.cjs`,
    );
    try {
      // #114 SAFE auto-reclaim of DIFFERENT-name orphans: a pre-id create
      // timeout can also strand a broker sidecar/network under the ABANDONED
      // run's container name (the guest `docker run` is abandoned after the
      // sidecar/network are up, before the guest id surfaces, so the caller
      // can't sweep it by id). Every (re)create draws a fresh nanoid name, so
      // the same-name reclaim below never catches those. Sweep AGED +
      // UNREFERENCED broker orphans here so the next brokered create reclaims
      // the stranded token-holder — gated so it can NEVER touch a concurrent
      // live sandbox's broker (young, or with a running/paused guest attached).
      this.reclaimOrphanedBrokerResources(containerName);
      // #114 idempotent pre-create reclaim: an uncatchable pre-id create timeout
      // (the guest `docker run` is abandoned mid-flight after this sidecar +
      // network are already up) leaves a stale same-name broker sidecar/network
      // behind, and the `docker run -d --name` below would then collide. Sweep
      // any stale same-name broker resources BEFORE (re)creating so the next
      // brokered create reclaims the orphan instead of failing on it. Mirrors
      // the transactional teardown-on-failure below and the egress
      // network-create idempotency; best-effort, so a clean slate is a no-op.
      // Only drop the dedicated broker network here — when sharing the egress
      // network (createNetwork=false) that network is egress-owned and reused.
      this.tearDownCredentialBroker(containerName, {
        removeNetwork: opts.createNetwork,
      });
      try {
        await fs.writeFile(scriptHostPath, CRED_BROKER_SCRIPT, {
          mode: 0o444,
          flag: "wx", // content-addressed name guarantees equality
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      // Per-run secret file (mode 0o400). Unique per container name; overwrite
      // any stale file from a previous same-named run (there is none in
      // practice — names carry a nanoid).
      await fs.writeFile(
        secretsHostPath,
        buildCredBrokerSecretsFileContent({
          installationToken: broker.installationToken,
          runBearer: broker.runBearer,
        }),
        { mode: 0o400 },
      );
      if (opts.createNetwork) {
        // Dedicated user-defined (NON-internal) network: guest + sidecar reach
        // each other by alias and both keep normal outbound internet.
        try {
          execSync(`docker network create ${opts.networkName}`, {
            stdio: "ignore",
          });
        } catch (error) {
          const exists = execSync(
            `docker network ls --filter name=^${opts.networkName}$ --format '{{.Name}}'`,
            { encoding: "utf8" },
          ).trim();
          if (exists !== opts.networkName) {
            throw error;
          }
        }
      }
      execSync(
        buildCredBrokerSidecarRunCommand({
          sidecarName,
          networkName: opts.networkName,
          baseImage: BASE_IMAGE,
          scriptHostPath,
          secretsHostPath,
          repoFullName: broker.repoFullName,
        }),
        { stdio: "ignore" },
      );
      if (opts.connectBridge) {
        // The egress `--internal` network has no route out; give the sidecar
        // (and only the sidecar) a path to github.com via the default bridge.
        execSync(`docker network connect bridge ${sidecarName}`, {
          stdio: "ignore",
        });
      }
      await this.waitForCredBrokerReady(sidecarName);
    } catch (error) {
      // Transactional: sweep any partial broker resources before rethrowing.
      this.tearDownCredentialBroker(containerName, {
        removeNetwork: opts.createNetwork,
      });
      throw error;
    }
  }

  /** Readiness barrier: poll the sidecar's git listener until it accepts a
   * connection, so the guest's first clone can't race it. Fails closed. */
  private async waitForCredBrokerReady(
    sidecarName: string,
    maxAttempts = 40,
    intervalMs = 500,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        execSync(
          `docker exec ${sidecarName} bash -c "timeout 1 bash -c '</dev/tcp/127.0.0.1/${CRED_BROKER_GIT_PORT}'"`,
          { stdio: "ignore" },
        );
        return;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `cred-broker sidecar ${sidecarName} never bound its git listener`,
    );
  }

  /** Best-effort, idempotent sweep of one sandbox's cred-broker sidecar +
   * (dedicated) network + host secret file. */
  private tearDownCredentialBroker(
    containerName: string,
    opts: { removeNetwork?: boolean } = { removeNetwork: true },
  ): void {
    const commands = [`docker rm -f ${credBrokerSidecarName(containerName)}`];
    if (opts.removeNetwork ?? true) {
      commands.push(
        `docker network rm ${credBrokerNetworkName(containerName)}`,
      );
    }
    for (const command of commands) {
      try {
        execSync(command, { stdio: "ignore" });
      } catch {
        // Best-effort cleanup of partially-created broker resources.
      }
    }
    fs.unlink(credBrokerSecretHostPath(containerName)).catch(() => {});
  }

  /**
   * #114 SAFE create-time reclaim of AGED + UNREFERENCED orphan cred-broker
   * resources. A pre-id create timeout can strand a broker sidecar/network under
   * the abandoned run's container name (a DIFFERENT name than any later create's
   * fresh nanoid), so the same-name reclaim in {@link setUpCredentialBroker}
   * never catches it and the stranded sidecar keeps holding the installation
   * token until the (test-only) prefix sweep runs. This closes that gap on the
   * live path.
   *
   * Safety (Codex non-regression): a broker is removed ONLY when it is BOTH
   * older than {@link ORPHAN_BROKER_MIN_AGE_MS} AND has no live (running/paused)
   * guest attached — see {@link isAgedUnreferencedBroker}. A concurrent LIVE
   * sandbox's broker is always either young (its create is still in flight) or
   * has a running/paused guest, so it can never be selected. A guest that is
   * itself still running is treated as live and left untouched — we never
   * force-remove a running guest or its broker. Best-effort/idempotent: any
   * docker error (daemon down, resource already gone, network still attached)
   * is swallowed so a broker create never fails on cleanup.
   */
  private reclaimOrphanedBrokerResources(
    currentContainerName: string,
    minAgeMs: number = ORPHAN_BROKER_MIN_AGE_MS,
  ): void {
    const isTest = process.env.NODE_ENV === "test";
    const containerPrefix = isTest ? TEST_CONTAINER_PREFIX : CONTAINER_PREFIX;
    const nowMs = Date.now();

    // One pass over every container carrying our prefix: classify broker
    // sidecars vs. their (potentially live) guests. A guest is "live" — hence
    // its broker is referenced — when running OR paused (a hibernated guest may
    // still resume; treat it as live so we never touch it).
    let rows: string[] = [];
    try {
      rows = execSync(
        `docker ps -a --filter name=${containerPrefix} --format '{{.Names}}|{{.State}}'`,
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter((r) => r.trim());
    } catch {
      // Docker unavailable / nothing listed — nothing to reclaim.
      return;
    }
    const liveGuestNames = new Set<string>();
    const sidecarNames: string[] = [];
    for (const row of rows) {
      const [name, state] = row.split("|");
      if (!name) {
        continue;
      }
      if (name.endsWith(CRED_BROKER_SIDECAR_SUFFIX)) {
        sidecarNames.push(name);
      } else if (state === "running" || state === "paused") {
        liveGuestNames.add(name);
      }
    }

    // Sidecars: reclaim the aged, unreferenced ones (sidecar + its dedicated
    // network + host secret file).
    for (const sidecar of sidecarNames) {
      const guestName = sidecar.slice(0, -CRED_BROKER_SIDECAR_SUFFIX.length);
      if (guestName === currentContainerName || liveGuestNames.has(guestName)) {
        continue; // in-flight run or live guest → keep (no inspect needed).
      }
      let createdAtMs = NaN;
      try {
        createdAtMs = Date.parse(
          execSync(`docker inspect --format '{{.Created}}' ${sidecar}`, {
            encoding: "utf8",
          }).trim(),
        );
      } catch {
        continue; // Vanished between listing and inspect.
      }
      if (
        !isAgedUnreferencedBroker({
          containerName: guestName,
          createdAtMs,
          guestAlive: false,
          nowMs,
          minAgeMs,
          currentContainerName,
        })
      ) {
        continue;
      }
      this.tearDownCredentialBroker(guestName, { removeNetwork: true });
    }

    // Networks stranded WITHOUT a sidecar (network create succeeded but the
    // sidecar run was abandoned): reclaim aged ones with nothing attached. A
    // live sandbox's broker network always has its sidecar+guest attached, so
    // an empty container list can't belong to a live sandbox; the age gate
    // still protects a concurrent create's pre-attach window.
    let netNames: string[] = [];
    try {
      netNames = execSync(
        `docker network ls --filter name=${CRED_BROKER_NETWORK_PREFIX}${containerPrefix} --format '{{.Name}}'`,
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter((n) => n.trim());
    } catch {
      return;
    }
    for (const net of netNames) {
      const guestName = net.slice(CRED_BROKER_NETWORK_PREFIX.length);
      if (
        !guestName ||
        guestName === currentContainerName ||
        liveGuestNames.has(guestName)
      ) {
        continue;
      }
      let createdAtMs = NaN;
      let hasAttachedContainers = true;
      try {
        createdAtMs = Date.parse(
          execSync(`docker network inspect --format '{{.Created}}' ${net}`, {
            encoding: "utf8",
          }).trim(),
        );
        const containersJson = execSync(
          `docker network inspect --format '{{json .Containers}}' ${net}`,
          { encoding: "utf8" },
        ).trim();
        hasAttachedContainers =
          containersJson !== "{}" && containersJson !== "null";
      } catch {
        continue; // Vanished between listing and inspect.
      }
      if (hasAttachedContainers) {
        continue; // Something still attached → not a bare orphan.
      }
      if (
        !isAgedUnreferencedBroker({
          containerName: guestName,
          createdAtMs,
          guestAlive: false,
          nowMs,
          minAgeMs,
          currentContainerName,
        })
      ) {
        continue;
      }
      try {
        execSync(`docker network rm ${net}`, { stdio: "ignore" });
      } catch {
        // Still in use or already gone — leave it.
      }
      fs.unlink(credBrokerSecretHostPath(guestName)).catch(() => {});
    }
  }

  /** Best-effort, idempotent sweep of one sandbox's egress sidecar + network. */
  private tearDownEgressEnforcement(containerName: string): void {
    for (const command of [
      `docker rm -f ${egressSidecarName(containerName)}`,
      `docker network rm ${egressNetworkName(containerName)}`,
    ]) {
      try {
        execSync(command, { stdio: "ignore" });
      } catch {
        // Best-effort cleanup of partially-created egress resources.
      }
    }
  }

  async extendLife(sandboxId: string): Promise<void> {
    // TODO: Implement
  }

  async hibernateById(sandboxId: string): Promise<void> {
    // For debugging purposes, don't pause the container when hibernate is called
    // We automatically pause the container using the hibernation timeout instead.
    console.log("Hibernate called, but not pausing container");
  }

  /**
   * #114: force-destroy a sandbox by id WITHOUT unpausing/starting it. A
   * rehydrated {@link DockerSession} (no `created` metadata) recovers the
   * container name via `docker inspect` and best-efforts the sidecar/network/
   * secret-file teardown; `docker rm -f` removes the guest in place (paused,
   * exited, or running) and never resumes its daemon — unlike
   * {@link getSandboxOrNull}, which unpauses a stale guest before returning it.
   * Errors propagate so the caller can fail loudly rather than orphan.
   */
  async shutdownById(sandboxId: string): Promise<void> {
    await new DockerSession(sandboxId).shutdown();
  }

  /**
   * Cleanup utility function to remove all test containers
   * Useful for test teardown and CI cleanup
   */
  static async cleanupTestContainers(): Promise<void> {
    try {
      // Get all containers with test prefix
      const listCommand = `docker ps -a --filter "name=${TEST_CONTAINER_PREFIX}" --format "{{.Names}}"`;
      const containerList = execSync(listCommand, { encoding: "utf8" }).trim();
      if (!containerList) {
        return;
      }
      const containers = containerList
        .split("\n")
        .filter((name) => name.trim());
      // Remove all test containers (force remove)
      const removeCommand = `docker rm -f ${containers.join(" ")}`;
      execSync(removeCommand, { stdio: "ignore" });
    } catch (error) {
      console.warn("Failed to cleanup test containers:", error);
    }
    DockerProvider.cleanupNetworksByPrefix(
      EGRESS_NETWORK_PREFIX,
      TEST_CONTAINER_PREFIX,
      "egress",
    );
    DockerProvider.cleanupNetworksByPrefix(
      CRED_BROKER_NETWORK_PREFIX,
      TEST_CONTAINER_PREFIX,
      "cred-broker",
    );
  }

  /**
   * Remove leaked per-sandbox docker networks matching one sidecar-network
   * prefix (egress `--internal` nets, #66 §3.5; cred-broker dedicated nets,
   * #114). Sidecar containers share the sandbox name prefix and are removed
   * with the container sweep above; these networks need their own sweep.
   */
  private static cleanupNetworksByPrefix(
    networkPrefix: string,
    containerPrefix: string,
    label: string,
  ): void {
    try {
      const listCommand = `docker network ls --filter "name=${networkPrefix}${containerPrefix}" --format "{{.Name}}"`;
      const networkList = execSync(listCommand, { encoding: "utf8" }).trim();
      if (!networkList) {
        return;
      }
      for (const network of networkList.split("\n")) {
        if (!network.trim()) {
          continue;
        }
        try {
          execSync(`docker network rm ${network.trim()}`, { stdio: "ignore" });
        } catch {
          // Network still in use or already gone — leave it.
        }
      }
    } catch (error) {
      console.warn(`Failed to cleanup ${label} networks:`, error);
    }
  }

  /**
   * Cleanup utility function to remove all Terragon containers
   * Useful for complete system cleanup
   */
  static async cleanupAllContainers(): Promise<void> {
    try {
      // Get all containers with any terragon prefix
      const listCommand = `docker ps -a --filter "name=${CONTAINER_PREFIX}" --format "{{.Names}}"`;
      const containerList = execSync(listCommand, { encoding: "utf8" }).trim();
      if (!containerList) {
        return;
      }
      const containers = containerList
        .split("\n")
        .filter((name) => name.trim());
      // Remove all containers (force remove)
      const removeCommand = `docker rm -f ${containers.join(" ")}`;
      execSync(removeCommand, { stdio: "ignore" });
    } catch (error) {
      console.warn("Failed to cleanup Terragon containers:", error);
    }
    DockerProvider.cleanupNetworksByPrefix(
      EGRESS_NETWORK_PREFIX,
      CONTAINER_PREFIX,
      "egress",
    );
    DockerProvider.cleanupNetworksByPrefix(
      CRED_BROKER_NETWORK_PREFIX,
      CONTAINER_PREFIX,
      "cred-broker",
    );
  }
}
