import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useRealtimeUser } from "@/hooks/useRealtime";
import { getAgentActivity } from "@/server-actions/agent-activity";
import { getServerActionQueryOptions } from "./server-action-helpers";

/** There is no org-level realtime channel, so teammates' runs poll. */
const ACTIVITY_POLL_MS = 10_000;

export function agentActivityQueryOptions({
  mineOnly,
  peopleOnly,
}: {
  mineOnly: boolean;
  peopleOnly: boolean;
}) {
  return getServerActionQueryOptions({
    queryKey: ["agent-activity", { mineOnly, peopleOnly }],
    queryFn: () => getAgentActivity({ mineOnly, peopleOnly }),
    refetchInterval: ACTIVITY_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

export function useAgentActivity(filters: {
  mineOnly: boolean;
  peopleOnly: boolean;
}) {
  return useQuery(agentActivityQueryOptions(filters));
}

/**
 * The viewer's own runs update at once through their realtime channel. Mount
 * once (the sidebar badge, present on every page), not per query consumer.
 */
export function useAgentActivityRealtime() {
  const queryClient = useQueryClient();
  useRealtimeUser({
    matches: (message) =>
      !!message.data.threadStatusUpdated ||
      !!message.data.isThreadCreated ||
      !!message.data.isThreadArchived ||
      !!message.dataByThreadId,
    onMessage: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-activity"] });
    },
  });
}
