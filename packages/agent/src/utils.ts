import {
  AIModel,
  AIAgent,
  AIAgentSlashCommand,
  AgentModelPreferences,
  AIModelSchema,
  AIModelExternal,
} from "./types";

const defaultAgent: AIAgent = "claudeCode";

export function ensureAgent(agent: AIAgent | null | undefined): AIAgent {
  if (agent) {
    switch (agent) {
      case "claudeCode":
      case "gemini":
      case "amp":
      case "codex":
      case "opencode":
        return agent;
      default: {
        const _exhaustiveCheck: never = agent;
        console.warn("Unknown agent", _exhaustiveCheck);
        return defaultAgent;
      }
    }
  }
  return defaultAgent;
}

/**
 * Maps an AI model to its corresponding agent type
 */
export function modelToAgent(model: AIModel | null): AIAgent {
  if (!model) {
    return defaultAgent;
  }
  switch (model) {
    case "gemini-2.5-pro":
    case "gemini-3-pro": {
      return "gemini";
    }
    case "amp": {
      return "amp";
    }
    case "gpt-5":
    case "gpt-5-low":
    case "gpt-5-high":
    case "gpt-5-codex-low":
    case "gpt-5-codex-medium":
    case "gpt-5-codex-high":
    case "gpt-5.2-low":
    case "gpt-5.2":
    case "gpt-5.2-high":
    case "gpt-5.2-xhigh":
    case "gpt-5.1":
    case "gpt-5.1-low":
    case "gpt-5.1-high":
    case "gpt-5.1-codex-low":
    case "gpt-5.1-codex-medium":
    case "gpt-5.1-codex-high":
    case "gpt-5.1-codex-max":
    case "gpt-5.1-codex-max-low":
    case "gpt-5.1-codex-max-high":
    case "gpt-5.1-codex-max-xhigh":
    case "gpt-5.2-codex-low":
    case "gpt-5.2-codex-medium":
    case "gpt-5.2-codex-high":
    case "gpt-5.2-codex-xhigh": {
      return "codex";
    }
    case "fable":
    case "opus":
    case "haiku":
    case "sonnet": {
      return "claudeCode";
    }
    case "opencode/grok-code":
    case "opencode/qwen3-coder":
    case "opencode/kimi-k2":
    case "opencode/glm-4.6":
    case "opencode/gemini-2.5-pro":
    case "opencode/gemini-3-pro":
    case "opencode-oai/gpt-5":
    case "opencode-oai/gpt-5-codex":
    case "opencode-ant/sonnet": {
      return "opencode";
    }
    default: {
      const _exhaustiveCheck: never = model;
      console.warn("Unknown model", _exhaustiveCheck);
      return defaultAgent;
    }
  }
}

/**
 * Maps an agent type to its available AI models
 */
export function agentToModels(
  agent: AIAgent | undefined,
  options: {
    agentVersion: number | "latest";
    enableOpenRouterOpenAIAnthropicModel: boolean;
    enableOpencodeGemini3ProModelOption: boolean;
  },
): AIModel[] {
  agent = agent ?? defaultAgent;
  switch (agent) {
    case "gemini": {
      return ["gemini-3-pro", "gemini-2.5-pro"];
    }
    case "claudeCode": {
      return ["haiku", "sonnet", "opus", "fable"];
    }
    case "amp": {
      return ["amp"];
    }
    case "codex": {
      let models: AIModel[] = [
        "gpt-5-codex-low",
        "gpt-5-codex-medium",
        "gpt-5-codex-high",
        "gpt-5-low",
        "gpt-5",
        "gpt-5-high",
      ];
      if (options.agentVersion === "latest" || options.agentVersion >= 2) {
        models.unshift(
          "gpt-5.1-codex-max-low",
          "gpt-5.1-codex-max",
          "gpt-5.1-codex-max-high",
          "gpt-5.1-codex-max-xhigh",
          "gpt-5.1-codex-low",
          "gpt-5.1-codex-medium",
          "gpt-5.1-codex-high",
          "gpt-5.1-low",
          "gpt-5.1",
          "gpt-5.1-high",
        );
      }
      if (options.agentVersion === "latest" || options.agentVersion >= 3) {
        models.unshift(
          "gpt-5.2-codex-low",
          "gpt-5.2-codex-medium",
          "gpt-5.2-codex-high",
          "gpt-5.2-codex-xhigh",
          "gpt-5.2-low",
          "gpt-5.2",
          "gpt-5.2-high",
          "gpt-5.2-xhigh",
        );
      }
      return models;
    }
    case "opencode": {
      const models: AIModel[] = [
        "opencode/glm-4.6",
        "opencode/kimi-k2",
        "opencode/grok-code",
        "opencode/qwen3-coder",
        "opencode/gemini-2.5-pro",
      ];
      if (options.enableOpencodeGemini3ProModelOption) {
        models.push("opencode/gemini-3-pro");
      }
      if (options.enableOpenRouterOpenAIAnthropicModel) {
        models.push(
          "opencode-oai/gpt-5",
          "opencode-oai/gpt-5-codex",
          "opencode-ant/sonnet",
        );
      }
      return models;
    }
    default: {
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      return [];
    }
  }
}

