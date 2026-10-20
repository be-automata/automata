import { createJiraClient } from "./jira-client";
import type { TrackerConfig } from "./tracker-config";
import { createYouTrackClient, type TrackerClient } from "./youtrack-client";

/**
 * The one place a tracker client is constructed from a repo's config. A second
 * tracker is a new `kind` and a new case here; the audit executor and the
 * intake path depend only on `TrackerClient`.
 */
export function createTrackerClient(
  config: TrackerConfig,
  options: { timeoutMs?: number } = {},
): TrackerClient {
  switch (config.kind) {
    case "youtrack":
      return createYouTrackClient({
        baseUrl: config.baseUrl,
        token: config.token,
        timeoutMs: options.timeoutMs,
      });
    case "jira":
      return createJiraClient({
        baseUrl: config.baseUrl,
        username: config.username,
        token: config.token,
        timeoutMs: options.timeoutMs,
      });
    default: {
      const exhaustive: never = config;
      throw new Error(
        `Unsupported tracker kind: ${String((exhaustive as TrackerConfig).kind)}`,
      );
    }
  }
}
