import { Daytona, Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
import {
  BackgroundCommandOptions,
  CreateSandboxOptions,
  ISandboxProvider,
  ISandboxSession,
} from "../types";
import { nanoid } from "nanoid/non-secure";
import { bashQuote, safeEnvKey } from "../utils";
import path from "path";
import { getTemplateIdForSize } from "@terragon/sandbox-image";
import { retryAsync } from "@terragon/utils/retry";
import { formatError } from "@terragon/utils/error";
import { toDaytonaNetwork, type EgressPolicyShape } from "../egress";

const HOME_DIR = "root";
const DEFAULT_DIR = `/${HOME_DIR}`;
const REPO_DIR = "repo";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function resumeWithRetry(sandboxId: string): Promise<DaytonaSandbox> {
  const startTime = Date.now();
  const daytona = getDaytonaOrThrow();
  return await retryAsync(
    async () => {
      console.log(`[daytona] Resuming sandbox ${sandboxId}...`);
      const sandbox = await daytona.get(sandboxId);
      console.log(`[daytona] Sandbox ${sandboxId} state: ${sandbox.state}`);
      if (sandbox.state === "stopping") {
        await sandbox.waitUntilStopped();
      }
      if (sandbox.state === "restoring" || sandbox.state === "starting") {
        await sandbox.waitUntilStarted();
      } else {
        await sandbox.start();
      }
      console.log(
        `[daytona] Resumed sandbox ${sandboxId} in ${Date.now() - startTime}ms`,
      );
      return sandbox;
    },
    {
      label: `resume sandbox ${sandboxId}`,
      maxAttempts: 3,
      delayMs: 1000,
    },
  );
}
async function createWithRetry(
  templateId: string,
  envs: Record<string, string>,
  egressPolicy?: EgressPolicyShape,
): Promise<DaytonaSandbox> {
  const daytona = getDaytonaOrThrow();
  // Egress enforcement (#66 §3.7): translate the control-plane shape into
  // Daytona's create-time network params BEFORE any create attempt — an
  // unrepresentable policy (level "none", non-IP entries at ip_port level,
  // over-cap lists) must throw here, never produce a broken/unfenced sandbox.
  // Create-time only: live network updates are tier-gated on Daytona, which is
  // acceptable because sandboxes are created per-thread. Like E2B, Daytona
  // enforces natively (provider-side iptables) but emits no per-connection
  // audit feed — documented limitation (docs/egress-enforcement.md).
  const networkParams = egressPolicy ? toDaytonaNetwork(egressPolicy) : {};
  return await retryAsync(
    async () => {
      console.log(
        `[daytona] Creating sandbox with templateId: ${templateId}...`,
      );
      const startTime = Date.now();
      const sandbox = await daytona.create({
        user: "root",
        snapshot: templateId,
        envVars: envs,
        autoStopInterval: 15, // 15 minutes
        autoArchiveInterval: 5, // 5 minutes
        autoDeleteInterval: 60 * 24 * 30, // 30 days
        ...networkParams,
      });
      console.log(
        `[daytona] Created sandbox in ${Date.now() - startTime}ms`,
        sandbox.id,
      );
      return sandbox;
    },
    {
      label: `create sandbox with templateId ${templateId}`,
      maxAttempts: 3,
      delayMs: 1000,
    },
  );
}

function getDaytonaOrThrow(): Daytona {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error("DAYTONA_API_KEY is not set");
  }
  const daytona = new Daytona({ apiKey });
  return daytona;
}

class DaytonaSession implements ISandboxSession {
  public readonly sandboxProvider: "daytona" = "daytona";

  constructor(private sandbox: DaytonaSandbox) {}

  get homeDir(): string {
    return HOME_DIR;
  }

  get repoDir(): string {
    return REPO_DIR;
  }

  get sandboxId(): string {
    return this.sandbox.id;
  }

  async hibernate(): Promise<void> {
    await hibernateSandbox(this.sandbox);
  }