export function getDefaultModelForAgent({
  agent,
  agentVersion,
}: {
  agent: AIAgent;
  agentVersion: number | "latest";
}): AIModel {
  switch (agent) {
    case "claudeCode":
      return "sonnet";
    case "codex":
      if (agentVersion === "latest" || agentVersion >= 2) {
        return "gpt-5.1-codex-medium";
      }
      return "gpt-5-codex-medium";
    case "amp":
      return "amp";
    case "gemini":
      return "gemini-3-pro";
    case "opencode":
      return "opencode/glm-4.6";
    default:
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      return "sonnet";
  }
}

export function isImageUploadSupported(model: AIModel | null): boolean {
  const agent = modelToAgent(model);
  switch (agent) {
    case "amp":
    case "claudeCode":
    case "codex":
    case "opencode":
      return true;
    case "gemini":
      return false;
    default:
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      return false;
  }
}

export function isPlanModeSupported(model: AIModel | null): boolean {
  const agent = modelToAgent(model);
  switch (agent) {
    case "claudeCode":
      return true;
    case "opencode":
    case "codex":
    case "gemini":
    case "amp":
      return false;
    default:
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      return false;
  }
}

export function isConnectedCredentialsSupported(agent: AIAgent): boolean {
  switch (agent) {
    case "claudeCode":
    case "codex":
    case "amp":
      return true;
    case "gemini":
    case "opencode":
      return false;
    default:
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      return false;
  }
}

export function isAgentSupportedForCredits(agent: AIAgent): boolean {
  switch (agent) {
    case "claudeCode":
    case "codex":
    case "opencode":
    case "gemini":
      return true;
    case "amp":
      return false;
    default:
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      return false;
  }
}

const agentDisplayNameMap: Record<AIAgent, string> = {
  claudeCode: "Claude Code",
  codex: "OpenAI Codex",
  gemini: "Gemini",
  amp: "Amp",
  opencode: "OpenCode",
};

export function getAllAgentTypes(): AIAgent[] {
  const agentTypes = Object.keys(agentDisplayNameMap) as AIAgent[];
  agentTypes.sort(sortByAgents);
  return agentTypes;
}

export function getAgentDisplayName(agent: AIAgent): string {
  return agentDisplayNameMap[agent];
}

export function getAgentProviderDisplayName(agent: AIAgent): string {
  switch (agent) {
    case "claudeCode":
      return "Claude";
    case "codex":
      return "OpenAI";
    case "gemini":
      return "Gemini";
    case "amp":
      return "Amp";
    case "opencode":
      return "OpenCode";
    default:
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      return "Unknown";
  }
}

type ModelDisplayName = {
  fullName: string;
  mainName: string;
  subName: string | null;
};

