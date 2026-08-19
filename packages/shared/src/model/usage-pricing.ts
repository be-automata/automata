import type { UsageSku } from "../db/types";

export type UsageTokenUsage = {
  inputTokens?: number | string | null;
  cachedInputTokens?: number | string | null;
  cacheCreationInputTokens?: number | string | null;
  outputTokens?: number | string | null;
};

export type UsageSkuPricing = {
  currency: "usd";
  inputRatePerToken: number;
  cachedInputRatePerToken: number;
  cacheCreationRatePerToken: number;
  outputRatePerToken: number;
};

export const OPENAI_RESPONSES_GPT_5_SKU: UsageSku = "openai_responses_gpt_5";
export const OPENAI_RESPONSES_GPT_5_2_SKU: UsageSku =
  "openai_responses_gpt_5_2";
export const ANTHROPIC_MESSAGES_SONNET_SKU: UsageSku =
  "anthropic_messages_sonnet";
export const ANTHROPIC_MESSAGES_HAIKU_SKU: UsageSku =
  "anthropic_messages_haiku";
export const ANTHROPIC_MESSAGES_OPUS_SKU: UsageSku = "anthropic_messages_opus";
export const ANTHROPIC_MESSAGES_OPUS_4_5_SKU: UsageSku =
  "anthropic_messages_opus_4_5";
export const ANTHROPIC_MESSAGES_FABLE_SKU: UsageSku =
  "anthropic_messages_fable";
export const ANTHROPIC_MESSAGES_DEFAULT_SKU: UsageSku =
  "anthropic_messages_default";
export const OPENROUTER_QWEN_SKU: UsageSku = "openrouter_qwen";
export const OPENROUTER_GROK_SKU: UsageSku = "openrouter_grok";
export const OPENROUTER_KIMI_SKU: UsageSku = "openrouter_kimi";
export const OPENROUTER_GLM_SKU: UsageSku = "openrouter_glm";
export const OPENROUTER_GEMINI_SKU: UsageSku = "openrouter_gemini";
export const OPENROUTER_GEMINI_3_PRO_SKU: UsageSku = "openrouter_gemini_3_pro";
export const OPENROUTER_DEFAULT_SKU: UsageSku = "openrouter_default";
export const GOOGLE_GEMINI_2_5_PRO_SKU: UsageSku = "google_gemini_2_5_pro";
export const GOOGLE_GEMINI_2_5_FLASH_SKU: UsageSku = "google_gemini_2_5_flash";
export const GOOGLE_GEMINI_3_PRO_SKU: UsageSku = "google_gemini_3_pro";
export const GOOGLE_DEFAULT_SKU: UsageSku = "google_default";

