import {
  DaemonMessage,
  defaultPipePath,
  FeatureFlags,
} from "@terragon/daemon/shared";
import { McpConfig } from "./mcp-config";
import { getDaemonFile, getMcpServerFile } from "./constants";
import { CreateSandboxOptions, ISandboxSession } from "./types";
import { createHash } from "crypto";
import { buildMergedMcpConfig } from "./utils/mcp-merge";
import { getEnv } from "./env";
import { AIAgentCredentials } from "@terragon/agent/types";

export const DAEMON_FILE_PATH = "/tmp/terragon-daemon.mjs";
export const MCP_SERVER_FILE_PATH = "/tmp/terry-mcp-server.mjs";
export const MCP_SERVER_JSON_FILE_PATH = "/tmp/mcp-server.json";
export const DAEMON_LOG_FILE_PATH = "/tmp/terragon-daemon.log";

async function startDaemon({
  session,
  environmentVariables,
  githubAccessToken,
  agentCredentials,
  publicUrl,
  featureFlags,
  credentialBroker,
}: {
  session: ISandboxSession;
  environmentVariables: Array<{ key: string; value: string }>;
  githubAccessToken: string;
  agentCredentials: AIAgentCredentials | null;
  publicUrl: string;
  featureFlags: FeatureFlags;
  credentialBroker?: CreateSandboxOptions["credentialBroker"];
}) {
  if (!agentCredentials) {
    console.warn("No agent credentials provided");
  }
  await session.runBackgroundCommand(
    [
      "node",
      DAEMON_FILE_PATH,
      "--output-format",
      "json",
      "-u",
      publicUrl,
      "--mcp-config-path",
      MCP_SERVER_JSON_FILE_PATH,
      // Append stdout and stderr to the log file
      `>> ${DAEMON_LOG_FILE_PATH} 2>&1`,
    ].join(" "),
    {
      env: getEnv({
        userEnv: environmentVariables,
        githubAccessToken,
        agentCredentials,
        credentialBroker,
        overrides: {
          // 1 minute max timeout for bash commands
          BASH_MAX_TIMEOUT_MS: (60 * 1000).toString(),
          // Pass feature flags as JSON in environment variable
          TERRAGON_FEATURE_FLAGS: JSON.stringify(featureFlags),
        },
      }),
      onOutput: (data) => {
        console.log(data);
      },
    },
  );
}

export async function installDaemon({
  session,
  environmentVariables,
  githubAccessToken,
  agentCredentials,
  userMcpConfig,
  publicUrl,
  featureFlags,
  credentialBroker,
}: {
  session: ISandboxSession;
  environmentVariables: Array<{ key: string; value: string }>;
  githubAccessToken: string;
  agentCredentials: AIAgentCredentials | null;
  userMcpConfig?: McpConfig;
  publicUrl: string;
  featureFlags: FeatureFlags;
  credentialBroker?: CreateSandboxOptions["credentialBroker"];
}) {
  const daemonFile = getDaemonFile();
  const mcpServerFile = getMcpServerFile();

  await session.writeTextFile(DAEMON_FILE_PATH, daemonFile);
  await session.writeTextFile(MCP_SERVER_FILE_PATH, mcpServerFile);

  // Merge user MCP config with built-in terry server (shared logic with Codex)
  const mcpConfig = buildMergedMcpConfig({
    userMcpConfig,
    includeTerry: true,
    terryCommand: "node",
    terryArgs: [MCP_SERVER_FILE_PATH],
  });

  await session.writeTextFile(
    MCP_SERVER_JSON_FILE_PATH,
    JSON.stringify(mcpConfig, null, 2),
  );
  await session.runCommand(`chmod +x ${DAEMON_FILE_PATH}`);
  console.log("Daemon file written");
  await startDaemon({
    session,
    environmentVariables,
    githubAccessToken,
    agentCredentials,
    publicUrl,
    featureFlags,
    credentialBroker,
  });
  console.log("Daemon command running");
  await waitForDaemonReady(session);
}

async function waitForDaemonReady(
  session: ISandboxSession,
  maxAttempts = 20,
  intervalMs = 500,
) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Check if the daemon is responsive
      const result = await sendPingMessage({ session });
      if (result) {
        console.log("Daemon is ready");
        // Give it a tiny bit more time to ensure the daemon is fully listening
        await new Promise((resolve) => setTimeout(resolve, 100));
        return;
      }
    } catch (error) {
      // Ignore errors during startup check
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Daemon failed to start within timeout period");
}