export function getModelDisplayName(model: AIModel): ModelDisplayName {
  switch (model) {
    case "fable":
      return {
        fullName: "Fable 5.0",
        mainName: "Fable",
        subName: "5.0",
      };
    case "opus":
      return {
        fullName: "Opus 5.0",
        mainName: "Opus",
        subName: "5.0",
      };
    case "sonnet":
      return {
        fullName: "Sonnet 5",
        mainName: "Sonnet",
        subName: "5.0",
      };
    case "haiku":
      return {
        fullName: "Haiku 4.5",
        mainName: "Haiku",
        subName: "4.5",
      };
    case "gemini-2.5-pro":
      return {
        fullName: "Gemini 2.5 Pro",
        mainName: "Gemini",
        subName: "2.5 Pro",
      };
    case "gemini-3-pro":
      return {
        fullName: "Gemini 3 Pro",
        mainName: "Gemini",
        subName: "3 Pro",
      };
    case "amp":
      return {
        fullName: "Amp",
        mainName: "Amp",
        subName: null,
      };
    case "gpt-5":
      return {
        fullName: "GPT-5 Medium",
        mainName: "GPT-5",
        subName: "Medium",
      };
    case "gpt-5-low":
      return {
        fullName: "GPT-5 Low",
        mainName: "GPT-5",
        subName: "Low",
      };
    case "gpt-5-high":
      return {
        fullName: "GPT-5 High",
        mainName: "GPT-5",
        subName: "High",
      };
    case "gpt-5-codex-medium":
      return {
        fullName: "GPT-5 Codex Medium",
        mainName: "GPT-5 Codex",
        subName: "Medium",
      };
    case "gpt-5-codex-low":
      return {
        fullName: "GPT-5 Codex Low",
        mainName: "GPT-5 Codex",
        subName: "Low",
      };
    case "gpt-5-codex-high":
      return {
        fullName: "GPT-5 Codex High",
        mainName: "GPT-5 Codex",
        subName: "High",
      };
    case "gpt-5.1":
      return {
        fullName: "GPT-5.1 Medium",
        mainName: "GPT-5.1",
        subName: "Medium",
      };
    case "gpt-5.1-low":
      return {
        fullName: "GPT-5.1 Low",
        mainName: "GPT-5.1",
        subName: "Low",
      };
    case "gpt-5.1-high":
      return {
        fullName: "GPT-5.1 High",
        mainName: "GPT-5.1",
        subName: "High",
      };
    case "gpt-5.2":
      return {
        fullName: "GPT-5.2 Medium",
        mainName: "GPT-5.2",
        subName: "Medium",
      };
    case "gpt-5.2-low":
      return {
        fullName: "GPT-5.2 Low",
        mainName: "GPT-5.2",
        subName: "Low",
      };
    case "gpt-5.2-high":
      return {
        fullName: "GPT-5.2 High",
        mainName: "GPT-5.2",
        subName: "High",
      };
    case "gpt-5.2-xhigh":
      return {
        fullName: "GPT-5.2 X-High",
        mainName: "GPT-5.2",
        subName: "X-High",
      };
    case "gpt-5.1-codex-max":
      return {
        fullName: "GPT-5.1 Codex Max (Medium)",
        mainName: "GPT-5.1 Codex Max",
        subName: "Medium",
      };
    case "gpt-5.1-codex-max-low":
      return {
        fullName: "GPT-5.1 Codex Max Low",
        mainName: "GPT-5.1 Codex Max",
        subName: "Low",
      };
    case "gpt-5.1-codex-max-high":
      return {
        fullName: "GPT-5.1 Codex Max High",
        mainName: "GPT-5.1 Codex Max",
        subName: "High",
      };
    case "gpt-5.1-codex-max-xhigh":
      return {
        fullName: "GPT-5.1 Codex Max X-High",
        mainName: "GPT-5.1 Codex Max",
        subName: "X-High",
      };
    case "gpt-5.1-codex-medium":
      return {
        fullName: "GPT-5.1 Codex Medium",
        mainName: "GPT-5.1 Codex",
        subName: "Medium",
      };
    case "gpt-5.1-codex-low":
      return {
        fullName: "GPT-5.1 Codex Low",
        mainName: "GPT-5.1 Codex",
        subName: "Low",
      };
    case "gpt-5.1-codex-high":
      return {
        fullName: "GPT-5.1 Codex High",
        mainName: "GPT-5.1 Codex",
        subName: "High",
      };
    case "gpt-5.2-codex-low":
      return {
        fullName: "GPT-5.2 Codex Low",
        mainName: "GPT-5.2 Codex",
        subName: "Low",
      };
    case "gpt-5.2-codex-medium":
      return {
        fullName: "GPT-5.2 Codex Medium",
        mainName: "GPT-5.2 Codex",
        subName: "Medium",
      };
    case "gpt-5.2-codex-high":
      return {
        fullName: "GPT-5.2 Codex High",
        mainName: "GPT-5.2 Codex",
        subName: "High",
      };
    case "gpt-5.2-codex-xhigh":
      return {
        fullName: "GPT-5.2 Codex X-High",
        mainName: "GPT-5.2 Codex",
        subName: "X-High",
      };
    case "opencode/grok-code":
      return {
        fullName: "Grok Code Fast 1",
        mainName: "Grok Code Fast",
        subName: "1",
      };
    case "opencode/qwen3-coder":
      return {
        fullName: "Qwen3 Coder 480B",
        mainName: "Qwen3 Coder",
        subName: "480B",
      };
    case "opencode/kimi-k2":
      return {
        fullName: "Kimi K2",
        mainName: "Kimi K2",
        subName: null,
      };
    case "opencode/glm-4.6":
      return {
        fullName: "GLM 4.6",
        mainName: "GLM",
        subName: "4.6",
      };
    case "opencode/gemini-2.5-pro":
      return {
        fullName: "Gemini 2.5 Pro",
        mainName: "Gemini",
        subName: "2.5 Pro",
      };
    case "opencode/gemini-3-pro":
      return {
        fullName: "Gemini 3 Pro",
        mainName: "Gemini",
        subName: "3 Pro",
      };
    case "opencode-oai/gpt-5":
      return {
        fullName: "GPT-5",
        mainName: "GPT-5",
        subName: null,
      };
    case "opencode-oai/gpt-5-codex":
      return {
        fullName: "GPT-5 Codex",
        mainName: "GPT-5 Codex",
        subName: null,
      };
    case "opencode-ant/sonnet":
      return {
        fullName: "Sonnet 4.5",
        mainName: "Sonnet",
        subName: "4.5",
      };
    default:
      const _exhaustiveCheck: never = model;
      console.warn("Unknown model", _exhaustiveCheck);
      return {
        fullName: _exhaustiveCheck,
        mainName: _exhaustiveCheck,
        subName: null,
      };
  }
}

