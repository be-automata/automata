import type { CheckOutcome } from "../decide-audit-actions";

/**
 * A minimal model of the #266 -> #275 failure (#277): a repository's manifest
 * and lockfile, a dependency fix applied to them, and a later PR that
 * re-resolves the lockfile from its own, older resolution.
 *
 * Resolution follows the package manager's rule that matters here: an
 * `overrides` entry in the manifest pins the version on every resolve, while
 * anything else keeps whatever the resolving branch already had locked. So a
 * lockfile-only bump lives only in the lockfile and is lost on re-resolve.
 */

export interface FixtureRepo {
  /** `pnpm.overrides` of the root `package.json`: package -> exact version. */
  overrides: Record<string, string>;
  /** `pnpm-lock.yaml`: package -> resolved version. */
  lock: Record<string, string>;
}

export interface FixtureAdvisory {
  pkg: string;
  /** First version without the advisory. */
  patched: string;
}

export type DependencyFixStrategy = "lockfile-only" | "overrides";

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The fix a self-heal run commits: the patched version, pinned or not. */
export function applyDependencyFix(
  repo: FixtureRepo,
  advisory: FixtureAdvisory,
  strategy: DependencyFixStrategy,
): FixtureRepo {
  const lock = { ...repo.lock, [advisory.pkg]: advisory.patched };
  if (strategy === "lockfile-only") return { overrides: repo.overrides, lock };
  return {
    overrides: { ...repo.overrides, [advisory.pkg]: advisory.patched },
    lock,
  };
}

/**
 * A later PR that re-resolves the lockfile on a branch whose lockfile predates
 * the fix, then lands: the merged manifest keeps the fix's overrides, and the
 * merged lockfile is that branch's resolution under those overrides.
 */
export function reresolveLockfile(
  merged: FixtureRepo,
  staleBranchLock: Record<string, string>,
): FixtureRepo {
  const lock = { ...staleBranchLock };
  for (const [pkg, version] of Object.entries(merged.overrides)) {
    lock[pkg] = version;
  }
  return { overrides: merged.overrides, lock };
}

/** The `npm-audit-clean` check: fails while the locked version is affected. */
export function npmAuditCheck(
  repo: FixtureRepo,
  advisory: FixtureAdvisory,
): CheckOutcome {
  const locked = repo.lock[advisory.pkg];
  if (locked === undefined) return "pass";
  return compareVersions(locked, advisory.patched) < 0 ? "fail" : "pass";
}
