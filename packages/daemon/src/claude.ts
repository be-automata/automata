import crypto from "node:crypto";
import { nanoid } from "nanoid/non-secure";
import { IDaemonRuntime } from "./runtime";

export function getAnthropicApiKeyOrNull(runtime: IDaemonRuntime) {
  // Check if the user has Claude credentials.
  // If they do, we don't need to set the ANTHROPIC_API_KEY environment variable.
  // If they don't, we need to set it to the API key from the environment.
  const fallbackApiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const cmd =
    "cd && test -f .claude/.credentials.json && echo 'EXISTS' || echo 'NOT_EXISTS'";
  if (runtime.execSync(cmd).trim() === "NOT_EXISTS") {
    return fallbackApiKey;
  }
  try {
    const homeDir = runtime.execSync("cd && pwd").trim();
    const credentials = runtime.readFileSync(
      `${homeDir}/.claude/.credentials.json`,
    );
    const credentialsJSON = JSON.parse(credentials);
    if (credentialsJSON.anthropicApiKey) {
      runtime.logger.info("Using anthropicApiKey from credentials file.");
      return credentialsJSON.anthropicApiKey;
    }
    runtime.logger.info("Not setting ANTHROPIC_API_KEY.");
    // Otherwise, the credentials file exists so we don't need to set the API key.
    return "";
  } catch (e) {
    runtime.logger.error("Error parsing credentials", { error: e });
    return fallbackApiKey;
  }
}

const toolUseErrorStr =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

function isValidSessionId(runtime: IDaemonRuntime, sessionId: string) {
  try {
    // Look for the sessionId in ~/.claude/projects/**/<sessionId>.jsonl
    const homeDir = runtime.execSync("cd && pwd").trim();
    // Escape sessionId to prevent command injection
    const escapedSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "");
    const sessionLogFile = runtime
      .execSync(
        `find ${homeDir}/.claude/projects -name "${escapedSessionId}.jsonl"`,
      )
      .trim();
    if (!sessionLogFile) {
      runtime.logger.warn("No session log file found for sessionId", {
        sessionId,
      });
      return false;
    }
    return true;
  } catch (e) {
    runtime.logger.error("Error finding session log file", {
      sessionId,
    });
  }
  return false;
}

/**
 * If the user interrupted the tool use, we need to fix the logs otherwise claude doesn't know how to continue.
 * Every tool call needs a tool result.
 */
export function maybeFixLogsForSessionId(
  runtime: IDaemonRuntime,
  sessionId: string,
) {
  try {
    // Look for the sessionId in ~/.claude/projects/**/<sessionId>.jsonl
    const homeDir = runtime.execSync("cd && pwd").trim();
    // Escape sessionId to prevent command injection
    const escapedSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "");
    const sessionLogFile = runtime
      .execSync(
        `find ${homeDir}/.claude/projects -name "${escapedSessionId}.jsonl"`,
      )
      .trim();
    if (!sessionLogFile) {
      runtime.logger.warn("No session log file found for sessionId", {
        sessionId,
      });
      return;
    }
    const sessionLog = runtime.readFileSync(sessionLogFile);
    const sessionLogLines = sessionLog
      .split("\n")
      .filter((line) => line.trim());
    const sessionLogLinesParsed = sessionLogLines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);

    let lastUuid: string | null = null;
    const lineByToolUseId: Record<string, any> = {};
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const line of sessionLogLinesParsed) {
      if (line.type === "assistant") {
        for (const part of line.message.content) {
          if (part.type === "tool_use") {
            toolUseIds.add(part.id);
            lineByToolUseId[part.id] = line;
          }
        }
      }
      if (line.type === "user") {
        for (const part of line.message.content) {
          if (part.type === "tool_result") {
            toolResultIds.add(part.tool_use_id);
          }
        }
      }
      lastUuid = line.uuid;
    }
    const toolUseIdsToFix = new Set<string>();
    for (const toolUseId of toolUseIds) {
      if (!toolResultIds.has(toolUseId)) {
        toolUseIdsToFix.add(toolUseId);
      }
    }
    // Nothing to fix.
    if (toolUseIdsToFix.size === 0) {
      return;
    }

    runtime.logger.info("Fixing tool use ids", {
      toolUseIdsToFix: Array.from(toolUseIdsToFix),
    });
    const logLinesToAppend = [];
    for (const toolUseId of toolUseIdsToFix) {
      const line = lineByToolUseId[toolUseId]!;
      const uuid = crypto.randomUUID();
      logLinesToAppend.push({
        ...line,
        parentUuid: lastUuid,
        uuid,
        type: "user",
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: toolUseErrorStr,
              is_error: true,
              tool_use_id: toolUseId,
            },
          ],
        },
        toolUseResult: `Error: ${toolUseErrorStr}`,
      });
      lastUuid = uuid;
    }
    runtime.logger.info(
      `Appending ${logLinesToAppend.length} lines to ${sessionLogFile}`,
    );
    for (const line of logLinesToAppend) {
      runtime.appendFileSync(sessionLogFile, JSON.stringify(line) + "\n");
    }
    runtime.logger.info("Done fixing logs for sessionId", { sessionId });
  } catch (e) {
    runtime.logger.error("Error fixing logs for sessionId", {
      sessionId,
      error: e,
    });
  }
}

