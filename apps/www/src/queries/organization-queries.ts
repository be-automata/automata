import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  switchActiveOrganization,
  type MyOrganizations,
} from "@/server-actions/organizations";
import {
  MY_ORGANIZATIONS_QUERY_KEY,
  myOrganizationsQueryOptions,
} from "./my-organizations-query-options";
import { useServerActionMutation } from "./server-action-helpers";

export {
  MY_ORGANIZATIONS_QUERY_KEY,
  myOrganizationsQueryOptions,
} from "./my-organizations-query-options";

export function useMyOrganizations() {
  return useQuery(myOrganizationsQueryOptions());
}

/**
 * Point the cached org list at the org the session just switched to, before
 * its refetch returns: org-keyed queries (the repo list) move to the new
 * org's cache entry at once, so the dashboard never pairs the new org with
 * the previous org's repos.
 */
export function markActiveOrganizationSwitched(
  queryClient: QueryClient,
  organizationId: string,
): void {
  queryClient.setQueryData<MyOrganizations>(
    MY_ORGANIZATIONS_QUERY_KEY,
    (old) =>
      old && old.organizations.some((org) => org.id === organizationId)
        ? { ...old, activeOrganizationId: organizationId }
        : old,
  );
}

/**
 * The org the session is acting in, or null. Null is a real state: no
 * membership, or a session created before the user joined an org.
 */
export function useActiveOrganization() {
  const { data, isLoading, isError } = useMyOrganizations();
  const active =
    data?.organizations.find((org) => org.id === data.activeOrganizationId) ??
    null;
  return {
    activeOrganization: active,
    isLoading,
    /** The org list failed to load; the active org is unknown. */
    isError,
    /**
     * The org the page shows, for a server action to check against the
     * session: an id, null for "no org", or undefined while it is not known
     * yet (loading or failed) — undefined skips the check rather than
     * reporting a change the user never made.
     */
    expectedOrganizationId: data ? (active?.id ?? null) : undefined,
  };
}

export function useSwitchActiveOrganization() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: ({
      organizationId,
    }: {
      organizationId: string;
      organizationName: string;
    }) => switchActiveOrganization({ organizationId }),
    onSuccess: (_data, { organizationId, organizationName }) => {
      markActiveOrganizationSwitched(queryClient, organizationId);
      // Every org-scoped query is now stale: start over from the new org's
      // home instead of leaving the previous org's page on screen. Only the
      // switcher's own list refetches now (the sidebar shows it); the rest
      // refetch when the new page asks for them.
      void queryClient.invalidateQueries({ refetchType: "none" });
      void queryClient.refetchQueries({ queryKey: MY_ORGANIZATIONS_QUERY_KEY });
      router.push("/dashboard");
      router.refresh();
      toast.success(`Switched to ${organizationName}`);
    },
  });
}
