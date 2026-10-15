import { getTenantContextOrNull } from "@/lib/auth-server";
import {
  listingError,
  listingJson,
  listingUnauthorized,
  wantsRefresh,
} from "@/server-lib/github-listing-response";
import { listUserRepos } from "@/server-lib/user-repos";

export const dynamic = "force-dynamic";

/**
 * GET /api/github/repos[?refresh=1]
 *
 * The repos the signed-in user can push to, scoped to the session's active
 * org (UserReposResult). A route, not a server action, so the repo picker
 * loads in parallel with the page's other requests instead of queueing
 * behind them. `refresh=1` skips the short per-user GitHub listing cache.
 */
export async function GET(request: Request): Promise<Response> {
  const tenant = await getTenantContextOrNull();
  if (!tenant) {
    return listingUnauthorized();
  }
  try {
    const { result, timing } = await listUserRepos({
      userId: tenant.userId,
      organizationId: tenant.organizationId,
      refresh: wantsRefresh(request),
    });
    return listingJson(result, timing);
  } catch (error) {
    return listingError(error, "api/github/repos");
  }
}
