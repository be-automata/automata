/**
 * Self-heal fix lane path policy (phase 9) — THE one definition of which files
 * a fix run may change and which it may never touch.
 *
 * Dependency-free on purpose (no imports at all): the www fix prompt, the www
 * compare-diff guard and — through a drift-tested mirror — the worker's
 * pushed-diff check all read this module, and the deploy tsx scripts can load
 * it without alias resolution. The prompt is advice to a well-behaved agent;
 * the worker and www checks are the enforcement, and they must agree with the
 * prompt byte for byte, which is why the list lives here and nowhere else.
 */

/** Every fix branch starts with this; the git-broker ref fence accepts nothing else. */
export const FIX_BRANCH_PREFIX = "automata/fix-";

/**
 * Paths a fix run may never change, whatever the plan lists. Agent
 * instructions and deploy tooling are persistence targets (an edit there
 * steers every later run); `.github/**` holds the CI that gates the fix.
 * Root-anchored; a trailing `/**` covers the directory and everything below.
 */
export const FIX_DENY_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/**",
  "deploy/**",
  "packages/worker/deploy/**",
  ".github/**",
] as const;

/**
 * Agent-instruction names denied at ANY depth, on top of the root-anchored
 * list: Claude Code also loads a nested `CLAUDE.md` / `.claude/` when it works
 * in that directory, so a nested copy is the same persistence target.
 * Compared lowercased (a case-insensitive checkout resolves `claude.md` to the
 * same file).
 */
const DENY_ANY_DEPTH_SEGMENTS: ReadonlySet<string> = new Set([
  "agents.md",
  "claude.md",
  ".claude",
]);

/** The only `.github/**` shape an exception can ever cover. */
const WORKFLOW_FILE_RE = /^\.github\/workflows\/[^/]+$/;

/** The only rule family whose job is fixing workflows. */
const CI_RULE_PREFIX = "ci.";

/**
 * Files a fix may change in addition to the plan's own files: the lockfile
 * that moves with an allowed `package.json`, and the root VERSION /
 * CHANGELOG.md for repos that record every change.
 */
export const FIX_COMPANION_FILES = {
  lockfiles: ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"],
  root: ["VERSION", "CHANGELOG.md"],
} as const;

export interface FixPathContext {
  ruleId: string;
  /** The finding's DB snapshot `plan_files` column (nullable). */
  planFiles: readonly string[] | null;
}

/**
 * Canonical repo-relative spelling, or null when the path cannot be trusted
 * (empty, or a `.`/`..` segment). Leading `./` and `/` and repeated or
 * trailing slashes are folded so `./AGENTS.md` cannot dodge a literal match.
 */
export function normalizeFixPath(path: string): string | null {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  while (segments[0] === ".") segments.shift();
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

function matchesDenyEntry(lowerPath: string, entry: string): boolean {
  const lowerEntry = entry.toLowerCase();
  if (lowerEntry.endsWith("/**")) {
    const dir = lowerEntry.slice(0, -3);
    return lowerPath === dir || lowerPath.startsWith(`${dir}/`);
  }
  return lowerPath === lowerEntry;
}

function uniqueNormalized(paths: readonly string[] | null): string[] {
  const out: string[] = [];
  for (const path of paths ?? []) {
    const normalized = normalizeFixPath(path);
    if (normalized !== null && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * The exact `.github/workflows/<file>` paths a `ci.*` rule may touch: the
 * workflow files its plan lists, and nothing else. `[]` for every other rule.
 * Shipped to the worker in the fix payload so both checks share one answer.
 */
export function denyExceptionsFor(ctx: FixPathContext): string[] {
  if (!ctx.ruleId.startsWith(CI_RULE_PREFIX)) return [];
  return uniqueNormalized(ctx.planFiles).filter((path) =>
    WORKFLOW_FILE_RE.test(path),
  );
}

/**
 * True when a fix run must not change `path`. Denied regardless of
 * plan_files, except a `.github/workflows/<file>` that a `ci.*` rule's plan
 * lists exactly. The instruction and deploy paths have no exception. An
 * untrustworthy spelling (traversal, empty) is denied.
 */
export function isDeniedPath(path: string, ctx: FixPathContext): boolean {
  const normalized = normalizeFixPath(path);
  if (normalized === null) return true;
  const lower = normalized.toLowerCase();
  if (
    lower.split("/").some((segment) => DENY_ANY_DEPTH_SEGMENTS.has(segment))
  ) {
    return true;
  }
  const matched = FIX_DENY_PATHS.filter((entry) =>
    matchesDenyEntry(lower, entry),
  );
  if (matched.length === 0) return false;
  const onlyGithub = matched.every((entry) => entry === ".github/**");
  return !(onlyGithub && denyExceptionsFor(ctx).includes(normalized));
}

/**
 * The plan's files plus their companions, normalized and deduplicated in a
 * stable order: plan files, then the lockfiles for each listed `package.json`
 * (its sibling lockfiles and the workspace-root ones, since a workspace keeps
 * a single lockfile at the root), then the root VERSION / CHANGELOG.md.
 * Callers still filter the result through isDeniedPath.
 */
export function allowedFilesFor(planFiles: readonly string[] | null): string[] {
  const out = uniqueNormalized(planFiles);
  const add = (path: string): void => {
    if (!out.includes(path)) out.push(path);
  };
  for (const file of [...out]) {
    if (file !== "package.json" && !file.endsWith("/package.json")) continue;
    const dir = file.slice(0, -"package.json".length);
    for (const lockfile of FIX_COMPANION_FILES.lockfiles)
      add(`${dir}${lockfile}`);
    for (const lockfile of FIX_COMPANION_FILES.lockfiles) add(lockfile);
  }
  for (const file of FIX_COMPANION_FILES.root) add(file);
  return out;
}
