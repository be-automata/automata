import { db } from "@/lib/db";
import { trackUsageEventBatched } from "@terragon/shared/model/usage-events";
import {
  calculateUsageCostUsd,
  getGoogleSkuForModel,
} from "@terragon/shared/model/usage-pricing";

type UsagePayload = {
  promptTokenCount?: number | null;
  cachedContentTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  totalTokenCount?: number | null;
};

export async function logGoogleUsage({
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
  console.log("Google usage", {
    path,
    usage,
    ...(model ? { model } : {}),
  });

  if (!userId || !usage) {
    return;
  }

  const totalInputTokens = Math.max(Number(usage.promptTokenCount ?? 0), 0);
  const cachedInputTokens = Math.min(
    Math.max(Number(usage.cachedContentTokenCount ?? 0), 0),
    totalInputTokens,
  );
  const inputTokens = Math.max(totalInputTokens - cachedInputTokens, 0);
  const outputTokens = Math.max(Number(usage.candidatesTokenCount ?? 0), 0);
  const totalTokens = Math.max(
    Number(
      usage.totalTokenCount ??
        (Number.isFinite(totalInputTokens + outputTokens)
          ? totalInputTokens + outputTokens
          : 0),
    ),
    0,
  );

  const sku = getGoogleSkuForModel(model);
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

  const eventType = "billable_google_usd";
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
