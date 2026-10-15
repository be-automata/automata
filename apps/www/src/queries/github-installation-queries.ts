import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  bindGithubInstallation,
  type GithubInstallationsResult,
} from "@/server-actions/bind-github-installation";
import { errorFromResponse } from "./error-from-response";
import { useActiveOrganization } from "./organization-queries";
import { useServerActionMutation } from "./server-action-helpers";
import { USER_REPOS_QUERY_KEY } from "./user-repo-queries";

/** Prefix of every org's entry: invalidating it reaches them all. */
export const GITHUB_INSTALLATIONS_QUERY_KEY = ["github-installations"] as const;

/** One org's entry (the bindings are shown relative to the active org). */
export function githubInstallationsQueryKey(organizationKey: string | null) {
  return [...GITHUB_INSTALLATIONS_QUERY_KEY, organizationKey] as const;
}

export async function fetchGithubInstallations(): Promise<GithubInstallationsResult> {
  // A GET route, not a server action, so it is not serialized behind the
  // page's other server actions.
  const res = await fetch("/api/github/installations", { cache: "no-store" });
  if (!res.ok) {
    throw await errorFromResponse(res);
  }
  return (await res.json()) as GithubInstallationsResult;
}

export function useGithubInstallationsQuery() {
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
    queryKey: githubInstallationsQueryKey(organizationKey ?? null),
    queryFn: fetchGithubInstallations,
    staleTime: 60_000,
    enabled: organizationKey !== undefined,
  });
  const organizationUnknown = organizationKey === undefined;
  return {
    ...query,
    data: organizationUnknown ? undefined : query.data,
    isLoading:
      (organizationUnknown && isOrganizationLoading) || query.isLoading,
  };
}

export function useBindGithubInstallation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: ({
      installationId,
      expectedOrganizationId,
    }: {
      installationId: string;
      expectedOrganizationId: string | null;
      accountLogin: string;
      organizationName: string;
    }) => bindGithubInstallation({ installationId, expectedOrganizationId }),
    onSuccess: (_data, { accountLogin, organizationName }) => {
      // The repo picker is scoped by these bindings, so every org's entry is
      // stale too. The server re-reads bindings on every request; only the
      // raw GitHub listings are cached there, and a bind does not change them.
      void queryClient.invalidateQueries({
        queryKey: GITHUB_INSTALLATIONS_QUERY_KEY,
      });
      void queryClient.invalidateQueries({ queryKey: USER_REPOS_QUERY_KEY });
      toast.success(`${accountLogin} now runs in ${organizationName}`);
    },
  });
}
