import { CreateSandboxOptions, ISandboxSession } from "./types";
import {
  updateDaemonIfOutdated,
  restartDaemonIfNotRunning,
  installDaemon,
  MCP_SERVER_FILE_PATH,
} from "./daemon";
import {
  generateRandomBranchName,
  generateRandomBranchSuffix,
  bashQuote,
} from "./utils";
import { McpConfig } from "./mcp-config";
import { AIAgent, AIAgentCredentials } from "@terragon/agent/types";
import { terragonSetupScriptTimeoutMs } from "./constants";
import { buildAmpSettings } from "./agents/amp-settings";
import { buildCodexToml } from "./agents/codex-config";
import { buildGeminiSettings } from "./agents/gemini-settings";
import {
  buildOpencodeConfig,
  OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT,
} from "./agents/opencode-config";
import { getEnv } from "./env";
import {
  CRED_BROKER_ALIAS,
  CRED_BROKER_GIT_PORT,
  buildGuestCredBrokerGitConfig,
} from "./providers/docker-cred-broker";
import path from "path";

async function createNewBranch({
  session,
  threadName,
  generateBranchName,
}: {
  session: ISandboxSession;
  threadName: string | null;
  generateBranchName: (threadName: string | null) => Promise<string | null>;
}): Promise<void> {
  // Generate a smart branch name based on the thread name
  let baseBranchName = await generateBranchName?.(threadName);
  if (!baseBranchName) {
    baseBranchName = generateRandomBranchName();
  }

  // Always append unique hash to avoid conflicts
  let branchName: string;
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    const uniqueSuffix = generateRandomBranchSuffix();
    branchName = `${baseBranchName}-${uniqueSuffix}`;

    // Check if the branch already exists (locally or remotely)
    const localBranchRef = `refs/heads/${branchName}`;
    const remoteBranchRef = `refs/remotes/origin/${branchName}`;
    const branchCheckResult = await session.runCommand(
      `(git show-ref --verify --quiet ${bashQuote(localBranchRef)} || git show-ref --verify --quiet ${bashQuote(remoteBranchRef)}) && echo "exists" || echo "not-exists"`,
    );
    if (branchCheckResult.trim() === "exists") {
      console.log(`Branch ${branchName} already exists, retrying...`);
      attempts++;
      continue;
    }
    console.log(`Creating branch with hash: ${branchName}`);
    await session.runCommand(`git checkout -b ${bashQuote(branchName)}`);
    return;
  }

  throw new Error(
    `Failed to generate unique branch name after ${maxAttempts} attempts`,
  );
}

/**
 * Run this function one time when creating a sandbox.
 */
export async function setupSandboxOneTime(
  session: ISandboxSession,
  options: CreateSandboxOptions,
) {
  const dotProfileContents = [
    "ulimit -c 0",
    "if [ -f ~/.bashrc ]; then . ~/.bashrc; fi",
  ].join("\n");
  await session.runCommand(
    `echo ${bashQuote(dotProfileContents)} >> ~/.profile`,
    { cwd: "/" },
  );

  await gitCloneRepo(session, options);
  await session.runCommand(
    [
      `git config user.name ${bashQuote(options.userName)}`,
      `git config user.email ${bashQuote(options.userEmail)}`,
      `git config core.pager cat`,
    ].join(" && "),
  );
  if (options.createNewBranch) {
    await createNewBranch({
      session,
      threadName: options.threadName,
      generateBranchName: options.generateBranchName,
    });
  } else if (options.branchName) {
    // Checkout specific branch when createNewBranch is false but branchName is provided
    await session.runCommand(`git checkout ${bashQuote(options.branchName)}`);
  }
  await session.runCommand(`git clean -fxd`);

  // Install daemon while setup script runs in background
  await options.onStatusUpdate({
    sandboxId: session.sandboxId,
    sandboxStatus: "booting",
    bootingStatus: "installing-agent",
  });
  const daemonPromise = installDaemon({
    session,
    environmentVariables: options.environmentVariables || [],
    githubAccessToken: options.githubAccessToken,
    agentCredentials: options.agentCredentials,
    userMcpConfig: options.mcpConfig,
    publicUrl: options.publicUrl,
    featureFlags: options.featureFlags,
    credentialBroker: options.credentialBroker,
  });

  // Wait for daemon to be ready (it has its own 1 second wait)
  await daemonPromise;

  // Only run terragon-setup.sh if not explicitly skipped
  if (options.skipSetupScript) {
    console.log("Skipping setup script");
  } else {
    await options.onStatusUpdate({
      sandboxId: session.sandboxId,
      sandboxStatus: "booting",
      bootingStatus: "running-setup-script",
    });
    await runSetupScript({
      session,
      options: {
        environmentVariables: options.environmentVariables,
        githubAccessToken: options.githubAccessToken,
        agentCredentials: options.agentCredentials,
        credentialBroker: options.credentialBroker,
        setupScript: options.setupScript,
      },
    });
  }
}

