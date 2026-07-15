"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { ThreadInfo } from "@terragon/shared";
import { getThreads } from "@terragon/shared/model/threads";

export const getThreadsAction = userOnlyAction(
  async function getThreadsAction(
    userId: string,
    filters: {
      archived?: boolean;
      automationId?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<ThreadInfo[]> {
    // Thread the request's active organization into the tenant fence (WI-5). The
    // session is already resolved (userOnlyAction) and React-cached, so this is a
    // cheap re-read. Nullable during the backfill phase → user-only fence.
    const tenant = await getTenantContextOrNull();
    const threads = await getThreads({
      db,
      userId,
      organizationId: tenant?.organizationId ?? null,
      limit: filters.limit ?? 100,
      offset: filters.offset ?? 0,
      archived: filters.archived,
      automationId: filters.automationId,
    });
    return threads;
  },
  { defaultErrorMessage: "Failed to get tasks" },
);
