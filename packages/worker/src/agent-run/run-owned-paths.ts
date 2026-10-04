import fs from "node:fs/promises";
import path from "node:path";

/**
 * The directories the WORKER creates inside a run's checkout. They live in the
 * clone (not beside it) so they inherit the per-run grant provisioning put on
 * the workdir — see provision.ts. The names are defined once, here, so the git
 * exclusion below cannot drift from what the creators actually make.
 */
/** Per-run HOME (agent-credentials.ts) — carries the delivered credential. */
export const RUN_HOME_DIR = "home";
/** Agent-uid gh config dir (daemon-process.ts createGhConfigDir). */
export const RUN_GH_CONFIG_DIR = "gh-config";
/** Agent-uid TMPDIR (provision.ts). */
export const RUN_TMP_DIR = "tmp";

export const RUN_OWNED_DIRS: readonly string[] = [
  RUN_HOME_DIR,
  RUN_GH_CONFIG_DIR,
  RUN_TMP_DIR,
];

const EXCLUDE_HEADER = "# automata: run-owned dirs (worker-managed)";

/** `fallback` on ENOENT only; every other failure (EACCES, EIO) propagates. */
async function orIfMissing<T>(op: Promise<T>, fallback: T): Promise<T> {
  try {
    return await op;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

/**
 * Where this checkout's `info/exclude` lives.
 *
 * provisionWorkdir clones with a plain `git clone` (no --separate-git-dir), so
 * `.git` is a directory in production. A `.git` FILE (`gitdir: <path>`, a
 * linked worktree or submodule) is followed anyway rather than failing the run:
 * a linked worktree's private gitdir names the shared repo in `commondir`, and
 * git reads `info/exclude` from that common dir only.
 *
 * Returns null when there is no `.git` at all — nothing can be committed then.
 */
async function resolveExcludePath(workdir: string): Promise<string | null> {
  const dotGit = path.join(workdir, ".git");
  const stat = await orIfMissing(fs.stat(dotGit), null);
  if (!stat) {
    return null;
  }
  if (stat.isDirectory()) {
    return path.join(dotGit, "info", "exclude");
  }
  const pointer = (await fs.readFile(dotGit, "utf8")).trim();
  const match = /^gitdir:\s*(.+)$/.exec(pointer);
  if (!match?.[1]) {
    throw new Error(`unrecognised .git file in ${workdir}`);
  }
  const gitDir = path.resolve(workdir, match[1]);
  // No `commondir` = the pointer names a full gitdir (submodule): use it as is.
  const commonDir = await orIfMissing(
    fs.readFile(path.join(gitDir, "commondir"), "utf8"),
    null,
  );
  return path.join(
    commonDir === null ? gitDir : path.resolve(gitDir, commonDir.trim()),
    "info",
    "exclude",
  );
}

/**
 * Keep the run-owned dirs out of `git status` and `git add -A`. Observed in
 * production: a task agent reported `home/` and `gh-config/` as untracked, and
 * an agent that stages everything would commit the run HOME — credential
 * included — to the user's branch.
 *
 * `info/exclude`, not `.gitignore`: it is local to this clone, never committed,
 * and leaves the repo's own files untouched. Patterns are root-anchored, so a
 * repo's nested `src/tmp/` stays visible; exclusion never hides TRACKED files.
 *
 * Idempotent (a line already present is not re-added) and append-only, so a
 * template- or user-provided exclude survives. Run after the clone and before
 * the agent starts.
 *
 * Agent-uid mode needs no re-grant here: the file is written with a 0644 mode,
 * whose group bits keep the inherited ACL mask at `r--` on Linux, and the agent
 * only ever reads it.
 */
export async function excludeRunOwnedPaths(workdir: string): Promise<void> {
  const excludePath = await resolveExcludePath(workdir);
  if (!excludePath) {
    return;
  }
  const existing = await orIfMissing(fs.readFile(excludePath, "utf8"), "");
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = RUN_OWNED_DIRS.map((d) => `/${d}/`).filter(
    (p) => !present.has(p),
  );
  if (missing.length === 0) {
    return;
  }
  const lines = present.has(EXCLUDE_HEADER)
    ? missing
    : [EXCLUDE_HEADER, ...missing];
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.appendFile(excludePath, `${separator}${lines.join("\n")}\n`, {
    mode: 0o644,
  });
}
