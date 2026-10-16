import { getOctokitForUser, parseRepoFullName } from "@/lib/github";

const ACCESS_TTL_MS = 5 * 60 * 1000;
/** Per isolate; best-effort. Keeps 10s activity polls off GitHub's rate limit. */
const accessCache = new Map<string, { value: boolean; expiresAt: number }>();

/**
 * Whether the user's GitHub token can see a repository: what `repo` thread
 * visibility means. Any failure (no token, 404, rate limit) reads as no access.
 */
export async function userHasRepoAccess({
  userId,
  repoFullName,
}: {
  userId: string;
  repoFullName: string;
}): Promise<boolean> {
  // Opening a thread always asks GitHub: a revoked permission takes effect now.
  return createRepoAccessChecker(userId, { cache: false })(repoFullName);
}

/**
 * A checker for one request: the GitHub client is built once. With `cache`,
 * answers are kept per (user, repo) for a few minutes; use it only where a
 * stale answer masks or shows a title (activity lists), never to open a thread.
 */
export function createRepoAccessChecker(
  userId: string,
  { cache }: { cache: boolean },
): (repoFullName: string) => Promise<boolean> {
  let octokit: ReturnType<typeof getOctokitForUser> | null = null;
  return async (repoFullName) => {
    const key = `${userId}:${repoFullName}`;
    const cached = cache ? accessCache.get(key) : undefined;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    octokit ??= getOctokitForUser({ userId });
    const client = await octokit;
    if (!client) {
      return false;
    }
    let value = false;
    // Only a definite answer is cached: a success, or GitHub saying no (403,
    // 404). A rate limit, 5xx or network error must not mask for the TTL.
    let definite = true;
    try {
      const [owner, repo] = parseRepoFullName(repoFullName);
      const repoInfo = await client.rest.repos.get({ owner, repo });
      value = !!repoInfo.data.permissions;
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? (error as { status?: unknown }).status
          : undefined;
      definite = status === 403 || status === 404;
      console.warn("Repository access check failed", {
        repoFullName,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (cache && definite) {
      accessCache.set(key, { value, expiresAt: Date.now() + ACCESS_TTL_MS });
    }
    return value;
  };
}