  async runCommandWithSession(
    command: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      timeoutMs?: number;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
      blockUntilComplete?: boolean;
    },
  ): Promise<{
    sessionId: string;
    cmdId: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }> {
    const sessionId = nanoid();
    try {
      const workDir = options?.cwd || REPO_DIR;
      const workDirPath = workDir.startsWith("/")
        ? workDir
        : path.join(DEFAULT_DIR, workDir);
      await this.sandbox.process.createSession(sessionId);
      await this.sandbox.process.executeSessionCommand(sessionId, {
        command: `cd ${workDirPath}`,
        runAsync: false,
      });
      if (options?.env) {
        for (const [key, value] of Object.entries(options.env)) {
          await this.sandbox.process.executeSessionCommand(sessionId, {
            command: `export ${safeEnvKey(key)}=${bashQuote(value)}`,
            runAsync: false,
          });
        }
      }
      const commandExecutionResult =
        await this.sandbox.process.executeSessionCommand(sessionId, {
          command,
          runAsync: true,
        });
      const commandId = commandExecutionResult.cmdId!;
      let stdoutLines: string[] = [];
      let stderrLines: string[] = [];
      const commandLogsPromise = this.sandbox.process.getSessionCommandLogs(
        sessionId,
        commandId,
        (chunk) => {
          options?.onStdout?.(chunk);
          stdoutLines.push(chunk);
        },
        (chunk) => {
          options?.onStderr?.(chunk);
          stderrLines.push(chunk);
        },
      );
      if (!options?.blockUntilComplete) {
        return { sessionId, cmdId: commandId };
      }
      const result = await Promise.race([
        commandLogsPromise,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => {
            resolve("timeout");
          }, options?.timeoutMs || DEFAULT_TIMEOUT_MS),
        ),
      ]);
      if (result === "timeout") {
        throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
      }
      const commandResult = await this.sandbox.process.getSessionCommand(
        sessionId,
        commandId,
      );
      return {
        sessionId,
        cmdId: commandId,
        exitCode: commandResult.exitCode!,
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
      };
    } catch (error) {
      console.error("Error running command with session:", formatError(error));
      try {
        await this.sandbox.process.deleteSession(sessionId);
      } catch (error) {
        console.error("Error deleting session:", formatError(error));
      }
      if (
        error instanceof Error &&
        error.message.includes("Operation timed out")
      ) {
        throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
      }
      throw error;
    }
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
    console.log("Running command:", command);
    const startTime = Date.now();
    if (
      typeof options?.onStdout === "function" ||
      typeof options?.onStderr === "function"
    ) {
      const commandResult = await this.runCommandWithSession(command, {
        env: options?.env,
        cwd: options?.cwd,
        timeoutMs: options?.timeoutMs,
        blockUntilComplete: true,
        onStdout: options?.onStdout,
        onStderr: options?.onStderr,
      });
      if (commandResult.exitCode !== 0) {
        throw new Error(
          `Command failed with exit code ${commandResult.exitCode}\n\nstdout:\n ${commandResult.stdout || "(empty)"}\nstderr:\n ${commandResult.stderr || "(empty)"}`,
        );
      }
      return commandResult.stdout || "";
    }

    try {
      const workDir = options?.cwd || REPO_DIR;
      const workDirPath = workDir.startsWith("/")
        ? workDir
        : path.join(DEFAULT_DIR, workDir);
      const timeoutSecs = Math.ceil(
        (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000,
      );
      const commandResult = await this.sandbox.process.executeCommand(
        command,
        workDirPath,
        options?.env,
        timeoutSecs,
      );
      console.log(`Command executed (took ${Date.now() - startTime}ms)`, {
        exitCode: commandResult.exitCode,
        result: commandResult.result,
        workDirPath,
      });
      if (commandResult.exitCode !== 0) {
        throw new Error(
          `Command failed with exit code ${commandResult.exitCode}\n\noutput:\n ${commandResult.result || "(empty)"}`,
        );
      }
      return commandResult.result || "";
    } catch (error) {
      console.error("Error running command:", formatError(error));
      if (
        error instanceof Error &&
        error.message.includes("command execution timeout")
      ) {
        throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
      }
      throw error;
    }
  }

  async runBackgroundCommand(
    command: string,
    options?: BackgroundCommandOptions,
  ): Promise<void> {
    console.log("Running command:", command);
    await this.runCommandWithSession(command, {
      env: options?.env,
      timeoutMs: options?.timeoutMs,
      onStdout: options?.onOutput,
      onStderr: options?.onOutput,
      blockUntilComplete: false,
    });
  }

  async shutdown(): Promise<void> {
    await this.sandbox.stop();
    await this.sandbox.delete();
  }

  async readTextFile(path: string): Promise<string> {
    const file = await this.sandbox.fs.downloadFile(path);
    return file.toString();
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    const fileContent = Buffer.from(content);
    await this.sandbox.fs.uploadFile(fileContent, path);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const fileContent = Buffer.from(content);
    await this.sandbox.fs.uploadFile(fileContent, path);
  }
}

