import type { AIModel } from "@terragon/agent/types";
import type { CredentialSource } from "../model/credential-source";
import type { GitDiffStats } from "./types";

export type DBMessage =
  | DBUserMessage
  | DBAgentMessage
  | DBSystemMessage
  | DBToolCall
  | DBToolResult
  | DBGitDiffMessage
  | DBStopMessage
  | DBErrorMessage
  | DBMetaMessage
  | DBThreadContextMessage
  | DBThreadContextResultMessage
  | DBCredentialSourceMessage;

export type DBUserMessage = {
  type: "user";
  model: AIModel | null;
  parts: (
    | DBTextPart
    | DBImagePart
    | DBRichTextPart
    | DBPdfPart
    | DBTextFilePart
  )[];
  timestamp?: string;
  permissionMode?: "allowAll" | "plan";
};

export type DBUserMessageWithModel = DBUserMessage & {
  model: AIModel;
};

export type DBSystemMessage = {
  type: "system";
  message_type:
    | "cancel-schedule"
    | "fix-github-checks"
    | "retry-git-commit-and-push"
    | "generic-retry"
    | "invalid-token-retry"
    | "clear-context"
    | "compact-result";
  parts: DBTextPart[];
  timestamp?: string;
  model?: AIModel | null;
};

export type DBThreadContextMessage = {
  type: "thread-context";
  threadId: string;
  threadChatId: string;
  threadChatHistory: string;
  taskDescription: string;
};

export type DBThreadContextResultMessage = {
  type: "thread-context-result";
  summary: string;
};

/**
 * Which credential path an agent run actually took (#209 item 1), appended by
 * POST /api/daemon/run-credential-source. The payload is the closed enum and
 * nothing else — there is no free-text field, so no credential material can
 * reach the message stream by construction.
 */
export type DBCredentialSourceMessage = {
  type: "credential-source";
  source: CredentialSource;
  timestamp?: string;
};

export type DBRichTextPart = {
  type: "rich-text";
  nodes: DBRichTextNode[];
};

export type DBRichTextNode =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      text: string;
    }
  | {
      type: "link";
      text: string;
    };

export type DBTextPart = {
  type: "text";
  text: string;
};

type DBImagePart = {
  type: "image";
  mime_type: string;
  image_url: string;
};

type DBPdfPart = {
  type: "pdf";
  mime_type: string;
  pdf_url: string;
  filename?: string;
};

type DBTextFilePart = {
  type: "text-file";
  mime_type: string;
  file_url: string;
  filename?: string;
};

export type DBThinkingPart = {
  type: "thinking";
  thinking: string;
};

type DBToolCall = {
  type: "tool-call";
  id: string;
  name: string;
  parameters: Record<string, any>;
  parent_tool_use_id: string | null;
};

type DBToolResult = {
  type: "tool-result";
  id: string;
  is_error: boolean | null;
  parent_tool_use_id: string | null;
  result: string;
};

type DBAgentMessage = {
  type: "agent";
  parent_tool_use_id: string | null;
  parts: (DBTextPart | DBThinkingPart)[];
};

type DBGitDiffMessage = {
  type: "git-diff";
  diff: string;
  diffStats?: GitDiffStats | null;
  timestamp?: string;
  description?: string;
};

type DBStopMessage = {
  type: "stop";
};

type DBErrorMessage = {
  type: "error";
  error_type?: string; // Can be ThreadErrorType or any string
  error_info?: string;
  timestamp?: string;
};

type DBMetaMessage = DBSystemMetaMessage | DBResultMetaMessage;

type DBSystemMetaMessage =
  | {
      type: "meta";
      subtype: "system-init";
      session_id: string;
      tools: string[];
      mcp_servers: {
        name: string;
        status: string;
      }[];
    }
  | {
      type: "meta";
      subtype: "system-metadata";
      content: string;
    };

export type DBResultMetaMessage = {
  type: "meta";
  subtype: "result-success" | "result-error-max-turns" | "result-error";
  cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  result?: string;
  session_id: string;
};