/**
 * Single-writer review runs (ADR phase-2): the agent produces a structured
 * review result and the executor is the sole poster — the agent must have
 * NO GitHub-write outlet. --dangerously-skip-permissions bypasses ALL
 * permission checks (so --disallowedTools would be ignored), so it is
 * DROPPED here; a scoped default-mode policy denies gh entirely (read+write)
 * and git push, while keeping repo Read/Grep/Glob + Bash for tests + git
 * diff for the PR diff. The token is separately withheld from the run env
 * (see daemon-env), so a raw curl bypass also has no credential.
 *
 * Extracted verbatim (#75 AC4) so a golden test can pin the review tool
 * policy at a single named seam (ADR-004) — every HarnessAdapter's review
 * policy is expected to converge on an equivalent shape.
 */
export function reviewPolicyArgs(): string[] {
  return [
    "--permission-mode",
    "default",
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "Bash",
    // SHELL-QUOTED: the whole command is joined into a string and run via a
    // shell (`cat prompt | claude ...`), so the parentheses/space/glob in these
    // matchers MUST be single-quoted or the shell errors ("syntax error near
    // unexpected token '('") and the agent never launches.
    "--disallowedTools",
    "'Bash(gh:*)'",
    "'Bash(git push:*)'",
    // Review runs execute UNTRUSTED PR content, and the execution box
    // seeds workspace trust (so review mode can grant its tools at all
    // in -p). Trust also makes the CLI honor the reviewed branch's OWN
    // .claude/settings.json — attacker-controlled on a fork PR, which
    // could allow-list tools beyond this deliberately scoped set.
    // Loading only user-level settings closes that: the repo's
    // settings.json is never read, so the permission surface is exactly
    // these flags regardless of what the PR commits. Supported on both
    // CLI versions in service (verified 2.0.65 and 2.1.235).
    "--setting-sources",
    "user",
  ];
}

export function claudeCommand({
  runtime,
  prompt,
  sessionId,
  model,
  mcpConfigPath,
  permissionMode,
  enableMcpPermissionPrompt = false,
}: {
  runtime: IDaemonRuntime;
  prompt: string;
  sessionId: string | null;
  model: string;
  mcpConfigPath: string | null;
  permissionMode?: "allowAll" | "plan" | "review";
  enableMcpPermissionPrompt?: boolean;
}) {
  // Write prompt to a file.
  const tmpFileName = `/tmp/claude-prompt-${nanoid()}.txt`;
  runtime.writeFileSync(tmpFileName, prompt);

  let resumeOrContinueFlag = "";
  if (sessionId) {
    if (isValidSessionId(runtime, sessionId)) {
      resumeOrContinueFlag = `--resume ${sessionId}`;
    } else {
      runtime.logger.warn(
        "Using the continue flag instead because of invalid sessionId",
        {
          sessionId,
        },
      );
      resumeOrContinueFlag = "--continue";
    }
  }

  const parts = [
    "cat",
    tmpFileName,
    "|",
    "claude",
    "-p",
    "--model",
    model,
    resumeOrContinueFlag,
    "--verbose",
    ...(permissionMode === "plan"
      ? [
          "--permission-mode",
          "plan",
          "--allowedTools",
          "WebSearch",
          "WebFetch",
          "Read",
          "Bash",
        ]
      : permissionMode === "review"
        ? reviewPolicyArgs()
        : ["--dangerously-skip-permissions"]),
    "--output-format",
    "stream-json",
    ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
    ...(enableMcpPermissionPrompt
      ? ["--permission-prompt-tool", "mcp__terry__PermissionPrompt"]
      : []),
    "--append-system-prompt",
    `"${systemPrompt}"`,
  ];
  return parts.join(" ");
}

const systemPrompt = `Your name is Terry and you are a coding agent that works for Terragon Labs. You can use the gh cli to interact with github. You are running as part of a system that might automatically commit and push changes to the remote for you. You can use the git commands to orient yourself.`;