export async function gitCloneRepo(
  session: ISandboxSession,
  options: CreateSandboxOptions,
) {
  await options.onStatusUpdate({
    sandboxId: session.sandboxId,
    sandboxStatus: "booting",
    bootingStatus: "cloning-repo",
  });
  // Build clone command with blobless clone and branch specification
  let cloneCommand = `git clone --filter=blob:none --no-recurse-submodules`;
  // Add branch specification if provided
  if (options.repoBaseBranchName) {
    cloneCommand += ` --branch ${bashQuote(options.repoBaseBranchName)}`;
  }
  cloneCommand += ` https://github.com/${options.githubRepoFullName}.git ${session.repoDir}`;
  await session.runCommand(cloneCommand, { cwd: "." });
}

export async function setupGitCredentials(
  session: ISandboxSession,
  options: CreateSandboxOptions,
) {
  // Brokered (#114): the guest NEVER holds the installation token and NO
  // ~/.git-credentials is written on either brokered path.
  //
  // Docker (`docker-sidecar`): route github.com through the per-run
  // credential-broker sidecar (insteadOf + Bearer extraheader). Defensively
  // scrub any residue first (belt-and-suspenders for #89; a fresh base image is
  // clean, so these are normally no-ops). Docker brokered sandboxes are
  // non-resumable (the control plane recreates on resume), so this always runs
  // on a fresh create-path guest.
  if (options.credentialBroker?.kind === "docker-sidecar") {
    const gitConfigScript = buildGuestCredBrokerGitConfig({
      alias: CRED_BROKER_ALIAS,
      port: CRED_BROKER_GIT_PORT,
      bearer: options.credentialBroker.runBearer,
    }).join(" && ");
    await session.runCommand(gitConfigScript, { cwd: "/" });
    return;
  }
  // E2B (`e2b-native`): E2B's egress proxy injects the `Authorization` header
  // per request, OUTSIDE the guest — git uses plain `https://github.com/...`
  // with NO credential of its own. Write no ~/.git-credentials and no broker
  // wiring; only defensively scrub any residue (a fresh template is clean, so
  // this is normally a no-op). This runs on both the create and the in-place
  // resume path (E2B brokered sandboxes resume in place), so scrubbing here
  // also guarantees a resume never re-introduces a raw-token credential file.
  if (options.credentialBroker?.kind === "e2b-native") {
    await session.runCommand(
      [
        `rm -f ~/.git-credentials`,
        `git config --global --unset-all credential.helper || true`,
        `git config --global --unset-all http.https://github.com/.extraheader || true`,
      ].join(" && "),
      { cwd: "/" },
    );
    return;
  }
  // Daytona (`daytona-native`): Daytona substitutes the org Secret's opaque
  // placeholder ONLY where it appears VERBATIM in an outbound HTTPS header.
  // `gh`/Octokit send `Authorization: token <GH_TOKEN>` (GH_TOKEN = the
  // placeholder) → verbatim → substituted. But git's default credential helper
  // sends `Authorization: Basic base64(user:token)`, which base64-WRAPS the
  // placeholder and DEFEATS substitution. So write NO `~/.git-credentials` and
  // instead a VERBATIM `Authorization: token $GH_TOKEN` extraheader for the
  // GitHub hosts. `$GH_TOKEN` is shell-expanded at setup time (from the
  // sandbox-level placeholder Daytona's `secrets` map injected), so the
  // placeholder lands VERBATIM in ~/.gitconfig — it is NON-secret, so writing it
  // to disk preserves never-residency of the REAL token. NEVER base64-wrap.
  // Scrub any residue first (#89 belt-and-suspenders; a fresh snapshot is clean).
  if (options.credentialBroker?.kind === "daytona-native") {
    await session.runCommand(
      [
        `rm -f ~/.git-credentials`,
        `git config --global --unset-all credential.helper || true`,
        `git config --global --unset-all http.https://github.com/.extraheader || true`,
        `git config --global --unset-all http.https://api.github.com/.extraheader || true`,
        `git config --global http.https://github.com/.extraheader "Authorization: token $GH_TOKEN"`,
        `git config --global http.https://api.github.com/.extraheader "Authorization: token $GH_TOKEN"`,
      ].join(" && "),
      { cwd: "/" },
    );
    return;
  }
  try {
    await session.runCommand(`git config --global credential.helper store`, {
      cwd: "/",
    });
  } catch (error) {
    // This is an attempt to fix this:
    // https://discord.com/channels/1389834244985196575/1401876436867878923/1401876436867878923
    if (
      error instanceof Error &&
      error.message.includes(
        "failed to write new configuration file /root/.gitconfig.lock",
      )
    ) {
      console.error(
        "Failed to write new configuration file /root/.gitconfig.lock, continuing anyway",
      );
    } else {
      throw error;
    }
  }

  // Use environment variables to set the git credentials so that these don't show up in our logs or errors.
  await session.runCommand(
    'echo "https://${GITHUB_USER_NAME}:${GITHUB_ACCESS_TOKEN}@github.com" > ~/.git-credentials',
    {
      cwd: "/",
      env: {
        GITHUB_USER_NAME: options.userName,
        GITHUB_ACCESS_TOKEN: options.githubAccessToken,
      },
    },
  );
}

