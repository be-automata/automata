import { getMyOrganizations } from "@/server-actions/organizations";
import { getServerActionQueryOptions } from "./server-action-helpers";

export const MY_ORGANIZATIONS_QUERY_KEY = ["my-organizations"] as const;

/** Shared by the client hook and the sidebar layout's server prefetch. */
export function myOrganizationsQueryOptions() {
  return getServerActionQueryOptions({
    queryKey: MY_ORGANIZATIONS_QUERY_KEY,
    queryFn: () => getMyOrganizations(),
    staleTime: 60_000,
  });
}
