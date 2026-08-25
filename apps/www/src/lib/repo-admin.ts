import { getOctokitForUser, parseRepoFullName } from "@/lib/github";

/**
 * Repo-admin gate for the per-repo review-settings write path (#125 C6): a
 * repo override may be written by an ORG admin (isOrgAdmin, checked first by
 * the routes) or by someone GitHub says administers THAT repo — checked here
 * with the CALLER's own GitHub token via `repos.get`, whose `permissions`
 * object is already scoped to the authenticated user (one round trip).
 *
 * FAIL-CLOSED: no linked GitHub identity, an expired token, or any lookup
 * error answers `lookup-failed` (→ 403 with "we couldn't verify" copy), never
 * a silent allow.
 *
 * Cached 5 minutes per (userId, repo) — per isolate; a Workers deploy has
 * several isolates, so the cache is a cost bound, not a consistency
 * mechanism (a revoked admin can act for ≤5 min per isolate, matching the
 * ticket's operative definition).
 */

export type RepoAdminCheck = "admin" | "not-admin" | "lookup-failed";

const CACHE_TTL_MS = 5 * 60 * 1000;
// Bounded: distinct (user, repo) pairs accumulate over an isolate's lifetime.
const CACHE_MAX_ENTRIES = 1000;
const cache = new Map<string, { value: RepoAdminCheck; expiresAt: number }>();

export function clearRepoAdminCacheForTest(): void {
  cache.clear();
}

export async function checkRepoAdmin({
  userId,
  repoFullName,
  now = Date.now,
}: {
  userId: string;
  repoFullName: string;
  now?: () => number;
}): Promise<RepoAdminCheck> {
  const key = `${userId}:${repoFullName.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) {
    if (hit.expiresAt > now()) return hit.value;
    cache.delete(key);
  }
  const value = await lookup({ userId, repoFullName });
  // Never cache a failed lookup: the next attempt should retry GitHub.
  if (value !== "lookup-failed") {
    if (cache.size >= CACHE_MAX_ENTRIES) {
      // Maps iterate in insertion order — drop the oldest entry (FIFO trim).
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS });
  }
  return value;
}

async function lookup({
  userId,
  repoFullName,
}: {
  userId: string;
  repoFullName: string;
}): Promise<RepoAdminCheck> {
  try {
    const octokit = await getOctokitForUser({ userId });
    if (!octokit) return "lookup-failed";
    const [owner, repo] = parseRepoFullName(repoFullName);
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return data.permissions?.admin === true ? "admin" : "not-admin";
  } catch (error) {
    console.warn("[repo-admin] GitHub permission lookup failed", {
      repoFullName,
      error: error instanceof Error ? error.message : String(error),
    });
    return "lookup-failed";
  }
}