export async function setupSandboxEveryTime({
  session,
  options,
  isCreatingSandbox,
}: {
  session: ISandboxSession;
  options: CreateSandboxOptions;
  isCreatingSandbox: boolean;
}) {
  await setupGitCredentials(session, options);
  if (!options.fastResume) {
    if (options.agent) {
      await updateAgentFiles({
        session,
        customSystemPrompt: options.customSystemPrompt,
        agent: options.agent,
        agentCredentials: options.agentCredentials,
        isCreatingSandbox,
        mcpConfig: options.mcpConfig,
        publicUrl: options.publicUrl,
      });
    }
    if (options.autoUpdateDaemon && !isCreatingSandbox) {
      await updateDaemonIfOutdated({ session, options });
    }
    if (!isCreatingSandbox) {
      await restartDaemonIfNotRunning({ session, options });
    }
  }
}

async function updateAgentFilesShared({
  homeDir,
  session,
  agentConfigDir,
  agentCredentialsFilename,
  isCreatingSandbox,
  agentCredentials,
  customSystemPromptFilename,
  customSystemPrompt,
  otherFiles,
}: {
  homeDir: string;
  session: ISandboxSession;
  agentConfigDir: string;
  agentCredentialsFilename: string | null;
  agentCredentials: AIAgentCredentials | null;
  isCreatingSandbox: boolean;
  customSystemPromptFilename: string;
  customSystemPrompt: string | null | undefined;
  otherFiles?: Array<{
    filename: string;
    content: string;
  }>;
}) {
  const configDirAbsolutePath = path.join(homeDir, agentConfigDir);
  await session.runCommand(`mkdir -p ${configDirAbsolutePath}`, { cwd: "/" });

  if (agentCredentialsFilename) {
    const credentialsPath = path.join(
      configDirAbsolutePath,
      agentCredentialsFilename,
    );
    if (agentCredentials && agentCredentials.type === "json-file") {
      console.log("Writing agent credentials to", credentialsPath);
      await session.writeTextFile(credentialsPath, agentCredentials.contents);
      await session.runCommand(`chmod 600 ${credentialsPath}`, { cwd: "/" });
    } else if (!isCreatingSandbox) {
      console.log("Removing agent credentials from", credentialsPath);
      await session
        .runCommand(`rm -f ${credentialsPath}`, { cwd: "/" })
        .catch(() => {});
    }
  }

  const customSystemPromptPath = path.join(
    configDirAbsolutePath,
    customSystemPromptFilename,
  );
  if (customSystemPrompt) {
    console.log("Writing custom system prompt to", customSystemPromptPath);
    await session.writeTextFile(customSystemPromptPath, customSystemPrompt);
    await session.runCommand(`chmod 644 ${customSystemPromptPath}`, {
      cwd: "/",
    });
  } else if (!isCreatingSandbox) {
    await session
      .runCommand(`rm -f ${customSystemPromptPath}`, { cwd: "/" })
      .catch(() => {});
  }
  if (otherFiles) {
    for (const file of otherFiles) {
      const filePath = path.join(configDirAbsolutePath, file.filename);
      if (path.dirname(filePath) !== configDirAbsolutePath) {
        const dirPath = path.dirname(filePath);
        console.log("Creating directory", dirPath);
        await session.runCommand(`mkdir -p ${dirPath}`, { cwd: "/" });
      }
      console.log("Writing to", filePath);
      await session.writeTextFile(filePath, file.content);
      await session.runCommand(`chmod 644 ${filePath}`, { cwd: "/" });
    }
  }
}

