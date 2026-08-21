import { nanoid } from "nanoid/non-secure";
import type {
  Part,
  TextPart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
} from "@opencode-ai/sdk/client";
import { IDaemonRuntime } from "./runtime";
import {
  ClaudeMessage,
  type PermissionMode,
  reviewPolicyArgsFor,
} from "./shared";

/**
 * Get the Opencode API key from the environment.
 * The key is passed from the sandbox environment variables.
 */
export function getOpencodeApiKeyOrNull(_runtime: IDaemonRuntime): string {
  return process.env.OPENCODE_API_KEY ?? "";
}

/**
 * Opencode CLI event structure
 * Based on opencode's internal message format
 */
type OpencodeEvent = {
  type: "tool_use" | "text" | "step_start" | "step_finish" | "error";
  timestamp: number;
  sessionID: string;
  part?: Part;
  error?: {
    name: string;
    message: string;
    data?: {
      message: string;
      [key: string]: unknown;
    };
  };
};

/**
 * Parse a line of JSON output from Opencode CLI.
 * Opencode outputs events in its own format which we transform to ClaudeMessage format.
 *
 * Event types from opencode (using @opencode-ai/sdk types):
 * - tool_use: Tool execution completed (transform to assistant + user messages)
 *   - part.type === "tool" (ToolPart)
 * - text: Text output from assistant (transform to assistant message)
 *   - part.type === "text" (TextPart)
 * - step_start: Start of a reasoning step (transform to system message)
 *   - part.type === "step-start" (StepStartPart)
 * - step_finish: End of a reasoning step (track session, ignore in output)
 *   - part.type === "step-finish" (StepFinishPart)
 * - error: Error occurred (transform to result error message)
 *
 * @param line - A line of JSON output from opencode
 * @param runtime - The daemon runtime for logging
 * @returns Array of ClaudeMessage objects (transformed from opencode events)
 */
export function parseOpencodeLine({
  line,
  runtime,
  isWorking,
}: {
  line: string;
  runtime: IDaemonRuntime;
  isWorking: boolean;
}): ClaudeMessage[] {
  const messages: ClaudeMessage[] = [];

  // Try to parse as JSON
  let opencodeEvent: OpencodeEvent;
  try {
    opencodeEvent = JSON.parse(line) as OpencodeEvent;
  } catch (e) {
    runtime.logger.error("Failed to parse Opencode output line", {
      line,
      error: e,
    });
    return messages;
  }

  const eventType = opencodeEvent.type;
  const sessionID = opencodeEvent.sessionID || "";

  switch (eventType) {
    case "tool_use": {
      const part = opencodeEvent.part as ToolPart | undefined;
      if (!part || part.type !== "tool") {
        runtime.logger.warn(
          "Invalid tool_use event: missing or wrong part type",
          {
            eventType,
            partType: part?.type,
          },
        );
        return messages;
      }

      const toolName = part.tool;
      const toolState = part.state;
      const toolUseId = part.callID;

      // Transform tool name to match Claude's format
      const normalizedToolName =
        toolName.charAt(0).toUpperCase() + toolName.slice(1);

      switch (toolState.status) {
        case "pending": {
          // Tool is queued but not started yet - don't emit anything
          return messages;
        }

        case "running": {
          // Tool is executing - emit just the tool_use (assistant message)
          messages.push({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  name: normalizedToolName,
                  input: toolState.input || {},
                  id: toolUseId,
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: sessionID,
          });
          return messages;
        }

        case "completed":
        case "error": {
          // Tool finished - emit both tool_use (assistant) and tool_result (user)
          messages.push({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  name: normalizedToolName,
                  input: toolState.input,
                  id: toolUseId,
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: sessionID,
          });

          // Create user message with tool_result
          const isError = toolState.status === "error";
          const content = isError ? toolState.error : toolState.output;

          messages.push({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content,
                  is_error: isError,
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: sessionID,
          });

          return messages;
        }

        default: {
          const _exhaustiveCheck: never = toolState;
          runtime.logger.warn("Unknown tool state", {
            status: _exhaustiveCheck,
          });
          return messages;
        }
      }
    }

    case "text": {
      const part = opencodeEvent.part as TextPart | undefined;
      if (!part || part.type !== "text") {
        runtime.logger.warn("Invalid text event: missing or wrong part type", {
          eventType,
          partType: part?.type,
        });
        return messages;
      }

      // Only emit when text is complete (has end time)
      if (!part.time?.end) {
        return messages;
      }

      messages.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: part.text,
        },
        parent_tool_use_id: null,
        session_id: sessionID,
      });

      return messages;
    }

    case "step_start": {
      const part = opencodeEvent.part as StepStartPart | undefined;
      if (!part || part.type !== "step-start") {
        runtime.logger.warn(
          "Invalid step_start event: missing or wrong part type",
          {
            eventType,
            partType: part?.type,
          },
        );
        return messages;
      }
      // Skip step_start event if the agent is already working
      if (isWorking) {
        return messages;
      }
      // Create system init message for first step
      messages.push({
        type: "system",
        subtype: "init",
        session_id: sessionID,
        tools: [],
        mcp_servers: [],
      });
      return messages;
    }

    case "step_finish": {
      const part = opencodeEvent.part as StepFinishPart | undefined;
      if (!part || part.type !== "step-finish") {
        runtime.logger.warn(
          "Invalid step_finish event: missing or wrong part type",
          {
            eventType,
            partType: part?.type,
          },
        );
        return messages;
      }

      // Log token usage but don't create a message
      runtime.logger.debug("Opencode step finished", {
        tokens: part.tokens,
        cost: part.cost,
      });

      return messages;
    }

    case "error": {
      const error = opencodeEvent.error;
      const errorMessage =
        error?.data?.message || error?.message || "Unknown error";

      messages.push({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: sessionID,
        error: errorMessage,
        num_turns: 0,
        duration_ms: 0,
      });

      return messages;
    }

    default: {
      runtime.logger.debug("Unknown Opencode event type, ignoring", {
        type: eventType,
        event: opencodeEvent,
      });
      return messages;
    }
  }
}