export const USAGE_SKU_PRICING: Record<UsageSku, UsageSkuPricing> = {
  [OPENAI_RESPONSES_GPT_5_SKU]: {
    currency: "usd",
    inputRatePerToken: 1.25 / 1_000_000,
    cachedInputRatePerToken: 0.125 / 1_000_000,
    cacheCreationRatePerToken: 0,
    outputRatePerToken: 10 / 1_000_000,
  },
  [OPENAI_RESPONSES_GPT_5_2_SKU]: {
    currency: "usd",
    inputRatePerToken: 1.75 / 1_000_000,
    cachedInputRatePerToken: 0.175 / 1_000_000,
    cacheCreationRatePerToken: 0,
    outputRatePerToken: 14 / 1_000_000,
  },
  [ANTHROPIC_MESSAGES_SONNET_SKU]: {
    currency: "usd",
    inputRatePerToken: 3 / 1_000_000,
    cacheCreationRatePerToken: 3.75 / 1_000_000,
    cachedInputRatePerToken: 0.3 / 1_000_000,
    outputRatePerToken: 15 / 1_000_000,
  },
  [ANTHROPIC_MESSAGES_HAIKU_SKU]: {
    currency: "usd",
    inputRatePerToken: 0.8 / 1_000_000,
    cacheCreationRatePerToken: 1 / 1_000_000,
    cachedInputRatePerToken: 0.08 / 1_000_000,
    outputRatePerToken: 4 / 1_000_000,
  },
  [ANTHROPIC_MESSAGES_OPUS_SKU]: {
    currency: "usd",
    inputRatePerToken: 15 / 1_000_000,
    cacheCreationRatePerToken: 18.75 / 1_000_000,
    cachedInputRatePerToken: 1.5 / 1_000_000,
    outputRatePerToken: 75 / 1_000_000,
  },
  [ANTHROPIC_MESSAGES_OPUS_4_5_SKU]: {
    currency: "usd",
    inputRatePerToken: 5 / 1_000_000,
    cacheCreationRatePerToken: 6.25 / 1_000_000,
    cachedInputRatePerToken: 0.5 / 1_000_000,
    outputRatePerToken: 25 / 1_000_000,
  },
  // PLACEHOLDER pricing, deliberately set to the HIGHEST Anthropic bucket
  // (legacy-Opus rates) until official Fable/Mythos-tier list prices are added:
  // over-billing a premium model is recoverable, silently under-billing is not.
  // A dedicated SKU (rather than falling through to default) keeps Fable spend
  // separately visible in usage reports so the placeholder is auditable.
  [ANTHROPIC_MESSAGES_FABLE_SKU]: {
    currency: "usd",
    inputRatePerToken: 15 / 1_000_000,
    cacheCreationRatePerToken: 18.75 / 1_000_000,
    cachedInputRatePerToken: 1.5 / 1_000_000,
    outputRatePerToken: 75 / 1_000_000,
  },
  [ANTHROPIC_MESSAGES_DEFAULT_SKU]: {
    currency: "usd",
    inputRatePerToken: 15 / 1_000_000,
    cacheCreationRatePerToken: 18.75 / 1_000_000,
    cachedInputRatePerToken: 1.5 / 1_000_000,
    outputRatePerToken: 75 / 1_000_000,
  },
  // https://openrouter.ai/qwen/qwen3-coder:exacto
  [OPENROUTER_QWEN_SKU]: {
    currency: "usd",
    inputRatePerToken: 0.38 / 1_000_000,
    cachedInputRatePerToken: 0,
    cacheCreationRatePerToken: 0,
    outputRatePerToken: 1.53 / 1_000_000,
  },
  // https://openrouter.ai/x-ai/grok-code-fast-1
  [OPENROUTER_GROK_SKU]: {
    currency: "usd",
    inputRatePerToken: 0.2 / 1_000_000,
    cachedInputRatePerToken: 0,
    cacheCreationRatePerToken: 0,
    outputRatePerToken: 1.5 / 1_000_000,
  },
  // https://openrouter.ai/moonshotai/kimi-k2-0905:exacto
  [OPENROUTER_KIMI_SKU]: {
    currency: "usd",
    inputRatePerToken: 0.6 / 1_000_000,
    cachedInputRatePerToken: 0,
    cacheCreationRatePerToken: 0,
    outputRatePerToken: 2.5 / 1_000_000,
  },
  // https://openrouter.ai/z-ai/glm-4.6:exacto
  [OPENROUTER_GLM_SKU]: {
    currency: "usd",
    inputRatePerToken: 0.45 / 1_000_000,
    cachedInputRatePerToken: 0,
    cacheCreationRatePerToken: 0,
    outputRatePerToken: 1.9 / 1_000_000,
  },
  // https://openrouter.ai/google/gemini-2.5-pro
  [OPENROUTER_GEMINI_SKU]: {
    currency: "usd",
    inputRatePerToken: 1.25 / 1_000_000,
    cachedInputRatePerToken: 0.25 / 1_000_000,
    cacheCreationRatePerToken: 1.625 / 1_000_000,
    outputRatePerToken: 10 / 1_000_000,
  },
  // https://openrouter.ai/google/gemini-3-pro-preview
  [OPENROUTER_GEMINI_3_PRO_SKU]: {
    currency: "usd",
    inputRatePerToken: 2 / 1_000_000,
    cachedInputRatePerToken: 0.2 / 1_000_000,
    cacheCreationRatePerToken: 2.375 / 1_000_000,
    outputRatePerToken: 12 / 1_000_000,
  },
  // Catch-all for unknown models - arbitrarily use sonnet
  // https://openrouter.ai/
  [OPENROUTER_DEFAULT_SKU]: {
    currency: "usd",
    inputRatePerToken: 3 / 1_000_000,
    cacheCreationRatePerToken: 3.75 / 1_000_000,
    cachedInputRatePerToken: 0.3 / 1_000_000,
    outputRatePerToken: 15 / 1_000_000,
  },
  // https://ai.google.dev/pricing
  [GOOGLE_GEMINI_2_5_PRO_SKU]: {
    currency: "usd",
    inputRatePerToken: 1.25 / 1_000_000,
    cachedInputRatePerToken: 0.25 / 1_000_000,
    cacheCreationRatePerToken: 0,
    outputRatePerToken: 10 / 1_000_000,
  },
  // https://ai.google.dev/pricing
  [GOOGLE_GEMINI_3_PRO_SKU]: {
    currency: "usd",
    inputRatePerToken: 2 / 1_000_000,
    cachedInputRatePerToken: 0.4 / 1_000_000,
    cacheCreationRatePerToken: 0,
    outputRatePerToken: 12 / 1_000_000,
  },
  // https://ai.google.dev/pricing
  [GOOGLE_GEMINI_2_5_FLASH_SKU]: {
    currency: "usd",
    inputRatePerToken: 0.3 / 1_000_000,
    cachedInputRatePerToken: 0.03 / 1_000_000,
    cacheCreationRatePerToken: 0,
    outputRatePerToken: 2.5 / 1_000_000,
  },
  // https://ai.google.dev/pricing
  [GOOGLE_DEFAULT_SKU]: {
    currency: "usd",
    inputRatePerToken: 1.25 / 1_000_000,
    cachedInputRatePerToken: 0.25 / 1_000_000,
    cacheCreationRatePerToken: 0,
    outputRatePerToken: 10 / 1_000_000,
  },
};