async function updateAgentFiles({
  session,
  agentCredentials,
  customSystemPrompt,
  agent,
  isCreatingSandbox,
  mcpConfig,
  publicUrl,
}: {
  session: ISandboxSession;
  agent: AIAgent;
  agentCredentials: AIAgentCredentials | null;
  customSystemPrompt: string | null | undefined;
  isCreatingSandbox: boolean;
  mcpConfig: McpConfig | undefined;
  publicUrl: CreateSandboxOptions["publicUrl"];
}) {
  const homeDir = (await session.runCommand("cd && pwd", { cwd: "/" })).trim();
  switch (agent) {
    case "claudeCode": {
      await updateAgentFilesShared({
        session,
        homeDir,
        agentConfigDir: ".claude",
        agentCredentialsFilename: ".credentials.json",
        agentCredentials,
        isCreatingSandbox,
        customSystemPromptFilename: "CLAUDE.md",
        customSystemPrompt,
      });
      break;
    }
    case "codex": {
      let normalizedUrl: string | null = publicUrl ?? null;
      if (normalizedUrl) {
        while (normalizedUrl.endsWith("/") && normalizedUrl.length > 1) {
          normalizedUrl = normalizedUrl.slice(0, -1);
        }
      }
      const terryModelProviderBaseUrl = normalizedUrl
        ? `${normalizedUrl}/api/proxy/openai/v1`
        : null;
      await updateAgentFilesShared({
        session,
        homeDir,
        agentConfigDir: ".codex",
        agentCredentialsFilename: "auth.json",
        agentCredentials,
        isCreatingSandbox,
        customSystemPromptFilename: "AGENTS.md",
        customSystemPrompt,
        otherFiles: [
          {
            filename: "config.toml",
            // Always (re)write Codex MCP config TOML including built-in 'terry' server
            content: buildCodexToml({
              userMcpConfig: mcpConfig,
              includeTerry: true,
              terryCommand: "node",
              terryArgs: [MCP_SERVER_FILE_PATH],
              terryModelProviderBaseUrl,
            }),
          },
        ],
      });
      break;
    }
    case "amp": {
      const ampSettingsContent = buildAmpSettings({
        userMcpConfig: mcpConfig,
      });
      await updateAgentFilesShared({
        session,
        homeDir,
        agentConfigDir: ".config",
        agentCredentialsFilename: null,
        agentCredentials: null,
        isCreatingSandbox,
        customSystemPromptFilename: "AGENTS.md",
        customSystemPrompt,
        otherFiles: [
          {
            filename: "amp/settings.json",
            content: ampSettingsContent,
          },
        ],
      });
      break;
    }
    case "opencode": {
      const opencodeConfigContent = buildOpencodeConfig({
        publicUrl,
        userMcpConfig: mcpConfig,
      });
      await updateAgentFilesShared({
        session,
        homeDir,
        agentConfigDir: ".config/opencode",
        agentCredentialsFilename: null,
        agentCredentials: null,
        isCreatingSandbox,
        customSystemPromptFilename: "AGENTS.md",
        customSystemPrompt,
        otherFiles: [
          {
            filename: "opencode.json",
            content: opencodeConfigContent,
          },
          {
            filename: "plugin/auto-approve.ts",
            content: OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT,
          },
        ],
      });
      break;
    }
    case "gemini": {
      const geminiSettingsContent = buildGeminiSettings({
        userMcpConfig: mcpConfig,
      });
      await updateAgentFilesShared({
        session,
        homeDir,
        agentConfigDir: ".gemini",
        agentCredentialsFilename: null,
        agentCredentials: null,
        isCreatingSandbox,
        customSystemPromptFilename: "GEMINI.md",
        customSystemPrompt,
        otherFiles: [
          {
            filename: "settings.json",
            content: geminiSettingsContent,
          },
        ],
      });
      break;
    }
    default: {
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      break;
    }
  }
}

