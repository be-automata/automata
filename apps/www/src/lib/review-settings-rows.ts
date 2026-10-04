/**
 * Pure helpers over the per-repo review-settings rows the client holds.
 * GitHub reports cased slugs ("Acme/Widgets"); the model stores and matches
 * them lowercased (repo-review-settings.ts), so every comparison here runs on
 * the lowercased key — strict equality would miss a cased slug.
 */

/** The row for a repo slug, compared case-insensitively. */
export function findSettingByRepo<T extends { repoFullName: string }>(
  list: readonly T[],
  repoFullName: string,
): T | undefined {
  const key = repoFullName.toLowerCase();
  return list.find((row) => row.repoFullName.toLowerCase() === key);
}

/**
 * Repos an "Add override" picker may offer: every repo the caller can see
 * minus those whose row already carries an override of the family that
 * `hasOverride` checks. Sorted.
 */
export function availableRepoNames<T extends { repoFullName: string }>(
  repoFullNames: readonly string[],
  settings: readonly T[],
  hasOverride: (setting: T) => boolean,
): string[] {
  const taken = new Set(
    settings.filter(hasOverride).map((s) => s.repoFullName.toLowerCase()),
  );
  return repoFullNames.filter((name) => !taken.has(name.toLowerCase())).sort();
}