export type AgentModelGroup = {
  agent: AIAgent;
  label: string;
  models: AIModel[];
};

export function getAgentModelGroups({
  agent,
  agentModelPreferences,
  selectedModels = [],
  options,
}: {
  agent: AIAgent;
  agentModelPreferences: AgentModelPreferences;
  selectedModels?: AIModel[];
  options: {
    agentVersion: number;
    enableOpenRouterOpenAIAnthropicModel: boolean;
    enableOpencodeGemini3ProModelOption: boolean;
  };
}): AgentModelGroup {
  return {
    agent,
    label: agentDisplayNameMap[agent],
    models: agentToModels(agent, options).filter((model) => {
      if (selectedModels.includes(model)) {
        return true;
      }
      const userPreference = agentModelPreferences.models?.[model];
      if (typeof userPreference === "boolean") {
        return userPreference;
      }
      return isModelEnabledByDefault({
        model,
        agentVersion: options.agentVersion,
      });
    }),
  };
}

// Universal commands that work for all agents
const UNIVERSAL_SLASH_COMMANDS: AIAgentSlashCommand[] = [
  {
    name: "clear",
    description: "Clear conversation history",
  },
  {
    name: "compact",
    description: "Compact conversation",
  },
];

export function getAgentSlashCommands(agent: AIAgent): AIAgentSlashCommand[] {
  const cmds: AIAgentSlashCommand[] = [...UNIVERSAL_SLASH_COMMANDS];
  switch (agent) {
    case "claudeCode":
      cmds.push(
        {
          name: "init",
          description: "Initialize project with CLAUDE.md guide",
        },
        {
          name: "pr-comments",
          description: "View pull request comments",
        },
        {
          name: "review",
          description: "Request code review",
        },
      );
      break;
    default:
      break;
  }
  return cmds;
}

const agentSortOrder: Record<AIAgent, number> = {
  claudeCode: 0,
  codex: 1,
  gemini: 2,
  opencode: 3,
  amp: 4,
};

export function sortByAgents(a: AIAgent, b: AIAgent): number {
  const aIndex = agentSortOrder[a] ?? 100;
  const bIndex = agentSortOrder[b] ?? 100;
  return aIndex - bIndex;
}

export function isAgentEnabledByDefault(agent: AIAgent): boolean {
  switch (agent) {
    case "claudeCode":
    case "codex":
    case "opencode":
    case "gemini":
      return true;
    case "amp":
      return false;
    default:
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      return false;
  }
}

export function isModelEnabledByDefault({
  model,
  agentVersion,
}: {
  model: AIModel;
  agentVersion: number | "latest";
}): boolean {
  switch (model) {
    // Deprecate the non-codex models
    case "gpt-5":
    case "gpt-5-low":
    case "gpt-5-high":
    case "gpt-5.1":
    case "gpt-5.1-low":
    case "gpt-5.1-high":
    case "gpt-5.2":
    case "gpt-5.2-low":
    case "gpt-5.2-high":
    case "gpt-5.2-xhigh":
      return false;
    case "gpt-5-codex-low":
    case "gpt-5-codex-medium":
    case "gpt-5-codex-high":
      return agentVersion !== "latest" && agentVersion < 2;
    // TODO: Which to deprecate?
    case "opencode/grok-code":
    case "opencode/qwen3-coder":
    case "opencode/gemini-2.5-pro":
    case "opencode/gemini-3-pro":
    case "opencode-oai/gpt-5":
    case "opencode-oai/gpt-5-codex":
    case "opencode-ant/sonnet":
      return false;
    case "fable":
    case "opus":
    case "sonnet":
    case "haiku":
      return true;
    case "gemini-3-pro":
    case "gemini-2.5-pro":
      return true;
    case "amp":
      return true;
    case "gpt-5.1-codex-max":
    case "gpt-5.1-codex-max-low":
    case "gpt-5.1-codex-max-high":
    case "gpt-5.1-codex-max-xhigh":
      return true;
    case "gpt-5.1-codex-low":
    case "gpt-5.1-codex-medium":
    case "gpt-5.1-codex-high":
    case "gpt-5.2-codex-low":
    case "gpt-5.2-codex-medium":
    case "gpt-5.2-codex-high":
    case "gpt-5.2-codex-xhigh":
      return true;
    case "opencode/kimi-k2":
    case "opencode/glm-4.6":
      return true;
    default:
      const _exhaustiveCheck: never = model;
      console.warn("Unknown model", _exhaustiveCheck);
      return false;
  }
}

