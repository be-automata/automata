import { db } from "@/lib/db";
import { UsageEventType } from "@terragon/shared/db/types";
import { trackUsageEventBatched } from "@terragon/shared/model/usage-events";

// Cap this at something reasonable to avoid bad data
// Sometimes claude returns really large duration numbers.
// In prod the largest "good" value we have is well under 2 hours.
const MAX_DURATION_MS = 1000 * 60 * 60 * 24; /* 1 day */

export async function trackUsageEvents({
  userId,
  costUsd,
  agentDurationMs,
  applicationDurationMs,
  organizationId,
}: {
  userId: string;
  costUsd?: number;
  agentDurationMs?: number;
  applicationDurationMs?: number;
  // Tenant to stamp (WI-5 batch 3a). Derived from the thread these usage events
  // belong to. Nullable-safe: null = unstamped, today's behavior.
  organizationId?: string | null;
}) {
  const events: {
    eventType: UsageEventType;
    value: number;
  }[] = [];
  if (costUsd && costUsd > 0) {
    events.push({
      eventType: "claude_cost_usd",
      value: costUsd,
    });
  }
  if (
    agentDurationMs &&
    agentDurationMs > 0 &&
    agentDurationMs < MAX_DURATION_MS
  ) {
    events.push({
      eventType: "sandbox_usage_time_agent_ms",
      value: agentDurationMs,
    });
  }
  if (
    applicationDurationMs &&
    applicationDurationMs > 0 &&
    applicationDurationMs < MAX_DURATION_MS
  ) {
    events.push({
      eventType: "sandbox_usage_time_application_ms",
      value: applicationDurationMs,
    });
  }
  if (events.length > 0) {
    await trackUsageEventBatched({ db, userId, organizationId, events });
  }
}