export function calculateUsageCostUsd({
  sku,
  usage,
}: {
  sku: UsageSku;
  usage: UsageTokenUsage;
}) {
  const pricing = USAGE_SKU_PRICING[sku];
  if (!pricing) {
    return 0;
  }

  const inputTokens = Math.max(Number(usage.inputTokens ?? 0), 0);
  const cachedInputTokens = Math.max(Number(usage.cachedInputTokens ?? 0), 0);
  const cacheCreationInputTokens = Math.max(
    Number(usage.cacheCreationInputTokens ?? 0),
    0,
  );
  const outputTokens = Math.max(Number(usage.outputTokens ?? 0), 0);

  // Each usage field now represents the tokens charged at the corresponding rate.
  let costUsd = 0;

  costUsd += inputTokens * pricing.inputRatePerToken;
  costUsd += cacheCreationInputTokens * pricing.cacheCreationRatePerToken;
  costUsd += cachedInputTokens * pricing.cachedInputRatePerToken;
  costUsd += outputTokens * pricing.outputRatePerToken;

  return costUsd;
}

export function getOpenAIResponsesSkuForModel(model?: string | null): UsageSku {
  if (model?.includes("gpt-5.2")) {
    return OPENAI_RESPONSES_GPT_5_2_SKU;
  }
  return OPENAI_RESPONSES_GPT_5_SKU;
}

export function getAnthropicMessagesSkuForModel(
  model?: string | null,
): UsageSku {
  if (!model) {
    return ANTHROPIC_MESSAGES_DEFAULT_SKU;
  }
  const normalized = model.toLowerCase();
  // Upstream ids look like "claude-fable-5"; match before the generic buckets.
  if (normalized.includes("fable")) {
    return ANTHROPIC_MESSAGES_FABLE_SKU;
  }
  if (normalized.includes("opus-4-5")) {
    return ANTHROPIC_MESSAGES_OPUS_4_5_SKU;
  }
  if (normalized.includes("opus")) {
    return ANTHROPIC_MESSAGES_OPUS_SKU;
  }
  if (normalized.includes("haiku")) {
    return ANTHROPIC_MESSAGES_HAIKU_SKU;
  }
  if (normalized.includes("sonnet")) {
    return ANTHROPIC_MESSAGES_SONNET_SKU;
  }
  return ANTHROPIC_MESSAGES_DEFAULT_SKU;
}

export function getOpenRouterSkuForModel(model?: string | null): UsageSku {
  if (!model) {
    throw new Error("Model is required");
  }
  if (model.includes("grok-code")) {
    return OPENROUTER_GROK_SKU;
  }
  if (model.includes("qwen3-coder")) {
    return OPENROUTER_QWEN_SKU;
  }
  if (model.includes("kimi-k2")) {
    return OPENROUTER_KIMI_SKU;
  }
  if (model.includes("glm-4.6")) {
    return OPENROUTER_GLM_SKU;
  }
  if (model.includes("gemini-2.5-pro")) {
    return OPENROUTER_GEMINI_SKU;
  }
  if (model.includes("gemini-3-pro")) {
    return OPENROUTER_GEMINI_3_PRO_SKU;
  }
  console.warn(`Unknown model: ${model}`);
  return OPENROUTER_DEFAULT_SKU;
}

export function getGoogleSkuForModel(model?: string | null): UsageSku {
  if (!model) {
    throw new Error("Model is required");
  }
  if (model.includes("gemini-2.5-flash")) {
    return GOOGLE_GEMINI_2_5_FLASH_SKU;
  }
  if (model.includes("gemini-2.5-pro")) {
    return GOOGLE_GEMINI_2_5_PRO_SKU;
  }
  if (model.includes("gemini-3-pro")) {
    return GOOGLE_GEMINI_3_PRO_SKU;
  }
  console.warn(`Unknown Google model: ${model}`);
  return GOOGLE_DEFAULT_SKU;
}
