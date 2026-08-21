import { nanoid } from "nanoid/non-secure";
import type { ThreadEvent } from "@openai/codex-sdk";
import { IDaemonRuntime } from "./runtime";
import {
  ClaudeMessage,
  type PermissionMode,
  reviewPolicyArgsFor,
} from "./shared";

function transformMcpToolCall({
  codexMsg,
  runtime,
}: {
  codexMsg: Extract<
    ThreadEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >;
  runtime: IDaemonRuntime;
}): ClaudeMessage[] {
  const messages: ClaudeMessage[] = [];
  const item = codexMsg.item;
  if (item.type !== "mcp_tool_call") {
    return messages;
  }
  const toolUseId = item.id;
  const status = item.status;
  const server = item.server;
  const tool = item.tool;
  const itemData = item as {
    status?: string;
    result?: unknown;
    response?: unknown;
    output?: unknown;
    error?: unknown;
  };
  switch (status) {
    case "in_progress":
    case undefined: {
      messages.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "MCPTool",
              input: { server, tool },
              id: toolUseId,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "",
      });
      return messages;
    }
    case "completed":
    case "failed": {
      const resultPayload =
        itemData.result ?? itemData.response ?? itemData.output;
      const serializedResult =
        typeof resultPayload === "string"
          ? resultPayload
          : resultPayload
            ? JSON.stringify(resultPayload, null, 2)
            : `MCP tool ${server}::${tool} ${status}.`;
      const errorPayload =
        typeof itemData.error === "string"
          ? itemData.error
          : itemData.error
            ? JSON.stringify(itemData.error, null, 2)
            : null;
      const isError = status === "failed" || errorPayload !== null;
      const resultContent = errorPayload
        ? `Error from MCP tool ${server}::${tool}: ${errorPayload}`
        : serializedResult;
      messages.push({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: resultContent,
              is_error: isError,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "",
      });
      return messages;
    }
    default: {
      const _exhaustiveCheck: never = status;
      runtime.logger.warn("Unknown MCP tool status", {
        status: _exhaustiveCheck,
      });
      return messages;
    }
  }
}

function transformTodoListItem({
  codexMsg,
  eventType,
  runtime,
}: {
  codexMsg: Extract<
    ThreadEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >;
  eventType: "item.started" | "item.updated" | "item.completed";
  runtime: IDaemonRuntime;
}): ClaudeMessage[] {
  const items =
    (codexMsg.item as { items?: Array<{ text: string; completed: boolean }> })
      .items ?? [];
  const formattedItems =
    items.length > 0
      ? items
          .map((item) => {
            const status = item.completed ? "x" : " ";
            return `- [${status}] ${item.text}`;
          })
          .join("\n")
      : "(empty)";

  if (eventType === "item.started") {
    const toolUseId = `${codexMsg.item.id}-read`;
    return [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "TodoRead",
              input: {},
              id: toolUseId,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: `Current todo list:\n${formattedItems}`,
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "",
      },
    ];
  }

  if (eventType === "item.completed") {
    const toolUseId = `${codexMsg.item.id}-write`;
    const todos = items.map((item, index) => ({
      id: `${index + 1}`,
      content: item.text,
      status: (item.completed ? "completed" : "pending") as
        | "completed"
        | "pending"
        | "in_progress",
    }));
    return [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "TodoWrite",
              input: { todos },
              id: toolUseId,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: `Updated todo list:\n${formattedItems}`,
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "",
      },
    ];
  }

  if (eventType === "item.updated") {
    runtime.logger.debug("Ignoring in-progress todo_list update", {
      itemId: codexMsg.item.id,
    });
    return [];
  }

  const _exhaustiveCheck: never = eventType;
  runtime.logger.warn("Unhandled todo_list event type", {
    type: _exhaustiveCheck,
  });
  return [];
}