export class DaytonaProvider implements ISandboxProvider {
  constructor() {}

  async extendLife(sandboxId: string): Promise<void> {
    const sandbox = await this.getSandboxOrNull(sandboxId);
    if (!sandbox) {
      throw new Error("Sandbox not found");
    }
    await sandbox.runCommand("echo 'hello'");
  }

  async getSandboxOrNull(sandboxId: string): Promise<ISandboxSession | null> {
    try {
      const sandbox = await resumeWithRetry(sandboxId);
      return new DaytonaSession(sandbox);
    } catch (error) {
      console.warn(`Failed to resume sandbox ${sandboxId}:`, error);
      return null;
    }
  }

  async getOrCreateSandbox(
    sandboxId: string | null,
    options: CreateSandboxOptions,
  ): Promise<ISandboxSession> {
    if (sandboxId) {
      const sandbox = await this.getSandboxOrNull(sandboxId);
      if (!sandbox) {
        throw new Error("Sandbox not found");
      }
      return sandbox;
    }
    // Convert environment variables array to object
    const envs: Record<string, string> = {};
    if (options.environmentVariables) {
      for (const { key, value } of options.environmentVariables) {
        envs[key] = value;
      }
    }
    const sandbox = await createWithRetry(
      getTemplateIdForSize({
        provider: "daytona",
        size: options.sandboxSize,
      }),
      envs,
      options.egressPolicy,
    );
    const session = new DaytonaSession(sandbox);
    await setupDaytonaOneTime(session);
    return session;
  }

  async hibernateById(sandboxId: string): Promise<void> {
    try {
      const daytona = getDaytonaOrThrow();
      const sandbox = await daytona.get(sandboxId);
      await hibernateSandbox(sandbox);
    } catch (error) {
      console.error(
        `Failed to hibernate sandbox ${sandboxId}:`,
        formatError(error),
      );
    }
  }
}

async function setupDaytonaOneTime(session: ISandboxSession): Promise<void> {
  const etcProfileDPromptShContents = [
    // Ensure PS1 is set so .bashrc won't early-return in login shells
    "[ -n \"${PS1-}\" ] || PS1='\\w $ '",
    "export PS1",
  ].join("\n");
  await session.runCommand(
    `if [ ! -f /etc/profile.d/prompt.sh ]; then echo ${bashQuote(etcProfileDPromptShContents)} >> /etc/profile.d/prompt.sh; chmod 644 /etc/profile.d/prompt.sh; fi`,
    { cwd: "/" },
  );
}

async function hibernateSandbox(sandbox: DaytonaSandbox): Promise<void> {
  await sandbox.stop();
  // Rely on the auto-archive feature to archive the sandbox automatically
  // await sandbox.archive();
}
