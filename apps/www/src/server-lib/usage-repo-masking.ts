/** A repo usage row whose name the viewer may not be allowed to see. */
export interface MaskableRepoRow {
  repoFullName: string;
  tasks: number;
  merged: number;
  errored: number;
  lastActivityAt: Date;
  daily: number[];
}

export const HIDDEN_REPOS_LABEL = "Other repositories";

/**
 * Org usage counts every member's threads, but a repository NAME is shown only
 * when the viewer's GitHub token can see it — the same rule Home applies to
 * titles. Repos the viewer cannot see fold into one unnamed row, so the counts
 * still add up and nothing is named.
 */
export async function maskReposWithoutAccess<T extends MaskableRepoRow>(
  rows: T[],
  hasRepoAccess: (repoFullName: string) => Promise<boolean>,
): Promise<(T | (MaskableRepoRow & { hidden: true }))[]> {
  const access = await Promise.all(
    rows.map((row) => hasRepoAccess(row.repoFullName).catch(() => false)),
  );
  const visible = rows.filter((_, i) => access[i]);
  const hidden = rows.filter((_, i) => !access[i]);
  if (hidden.length === 0) {
    return visible;
  }
  const folded: MaskableRepoRow & { hidden: true } = {
    repoFullName: HIDDEN_REPOS_LABEL,
    hidden: true,
    tasks: hidden.reduce((n, r) => n + r.tasks, 0),
    merged: hidden.reduce((n, r) => n + r.merged, 0),
    errored: hidden.reduce((n, r) => n + r.errored, 0),
    lastActivityAt: hidden.reduce(
      (latest, r) => (r.lastActivityAt > latest ? r.lastActivityAt : latest),
      hidden[0]!.lastActivityAt,
    ),
    daily: hidden[0]!.daily.map((_, day) =>
      hidden.reduce((n, r) => n + (r.daily[day] ?? 0), 0),
    ),
  };
  return [...visible, folded];
}
