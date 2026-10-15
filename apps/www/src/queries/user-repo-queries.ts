import { useQuery } from "@tanstack/react-query";

import { getUserRepoBranches } from "@/server-actions/user-repos";
import type { UserReposResult } from "@/server-actions/user-repos";
import { useServerActionQuery } from "./server-action-helpers";
import { serverActionSuccess } from "@/lib/server-actions";
import { errorFromResponse } from "./error-from-response";
import { useActiveOrganization } from "./organization-queries";

/** Prefix of every org's repo list: invalidating it reaches them all. */
export const USER_REPOS_QUERY_KEY = ["user-repos"] as const;

/**
 * The cache slot of one org's repo list. The list is org-scoped on the
 * server, so each org gets its own entry: switching back to an org shows its
 * list at once, and a switch never shows the previous org's list as the new
 * one's. `organizationKey` is the org id, null for "no org", or "unresolved"
 * when the org list itself failed to load.
 */
export function userReposQueryKey(organizationKey: string | null) {
  return [...USER_REPOS_QUERY_KEY, organizationKey] as const;
}

export async function fetchUserRepos(): Promise<UserReposResult> {
  // A GET route, not a server action: server actions from one client run one
  // at a time, so the slow GitHub listing would queue behind everything else.
  const res = await fetch("/api/github/repos", { cache: "no-store" });
  if (!res.ok) {
    throw await errorFromResponse(res);
  }
  return (await res.json()) as UserReposResult;
}

const USER_REPOS_STALE_TIME_MS = 10 * 60 * 1000;

export function userReposQueryOptions(organizationKey: string | null) {
  return {
    queryKey: userReposQueryKey(organizationKey),
    queryFn: fetchUserRepos,
    staleTime: USER_REPOS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
  };
}

/**
 * The active org's repo list. `isLoading` stays true until THIS org's list
 * has data — while the active org is still unknown, and after a switch while
 * the new org's entry is empty — so the dashboard holds the stored repo
 * (see resolveSelectedRepo) instead of acting on another org's list.
 */
export const useUserReposQuery = (options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true;
  const {
    expectedOrganizationId,
    isLoading: isOrganizationLoading,
    isError: isOrganizationError,
  } = useActiveOrganization();
  const organizationKey =
    expectedOrganizationId !== undefined
      ? expectedOrganizationId
      : isOrganizationError
        ? "unresolved"
        : undefined;
  const query = useQuery({
    ...userReposQueryOptions(organizationKey ?? null),
    enabled: enabled && organizationKey !== undefined,
  });
  const organizationUnknown = organizationKey === undefined;
  return {
    ...query,
    // Never another org's list: while the active org is unknown there is no
    // list to show, even if one is cached under some key.
    data: organizationUnknown ? undefined : query.data,
    isLoading:
      enabled &&
      ((organizationUnknown && isOrganizationLoading) || query.isPending),
  };
};

export const useUserRepoBranchesQuery = (
  repoFullName: string | null,
  options?: { enabled?: boolean },
) => {
  return useServerActionQuery({
    queryKey: ["user-repo-branches", repoFullName],
    queryFn: async () => {
      if (!repoFullName) {
        return serverActionSuccess([]);
      }
      return getUserRepoBranches(repoFullName);
    },
    staleTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: true,
    enabled: options?.enabled,
  });
};
