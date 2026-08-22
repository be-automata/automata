import {
  BackgroundCommandOptions,
  CreateSandboxOptions,
  ISandboxProvider,
  ISandboxSession,
} from "../types";
import { execSync, spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { nanoid } from "nanoid/non-secure";
import {
  buildEgressNetworkCreateCommand,
  buildEgressSidecarBridgeConnectCommand,
  buildEgressSidecarRunCommand,
  buildEgressTeardownCommands,
  buildSandboxEgressRunFlags,
  egressNetworkName,
  egressSidecarName,
} from "./docker-egress";
import { EGRESS_PROXY_SCRIPT } from "../egress-proxy-standalone.generated";

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

  constructor(private containerId: string) {}

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
    // Resolve the container NAME before removal so the egress sidecar +
    // internal network (derived from the name, #66 spec §3.5) can be torn
    // down too. Best-effort: a sandbox created without an egress policy has
    // neither, and the teardown commands simply fail silently.
    let containerName: string | null = null;
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
    try {
      execSync(`docker rm -f ${this.containerId}`, { stdio: "ignore" });
    } catch (error) {
      console.error(`Failed to remove container ${this.containerId}:`, error);
      throw error;
    }
    if (containerName) {
      for (const command of buildEgressTeardownCommands(containerName)) {
        try {
          execSync(command, { stdio: "ignore" });
        } catch {
          // No egress sidecar/network for this sandbox — nothing to remove.
        }
      }
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
    // today's path.
    let egressFlags = "";
    if (options.egressPolicy) {
      try {
        egressFlags = await this.setUpEgressEnforcement(
          containerName,
          options.egressPolicy,
        );
      } catch (error) {
        console.error("Failed to set up egress enforcement:", error);
        this.tearDownEgressEnforcement(containerName);
        throw error;
      }
    }
    try {
      // Create and start container
      const createCommand = egressFlags
        ? `docker run -d --name ${containerName} ${egressFlags} ${envFlags} -w ${DEFAULT_DIR} ${BASE_IMAGE} tail -f /dev/null`
        : `docker run -d --name ${containerName} ${envFlags} -w ${DEFAULT_DIR} ${BASE_IMAGE} tail -f /dev/null`;
      const containerId = execSync(createCommand, { encoding: "utf8" }).trim();
      const dockerSession = new DockerSession(containerId);
      return dockerSession;
    } catch (error) {
      console.error("Failed to create Docker sandbox:", error);
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
    const scriptDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "automata-egress-"),
    );
    const scriptHostPath = path.join(scriptDir, "egress-proxy.cjs");
    await fs.writeFile(scriptHostPath, EGRESS_PROXY_SCRIPT, { mode: 0o444 });
    try {
      execSync(buildEgressNetworkCreateCommand(networkName), {
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
    execSync(buildEgressSidecarBridgeConnectCommand(sidecarName), {
      stdio: "ignore",
    });
    return buildSandboxEgressRunFlags(networkName);
  }

  private tearDownEgressEnforcement(containerName: string): void {
    for (const command of buildEgressTeardownCommands(containerName)) {
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
    DockerProvider.cleanupEgressNetworks(TEST_CONTAINER_PREFIX);
  }

  /**
   * Remove leaked egress internal networks (#66 §3.5). Sidecar containers
   * share the sandbox name prefix and are removed with the container sweep
   * above; the `--internal` networks need their own sweep.
   */
  private static cleanupEgressNetworks(prefix: string): void {
    try {
      const listCommand = `docker network ls --filter "name=automata-egress-${prefix}" --format "{{.Name}}"`;
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
      console.warn("Failed to cleanup egress networks:", error);
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
    DockerProvider.cleanupEgressNetworks(CONTAINER_PREFIX);
  }
}
