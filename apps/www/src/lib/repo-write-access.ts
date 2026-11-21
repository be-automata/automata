import type { DB } from "@terragon/shared/db";

import { isOrgAdmin } from "@/lib/org-role";
import { checkRepoAdmin } from "@/lib/repo-admin";

/**
 * The outcome of the #125 C6 two-level permission for a per-repo settings
 * write. Callers render it: the legacy review-settings route as its human
 * 403 copy, later callers as named error codes. One rule, many renderings.
 */
export type RepoWriteAccess = "allowed" | "not_repo_admin" | "lookup_failed";

/**
 * An ORG admin may write any repo's settings; anyone else must administer
 * THAT repo on GitHub (the caller's own token, see {@link checkRepoAdmin}).
 * Fail-closed: a GitHub lookup that cannot answer is `lookup_failed`, never
 * an allow. The org-admin check runs first, so an org admin costs no GitHub
 * round trip.
 */
export async function checkRepoWriteAccess({
  db,
  userId,
  organizationId,
  repoFullName,
}: {
  db: DB;
  userId: string;
  organizationId: string;
  repoFullName: string;
}): Promise<RepoWriteAccess> {
  if (await isOrgAdmin({ db, organizationId, userId })) return "allowed";
  const repoCheck = await checkRepoAdmin({ userId, repoFullName });
  if (repoCheck === "admin") return "allowed";
  if (repoCheck === "lookup-failed") return "lookup_failed";
  return "not_repo_admin";
}
