import type { AIAgent } from "@terragon/agent/types";
import type { DBMessage, UIMessage, UIUserMessage } from "@terragon/shared";
import type {
  UIAgentMessage,
  UIToolPart,
  UICompletedToolPart,
  UIPart,
  UIGitDiffPart,
  ThreadStatus,
} from "@terragon/shared";
import {
  describeCredentialSource,
  isCredentialSource,
} from "@terragon/shared/model/credential-source";

/**
 * Converts a collection of DBMessages to UIMessages.
 *
 * DBMessages store each interaction separately (user messages, agent messages, tool calls, tool results),
 * while UIMessages group tool calls and results as parts of agent messages.
 *
 * @param dbMessages - The messages from the database
 * @param threadStatus - Optional thread status to determine if pending tools should be marked complete
 */
export function toUIMessages({
  dbMessages,
  agent,
  threadStatus,
}: {
  dbMessages: DBMessage[];
  agent: AIAgent;
  threadStatus?: ThreadStatus | null;
}): UIMessage[] {
  const uiMessages: UIMessage[] = [];
  let currentAgentMessage: UIAgentMessage | null = null;
  let currentUserMessage: UIUserMessage | null = null;

  // Map to store tool parts by their ID for efficient lookup
  const toolPartsById: Record<string, UIToolPart<string, any>> = {};

  function markPendingToolsAsCompleted() {
    // Mark all pending tool calls as completed with a mock result
    for (const toolPart of Object.values(toolPartsById)) {
      if (toolPart.status === "pending") {
        // Add both status and a mock result to make it a proper UICompletedToolPart
        (toolPart as any).status = "completed";
        (toolPart as any).result = "[Tool execution was interrupted]";
      }
    }
  }

  function getOrCreateAgentMessage(): UIAgentMessage {
    if (currentAgentMessage) {
      return currentAgentMessage;
    }
    currentAgentMessage = {
      role: "agent",
      agent,
      parts: [],
    };
    return currentAgentMessage;
  }

  function getOrCreateUserMessage(): UIUserMessage {
    if (currentUserMessage) {
      return currentUserMessage;
    }
    currentUserMessage = {
      role: "user",
      parts: [],
    };
    return currentUserMessage;
  }

  function clearCurrentUserMessage() {
    if (currentUserMessage) {
      uiMessages.push(currentUserMessage);
      currentUserMessage = null;
    }
  }

  function clearCurrentAgentMessage() {
    if (currentAgentMessage) {
      uiMessages.push(currentAgentMessage);
      currentAgentMessage = null;
    }
  }

  function pushPart(parts: UIPart[], newPart: UIPart) {
    if (newPart.type === "text" && newPart.text.trim() === "") {
      return;
    }
    parts.push(newPart);
  }

  function pushToolPart(parts: UIPart[], toolPart: UIToolPart<string, any>) {
    if (
      toolPart.name === "TodoWrite" &&
      parts.length > 0 &&
      parts[parts.length - 1]?.type === "tool" &&
      (parts[parts.length - 1] as UIToolPart<string, any>).name === "TodoWrite"
    ) {
      // Replace the last tool part with the new one
      parts[parts.length - 1] = toolPart;
    } else {
      pushPart(parts, toolPart);
    }
  }

  for (const dbMessage of dbMessages) {
    if (dbMessage.type === "meta" && dbMessage.subtype === "result-success") {
      clearCurrentAgentMessage();
      clearCurrentUserMessage();
      continue;
    }
    // Type guard for user messages
    if (dbMessage.type === "user") {
      // Mark any pending tools as completed before processing user message
      markPendingToolsAsCompleted();
      clearCurrentAgentMessage();
      const userMessage = getOrCreateUserMessage();
      for (const part of dbMessage.parts) {
        pushPart(userMessage.parts, part);
      }
      userMessage.timestamp = dbMessage.timestamp;
      userMessage.model = dbMessage.model;
    } else if (dbMessage.type === "system") {
      clearCurrentAgentMessage();
      clearCurrentUserMessage();
      uiMessages.push({
        role: "system",
        message_type: dbMessage.message_type,
        parts: dbMessage.parts,
      });
    } else if (dbMessage.type === "agent") {
      clearCurrentUserMessage();
      // Handle agent messages with parent_tool_use_id (nested inside a tool)
      if (dbMessage.parent_tool_use_id) {
        const found = toolPartsById[dbMessage.parent_tool_use_id];
        if (found) {
          // Add agent message parts to the parent tool's parts
          for (const part of dbMessage.parts) {
            pushPart(found.parts, part);
          }
        }
      } else {
        currentAgentMessage = getOrCreateAgentMessage();
        for (const part of dbMessage.parts) {
          pushPart(currentAgentMessage.parts, part);
        }
      }
    } else if (dbMessage.type === "tool-call") {
      clearCurrentUserMessage();
      const newToolPart: UIToolPart<string, any> = {
        type: "tool",
        id: dbMessage.id,
        agent,
        name: dbMessage.name,
        parameters: dbMessage.parameters,
        status: "pending",
        parts: [],
      };
      // Handle tool calls with parent_tool_use_id (nested inside another tool)
      if (dbMessage.parent_tool_use_id) {
        const found = toolPartsById[dbMessage.parent_tool_use_id];
        if (found) {
          pushToolPart(found.parts, newToolPart);
        }
      } else {
        currentAgentMessage = getOrCreateAgentMessage();
        pushToolPart(currentAgentMessage.parts, newToolPart);
      }
      toolPartsById[dbMessage.id] = newToolPart;
    } else if (dbMessage.type === "tool-result") {
      // Find the corresponding tool call and update it with result
      const found = toolPartsById[dbMessage.id];
      if (found) {
        found.status = dbMessage.is_error ? "error" : "completed";
        (found as UICompletedToolPart<string, any>).result = dbMessage.result;
      }
    } else if (dbMessage.type === "git-diff") {
      // Mark any pending tools as completed before processing git diff
      markPendingToolsAsCompleted();
      clearCurrentAgentMessage();
      clearCurrentUserMessage();

      // Add git-diff as a standalone agent message
      const gitDiffPart: UIGitDiffPart = {
        type: "git-diff",
        diff: dbMessage.diff,
        diffStats: dbMessage.diffStats || undefined,
        timestamp: dbMessage.timestamp,
        description: dbMessage.description,
      };
      uiMessages.push({
        role: "system",
        message_type: "git-diff",
        parts: [gitDiffPart],
      });
    } else if (dbMessage.type === "stop") {
      // Mark any pending tools as completed before processing stop
      markPendingToolsAsCompleted();
      clearCurrentAgentMessage();
      clearCurrentUserMessage();
      uiMessages.push({
        role: "system",
        message_type: "stop",
        parts: [{ type: "stop" }],
      });
    } else if (dbMessage.type === "credential-source") {
      clearCurrentAgentMessage();
      clearCurrentUserMessage();
      // A value this build does not know (a future or corrupted writer) renders
      // nothing at all — never a guessed label.
      if (isCredentialSource(dbMessage.source)) {
        uiMessages.push({
          role: "system",
          message_type: "credential-source",
          parts: [
            { type: "text", text: describeCredentialSource(dbMessage.source) },
          ],
        });
      }
    } else if (dbMessage.type === "error") {
      // Mark any pending tools as completed when agent encounters an error
      markPendingToolsAsCompleted();
      clearCurrentAgentMessage();
      clearCurrentUserMessage();
      // Handle error messages (they are not shown in UI messages based on tests)
    } else if (
      dbMessage.type === "meta" &&
      dbMessage.subtype === "result-error-max-turns"
    ) {
      // Mark any pending tools as completed when agent hits max turns
      markPendingToolsAsCompleted();
      // Meta messages are ignored in UI
    }
  }
  clearCurrentUserMessage();
  clearCurrentAgentMessage();

  // If thread is not actively working, mark any remaining pending tools as completed
  if (threadStatus && !isThreadWorking(threadStatus)) {
    markPendingToolsAsCompleted();
  }

  return uiMessages;
}

/**
 * Determines if a thread is actively working based on its status
 */
function isThreadWorking(status: ThreadStatus): boolean {
  const workingStatuses: ThreadStatus[] = [
    "queued",
    "queued-tasks-concurrency",
    "queued-sandbox-creation-rate-limit",
    "queued-agent-rate-limit",
    "booting",
    "working",
    "stopping",
    "checkpointing",
  ];
  return workingStatuses.includes(status);
}
