import { AIAgent } from "@terragon/agent/types";
import { IDaemonRuntime, writeToUnixSocket } from "./runtime";
import {
  DaemonMessageClaude,
  DaemonMessageSchema,
  FeatureFlags,
  DaemonEventAPIBody,
  ClaudeMessage,
  DaemonMessage,
  DAEMON_VERSION,
} from "./shared";
import { performance } from "node:perf_hooks";
import { RetryBackoff, RetryConfig, DEFAULT_RETRY_CONFIG } from "./retry";
import {
  getAnthropicApiKeyOrNull,
  maybeFixLogsForSessionId,
  claudeCommand,
} from "./claude";
import {
  geminiCommand,
  parseGeminiLine,
  createGeminiParserState,
} from "./gemini";
import {
  MessageBufferEntry,
  killProcessGroup,
  createIdleWatchdog,
} from "./utils";
import {
  opencodeCommand,
  getOpencodeApiKeyOrNull,
  parseOpencodeLine,
} from "./opencode";
import { ampCommand, getAmpApiKeyOrNull } from "./amp";
import { codexCommand, parseCodexLine } from "./codex";
import { AgentFrontmatterReader } from "./agent-frontmatter";

function formatError(error: unknown): object {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.cause ? { cause: error.cause } : {}),
    };
  }
  return { value: error };
}

type ActiveProcessState = {
  agent: AIAgent;
  threadId: string;
  threadChatId: string;
  token: string;
  processId: number | null;
  sessionId: string | null;
  startTime: number;
  stderr: string[];
  isWorking: boolean;
  isStopping: boolean;
  isCompleted: boolean;
  pollInterval: NodeJS.Timeout | null;
};

/**
 * Strip every GitHub credential from a review-run agent env (single-writer, ADR-036
 * phase-2): the installation token (GH_TOKEN/GITHUB_TOKEN) and the git http.extraheader
 * that base64-carries it (the indexed GIT_CONFIG_COUNT/KEY_n/VALUE_n auth entries that
 * buildDaemonEnv injects). GIT_CONFIG_GLOBAL/SYSTEM (=/dev/null host isolation, which
 * keeps the osxkeychain helper unreachable) are intentionally KEPT. Combined with the
 * worktree already being cloned token-free (provision.ts one-shot -c extraheader), the
 * review agent then has NO reachable GitHub credential — gh/curl/git-push all lack auth.
 * Pure; returns a new object.
 */
