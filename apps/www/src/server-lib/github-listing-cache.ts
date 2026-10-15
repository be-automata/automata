import type { Octokit } from "octokit";
import type { Endpoints } from "@octokit/types";

import { redis } from "@/lib/redis";
import {
  listInstallationsForOctokit,
  type VisibleGithubInstallation,
} from "@/server-lib/github-installations";

/**
 * Short-lived, per-user cache of what the user's GitHub token can list: the
 * App installations it sees and the repos it reaches in each one. These are
 * the RAW GitHub answers; org scoping (which installations the active org may
 * use) is applied by the callers on every request, so switching org or
 * binding an installation never serves another org's view.
 *
 * Keys always carry the user id: a listing is never shared across users.
 * The cache fails open — a Redis error falls through to GitHub — but it never
 * stands in for auth: callers still resolve the session and the user's
 * GitHub token before reading it.
 */

export type InstallationRepo =
  Endpoints["GET /user/installations/{installation_id}/repositories"]["response"]["data"]["repositories"][number];

export const GITHUB_LISTING_CACHE_TTL_S = 120;

const KEY_PREFIX = "github-listing:v1";

function installationsKey(userId: string): string {
  return `${KEY_PREFIX}:${userId}:installations`;
}

function installationReposKey(userId: string, installationId: string): string {
  return `${KEY_PREFIX}:${userId}:installation-repos:${installationId}`;
}

/**
 * GitHub could not list the user's installations or repos. Distinct from an
 * empty list: the route reports it as a 502 so the dashboard keeps the stored
 * repo instead of treating an outage as "no repos".
 */
export class GithubListingUnavailableError extends Error {
  constructor(cause: unknown) {
    super("GitHub did not answer the listing. Try again shortly.", {
      cause,
    });
    this.name = "GithubListingUnavailableError";
  }
}

export type GithubListingCacheStatus = "hit" | "miss" | "bypass";

/**
 * What one request spent on GitHub and whether the cache answered it, for
 * the `Server-Timing` header. `cache` is "miss" as soon as any listing had to
 * come from GitHub, "bypass" when the caller asked for fresh data.
 */
export interface GithubListingTiming {
  githubMs: number;
  cache: GithubListingCacheStatus;
}

export class GithubListingTimer {
  private githubMs = 0;
  private anyMiss = false;

  constructor(private readonly bypass: boolean) {}

  /** Runs a GitHub call; any failure surfaces as GithubListingUnavailableError. */
  async timeGithub<T>(call: () => Promise<T>): Promise<T> {
    this.anyMiss = true;
    const startedAt = performance.now();
    try {
      return await call();
    } catch (error) {
      throw new GithubListingUnavailableError(error);
    } finally {
      this.githubMs += performance.now() - startedAt;
    }
  }

  snapshot(): GithubListingTiming {
    return {
      githubMs: Math.round(this.githubMs),
      cache: this.bypass ? "bypass" : this.anyMiss ? "miss" : "hit",
    };
  }
}

export function formatServerTiming(timing: GithubListingTiming): string {
  return `github;dur=${timing.githubMs}, cache;desc=${timing.cache}`;
}

async function readCache<T>(key: string): Promise<T | null> {
  try {
    return await redis.get<T>(key);
  } catch (error) {
    console.warn("[github-listing-cache] read failed, using GitHub", error);
    return null;
  }
}

async function writeCache(key: string, value: unknown): Promise<void> {
  try {
    await redis.set(key, value, { ex: GITHUB_LISTING_CACHE_TTL_S });
  } catch (error) {
    console.warn("[github-listing-cache] write failed", error);
  }
}

interface CachedListingArgs {
  userId: string;
  octokit: Octokit;
  /** Skip the cached value (it is still refreshed with GitHub's answer). */
  bypass: boolean;
  timer: GithubListingTimer;
}

/**
 * The installations `octokit` (the user's token) can see. Throws when
 * GitHub does (GithubListingUnavailableError); a failure is never cached.
 */
export async function getCachedInstallations({
  userId,
  octokit,
  bypass,
  timer,
}: CachedListingArgs): Promise<VisibleGithubInstallation[]> {
  const key = installationsKey(userId);
  if (!bypass) {
    const cached = await readCache<VisibleGithubInstallation[]>(key);
    if (Array.isArray(cached)) {
      return cached;
    }
  }
  const fresh = await timer.timeGithub(() =>
    listInstallationsForOctokit(octokit),
  );
  await writeCache(key, fresh);
  return fresh;
}

/**
 * Every repo the user's token reaches in one installation (all pages).
 * Throws when GitHub does (GithubListingUnavailableError); a failure is never cached.
 */
export async function getCachedInstallationRepos({
  userId,
  octokit,
  bypass,
  timer,
  installationId,
}: CachedListingArgs & { installationId: string }): Promise<
  InstallationRepo[]
> {
  const key = installationReposKey(userId, installationId);
  if (!bypass) {
    const cached = await readCache<InstallationRepo[]>(key);
    if (Array.isArray(cached)) {
      return cached;
    }
  }
  const fresh = await timer.timeGithub(() =>
    octokit.paginate(
      octokit.rest.apps.listInstallationReposForAuthenticatedUser,
      { installation_id: Number(installationId), per_page: 100 },
    ),
  );
  await writeCache(key, fresh);
  return fresh;
}
