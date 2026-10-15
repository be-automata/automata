/**
 * The repository (and branch) the dashboard acts on. `user_flags.selectedRepo`
 * is per user, not per org, so after an org switch it can name a repo the
 * active org's list does not hold. Such a selection is ignored — never shown
 * in the "Runs in" cue or submitted — and the first listed repo stands in,
 * without overwriting the stored choice (switching back restores it).
 *
 * While the list is unknown (loading or failed) the stored choice is kept.
 */
export function resolveSelectedRepo<
  TRepo extends { full_name: string; default_branch?: string | null },
>({
  selectedRepoFullName,
  selectedBranch,
  repos,
}: {
  selectedRepoFullName: string | null;
  selectedBranch: string | null;
  repos: TRepo[] | undefined;
}): { repoFullName: string | null; branchName: string | null } {
  if (!repos) {
    return { repoFullName: selectedRepoFullName, branchName: selectedBranch };
  }
  if (
    selectedRepoFullName &&
    repos.some((repo) => repo.full_name === selectedRepoFullName)
  ) {
    return { repoFullName: selectedRepoFullName, branchName: selectedBranch };
  }
  const first = repos[0];
  if (!first) {
    return { repoFullName: null, branchName: null };
  }
  return {
    repoFullName: first.full_name,
    branchName: first.default_branch ?? "main",
  };
}