export function stripGithubCredentials(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "GH_TOKEN" || key === "GITHUB_TOKEN") continue;
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export class TerragonDaemon {
  private startTime: number = 0;
  private messageBuffer: MessageBufferEntry[] = [];
  private runtime: IDaemonRuntime;
  private mcpConfigPath: string | undefined;

  private activeProcesses: Map<string, ActiveProcessState> = new Map();

  private messageHandleDelay: number = 0;
  private messageFlushDelay: number = 0;
  private messageFlushTimer: NodeJS.Timeout | null = null;
  private uptimeReportingInterval: number = 0;
  private uptimeReportingTimer: NodeJS.Timeout | null = null;
  private isFlushInProgress: boolean = false;
  private pendingFlushRequired: boolean = false;
  private retryBackoff: RetryBackoff;

  private featureFlags: FeatureFlags = {} as FeatureFlags;
  private agentFrontmatterReader: AgentFrontmatterReader;

  constructor({
    messageFlushDelay = 1000,
    messageHandleDelay = 100,
    uptimeReportingInterval = 5000,
    runtime,
    retryConfig = DEFAULT_RETRY_CONFIG,
    mcpConfigPath,
  }: {
    messageFlushDelay?: number;
    messageHandleDelay?: number;
    uptimeReportingInterval?: number;
    runtime: IDaemonRuntime;
    retryConfig?: RetryConfig;
    mcpConfigPath?: string;
  }) {
    this.startTime = performance.now();
    this.runtime = runtime;
    this.messageHandleDelay = messageHandleDelay;
    this.messageFlushDelay = messageFlushDelay;
    this.uptimeReportingInterval = uptimeReportingInterval;
    this.retryBackoff = new RetryBackoff(retryConfig);
    this.mcpConfigPath = mcpConfigPath;
    this.agentFrontmatterReader = new AgentFrontmatterReader(runtime);

    // Load feature flags from environment variable if available
    const envFeatureFlags = process.env.TERRAGON_FEATURE_FLAGS;
    if (envFeatureFlags) {
      try {
        this.featureFlags = JSON.parse(envFeatureFlags);
        this.runtime.logger.info("Feature flags loaded from environment", {
          featureFlags: this.featureFlags,
        });
      } catch (error) {
        this.runtime.logger.error(
          "Failed to parse feature flags from environment",
          {
            error: formatError(error),
            envFeatureFlags,
          },
        );
      }
    }
  }

  /**
   * Initialize and start the daemon
   */
  async start(): Promise<void> {
    this.runtime.logger.info("🚀 Starting Terragon Daemon...");
    this.runtime.logger.info("Daemon version", {
      version: DAEMON_VERSION,
    });
    this.runtime.logger.info("Server URL configured", {
      url: this.runtime.url,
    });
    this.runtime.logger.info("Unix socket configured", {
      unixSocketPath: this.runtime.unixSocketPath,
    });
    this.runtime.logger.info("MCP config path configured", {
      mcpConfigPath: this.mcpConfigPath ?? null,
    });

    // Load agent frontmatter
    await this.agentFrontmatterReader.loadAgents();

    // Start listening to the unix socket
    await this.runtime.listenToUnixSocket(
      this.handleUnixSocketMessage.bind(this),
    );
    this.runtime.logger.info(
      "✅ Daemon started successfully, waiting for messages...",
    );

    // Log every 5 seconds
    this.uptimeReportingTimer = setInterval(() => {
      const uptime = Math.round((performance.now() - this.startTime) / 1000);
      this.runtime.logger.info("Daemon Heartbeat", {
        uptime: `${uptime}s`,
      });
    }, this.uptimeReportingInterval);
    // // Graceful shutdown handling
    this.runtime.onTeardown(this.teardown.bind(this));
  }

  private getCurrentTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (error) {
      this.runtime.logger.error(
        "Failed to get current timezone. Falling back to UTC.",
        { error: formatError(error) },
      );
      return "UTC";
    }
  }

  /**
   * Handle incoming message from the unix socket
   */
  private async handleUnixSocketMessage(message: string): Promise<void> {
    let parsedMessage: DaemonMessage | null = null;
    try {
      this.runtime.logger.info("Received unix socket message", { message });
      const jsonObj = JSON.parse(message);
      parsedMessage = DaemonMessageSchema.parse(jsonObj);
    } catch (error) {
      this.runtime.logger.error("Failed to parse unix socket message", {
        error: formatError(error),
      });
      throw error;
    }
    if (!parsedMessage) {
      this.runtime.logger.error("Failed to parse unix socket message", {
        message,
      });
      throw new Error("Failed to parse unix socket message");
    }
    // Process the message so we acknowledge the unix socket message
    // first.
    setTimeout(() => {
      switch (parsedMessage.type) {
        case "kill": {
          this.killAllActiveProcesses();
          if (process.env.NODE_ENV !== "test") {
            process.exit(0);
          }
          break;
        }
        case "stop": {
          this.runtime.logger.info(
            "Stop message received, killing specific process...",
            { threadChatId: parsedMessage.threadChatId },
          );
          const processDurationMs = this.getProcessDurationMs(
            parsedMessage.threadChatId,
          );
          const processToStop = this.activeProcesses.get(
            parsedMessage.threadChatId,
          );
          if (processToStop) {
            this.updateActiveProcessState(parsedMessage.threadChatId, {
              isStopping: true,
            });
            this.killActiveProcess(parsedMessage.threadChatId);
          } else {
            this.runtime.logger.warn(
              "Stop message received but no process found for threadChatId",
              { threadChatId: parsedMessage.threadChatId },
            );
          }
          this.addMessageToBuffer({
            agent: null,
            message: {
              type: "custom-stop",
              session_id: null,
              duration_ms: processDurationMs,
            },
            threadId: parsedMessage.threadId,
            threadChatId: parsedMessage.threadChatId,
            token: parsedMessage.token,
          });
          this.flushMessageBuffer();
          break;
        }
        case "ping": {
          this.runtime.logger.info("Ping message received");
          break;
        }
        case "claude": {
          this.runCommand(parsedMessage).catch((error) => {
            this.runtime.logger.error("Failed to run command", {
              error: formatError(error),
            });
          });
          break;
        }
        default: {
          const _exhaustiveCheck: never = parsedMessage;
          this.runtime.logger.error("Unknown message type", {
            msg: _exhaustiveCheck,
          });
          break;
        }
      }
    }, this.messageHandleDelay);
  }

  private killActiveProcess(threadChatId: string) {
    // Kill specific process
    const activeProcessState = this.activeProcesses.get(threadChatId);
    if (activeProcessState) {
      const processId = activeProcessState?.processId;
      if (processId) {
        this.runtime.logger.info("Killing active process", {
          pid: processId,
          threadChatId,
        });
        killProcessGroup(this.runtime, processId);
      }
      // Clean up polling interval to prevent memory leaks
      if (activeProcessState.pollInterval) {
        this.runtime.logger.info("Clearing polling interval", {
          pid: processId,
          threadChatId,
        });
        clearInterval(activeProcessState.pollInterval);
      }
      if (
        activeProcessState.agent === "claudeCode" &&
        activeProcessState.sessionId
      ) {
        this.runtime.logger.info("Cleaning up claude session logs", {
          session: activeProcessState.sessionId,
        });
        maybeFixLogsForSessionId(this.runtime, activeProcessState.sessionId);
      }
      this.activeProcesses.delete(threadChatId);
    }
  }

  private killAllActiveProcesses() {
    for (const threadChatId of this.activeProcesses.keys()) {
      this.killActiveProcess(threadChatId);
    }
  }

  private async runCommand(input: DaemonMessageClaude): Promise<void> {
    // Store feature flags if provided
    if (input.featureFlags) {
      this.featureFlags = input.featureFlags;
      this.runtime.logger.info("Feature flags updated", {
        featureFlags: this.featureFlags,
      });
    }
    // Kill any existing process for this threadChatId
    this.killActiveProcess(input.threadChatId);
    // Create new process state for this threadChatId
    const newProcessState: ActiveProcessState = {
      processId: null,
      agent: input.agent,
      sessionId: null,
      startTime: Date.now(),
      stderr: [],
      isStopping: false,
      isCompleted: false,
      isWorking: false,
      threadId: input.threadId,
      threadChatId: input.threadChatId,
      token: input.token,
      pollInterval: null,
    };
    this.activeProcesses.set(input.threadChatId, newProcessState);
    switch (input.agent) {
      case "claudeCode":
        await this.runClaudeCodeCommand(input);
        break;
      case "amp":
        await this.runAmpCommand(input);
        break;
      case "codex":
        await this.runCodexCommand(input);
        break;
      case "gemini":
        await this.runGeminiCommand(input);
        break;
      case "opencode":
        await this.runOpencodeCommand(input);
        break;
      default: {
        // This ensures we handle all model types exhaustively
        const _exhaustiveCheck: never = input.agent;
        this.runtime.logger.error("Unknown agent", {
          agent: _exhaustiveCheck,
          agentVersion: input.agentVersion,
          model: input.model,
        });
        throw new Error(`Unknown agent: ${input.agent}`);
      }
    }
  }

  private onProcessStderr = (
    agent: string,
    line: string,
    threadChatId: string,
  ) => {
    this.runtime.logger.error(`${agent} stderr`, {
      line,
      threadChatId,
    });
    const activeProcessState = this.activeProcesses.get(threadChatId);
    if (activeProcessState) {
      activeProcessState.stderr.push(line);
      if (activeProcessState.stderr.length > 20) {
        activeProcessState.stderr.shift();
      }
    }
  };

  private getProcessErrorInfo = (threadChatId: string) => {
    const activeProcessState = this.activeProcesses.get(threadChatId);
    if (activeProcessState?.stderr.length) {
      return activeProcessState.stderr.join("\n");
    }
    return undefined;
  };

  private getProcessDurationMs = (threadChatId: string) => {
    const activeProcessState = this.activeProcesses.get(threadChatId);
    if (activeProcessState?.startTime) {
      return Math.round(Date.now() - activeProcessState.startTime);
    }
    return 0;
  };

  private updateActiveProcessState = (
    threadChatId: string,
    update: Partial<
      Pick<
        ActiveProcessState,
        | "processId"
        | "sessionId"
        | "isWorking"
        | "isStopping"
        | "isCompleted"
        | "pollInterval"
      >
    >,
  ) => {
    const activeProcessState = this.activeProcesses.get(threadChatId);
    if (!activeProcessState) {
      this.runtime.logger.warn(
        "Attempt to update active process state but it is undefined.",
        { threadChatId, update },
      );
      return;
    }
    this.activeProcesses.set(threadChatId, {
      ...activeProcessState,
      ...update,
    });
  };

  private handleProcessClose = ({
    agent,
    processId,
    exitCode,
    threadChatId,
    getMockSuccessResult,
  }: {
    agent: string;
    processId: number | undefined;
    exitCode: number | null;
    threadChatId: string;
    getMockSuccessResult?: () => string;
  }) => {
    this.runtime.logger.info(`${agent} command finished`, {
      exitCode,
      processId,
      threadChatId,
    });
    const activeState = this.activeProcesses.get(threadChatId);
    if (!activeState || activeState.processId !== processId) {
      this.runtime.logger.info("Process closed but not handled", {
        processId,
        exitCode,
        threadChatId,
      });
      return;
    }
    if (exitCode !== 0 && !activeState.isStopping && !activeState.isCompleted) {
      this.addMessageToBuffer({
        agent: activeState.agent,
        message: {
          type: "custom-error",
          session_id: null,
          duration_ms: this.getProcessDurationMs(threadChatId),
          error_info: this.getProcessErrorInfo(threadChatId),
        },
        threadId: activeState.threadId,
        threadChatId: activeState.threadChatId,
        token: activeState.token,
      });
    }
    if (exitCode === 0 && typeof getMockSuccessResult === "function") {
      this.addMessageToBuffer({
        agent: activeState.agent,
        message: {
          type: "result",
          subtype: "success",
          total_cost_usd: 0,
          duration_ms: this.getProcessDurationMs(threadChatId),
          duration_api_ms: this.getProcessDurationMs(threadChatId),
          is_error: false,
          num_turns: 1,
          session_id: activeState.sessionId ?? "",
          result: getMockSuccessResult(),
        },
        threadId: activeState.threadId,
        threadChatId: activeState.threadChatId,
        token: activeState.token,
      });
    }
    // Remove this process from the map
    this.activeProcesses.delete(threadChatId);
  };

  private async spawnAgentProcess({
    agentName,
    command,
    env,
    input,
    withholdGitCredentials,
    onStdoutLine,
    onClose,
    getMockSuccessResult,
  }: {
    agentName: string;
    input: DaemonMessageClaude;
    command: string;
    env?: Record<string, string | undefined>;
    // Single-writer review runs (permissionMode="review"): withhold every GitHub
    // credential from the agent's env so it has NO write outlet (the executor is the
    // sole poster). See the strip below.
    withholdGitCredentials?: boolean;
    onStdoutLine: (line: string) => void;
    onClose?: (code: number | null) => void;
    getMockSuccessResult?: () => string;
  }): Promise<void> {
    this.runtime.logger.info("Spawning agent process", {
      agentName,
      command,
    });
    return new Promise((resolve) => {
      // Watchdog: kill process if it stops emitting output for too long
      const watchdogTimeoutMs = (() => {
        if (process.env.IDLE_TIMEOUT_MS) {
          const n = Number(process.env.IDLE_TIMEOUT_MS);
          if (Number.isFinite(n) && n > 0) return n;
        }
        return 15 * 60 * 1000; // default 15 minutes
      })();
      let spawnedProcessId: number | undefined;
      const watchdog = createIdleWatchdog({
        timeoutMs: watchdogTimeoutMs,
        logger: this.runtime.logger,
        onTimeout: async () => {
          const durationMs = this.getProcessDurationMs(input.threadChatId);
          this.runtime.logger.warn("Idle timeout reached, killing process", {
            agentName,
            processId: spawnedProcessId,
            watchdogTimeoutMs,
            durationMs,
          });
          this.addMessageToBuffer({
            agent: input.agent,
            message: {
              type: "result",
              subtype: "success",
              total_cost_usd: 0,
              duration_ms: durationMs,
              duration_api_ms: durationMs,
              is_error: true,
              num_turns: 1,
              result: `${agentName} error: no output for ${watchdogTimeoutMs / 1000}s; process killed`,
              session_id:
                this.activeProcesses.get(input.threadChatId)?.sessionId ?? "",
            },
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
          this.killActiveProcess(input.threadChatId);
          await this.flushMessageBuffer();
        },
      });

      const baseChildEnv: Record<string, string | undefined> = {
        ...process.env,
        ...env,
        DAEMON_TOKEN: input.token,
      };
      const childEnv = withholdGitCredentials
        ? stripGithubCredentials(baseChildEnv)
        : baseChildEnv;
      const { processId, pollInterval } = this.runtime.spawnCommandLine(
        command,
        {
          env: childEnv,
          onStdoutLine: (line) => {
            this.runtime.logger.debug("Agent output", { processId, line });
            if (line) {
              // Any output indicates activity; reset the watchdog
              watchdog.reset();
              onStdoutLine(line);
            }
          },
          onStderr: (line) => {
            watchdog.reset();
            this.onProcessStderr(agentName, line, input.threadChatId);
          },
          onError: (error: any) => {
            this.runtime.logger.error("Agent command error", {
              processId,
              error: formatError(error),
            });
          },
          onClose: (code) => {
            watchdog.clear();
            if (onClose) {
              onClose(code);
            }
            this.handleProcessClose({
              agent: agentName,
              exitCode: code,
              processId,
              threadChatId: input.threadChatId,
              getMockSuccessResult,
            });
            this.flushMessageBuffer();
            resolve();
          },
        },
      );
      this.runtime.logger.info("Spawned agent process", {
        agentName,
        processId,
      });
      if (processId) {
        spawnedProcessId = processId;
        this.updateActiveProcessState(input.threadChatId, {
          processId,
          pollInterval,
        });
        // Start the watchdog once the process is running
        watchdog.reset();
      }
    });
  }

  private async runClaudeCodeCommand(
    input: DaemonMessageClaude,
  ): Promise<void> {
    if (input.sessionId) {
      maybeFixLogsForSessionId(this.runtime, input.sessionId);
    }
    return this.spawnAgentProcess({
      agentName: "Claude",
      input,
      // Review runs (single-writer): strip every GitHub credential from the agent env.
      withholdGitCredentials: input.permissionMode === "review",
      command: claudeCommand({
        runtime: this.runtime,
        prompt: input.prompt,
        sessionId: input.sessionId,
        model: input.model,
        mcpConfigPath: this.mcpConfigPath ?? null,
        permissionMode: input.permissionMode,
        enableMcpPermissionPrompt: this.getFeatureFlag("mcpPermissionPrompt"),
      }),
      env: {
        ANTHROPIC_API_KEY: getAnthropicApiKeyOrNull(this.runtime),
        BASH_MAX_TIMEOUT_MS: (60 * 1000).toString(),
        ...(!!input.useCredits
          ? {
              ANTHROPIC_BASE_URL: `${this.runtime.normalizedUrl}/api/proxy/anthropic`,
              ANTHROPIC_AUTH_TOKEN: input.token,
            }
          : {}),
      },
      onStdoutLine: (line) => {
        try {
          const outputMessage = JSON.parse(line);
          const sessionId = outputMessage.session_id;
          if (sessionId) {
            this.updateActiveProcessState(input.threadChatId, {
              sessionId,
              isWorking: true,
            });
          }
          if (outputMessage.type === "result") {
            this.updateActiveProcessState(input.threadChatId, {
              isCompleted: true,
            });
          }
          this.addMessageToBuffer({
            agent: "claudeCode",
            message: outputMessage,
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
        } catch (e) {
          this.runtime.logger.error("Failed to parse Claude output line", {
            line,
            error: formatError(e),
          });
        }
      },
    });
  }

  private async runOpencodeCommand(input: DaemonMessageClaude): Promise<void> {
    return this.spawnAgentProcess({
      agentName: "Opencode",
      input,
      command: opencodeCommand({
        runtime: this.runtime,
        prompt: input.prompt,
        model: input.model,
        sessionId: input.sessionId,
      }),
      env: {
        OPENCODE_API_KEY: getOpencodeApiKeyOrNull(this.runtime),
      },
      getMockSuccessResult: () => "Opencode successfully completed",
      onStdoutLine: (line) => {
        const activeProcessState = this.activeProcesses.get(input.threadChatId);
        const parsedMessages = parseOpencodeLine({
          line,
          runtime: this.runtime,
          isWorking: !!activeProcessState?.isWorking,
        });
        for (const parsedMessage of parsedMessages) {
          const type = parsedMessage.type;
          const sessionId = parsedMessage.session_id;
          if (type === "system" && sessionId) {
            this.updateActiveProcessState(input.threadChatId, {
              sessionId,
              isWorking: true,
            });
          } else if (
            activeProcessState?.sessionId &&
            (type === "assistant" || type === "user")
          ) {
            parsedMessage.session_id = activeProcessState.sessionId;
          }
          if (type === "result") {
            this.updateActiveProcessState(input.threadChatId, {
              isCompleted: true,
            });
          }
          this.addMessageToBuffer({
            agent: "opencode",
            message: parsedMessage,
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
        }
      },
    });
  }

  private async runAmpCommand(input: DaemonMessageClaude): Promise<void> {
    return this.spawnAgentProcess({
      agentName: "Amp",
      command: ampCommand({
        runtime: this.runtime,
        prompt: input.prompt,
        sessionId: input.sessionId,
      }),
      env: { AMP_API_KEY: getAmpApiKeyOrNull(this.runtime) },
      input,
      onStdoutLine: (line) => {
        try {
          const outputMessage = JSON.parse(line);
          if (outputMessage.type === "result") {
            this.updateActiveProcessState(input.threadChatId, {
              isCompleted: true,
            });
          }
          if (
            outputMessage.type === "user" &&
            outputMessage.message?.role === "user" &&
            outputMessage.message?.content?.[0]?.type === "text"
          ) {
            // Ignore this message because amp echos the first message from the user.
            this.runtime.logger.debug("Ignoring Amp user message", {
              message: outputMessage,
            });
            return;
          }
          this.addMessageToBuffer({
            agent: "amp",
            message: outputMessage,
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
        } catch (e) {
          this.runtime.logger.error("Failed to parse Amp output line", {
            line,
            error: e,
          });
        }
      },
    });
  }

  private async runCodexCommand(input: DaemonMessageClaude): Promise<void> {
    return this.spawnAgentProcess({
      agentName: "Codex",
      input,
      command: codexCommand({
        runtime: this.runtime,
        prompt: input.prompt,
        model: input.model,
        sessionId: input.sessionId,
        useCredits: !!input.useCredits,
      }),
      getMockSuccessResult: () => "Codex successfully completed",
      onStdoutLine: (line) => {
        // Parse the line into ClaudeMessage format
        const parsedMessages = parseCodexLine({
          line,
          runtime: this.runtime,
        });
        const activeProcessState = this.activeProcesses.get(input.threadChatId);
        for (const parsedMessage of parsedMessages) {
          const type = parsedMessage.type;
          const sessionId = parsedMessage.session_id;
          if (type === "system" && sessionId) {
            this.updateActiveProcessState(input.threadChatId, {
              sessionId,
              isWorking: true,
            });
          } else if (
            activeProcessState?.sessionId &&
            (type === "assistant" || type === "user")
          ) {
            parsedMessage.session_id = activeProcessState.sessionId;
          }
          this.addMessageToBuffer({
            agent: "codex",
            message: parsedMessage,
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
          if (parsedMessage.type === "result") {
            this.updateActiveProcessState(input.threadChatId, {
              isCompleted: true,
            });
            if (parsedMessage.is_error) {
              this.flushMessageBuffer();
            }
          }
        }
      },
    });
  }

  private async runGeminiCommand(input: DaemonMessageClaude): Promise<void> {
    // Create parser state for accumulating deltas
    const parserState = createGeminiParserState();
    return this.spawnAgentProcess({
      agentName: "Gemini",
      command: geminiCommand({
        runtime: this.runtime,
        prompt: input.prompt,
        model: input.model,
        sessionId: input.sessionId,
      }),
      env: {
        GOOGLE_GEMINI_BASE_URL: `${this.runtime.normalizedUrl}/api/proxy/google`,
        GEMINI_API_KEY: input.token,
      },
      input,
      onStdoutLine: (line) => {
        // Parse the line into ClaudeMessage format
        const parsedMessages = parseGeminiLine({
          line,
          runtime: this.runtime,
          state: parserState,
        });
        const activeProcessState = this.activeProcesses.get(input.threadChatId);
        for (const parsedMessage of parsedMessages) {
          const type = parsedMessage.type;
          const sessionId = parsedMessage.session_id;
          if (type === "system" && sessionId) {
            this.updateActiveProcessState(input.threadChatId, {
              sessionId,
              isWorking: true,
            });
          } else if (
            activeProcessState?.sessionId &&
            (type === "assistant" || type === "user")
          ) {
            parsedMessage.session_id = activeProcessState.sessionId;
          }
          if (type === "result") {
            this.updateActiveProcessState(input.threadChatId, {
              isCompleted: true,
            });
          }
          this.addMessageToBuffer({
            agent: "gemini",
            message: parsedMessage,
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
        }
      },
      onClose: () => {
        // Flush any remaining accumulated content
        if (parserState.accumulatedContent) {
          const activeProcessState = this.activeProcesses.get(
            input.threadChatId,
          );
          this.addMessageToBuffer({
            agent: "gemini",
            message: {
              type: "assistant",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: parserState.accumulatedContent },
                ],
              },
              parent_tool_use_id: null,
              session_id: activeProcessState?.sessionId || "",
            },
            threadId: input.threadId,
            threadChatId: input.threadChatId,
            token: input.token,
          });
        }
      },
    });
  }

  private processMessagesForSending(
    entries: MessageBufferEntry[],
  ): MessageBufferEntry[] {
    if (entries.find((e) => e.agent === "gemini" || e.agent === "codex")) {
      // Check for error results and kill process if needed
      const errorEntry = entries.find(
        (e) => e.message.type === "result" && e.message.is_error,
      );
      if (errorEntry) {
        this.updateActiveProcessState(errorEntry.threadChatId, {
          isStopping: true,
        });
        this.killActiveProcess(errorEntry.threadChatId);
      }
      return entries;
    }
    // Enrich Claude messages with agent metadata
    if (entries.find((e) => e.agent === "claudeCode")) {
      this.runtime.logger.info(
        "Processing Claude messages for agent metadata enrichment",
        {
          messageCount: entries.length,
          claudeMessageCount: entries.filter((e) => e.agent === "claudeCode")
            .length,
        },
      );

      return entries.map((entry) => {
        if (
          entry.agent === "claudeCode" &&
          entry.message.type === "assistant"
        ) {
          const message = entry.message.message;
          if ("content" in message && Array.isArray(message.content)) {
            for (const content of message.content) {
              if (
                content.type === "tool_use" &&
                content.name === "Task" &&
                "input" in content
              ) {
                const input = content.input as any;
                if (input.subagent_type) {
                  this.runtime.logger.info(
                    "Found Task tool with subagent_type",
                    {
                      subagent_type: input.subagent_type,
                      description: input.description?.substring(0, 50) + "...",
                    },
                  );

                  const agentProps =
                    this.agentFrontmatterReader.getAgentProperties(
                      input.subagent_type,
                    );

                  if (agentProps) {
                    this.runtime.logger.info(
                      "Found agent properties for subagent",
                      {
                        subagent_type: input.subagent_type,
                        hasColor: !!agentProps.color,
                        color: agentProps.color || "(no color)",
                      },
                    );

                    if (agentProps.color) {
                      // Add color metadata to the input parameters
                      input._agent_color = agentProps.color;
                      this.runtime.logger.info(
                        "Added agent color to Task tool input",
                        {
                          subagent_type: input.subagent_type,
                          color: agentProps.color,
                        },
                      );
                    }
                  } else {
                    this.runtime.logger.info(
                      "No agent properties found for subagent",
                      {
                        subagent_type: input.subagent_type,
                        availableAgents: Array.from(
                          this.agentFrontmatterReader.getAllAgents().keys(),
                        ),
                      },
                    );
                  }
                }
              }
            }
          }
        }
        return entry;
      });
    }

    return entries;
  }

  /**
   * Add a message to the buffer and trigger debounced sending
   */
  private addMessageToBuffer(entry: MessageBufferEntry): void {
    this.retryBackoff.reset();
    this.messageBuffer.push(entry);
    this.runtime.logger.debug("Added message to buffer", {
      bufferSize: this.messageBuffer.length,
    });

    // If a flush is in progress, mark that another flush is needed
    if (this.isFlushInProgress) {
      this.pendingFlushRequired = true;
      return;
    }

    // Clear existing timer and set a new one
    if (this.messageFlushTimer) {
      clearTimeout(this.messageFlushTimer);
    }
    this.messageFlushTimer = setTimeout(() => {
      this.flushMessageBuffer();
    }, this.messageFlushDelay);
  }

  /**
   * Send all buffered messages to the API and clear the buffer
   */
  private async flushMessageBuffer(): Promise<void> {
    // Prevent concurrent flushes
    if (this.isFlushInProgress) {
      this.pendingFlushRequired = true;
      return;
    }

    if (this.messageBuffer.length === 0) {
      return;
    }

    this.isFlushInProgress = true;
    this.pendingFlushRequired = false;

    if (this.messageFlushTimer) {
      clearTimeout(this.messageFlushTimer);
      this.messageFlushTimer = null;
    }

    const messageBufferCopy = [...this.messageBuffer];
    this.messageBuffer = [];

    // Group messages by threadChatId so each thread flushes independently
    const groupsOrdered: Array<{
      threadChatId: string;
      entries: MessageBufferEntry[];
    }> = [];
    const groupMap = new Map<string, MessageBufferEntry[]>();
    for (const entry of messageBufferCopy) {
      const threadChatId = entry.threadChatId;
      let group = groupMap.get(threadChatId);
      if (!group) {
        group = [];
        groupMap.set(threadChatId, group);
        groupsOrdered.push({ threadChatId, entries: group });
      }
      group.push(entry);
    }

    const handledEntries = new Set<MessageBufferEntry>();
    let hasFailure = false;
    const timezone = this.getCurrentTimezone();

    for (const group of groupsOrdered) {
      const processedEntries = this.processMessagesForSending(group.entries);
      // No messages to send for this group (e.g., all filtered out)
      if (processedEntries.length === 0) {
        for (const entry of group.entries) {
          handledEntries.add(entry);
        }
        continue;
      }

      const lastEntry = processedEntries[processedEntries.length - 1]!;
      const threadId = lastEntry.threadId;
      const threadChatId = lastEntry.threadChatId;
      const token = lastEntry.token;

      try {
        await this.sendMessagesToAPI({
          messages: processedEntries.map((e) => e.message),
          timezone,
          token,
          threadId,
          threadChatId,
        });
        for (const entry of group.entries) {
          handledEntries.add(entry);
        }
      } catch (error) {
        hasFailure = true;
        this.retryBackoff.increment();

        const remainingEntries = messageBufferCopy.filter(
          (entry) => !handledEntries.has(entry),
        );
        // Always put the remaining messages back in the buffer (preserving original order)
        this.messageBuffer = [...remainingEntries, ...this.messageBuffer];

        const retryInOrNull = this.retryBackoff.retryIn();
        if (retryInOrNull === null) {
          this.runtime.logger.error(
            "Max retries reached for this message group, will wait for next trigger",
            {
              error: formatError(error),
              messageCount: processedEntries.length,
              threadId,
              threadChatId,
              attempt: this.retryBackoff.retryAttempt,
            },
          );
          // Don't set pendingFlushRequired - wait for next natural trigger
        } else {
          this.runtime.logger.error(
            "API call failed for message group, will retry messages",
            {
              error: formatError(error),
              messageCount: processedEntries.length,
              threadId,
              threadChatId,
              retryingIn: retryInOrNull,
              attempt: this.retryBackoff.retryAttempt,
            },
          );
          this.pendingFlushRequired = true;
        }
        break;
      }
    }

    if (!hasFailure && handledEntries.size > 0) {
      this.retryBackoff.reset();
    } else if (!hasFailure && handledEntries.size === 0) {
      this.runtime.logger.info("All messages filtered out, nothing to send");
    }

    this.isFlushInProgress = false;
    // If new messages arrived while we were flushing, or if we need to retry
    if (this.pendingFlushRequired && this.messageBuffer.length > 0) {
      const retryInOrNull = this.retryBackoff.retryIn();
      const delay = retryInOrNull ?? this.messageFlushDelay;
      this.messageFlushTimer = setTimeout(() => {
        this.flushMessageBuffer();
      }, delay);
    }
  }

  /**
   * Send an array of messages to the API endpoint
   */
  private async sendMessagesToAPI({
    messages,
    timezone,
    token,
    threadId,
    threadChatId,
  }: {
    messages: ClaudeMessage[];
    timezone: string;
    token: string;
    threadId: string;
    threadChatId: string;
  }): Promise<void> {
    try {
      this.runtime.logger.info("Sending messages to API", {
        messageCount: messages.length,
        threadId,
      });
      const payload: DaemonEventAPIBody = {
        messages,
        threadId,
        timezone,
        threadChatId,
      };

      await this.runtime.serverPost(payload, token);
      this.runtime.logger.info("Messages sent successfully", {
        messageCount: messages.length,
      });
    } catch (error) {
      this.runtime.logger.error("Failed to send messages to API", {
        error: formatError(error),
        messageCount: messages.length,
      });
      // Re-throw the error so flushMessageBuffer can handle it
      throw error;
    }
  }

  /**
   * Get a specific feature flag value
   */
  public getFeatureFlag(name: keyof FeatureFlags): boolean {
    return this.featureFlags[name] ?? false;
  }

  private async teardown(): Promise<void> {
    // Send any remaining messages in the buffer
    this.killAllActiveProcesses();
    await this.flushMessageBuffer();
    // Send a kill message to the unix socket to flush our blocking listeners.
    await writeToUnixSocket({
      unixSocketPath: this.runtime.unixSocketPath,
      dataStr: JSON.stringify({ type: "kill" }),
    });
    if (this.uptimeReportingTimer) {
      clearInterval(this.uptimeReportingTimer);
    }
    if (this.messageFlushTimer) {
      clearTimeout(this.messageFlushTimer);
    }
  }
}
