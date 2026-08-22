import * as z from "zod/v4";
import { Anthropic } from "@anthropic-ai/sdk";
import { AIAgentSchema } from "@terragon/agent/types";

export const defaultPipePath = "/tmp/terragon-daemon.pipe";
export const defaultUnixSocketPath = "/tmp/terragon-daemon.sock";

// Increment this when you make a breaking change to the daemon.
// 1: Supports the --version flag
export const DAEMON_VERSION = "1";

// TODO sawyer: we don't want to depend on shared so mirror the ones we need here.
export type FeatureFlags = {
  mcpPermissionPrompt?: boolean;
};

export const DaemonMessageClaudeSchema = z.object({
  type: z.literal("claude"),
  token: z.string(),
  prompt: z.string(),
  model: z.string(),
  agent: AIAgentSchema,
  agentVersion: z.number(),
  sessionId: z.string().nullable(),
  threadId: z.string(),
  threadChatId: z.string(),
  featureFlags: z.record(z.string(), z.boolean()).optional() as z.ZodOptional<
    z.ZodType<FeatureFlags>
  >,
  permissionMode: z.enum(["allowAll", "plan", "review"]).optional(),
  useCredits: z.boolean().optional(),
});

/**
 * The resolved permission mode for a run, derived from the wire schema above
 * so the two can never drift.
 */
export type PermissionMode = NonNullable<
  z.infer<typeof DaemonMessageClaudeSchema>["permissionMode"]
>;

/**
 * Compose a harness's review tool-policy into its command (#88): the policy
 * applies only when the run is in review mode and is a no-op otherwise.
 * Shared by every `*Command()` builder so the mode→policy rule lives in one
 * place.
 */
export function reviewPolicyArgsFor(
  permissionMode: PermissionMode | undefined,
  reviewPolicyArgs: () => string[],
): string[] {
  return permissionMode === "review" ? reviewPolicyArgs() : [];
}

export const DaemonMessagePingSchema = z.object({
  type: z.literal("ping"),
  threadId: z.null().optional(),
  threadChatId: z.null().optional(),
  token: z.null().optional(),
});

export const DaemonMessageKillSchema = z.object({
  type: z.literal("kill"),
  threadId: z.null().optional(),
  threadChatId: z.null().optional(),
  token: z.null().optional(),
});

export const DaemonMessageStopSchema = z.object({
  type: z.literal("stop"),
  threadId: z.string(),
  threadChatId: z.string(),
  token: z.string(),
});

export const DaemonMessageSchema = z.union([
  DaemonMessageClaudeSchema,
  DaemonMessageKillSchema,
  DaemonMessageStopSchema,
  DaemonMessagePingSchema,
]);

export type DaemonMessageClaude = z.infer<typeof DaemonMessageClaudeSchema>;
export type DaemonMessageStop = z.infer<typeof DaemonMessageStopSchema>;
export type DaemonMessagePing = z.infer<typeof DaemonMessagePingSchema>;
export type DaemonMessage = z.infer<typeof DaemonMessageSchema>;

export type ClaudeMessage =
  // An assistant message
  | {
      type: "assistant";
      message: Anthropic.MessageParam; // from Anthropic SDK
      parent_tool_use_id: string | null;
      session_id: string;
    }

  // A user message
  | {
      type: "user";
      message: Anthropic.MessageParam; // from Anthropic SDK
      parent_tool_use_id: string | null;
      session_id: string;
    }

  // A stop message
  | {
      type: "custom-stop";
      session_id: null;
      duration_ms: number;
    }

  // A custom error message
  | {
      type: "custom-error";
      session_id: null;
      duration_ms: number;
      error_info?: string;
    }

  // Emitted as the last message
  | {
      type: "result";
      subtype: "success";
      total_cost_usd: number;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;
      session_id: string;
    }

  // Emitted as the last message, when we've reached the maximum number of turns
  | {
      type: "result";
      subtype: "error_max_turns";
      total_cost_usd: number;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      session_id: string;
    }

  // Emitted as the last message, when there's an error
  | {
      type: "result";
      is_error: true;
      subtype: "error_during_execution";
      duration_ms: number;
      num_turns: number;
      error: string;
      session_id: string;
    }

  // Emitted as the first message at the start of a conversation
  | {
      type: "system";
      subtype: "init";
      session_id: string;
      tools: string[];
      mcp_servers: {
        name: string;
        status: string;
      }[];
    };

export type DaemonEventAPIBody = {
  threadId: string;
  threadChatId: string;
  messages: ClaudeMessage[];
  timezone: string;
};
