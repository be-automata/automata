import { getUsageStats } from "@/server-actions/stats";
import { getServerActionQueryOptions } from "./server-action-helpers";

export function statsQueryOptions({
  numDays,
  timezone,
  mineOnly = false,
}: {
  numDays: number;
  timezone: string;
  mineOnly?: boolean;
}) {
  return getServerActionQueryOptions({
    queryKey: ["usage-stats", numDays, timezone, mineOnly],
    queryFn: () => getUsageStats({ numDays, timezone, mineOnly }),
  });
}
