import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  getMyOrganizations,
  switchActiveOrganization,
} from "@/server-actions/organizations";
import {
  useServerActionMutation,
  useServerActionQuery,
} from "./server-action-helpers";

export const MY_ORGANIZATIONS_QUERY_KEY = ["my-organizations"] as const;

export function useMyOrganizations() {
  return useServerActionQuery({
    queryKey: MY_ORGANIZATIONS_QUERY_KEY,
    queryFn: () => getMyOrganizations(),
    staleTime: 60_000,
  });
}

/**
 * The org the session is acting in, or null. Null is a real state: no
 * membership, or a session created before the user joined an org.
 */
export function useActiveOrganization() {
  const { data, isLoading } = useMyOrganizations();
  const active =
    data?.organizations.find((org) => org.id === data.activeOrganizationId) ??
    null;
  return { activeOrganization: active, isLoading };
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
    onSuccess: (_data, { organizationName }) => {
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
