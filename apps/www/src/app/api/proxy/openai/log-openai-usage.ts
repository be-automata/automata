import { db } from "@/lib/db";
import { trackUsageEventBatched } from "@terragon/shared/model/usage-events";
import {
  calculateUsageCostUsd,
  getOpenAIResponsesSkuForModel,
} from "@terragon/shared/model/usage-pricing";

type UsagePayload = {
  input_tokens?: number | null;
  input_tokens_details?: {
    cached_tokens?: number | null;
  } | null;
  output_tokens?: number | null;
  output_tokens_details?: Record<string, unknown> | null;
  total_tokens?: number | null;
};

export async function logOpenAIUsage({
  path,
  usage,
  responseId,
  userId,
  organizationId,
  model,
}: {
  path: string;
  usage: UsagePayload | null | undefined;
  responseId?: string;
  userId?: string;
  organizationId?: string | null;
  model?: string;
}) {
  console.log("OpenAI responses usage", {
    path,
    ...(responseId ? { responseId } : {}),
    usage,
    ...(model ? { model } : {}),
  });

  if (!userId || !usage) {
    return;
  }

  const totalInputTokens = Math.max(Number(usage.input_tokens ?? 0), 0);
  const cachedInputTokens = Math.min(
    Math.max(Number(usage.input_tokens_details?.cached_tokens ?? 0), 0),
    totalInputTokens,
  );
  const inputTokens = Math.max(totalInputTokens - cachedInputTokens, 0);
  const outputTokens = Math.max(Number(usage.output_tokens ?? 0), 0);
  const totalTokens = Math.max(
    Number(
      usage.total_tokens ??
        (Number.isFinite(totalInputTokens + outputTokens)
          ? totalInputTokens + outputTokens
          : 0),
    ),
    0,
  );

  const sku = getOpenAIResponsesSkuForModel(model);

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

  await trackUsageEventBatched({
    db,
    userId,
    organizationId,
    events: [
      {
        eventType: "billable_openai_usd",
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
