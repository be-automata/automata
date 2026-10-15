import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  bindGithubInstallation,
  getGithubInstallations,
} from "@/server-actions/bind-github-installation";
import { USER_REPOS_QUERY_KEY } from "./user-repo-queries";
import {
  useServerActionMutation,
  useServerActionQuery,
} from "./server-action-helpers";

export const GITHUB_INSTALLATIONS_QUERY_KEY = ["github-installations"] as const;

export function useGithubInstallationsQuery() {
  return useServerActionQuery({
    queryKey: GITHUB_INSTALLATIONS_QUERY_KEY,
    queryFn: () => getGithubInstallations(),
    staleTime: 60_000,
  });
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
      // The repo picker is scoped by these bindings, so it is stale too.
      void queryClient.invalidateQueries({
        queryKey: GITHUB_INSTALLATIONS_QUERY_KEY,
      });
      void queryClient.invalidateQueries({ queryKey: USER_REPOS_QUERY_KEY });
      toast.success(`${accountLogin} now runs in ${organizationName}`);
    },
  });
}
