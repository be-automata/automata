import { getUserIdOrNull } from "@/lib/auth-server";
import { listGithubInstallationRows } from "@/server-lib/github-installation-rows";
import {
  listingError,
  listingJson,
  listingUnauthorized,
  wantsRefresh,
} from "@/server-lib/github-listing-response";

export const dynamic = "force-dynamic";

/**
 * GET /api/github/installations[?refresh=1]
 *
 * The GitHub App installations the signed-in user's token can see, each with
 * the org it is bound to (GithubInstallationsResult). Feeds Settings →
 * Integrations. `refresh=1` skips the short per-user GitHub listing cache.
 */
export async function GET(request: Request): Promise<Response> {
  const userId = await getUserIdOrNull();
  if (!userId) {
    return listingUnauthorized();
  }
  try {
    const { result, timing } = await listGithubInstallationRows({
      userId,
      refresh: wantsRefresh(request),
    });
    return listingJson(result, timing);
  } catch (error) {
    return listingError(error, "api/github/installations");
  }
}