/**
 * Review tool-policy for codex (#88, ADR-004 named seam). Ships `[]`: the
 * candidate restriction (`--sandbox read-only` replacing
 * `--dangerously-bypass-approvals-and-sandbox`) was researched against the
 * PINNED sandbox image version, codex 0.76.0
 * (packages/sandbox-image/Dockerfile.hbs:81-86), and REJECTED on both
 * verification points the orchestrator required:
 *
 * 1. Codex's OS-level sandbox (Landlock on Linux, falls back through
 *    seccomp/bubblewrap) is documented as unreliable inside containers
 *    without the SYS_ADMIN capability / an unconfined seccomp profile —
 *    exactly the automata sandbox's execution environment — commonly
 *    erroring ("the combination of seccomp/landlock ... is not supported in
 *    this environment") or silently falling back to full access, which
 *    would make `--sandbox read-only` either break the review run or grant
 *    no real restriction at all.
 * 2. Read-only sandbox mode is documented as NOT blocking network access by
 *    default ("Network access (if enabled)") — so it would not add a
 *    meaningful confused-deputy fence even where the sandbox mechanism does
 *    function.
 *
 * A review fence that hangs or breaks the run is worse than the status quo
 * (orchestrator safety ruling, #88): the git-credential withhold
 * (`withholdGitCredentialsInReviewMode`, #76) is the hard guarantee here;
 * this seam stays wired (composed as a no-op array spread below) so a
 * future verified restriction is a one-array edit.
 *
 * Verified against (2026-08-21): codex CLI sandboxing docs
 * (docs.onlinetool.cc/codex/docs/sandbox.html, docs/platform-sandboxing.html)
 * and community reports of Landlock/seccomp failures inside Docker
 * containers (github.com/openai/codex/issues/1039, OpenAI developer
 * community thread "using codex exec within docker (sandbox readonly
 * error)"). Neither source is version-pinned to 0.76.0 specifically, which
 * is itself part of why this ships `[]` rather than a guessed restriction.
 */
export function codexReviewPolicyArgs(): string[] {
  return [];
}

/**
 * Create a command to run the Codex CLI with the given prompt.
 *
 * @param runtime - The daemon runtime
 * @param prompt - The prompt to send to Codex
 * @param model - The specific codex model to use
 * @param agentVersion - The version of the agent to use
 * @returns The shell command to execute
 */
export function codexCommand({
  runtime,
  prompt,
  model,
  sessionId,
  useCredits = false,
  permissionMode,
}: {
  runtime: IDaemonRuntime;
  prompt: string;
  model: string;
  sessionId: string | null;
  useCredits?: boolean;
  permissionMode?: PermissionMode;
}): string {
  // Write prompt to a file
  const tmpFileName = `/tmp/codex-prompt-${nanoid()}.txt`;
  runtime.writeFileSync(tmpFileName, prompt);
  const commandParts = [
    "cat",
    tmpFileName,
    "|",
    "codex",
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--json",
    ...reviewPolicyArgsFor(permissionMode, codexReviewPolicyArgs),
  ];
  switch (model) {
    case "gpt-5-low":
      commandParts.push("--model gpt-5 --config model_reasoning_effort=low");
      break;
    case "gpt-5-high":
      commandParts.push("--model gpt-5 --config model_reasoning_effort=high");
      break;
    case "gpt-5-codex-low":
      commandParts.push(
        "--model gpt-5-codex --config model_reasoning_effort=low",
      );
      break;
    case "gpt-5-codex-medium":
      commandParts.push(
        "--model gpt-5-codex --config model_reasoning_effort=medium",
      );
      break;
    case "gpt-5-codex-high":
      commandParts.push(
        "--model gpt-5-codex --config model_reasoning_effort=high",
      );
      break;
    case "gpt-5.1-low":
      commandParts.push("--model gpt-5.1 --config model_reasoning_effort=low");
      break;
    case "gpt-5.1":
      commandParts.push("--model gpt-5.1");
      break;
    case "gpt-5.1-high":
      commandParts.push("--model gpt-5.1 --config model_reasoning_effort=high");
      break;
    case "gpt-5.1-codex-low":
      commandParts.push(
        "--model gpt-5.1-codex --config model_reasoning_effort=low",
      );
      break;
    case "gpt-5.1-codex-medium":
      commandParts.push(
        "--model gpt-5.1-codex --config model_reasoning_effort=medium",
      );
      break;
    case "gpt-5.1-codex-high":
      commandParts.push(
        "--model gpt-5.1-codex --config model_reasoning_effort=high",
      );
      break;
    case "gpt-5.1-codex-max-low":
      commandParts.push(
        "--model gpt-5.1-codex-max --config model_reasoning_effort=low",
      );
      break;
    case "gpt-5.1-codex-max":
      commandParts.push(
        "--model gpt-5.1-codex-max --config model_reasoning_effort=medium",
      );
      break;
    case "gpt-5.1-codex-max-high":
      commandParts.push(
        "--model gpt-5.1-codex-max --config model_reasoning_effort=high",
      );
      break;
    case "gpt-5.1-codex-max-xhigh":
      commandParts.push(
        "--model gpt-5.1-codex-max --config model_reasoning_effort=xhigh",
      );
      break;
    case "gpt-5.2-low":
      commandParts.push("--model gpt-5.2 --config model_reasoning_effort=low");
      break;
    case "gpt-5.2":
      commandParts.push(
        "--model gpt-5.2 --config model_reasoning_effort=medium",
      );
      break;
    case "gpt-5.2-high":
      commandParts.push("--model gpt-5.2 --config model_reasoning_effort=high");
      break;
    case "gpt-5.2-xhigh":
      commandParts.push(
        "--model gpt-5.2 --config model_reasoning_effort=xhigh",
      );
      break;
    case "gpt-5.2-codex-low":
      commandParts.push(
        "--model gpt-5.2-codex --config model_reasoning_effort=low",
      );
      break;
    case "gpt-5.2-codex-medium":
      commandParts.push(
        "--model gpt-5.2-codex --config model_reasoning_effort=medium",
      );
      break;
    case "gpt-5.2-codex-high":
      commandParts.push(
        "--model gpt-5.2-codex --config model_reasoning_effort=high",
      );
      break;
    case "gpt-5.2-codex-xhigh":
      commandParts.push(
        "--model gpt-5.2-codex --config model_reasoning_effort=xhigh",
      );
      break;
    default: {
      commandParts.push("--model gpt-5");
    }
  }
  if (useCredits) {
    commandParts.push("-c", 'model_provider="terry"');
  }
  if (sessionId) {
    commandParts.push("resume", sessionId);
  }
  return commandParts.join(" ");
}

