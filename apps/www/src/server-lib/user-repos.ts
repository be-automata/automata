import type { Endpoints } from "@octokit/types";

import { db } from "@/lib/db";
import { getOctokitForUser, parseRepoFullName } from "@/lib/github";
import {
  getCachedInstallationRepos,
  getCachedInstallations,
  GithubListingTimer,
  GithubListingUnavailableError,
  type GithubListingTiming,
} from "@/server-lib/github-listing-cache";
import type { VisibleGithubInstallation } from "@/server-lib/github-installations";
import {
  getGithubInstallationsByInstallationIds,
  getGithubInstallationsForOrganization,
} from "@terragon/shared/model/github-installation";
import { getMembership } from "@terragon/shared/model/organizations";

export { GithubListingUnavailableError };

export type UserRepo =
  Endpoints["GET /installation/repositories"]["response"]["data"]["repositories"][number];

/**
 * Which repos the list holds for the active org:
 * - "organization": only repos of GitHub installations bound to that org.
 * - "unassigned": the org has no bound installation yet, so the list falls
 *   back to every installation the user's token can see (the picker says so
 *   and points at Settings → Integrations).
 * Absent when there is no active org.
 */
export type UserReposScope = "organization" | "unassigned";

export type UserReposResult = {
  repos: UserRepo[];
  // The signed-in user has no usable GitHub OAuth token — e.g. an
  // email/password account, or a github account row created without ever
  // completing the OAuth flow. Distinct from "token is fine but the GitHub
  // App has no repositories": the first is fixed by signing in with GitHub,
  // the second by installing the App.
  githubTokenMissing?: boolean;
  scope?: UserReposScope;
};

type RepoScope = {
  scope: UserReposScope | undefined;
  /** Installations the list may hold; null for "no restriction". */
  allowedInstallationIds: Set<string> | null;
};

/**
 * Which installations the active org may list repos from. Null
 * `allowedInstallationIds` means no org restriction: no active org, the
 * user is no longer a member of it, or an org with nothing bound yet (the
 * "unassigned" fallback, which still drops installations bound to OTHER
 * orgs — see listUserRepos).
 */
async function resolveRepoScope({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string | null;
}): Promise<RepoScope> {
  const membership = organizationId
    ? await getMembership({ db, organizationId, userId })
    : undefined;
  if (!organizationId || !membership) {
    return { scope: undefined, allowedInstallationIds: null };
  }
  const bound = await getGithubInstallationsForOrganization({
    db,
    organizationId,
  });
  if (bound.length === 0) {
    return { scope: "unassigned", allowedInstallationIds: null };
  }
  return {
    scope: "organization",
    allowedInstallationIds: new Set(bound.map((row) => row.installationId)),
  };
}

/**
 * The installations the list draws from. An org-scoped list keeps only the
 * org's bound installations. The "unassigned" fallback keeps every visible
 * installation EXCEPT those bound to another org: those accounts' work runs
 * elsewhere, and listing them would show one org's repos inside another.
 */
async function selectInstallations({
  visible,
  scope,
  allowedInstallationIds,
  organizationId,
}: RepoScope & {
  visible: VisibleGithubInstallation[];
  organizationId: string | null;
}): Promise<VisibleGithubInstallation[]> {
  if (allowedInstallationIds) {
    return visible.filter((i) => allowedInstallationIds.has(i.installationId));
  }
  if (scope !== "unassigned") {
    return visible;
  }
  const rows = await getGithubInstallationsByInstallationIds({
    db,
    installationIds: visible.map((i) => i.installationId),
  });
  const boundElsewhere = new Set(
    rows
      .filter(
        (row) => row.organizationId && row.organizationId !== organizationId,
      )
      .map((row) => row.installationId),
  );
  return visible.filter((i) => !boundElsewhere.has(i.installationId));
}

