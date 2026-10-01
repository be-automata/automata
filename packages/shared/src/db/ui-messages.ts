/////////////////
// Messages
/////////////////
import { AIAgent } from "@terragon/agent/types";
import { DBSystemMessage } from "./db-message";
import { GitDiffStats } from "./types";
import { AIModel } from "@terragon/agent/types";

export type UIMessage = UIUserMessage | UIAgentMessage | UISystemMessage;

export type UIUserMessage = {
  role: "user";
  parts: (
    | UITextPart
    | UIImagePart
    | UIRichTextPart
    | UIPdfPart
    | UITextFilePart
  )[];
  timestamp?: string;
  model?: AIModel | null;
};

export type UIAgentMessage = {
  role: "agent";
  agent: AIAgent;
  parts: UIPart[];
};

export type UISystemMessage =
  | {
      role: "system";
      message_type: DBSystemMessage["message_type"];
      parts: UITextPart[];
    }
  | {
      role: "system";
      message_type: "stop";
      parts: UIStopPart[];
    }
  | {
      role: "system";
      message_type: "git-diff";
      parts: UIGitDiffPart[];
    }
  /**
   * Which credential path the run took (#209 item 1). Exactly one text part,
   * holding the label already resolved by describeCredentialSource — the UI
   * never re-derives the copy and never carries the raw enum.
   */
  | {
      role: "system";
      message_type: "credential-source";
      parts: UITextPart[];
    };

/////////////////
// Parts
/////////////////

export type UIPart =
  | UITextPart
  | UIThinkingPart
  | AllToolParts
  | UIImagePart
  | UIRichTextPart
  | UIPdfPart
  | UITextFilePart;

export type UIStopPart = {
  type: "stop";
};

export type UITextPart = {
  type: "text";
  text: string;
};

export type UIThinkingPart = {
  type: "thinking";
  thinking: string;
};

export type UIImagePart = {
  type: "image";
  image_url: string;
};

export type UIPdfPart = {
  type: "pdf";
  pdf_url: string;
  filename?: string;
};

export type UITextFilePart = {
  type: "text-file";
  file_url: string;
  filename?: string;
  mime_type?: string;
};

export type UIRichTextPart = {
  type: "rich-text";
  nodes: Array<{
    type: "text" | "mention" | "link";
    text: string;
  }>;
};

export type UIGitDiffPart = {
  type: "git-diff";
  diff: string;
  diffStats?: GitDiffStats;
  timestamp?: string;
  description?: string;
};

export type AllToolParts =
  | UIToolPart<"Read", ToolParams["Read"]>
  | UIToolPart<"Write", ToolParams["Write"]>
  | UIToolPart<"Edit", ToolParams["Edit"]>
  | UIToolPart<"MultiEdit", ToolParams["MultiEdit"]>
  | UIToolPart<"Glob", ToolParams["Glob"]>
  | UIToolPart<"Grep", ToolParams["Grep"]>
  | UIToolPart<"LS", ToolParams["LS"]>
  | UIToolPart<"NotebookRead", ToolParams["NotebookRead"]>
  | UIToolPart<"NotebookEdit", ToolParams["NotebookEdit"]>
  | UIToolPart<"Bash", ToolParams["Bash"]>
  | UIToolPart<"WebFetch", ToolParams["WebFetch"]>
  | UIToolPart<"WebSearch", ToolParams["WebSearch"]>
  | UIToolPart<"TodoRead", ToolParams["TodoRead"]>
  | UIToolPart<"TodoWrite", ToolParams["TodoWrite"]>
  | UIToolPart<"Task", ToolParams["Task"]>
  | UIToolPart<"SuggestFollowupTask", ToolParams["SuggestFollowupTask"]>
  | UIToolPart<"ExitPlanMode", ToolParams["ExitPlanMode"]>
  | UIToolPart<string, Record<string, any>>;

export type UIToolPart<
  TName extends string,
  TParams extends Record<string, any>,
> = UIPendingToolPart<TName, TParams> | UICompletedToolPart<TName, TParams>;

interface UIBaseToolPart<
  TName extends string,
  TParams extends Record<string, any>,
> {
  type: "tool";
  id: string;
  agent: AIAgent;
  name: TName;
  parameters: TParams;
  parts: UIPart[];
}

export interface UIPendingToolPart<
  TName extends string,
  TParams extends Record<string, any>,
> extends UIBaseToolPart<TName, TParams> {
  status: "pending";
}

export interface UICompletedToolPart<
  TName extends string,
  TParams extends Record<string, any>,
> extends UIBaseToolPart<TName, TParams> {
  status: "completed" | "error";
  result: string;
}

interface ToolParams {
  Read: {
    file_path: string;
    limit?: number;
    offset?: number;
  };

  Write: {
    file_path: string;
    content: string;
  };

  Edit: {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
    expected_replacements?: number;
  };

  MultiEdit: {
    file_path: string;
    edits: Array<{
      old_string: string;
      new_string: string;
      expected_replacements?: number;
    }>;
  };

  Glob: {
    pattern: string;
    path?: string;
  };

  Grep: {
    pattern: string;
    path?: string;
    include?: string;
  };

  LS: {
    path: string;
    ignore?: string[];
  };

  NotebookRead: {
    notebook_path: string;
  };

  NotebookEdit: {
    notebook_path: string;
    cell_number: number;
    new_source: string;
    cell_type?: "code" | "markdown";
    edit_mode?: "replace" | "insert" | "delete";
  };

  Bash: {
    command: string;
    description?: string;
    timeout?: number;
  };

  WebFetch: {
    url: string;
    prompt: string;
  };

  WebSearch: {
    query: string;
    allowed_domains?: string[];
    blocked_domains?: string[];
  };

  TodoRead: {};

  TodoWrite: {
    todos: Array<{
      id: string;
      content: string;
      status: "pending" | "in_progress" | "completed";
      priority: "high" | "medium" | "low";
    }>;
  };

  Task: {
    description: string;
    prompt: string;
    subagent_type?: string;
  };

  SuggestFollowupTask: {
    title: string;
    description: string;
  };

  ExitPlanMode: {
    plan: string;
  };
}
