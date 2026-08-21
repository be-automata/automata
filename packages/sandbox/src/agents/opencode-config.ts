import { AIModel } from "@terragon/agent/types";
import { McpConfig } from "../mcp-config";
import { agentToModels, getModelDisplayName } from "@terragon/agent/utils";

export function getModelId(modelName: AIModel): string {
  switch (modelName) {
    case "opencode/grok-code":
      // https://openrouter.ai/x-ai/grok-code-fast-1
      return "x-ai/grok-code-fast-1";
    case "opencode/qwen3-coder":
      // https://openrouter.ai/qwen/qwen3-coder:exacto
      return "qwen/qwen3-coder:exacto";
    case "opencode/kimi-k2":
      // https://openrouter.ai/moonshotai/kimi-k2-0905:exacto
      return "moonshotai/kimi-k2-0905:exacto";
    case "opencode/glm-4.6":
      // https://openrouter.ai/z-ai/glm-4.6:exacto
      return "z-ai/glm-4.6:exacto";
    case "opencode/gemini-2.5-pro":
      // https://openrouter.ai/google/gemini-2.5-pro
      return "google/gemini-2.5-pro";
    case "opencode/gemini-3-pro":
      // https://openrouter.ai/google/gemini-3-pro-preview
      return "google/gemini-3-pro-preview";
    default:
      throw new Error(`Unknown model: ${modelName}`);
  }
}

// https://opencode.ai/docs/config/
export function buildOpencodeConfig({
  publicUrl,
  userMcpConfig,
}: {
  publicUrl: string;
  userMcpConfig: McpConfig | undefined;
}): string {
  const mcp: Record<string, any> = {};
  for (const [name, server] of Object.entries(
    userMcpConfig?.mcpServers ?? {},
  )) {
    if ("command" in server) {
      mcp[name] = {
        type: "local",
        command: [server.command, ...(server.args ?? [])],
        enabled: true,
        environment: server.env,
      };
    } else if ("url" in server) {
      mcp[name] = {
        type: "remote",
        url: server.url,
        enabled: true,
        headers: server.headers,
      };
    }
  }

  const openRouterModels = Object.fromEntries(
    agentToModels("opencode", {
      agentVersion: "latest",
      // For the config, just include all available models
      enableOpenRouterOpenAIAnthropicModel: true,
      enableOpencodeGemini3ProModelOption: true,
    })
      .filter((model) => model.startsWith("opencode/"))
      .map((model) => {
        const displayName = getModelDisplayName(model);
        const modelName = model.split("/")[1]!;
        return [
          modelName,
          {
            id: getModelId(model),
            name: displayName.fullName,
          },
        ];
      }),
  );

  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    mcp,
    provider: {
      terry: {
        npm: "@ai-sdk/openai-compatible",
        name: "Terragon",
        options: {
          baseURL: `${publicUrl}/api/proxy/openrouter/v1`,
          headers: { "X-Daemon-Token": "{env:DAEMON_TOKEN}" },
        },
        models: openRouterModels,
      },
      "terry-google": {
        npm: "@ai-sdk/google",
        name: "Terragon Google",
        options: {
          baseURL: `${publicUrl}/api/proxy/google/v1`,
          apiKey: "unused",
          headers: {
            "X-Daemon-Token": "{env:DAEMON_TOKEN}",
          },
        },
        models: {
          "gemini-2.5-pro": {
            id: "gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
          },
          "gemini-3-pro": {
            id: "gemini-3-pro-preview",
            name: "Gemini 3 Pro",
          },
        },
      },
      "terry-ant": {
        npm: "@ai-sdk/anthropic",
        name: "Terragon Anthropic",
        options: {
          baseURL: `${publicUrl}/api/proxy/anthropic/v1`,
          apiKey: "unused",
          headers: { "X-Daemon-Token": "{env:DAEMON_TOKEN}" },
        },
        models: {
          sonnet: {
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
          },
        },
      },
      "terry-oai": {
        npm: "@ai-sdk/openai",
        name: "Terragon OpenAI",
        options: {
          baseURL: `${publicUrl}/api/proxy/openai/v1`,
          apiKey: "unused",
          headers: { "X-Daemon-Token": "{env:DAEMON_TOKEN}" },
        },
        models: {
          "gpt-5": {
            id: "gpt-5",
            name: "GPT-5",
          },
          "gpt-5-codex": {
            id: "gpt-5-codex",
            name: "GPT-5-Codex",
          },
        },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Mode-aware auto-approve plugin (#88 AC2, closing ADR-004's amendment gap
 * #3). Normal-mode behavior is UNCHANGED: every `permission.ask` is
 * allowed, exactly as before. In review mode — signalled by the
 * `TERRAGON_REVIEW_MODE` env marker `opencodeAdapter.prepareEnv` sets on the
 * spawned process when `permissionMode === "review"` (#88) — every ask is
 * DENIED instead. This is deliberately coarse (deny ALL asks, not just
 * write-class ones): opencode's `permission.ask` input does not reliably
 * distinguish a pure-read tool call from a write one across all providers,
 * and ADR-004's principle is that a review fence that is too strict (an
 * agent that can't act) is safe, while one that is too permissive
 * (allowing a write it shouldn't) is the actual hazard. `reviewPolicyArgs()`
 * for opencode is `[]` — this plugin, not a CLI arg, is the real seam (see
 * opencode.ts's opencodeReviewPolicyArgs() JSDoc).
 *
 * This closes ADR-004's amendment gap #3 ("OpenCode auto-approves every
 * permission") but NOT the on-disk credential channel (gap #1, tracked by
 * #89) — a review agent with this plugin still cannot use tools to push,
 * but `~/.git-credentials` remains a separate, still-open channel.
 */
export const OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT = `\
import { Plugin } from "@opencode-ai/plugin";

export default (async (ctx) => {
  return {
    "permission.ask": async (input, output) => {
      output.status = process.env.TERRAGON_REVIEW_MODE === "1" ? "deny" : "allow";
    },
  };
}) satisfies Plugin;`;