/**
 * Parse a single line of Codex JSON output into ClaudeMessage format
 *
 * @param line - A single line of JSON output from Codex CLI
 * @param runtime - The daemon runtime
 * @returns An array of ClaudeMessages (empty if the line should be skipped)
 */
export function parseCodexLine({
  line,
  runtime,
}: {
  line: string;
  runtime: IDaemonRuntime;
}): ClaudeMessage[] {
  const messages: ClaudeMessage[] = [];
  // Try to parse as JSON
  let codexMsg: ThreadEvent;
  try {
    codexMsg = JSON.parse(line);
  } catch (e) {
    // Not JSON, treat as regular assistant text
    messages.push({
      type: "assistant",
      message: { role: "assistant", content: line },
      parent_tool_use_id: null,
      session_id: "",
    });
    return messages;
  }
  const msgType = codexMsg.type;
  switch (msgType) {
    case "thread.started": {
      messages.push({
        type: "system",
        subtype: "init",
        session_id: codexMsg.thread_id || "",
        tools: [],
        mcp_servers: [],
      });
      return messages;
    }
    case "turn.started": {
      return messages;
    }
    case "turn.completed": {
      runtime.logger.debug("Codex token usage", {
        input_tokens: codexMsg.usage.input_tokens,
        cached_input_tokens: codexMsg.usage.cached_input_tokens,
        output_tokens: codexMsg.usage.output_tokens,
      });
      return messages;
    }
    case "turn.failed": {
      return messages;
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      return parseCodexItem({ codexMsg, runtime });
    }
    case "error": {
      messages.push({
        type: "result",
        subtype: "error_during_execution",
        session_id: "",
        error: codexMsg.message,
        is_error: true,
        num_turns: 0,
        duration_ms: 0,
      });
      return messages;
    }
    default: {
      const _exhaustiveCheck: never = msgType;
      runtime.logger.warn("Unknown Codex message type", {
        type: _exhaustiveCheck,
        msg: codexMsg,
      });
      // Unknown message type, treat as regular assistant text
      messages.push({
        type: "assistant",
        message: { role: "assistant", content: line },
        parent_tool_use_id: null,
        session_id: "",
      });
      return messages;
    }
  }
}

const CONVERSATION_LENGTH_WARNING_MESSAGE =
  "Long conversations and multiple compactions can cause the model to be less accurate";

