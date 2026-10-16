import { getOctokitForUser, parseRepoFullName } from "@/lib/github";

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
  const octokit = await getOctokitForUser({ userId });
  if (!octokit) {
    return false;
  }
  try {
    const [owner, repo] = parseRepoFullName(repoFullName);
    const repoInfo = await octokit.rest.repos.get({ owner, repo });
    return !!repoInfo.data.permissions;
  } catch (error) {
    console.warn("Repository access check failed", {
      repoFullName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
