import { db } from "@/lib/db";
import { trackUsageEventBatched } from "@terragon/shared/model/usage-events";
import {
  calculateUsageCostUsd,
  getOpenRouterSkuForModel,
} from "@terragon/shared/model/usage-pricing";

type UsagePayload = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  prompt_tokens_details?: {
    cached_tokens?: number | null;
  } | null;
  completion_tokens_details?: Record<string, unknown> | null;
};

export async function logOpenRouterUsage({
  path,
  usage,
  userId,
  organizationId,
  model,
}: {
  path: string;
  usage: UsagePayload | null | undefined;
  userId?: string;
  organizationId?: string | null;
  model?: string;
}) {
  console.log("OpenRouter usage", {
    path,
    usage,
    ...(model ? { model } : {}),
  });

  if (!userId || !usage) {
    return;
  }

  const totalInputTokens = Math.max(Number(usage.prompt_tokens ?? 0), 0);
  const cachedInputTokens = Math.min(
    Math.max(Number(usage.prompt_tokens_details?.cached_tokens ?? 0), 0),
    totalInputTokens,
  );
  const inputTokens = Math.max(totalInputTokens - cachedInputTokens, 0);
  const outputTokens = Math.max(Number(usage.completion_tokens ?? 0), 0);
  const totalTokens = Math.max(
    Number(
      usage.total_tokens ??
        (Number.isFinite(totalInputTokens + outputTokens)
          ? totalInputTokens + outputTokens
          : 0),
    ),
    0,
  );

  const sku = getOpenRouterSkuForModel(model);
  const costUsd = calculateUsageCostUsd({
    sku,
    usage: {
      inputTokens,
      cachedInputTokens,
      outputTokens,
    },
  });

  if (
    costUsd <= 0 &&
    inputTokens + cachedInputTokens + outputTokens <= 0 &&
    totalTokens <= 0
  ) {
    return;
  }

  const eventType = "billable_openrouter_usd";
  await trackUsageEventBatched({
    db,
    userId,
    organizationId,
    events: [
      {
        eventType,
        value: costUsd,
        tokenUsage: {
          inputTokens,
          cachedInputTokens,
          cacheCreationInputTokens: 0,
          outputTokens,
        },
        sku,
      },
    ],
  });
}