function parseCodexItem({
  codexMsg,
  runtime,
}: {
  codexMsg: Extract<
    ThreadEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >;
  runtime: IDaemonRuntime;
}): ClaudeMessage[] {
  const messages: ClaudeMessage[] = [];
  const itemType = codexMsg.item.type;
  const eventType = codexMsg.type;
  // Handle different item types
  switch (itemType) {
    case "reasoning": {
      messages.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: codexMsg.item.text,
              signature: "codex-synthetic-signature",
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "",
      });
      return messages;
    }
    case "agent_message": {
      messages.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: codexMsg.item.text }],
        },
        parent_tool_use_id: null,
        session_id: "",
      });
      return messages;
    }
    case "command_execution": {
      const toolUseId = codexMsg.item.id;
      const itemStatus = codexMsg.item.status;
      switch (itemStatus) {
        case "in_progress": {
          // Convert to Bash tool use
          const command = codexMsg.item.command;
          messages.push({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  name: "Bash",
                  input: { command, description: `Execute: ${command}` },
                  id: toolUseId,
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: "",
          });
          return messages;
        }
        case "completed": {
          const output = codexMsg.item.aggregated_output;
          const exitCode = codexMsg.item.exit_code;
          messages.push({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: output || "Command completed",
                  is_error: exitCode !== 0,
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: "",
          });
          return messages;
        }
        case "failed": {
          const output = codexMsg.item.aggregated_output;
          messages.push({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: output || "Command failed",
                  is_error: true,
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: "",
          });
          return messages;
        }
        default: {
          const _exhaustiveCheck: never = itemStatus;
          runtime.logger.warn("Unknown Codex item status", {
            status: _exhaustiveCheck,
          });
          return messages;
        }
      }
    }
    case "file_change": {
      // File changes are logged but not included in the message stream
      // The actual file content changes are handled by the codex CLI
      const changes = codexMsg.item.changes;
      const paths = changes.map((c) => c.path).join(", ");
      runtime.logger.info("Codex file changes", {
        changes,
        paths,
      });
      return messages;
    }
    case "web_search": {
      const toolUseId = codexMsg.item.id;
      const query = codexMsg.item.query;
      const rawResults = (codexMsg.item as { results?: unknown }).results;
      const status = (codexMsg.item as { status?: string }).status;
      switch (eventType) {
        case "item.started": {
          messages.push({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  name: "WebSearch",
                  input: { query },
                  id: toolUseId,
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: "",
          });
          return messages;
        }
        case "item.updated":
        case "item.completed": {
          const serializedResults =
            typeof rawResults === "string"
              ? rawResults
              : rawResults
                ? JSON.stringify(rawResults, null, 2)
                : `Web search completed for query: ${query}`;
          const isError =
            status?.toLowerCase() === "failed" ||
            (codexMsg.item as { error?: unknown }).error !== undefined;
          messages.push({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: serializedResults,
                  is_error: isError,
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: "",
          });
          return messages;
        }
        default: {
          const _exhaustiveCheck: never = eventType;
          runtime.logger.warn("Unhandled web_search event type", {
            type: _exhaustiveCheck,
          });
          return messages;
        }
      }
    }
    case "error": {
      const message = codexMsg.item.message || "Codex reported an error.";

      // Check if this is just a warning about long conversations, not an actual error
      // There's a bug in codex where warning are logged as errors in json mode.
      const isConversationLengthWarning = message
        .toLowerCase()
        .includes(CONVERSATION_LENGTH_WARNING_MESSAGE.toLowerCase());
      if (isConversationLengthWarning) {
        // Log the warning but don't create an error result
        runtime.logger.warn("Codex conversation length warning", { message });
        return messages;
      }

      runtime.logger.warn("Codex item error", { message });
      messages.push({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "",
        error: message,
        num_turns: 0,
        duration_ms: 0,
      });
      return messages;
    }
    case "mcp_tool_call": {
      return transformMcpToolCall({ codexMsg, runtime });
    }
    case "todo_list": {
      return transformTodoListItem({ codexMsg, eventType, runtime });
    }
    default: {
      const _exhaustiveCheck: never = itemType;
      runtime.logger.warn("Unknown Codex item type", {
        type: _exhaustiveCheck,
      });
      return messages;
    }
  }
}