export function getAgentInfo(agent: AIAgent): string {
  switch (agent) {
    case "claudeCode":
      return "";
    case "codex":
      return "";
    case "opencode":
      return "OpenCode is an open source agent that allows you to use a wide variety of models.";
    case "gemini":
      return "";
    case "amp":
      return "Amp is a coding agent built by Sourcegraph.";
    default:
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      return "";
  }
}

export function getModelInfo(model: AIModel): string {
  switch (model) {
    case "sonnet":
      return "Recommended for most tasks";
  }
  return "";
}

function isExactModelMatch(modelName: string): modelName is AIModel {
  return AIModelSchema.safeParse(modelName).success;
}

/**
 * Parses a model name string (supporting aliases and shortcuts)
 */
export function parseModelOrNull({
  modelName,
}: {
  modelName: string | undefined;
}): AIModel | null {
  if (!modelName) {
    return null;
  }
  // Make sure we handle all the supported AIModelExternal types
  const modelAsExternal = modelName as AIModelExternal;
  if (isExactModelMatch(modelAsExternal)) {
    return modelAsExternal;
  }
  switch (modelAsExternal) {
    case "gpt-5-medium":
      return "gpt-5";
    case "gpt-5.1-medium":
      return "gpt-5.1";
    case "gpt-5.2-medium":
      return "gpt-5.2";
    case "gpt-5.1-codex-max-medium":
      return "gpt-5.1-codex-max";
    case "gpt-5-codex":
      return "gpt-5-codex-medium";
    case "gpt-5.1-codex":
      return "gpt-5.1-codex-medium";
    case "gpt-5.2-codex":
      return "gpt-5.2-codex-medium";
    case "grok-code":
      return "opencode/grok-code";
    case "qwen3-coder":
      return "opencode/qwen3-coder";
    case "kimi-k2":
      return "opencode/kimi-k2";
    case "glm-4.6":
      return "opencode/glm-4.6";
    case "opencode/gpt-5":
      return "opencode-oai/gpt-5";
    case "opencode/gpt-5-codex":
      return "opencode-oai/gpt-5-codex";
    case "opencode/sonnet":
      return "opencode-ant/sonnet";
    default:
      const _exhaustiveCheck: never = modelAsExternal;
      console.warn("Unknown model name", _exhaustiveCheck);
      return null;
  }
}

export function normalizedModelForDaemon(model: AIModel): string {
  // Switch to using the google proxy
  // For now, just switch gemini-3-pro to the google proxy
  if (model === "opencode/gemini-3-pro") {
    return "terry-google/gemini-3-pro";
  }
  if (model.startsWith("opencode/")) {
    return model.replace("opencode/", "terry/");
  }
  if (model.startsWith("opencode-google/")) {
    return model.replace("opencode-google/", "terry-google/");
  }
  if (model.startsWith("opencode-oai")) {
    return model.replace("opencode-oai/", "terry-oai/");
  }
  if (model.startsWith("opencode-ant")) {
    return model.replace("opencode-ant/", "terry-ant/");
  }
  if (model === "gemini-3-pro") {
    return "gemini-3-pro-preview";
  }
  return model;
}

/**
 * Returns true if the model requires ChatGPT OAuth credentials to use.
 * These models cannot fall back to built-in credits.
 */
export function modelRequiresChatGptOAuth(model: AIModel | null): boolean {
  if (!model) {
    return false;
  }
  switch (model) {
    case "gpt-5.2-codex-low":
    case "gpt-5.2-codex-medium":
    case "gpt-5.2-codex-high":
    case "gpt-5.2-codex-xhigh":
      return true;
    default:
      return false;
  }
}