/**
 * Review tool-policy for opencode (#88, ADR-004 named seam). Ships `[]`:
 * unlike the other four harnesses, opencode's real review restriction is
 * NOT a CLI arg at all — opencode's permission system is enforced entirely
 * by its `permission.ask` plugin hook (`OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT`,
 * packages/sandbox/src/agents/opencode-config.ts), so args are the wrong
 * seam for this CLI regardless of the pinned version, opencode-ai 1.0.149
 * (packages/sandbox-image/Dockerfile.hbs:81-86). The actual AC2 fix is the
 * plugin itself becoming mode-aware (see opencode-config.ts's
 * `TERRAGON_REVIEW_MODE` marker), set via `opencodeAdapter.prepareEnv` in
 * review mode. This seam stays wired (composed as a no-op array spread
 * below) for contract symmetry with the other four adapters.
 */
export function opencodeReviewPolicyArgs(): string[] {
  return [];
}

/**
 * Create a command to run the Opencode CLI with the given prompt.
 *
 * The command format is:
 *   cat <prompt_file> | opencode run --model <model> --format json [--session <sessionId>]
 *
 * @param runtime - The daemon runtime
 * @param prompt - The prompt to send to Opencode
 * @returns The shell command to execute
 */
export function opencodeCommand({
  runtime,
  prompt,
  model,
  sessionId,
  permissionMode,
}: {
  runtime: IDaemonRuntime;
  prompt: string;
  model: string;
  sessionId: string | null;
  permissionMode?: PermissionMode;
}): string {
  // NOTE: We can remove once everything deploys for a day or so
  // now that we're using the normalizedModelForDaemon function.
  // Use the terry provider prefix for Opencode models
  let normalizedModel = model;
  if (model.startsWith("opencode/")) {
    normalizedModel = model.replace("opencode/", "terry/");
  }
  if (model.startsWith("opencode-google/")) {
    normalizedModel = model.replace("opencode-google/", "terry-google/");
  }
  if (model.startsWith("opencode-oai")) {
    normalizedModel = model.replace("opencode-oai/", "terry-oai/");
  }
  if (model.startsWith("opencode-ant")) {
    normalizedModel = model.replace("opencode-ant/", "terry-ant/");
  }
  // Write prompt to a temporary file
  const tmpFileName = `/tmp/opencode-prompt-${nanoid()}.txt`;
  runtime.writeFileSync(tmpFileName, prompt);
  // Build the command pipeline
  const parts = [
    "cat",
    tmpFileName,
    "|",
    "opencode",
    "run",
    "--model",
    normalizedModel,
    "--format",
    "json",
  ];
  if (sessionId) {
    parts.push("--session", sessionId);
  }
  parts.push(...reviewPolicyArgsFor(permissionMode, opencodeReviewPolicyArgs));
  return parts.join(" ");
}