export async function getDaemonLogs({
  session,
  parseJson = true,
}: {
  session: ISandboxSession;
  parseJson?: boolean;
}) {
  const rawLogs = await session.readTextFile(DAEMON_LOG_FILE_PATH);
  return rawLogs
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      if (parseJson) {
        try {
          return JSON.parse(line);
        } catch (e) {
          return line;
        }
      } else {
        return line;
      }
    });
}

export async function updateDaemonIfOutdated({
  session,
  options,
}: {
  session: ISandboxSession;
  options: CreateSandboxOptions;
}) {
  try {
    // Get the current daemon file content
    const newDaemonHash = createHash("sha256")
      .update(getDaemonFile())
      .digest("hex");
    // Check if daemon file exists and get its hash
    const hashCheckCommand = `if [ -f ${DAEMON_FILE_PATH} ]; then sha256sum ${DAEMON_FILE_PATH} | cut -d' ' -f1; else echo "NO_FILE"; fi`;
    const existingHash = (await session.runCommand(hashCheckCommand)).trim();

    // If file doesn't exist or hash differs, update the daemon
    if (existingHash === "NO_FILE" || existingHash !== newDaemonHash) {
      console.log(
        `Daemon update needed: existing hash=${existingHash}, new hash=${newDaemonHash}`,
      );
      await sendKillMessage({ session });
      // Remove the old daemon files
      await session.runCommand(
        `rm -f ${DAEMON_FILE_PATH} ${MCP_SERVER_FILE_PATH} ${MCP_SERVER_JSON_FILE_PATH} ${defaultPipePath}`,
      );
      // Install the new daemon
      await installDaemon({
        session,
        environmentVariables: options.environmentVariables,
        githubAccessToken: options.githubAccessToken,
        agentCredentials: options.agentCredentials,
        userMcpConfig: options.mcpConfig,
        publicUrl: options.publicUrl,
        featureFlags: options.featureFlags,
        credentialBroker: options.credentialBroker,
      });
      console.log("Daemon updated successfully");
    } else {
      console.log("Daemon is up-to-date");
    }
  } catch (error) {
    // Don't throw - we don't want to fail sandbox resumption if update fails
    console.error("Error checking/updating daemon:", error);
  }
}

export async function restartDaemonIfNotRunning({
  session,
  options,
}: {
  session: ISandboxSession;
  options: CreateSandboxOptions;
}) {
  if (await sendPingMessage({ session })) {
    console.log("Daemon is already running");
    return;
  }
  console.log("Daemon is not ready/running, restarting it...");
  console.log("Killing existing daemon");
  await sendKillMessage({ session });
  console.log("Starting daemon");
  await startDaemon({
    session,
    environmentVariables: options.environmentVariables || [],
    githubAccessToken: options.githubAccessToken,
    agentCredentials: options.agentCredentials,
    publicUrl: options.publicUrl,
    featureFlags: options.featureFlags,
    credentialBroker: options.credentialBroker,
  });
  console.log("Daemon started, waiting for it to be ready");
  await waitForDaemonReady(session);
}

export async function sendMessage({
  session,
  message,
}: {
  session: ISandboxSession;
  message: DaemonMessage;
}) {
  const jsonMessage = JSON.stringify(message);
  const filePath = `/tmp/terragon-msg-${Date.now()}.json`;
  await session.writeTextFile(filePath, jsonMessage);
  await session.runCommand(`chmod 666 ${filePath}`);
  await session.runCommand(
    `timeout 5s cat ${filePath} | node ${DAEMON_FILE_PATH} --write --timeout=5000`,
    { timeoutMs: 5000 },
  );
  console.log("Message sent to daemon");
}

export async function sendPingMessage({
  session,
}: {
  session: ISandboxSession;
}): Promise<boolean> {
  try {
    await sendMessage({ session, message: { type: "ping" } });
    return true;
  } catch (error) {
    return false;
  }
}

async function sendKillMessage({ session }: { session: ISandboxSession }) {
  try {
    // Send a kill message to the daemon
    await sendMessage({ session, message: { type: "kill" } });
    // Wait a bit for process to terminate
    await new Promise((resolve) => setTimeout(resolve, 100));
  } catch (error) {
    // Ignore errors during kill
    console.error("Error killing existing daemon", { error });
  }
}
