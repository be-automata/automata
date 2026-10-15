/**
 * The repository (and branch) the dashboard acts on. `user_flags.selectedRepo`
 * is per user, not per org, so after an org switch it can name a repo the
 * active org's list does not hold. Such a selection is ignored — never shown
 * in the "Runs in" cue or submitted — and the first listed repo stands in,
 * without overwriting the stored choice (switching back restores it).
 *
 * While the list is still loading the selection is unresolved: no repo is
 * returned and `pending` is set, so the cue shows no repo and the dashboard
 * holds submission (the stored repo may belong to the org the user just left).
 * If the list failed to load, the stored choice is kept, so a GitHub outage
 * never locks the dashboard.
 */
export function resolveSelectedRepo<
  TRepo extends { full_name: string; default_branch?: string | null },
>({
  selectedRepoFullName,
  selectedBranch,
  repos,
  isLoading = false,
}: {
  selectedRepoFullName: string | null;
  selectedBranch: string | null;
  repos: TRepo[] | undefined;
  /** The org's repo list is still being fetched. */
  isLoading?: boolean;
}): {
  repoFullName: string | null;
  branchName: string | null;
  pending: boolean;
} {
  if (!repos) {
    return isLoading
      ? { repoFullName: null, branchName: null, pending: true }
      : {
          repoFullName: selectedRepoFullName,
          branchName: selectedBranch,
          pending: false,
        };
  }
  if (
    selectedRepoFullName &&
    repos.some((repo) => repo.full_name === selectedRepoFullName)
  ) {
    return {
      repoFullName: selectedRepoFullName,
      branchName: selectedBranch,
      pending: false,
    };
  }
  const first = repos[0];
  if (!first) {
    return { repoFullName: null, branchName: null, pending: false };
  }
  return {
    repoFullName: first.full_name,
    branchName: first.default_branch ?? "main",
    pending: false,
  };
}
