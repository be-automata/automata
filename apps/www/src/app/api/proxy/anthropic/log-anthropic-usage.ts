import { db } from "@/lib/db";
import { trackUsageEventBatched } from "@terragon/shared/model/usage-events";
import {
  calculateUsageCostUsd,
  getAnthropicMessagesSkuForModel,
} from "@terragon/shared/model/usage-pricing";

type UsagePayload = {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens?: number | null;
};

export async function logAnthropicUsage({
  path,
  usage,
  userId,
  organizationId,
  model,
  messageId,
}: {
  path: string;
  usage: UsagePayload | null | undefined;
  userId?: string;
  organizationId?: string | null;
  model?: string | null;
  messageId?: string | null;
}) {
  console.log("Anthropic usage", {
    path,
    usage,
    ...(model ? { model } : {}),
    ...(messageId ? { messageId } : {}),
  });
  if (!userId || !usage) {
    return;
  }
  const inputTokens = Math.max(Number(usage.input_tokens ?? 0), 0);
  const cacheCreationInputTokens = Math.max(
    Number(usage.cache_creation_input_tokens ?? 0),
    0,
  );
  const cachedInputTokens = Math.max(
    Number(usage.cache_read_input_tokens ?? 0),
    0,
  );
  const outputTokens = Math.max(Number(usage.output_tokens ?? 0), 0);

  const sku = getAnthropicMessagesSkuForModel(model ?? undefined);

  const costUsd = calculateUsageCostUsd({
    sku,
    usage: {
      inputTokens,
      cacheCreationInputTokens,
      cachedInputTokens,
      outputTokens,
    },
  });

  const totalTokens =
    inputTokens + cacheCreationInputTokens + cachedInputTokens + outputTokens;

  if (costUsd <= 0 && totalTokens <= 0) {
    return;
  }

  await trackUsageEventBatched({
    db,
    userId,
    organizationId,
    events: [
      {
        eventType: "billable_anthropic_usd",
        value: costUsd,
        tokenUsage: {
          inputTokens,
          cachedInputTokens,
          cacheCreationInputTokens,
          outputTokens,
        },
        sku,
      },
    ],
  });
}