/**
 * Whether a task on `repoFullName` may run in `organizationId`: the same
 * scope the repo picker shows (resolveRepoScope), enforced on the server so a
 * hand-crafted request cannot create a task in an org on a repo whose
 * account is not bound to it. Read from the binding rows only — no GitHub
 * call on the task-creation path: the repo owner is matched against each
 * bound installation's `accountLogin`.
 *
 * The caller must already have checked that the user is a member of
 * `organizationId`. True when the org has nothing bound yet ("unassigned"),
 * and — logged — when a bound row has no `accountLogin` to compare against
 * (a binding from before the column was stamped), since the owner may be
 * that installation's account.
 */
export async function isRepoInOrganizationScope({
  organizationId,
  repoFullName,
}: {
  organizationId: string;
  repoFullName: string;
}): Promise<boolean> {
  const bound = await getGithubInstallationsForOrganization({
    db,
    organizationId,
  });
  if (bound.length === 0) {
    return true;
  }
  const [owner] = parseRepoFullName(repoFullName);
  // GitHub logins are case-insensitive.
  const ownerLogin = owner.toLowerCase();
  if (bound.some((row) => row.accountLogin?.toLowerCase() === ownerLogin)) {
    return true;
  }
  const unlabelled = bound.filter((row) => !row.accountLogin);
  if (unlabelled.length > 0) {
    console.warn(
      "Repo scope check allowed a repo it could not map: a bound installation has no accountLogin",
      {
        organizationId,
        repoFullName,
        installationIds: unlabelled.map((row) => row.installationId),
      },
    );
    return true;
  }
  return false;
}

function byMostRecentPush(a: UserRepo, b: UserRepo): number {
  const aPushedAt = a.pushed_at ? new Date(a.pushed_at).getTime() : 0;
  const bPushedAt = b.pushed_at ? new Date(b.pushed_at).getTime() : 0;
  return bPushedAt - aPushedAt;
}

/**
 * The repos the user can push to, scoped to the session's active org
 * (`organizationId`), most recently pushed first. The GitHub listings come
 * from the per-user cache (see github-listing-cache.ts) unless `refresh`;
 * the org scoping is resolved fresh on every call.
 *
 * Throws GithubListingUnavailableError when GitHub fails to list the
 * installations, or every installation's repos.
 */
export async function listUserRepos({
  userId,
  organizationId,
  refresh = false,
}: {
  userId: string;
  organizationId: string | null;
  refresh?: boolean;
}): Promise<{ result: UserReposResult; timing: GithubListingTiming }> {
  const timer = new GithubListingTimer(refresh);
  const scopePromise = resolveRepoScope({ userId, organizationId });
  const octokit = await getOctokitForUser({ userId });
  if (!octokit) {
    // Settle the scope read so its rejection is never left unhandled.
    await scopePromise.catch(() => undefined);
    return {
      result: { repos: [], githubTokenMissing: true },
      timing: timer.snapshot(),
    };
  }
  const cacheArgs = { userId, octokit, bypass: refresh, timer };
  const [repoScope, visible] = await Promise.all([
    scopePromise,
    getCachedInstallations(cacheArgs),
  ]);
  const installations = await selectInstallations({
    ...repoScope,
    visible,
    organizationId,
  });
  let failures = 0;
  const repoArrays = await Promise.all(
    installations.map(async (installation): Promise<UserRepo[]> => {
      try {
        return await getCachedInstallationRepos({
          ...cacheArgs,
          installationId: installation.installationId,
        });
      } catch (installationError) {
        failures++;
        console.warn(
          `Failed to get repos for installation ${installation.installationId}:`,
          installationError,
        );
        return [];
      }
    }),
  );
  if (installations.length > 0 && failures === installations.length) {
    throw new GithubListingUnavailableError(
      new Error("every installation's repo listing failed"),
    );
  }
  const repos = repoArrays
    .flat()
    .filter((repo) => repo && repo.permissions?.push === true)
    .sort(byMostRecentPush);
  return {
    result: { repos, scope: repoScope.scope },
    timing: timer.snapshot(),
  };
}