type OnUpdateCallback = (
  type: "stdout" | "stderr" | "error" | "system",
  output: string,
) => Promise<void> | void;

async function executeSetupScriptCommand({
  session,
  command,
  environmentVariables,
  agentCredentials,
  githubAccessToken,
  credentialBroker,
  onUpdate,
}: {
  session: ISandboxSession;
  command: string;
  environmentVariables: CreateSandboxOptions["environmentVariables"];
  agentCredentials: CreateSandboxOptions["agentCredentials"];
  githubAccessToken: string;
  credentialBroker?: CreateSandboxOptions["credentialBroker"];
  onUpdate?: OnUpdateCallback;
}) {
  // To debug some corrupted images issue, lets log the git status before and
  // after the setup script runs.
  await session.runCommand("git status");
  await onUpdate?.("system", `Executing setup script...`);
  await onUpdate?.("system", "=".repeat(50));
  const result = await Promise.race([
    (async () => {
      await session.runCommand(command, {
        timeoutMs: terragonSetupScriptTimeoutMs,
        onStdout: (data) => onUpdate?.("stdout", data),
        onStderr: (data) => onUpdate?.("stderr", data),
        env: getEnv({
          userEnv: environmentVariables,
          githubAccessToken,
          agentCredentials,
          credentialBroker,
          overrides: {
            CI: "true",
            TERM: "xterm",
          },
        }),
      });
    })(),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), terragonSetupScriptTimeoutMs),
    ),
  ]);
  if (result === "timeout") {
    throw new Error(
      `Command timed out after ${terragonSetupScriptTimeoutMs}ms`,
    );
  }
  // Log the git status after the setup script runs
  await session.runCommand("git status");
}

export async function runSetupScript({
  session,
  options,
}: {
  session: ISandboxSession;
  options: Pick<
    CreateSandboxOptions,
    | "environmentVariables"
    | "githubAccessToken"
    | "agentCredentials"
    | "credentialBroker"
  > & {
    setupScript?: string | null;
    setupScriptPath?: string;
    excludeOutputInError?: boolean;
    onUpdate?: (
      type: "stdout" | "stderr" | "error" | "system",
      output: string,
    ) => Promise<void> | void;
  };
}) {
  const customScriptPath =
    options.setupScriptPath || "/tmp/terragon-setup-custom.sh";
  const outputs: string[] = [];
  const onUpdateWrapped: OnUpdateCallback = (type, output) => {
    if (type === "stdout" || type === "stderr") {
      outputs.push(output);
    }
    options.onUpdate?.(type, output);
  };

  try {
    // If a custom setup script is provided, use it instead of checking for terragon-setup.sh
    if (options.setupScript) {
      await options.onUpdate?.(
        "system",
        `Writing setup script to ${customScriptPath}`,
      );
      // Write the custom setup script to a temporary file
      await session.writeTextFile(customScriptPath, options.setupScript);
      await session.runCommand(`chmod +x ${customScriptPath}`);
      await executeSetupScriptCommand({
        session,
        // We know the script path is safe, but mimic the way we invoke the script below for consistency
        command: `bash -c 'if [ -f ${customScriptPath} ]; then chmod +x ${customScriptPath} && bash -x ${customScriptPath}; fi'`,
        environmentVariables: options.environmentVariables,
        agentCredentials: options.agentCredentials,
        githubAccessToken: options.githubAccessToken,
        credentialBroker: options.credentialBroker,
        onUpdate: onUpdateWrapped,
      });
    } else {
      // Use the repository's terragon-setup.sh if it exists
      await executeSetupScriptCommand({
        session,
        command:
          "bash -c 'if [ -f terragon-setup.sh ]; then chmod +x terragon-setup.sh && bash -x ./terragon-setup.sh; fi'",
        environmentVariables: options.environmentVariables,
        agentCredentials: options.agentCredentials,
        githubAccessToken: options.githubAccessToken,
        credentialBroker: options.credentialBroker,
        onUpdate: onUpdateWrapped,
      });
    }
    console.log("Setup script output:", outputs.join("\n"));
  } catch (error) {
    // Include the full output in the error message
    let errorMessage = "Setup script failed";
    if (error instanceof Error) {
      // Extract any output that might be in the error message
      errorMessage = `Setup script failed:\n${error.message}`;
    }
    if (!options.excludeOutputInError) {
      errorMessage += "\n\nOutput:\n" + outputs.join("\n");
    }
    throw new Error(errorMessage);
  }
}
