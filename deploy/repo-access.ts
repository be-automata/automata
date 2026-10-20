/**
 * Pure rule for "does this GitHub App installation grant what the doc loop
 * needs on a repo". No imports, so it runs under Node type stripping (CI runs
 * deploy/*.test.ts with `node --test`).
 */

const LEVEL_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/**
 * Read for the loop = metadata + contents read. Doc PRs need contents write
 * (push a branch) and pull_requests write (open the PR).
 */
export const REQUIRED_DOC_PR_PERMISSIONS: readonly (readonly [
  string,
  string,
])[] = [
  ["metadata", "read"],
  ["contents", "write"],
  ["pull_requests", "write"],
];

export interface RepoAccessAssessment {
  ok: boolean;
  read: boolean;
  docPrWrite: boolean;
  missing: string[];
}

function rankOf(level: string | undefined): number {
  return level === undefined ? 0 : (LEVEL_RANK[level] ?? 0);
}

export function assessRepoAccess(
  permissions: Record<string, string | undefined>,
): RepoAccessAssessment {
  const missing: string[] = [];
  for (const [permission, needed] of REQUIRED_DOC_PR_PERMISSIONS) {
    if (rankOf(permissions[permission]) < rankOf(needed)) {
      missing.push(`${permission}:${needed}`);
    }
  }
  const read =
    rankOf(permissions["metadata"]) >= rankOf("read") &&
    rankOf(permissions["contents"]) >= rankOf("read");
  const docPrWrite =
    rankOf(permissions["contents"]) >= rankOf("write") &&
    rankOf(permissions["pull_requests"]) >= rankOf("write");
  return { ok: missing.length === 0, read, docPrWrite, missing };
}

export function parseRepoArg(arg: string): { owner: string; repo: string } {
  const parts = arg.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo) {
    throw new Error(`Expected a repo as "owner/repo", got "${arg}"`);
  }
  return { owner, repo };
}
