import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "@terragon/utils/redact";
import { runPaths, type RunPaths } from "./run-owned-paths";

const execFileAsync = promisify(execFile);

/**
 * Run git and, on failure, throw an error that carries the useful part (the
 * verb, exit code and the tail of stderr) and NEVER the command line: Node's
 * default "Command failed: git -c http.extraHeader=AUTHORIZATION: basic …"
 * message echoes the installation token, and that message becomes the run's
 * persisted failure reason (see postRunFailed). Stderr is redacted too.
 */
export async function gitExec(
  args: string[],
  opts: { maxBuffer?: number; timeout?: number } = {},
) {
  try {
    return await execFileAsync("git", args, opts);
  } catch (error) {
    const e = error as { code?: unknown; stderr?: unknown };
    const verb =
      args.find(
        (a) =>
          !a.startsWith("-") &&
          a !== "git" &&
          !a.includes("=") &&
          !a.startsWith("/"),
      ) ?? "git";
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    const tail = stderr.length > 600 ? `…${stderr.slice(-600)}` : stderr;
    // NO `cause`: the raw execFile rejection carries the full argv (with the
    // auth header) in .message and .cmd, and Node's default error inspection
    // prints the [cause] chain — so a logged throw would leak it anyway.
    // Everything diagnostic the raw error had (code, signal, stderr tail) is
    // already in the redacted message; the exit code is kept as a plain field.
    const redacted = new Error(
      redactSecrets(
        `git ${verb} failed (exit ${String(e.code ?? "?")})${tail ? `: ${tail}` : ""}`,
      ),
    ) as Error & { code?: unknown; signal?: unknown };
    redacted.code = e.code;
    redacted.signal = (error as { signal?: unknown }).signal;
    throw redacted;
  }
}

/**
 * Marks a directory that has been renamed out of the way and is no longer any
 * run's workdir. Chosen so it cannot collide with a runId (which is a uuid).
 */
const TOMBSTONE_SUFFIX = ".tombstone-";

/**
 * Best-effort removal of tombstones an earlier run could not free — a live
 * escapee holding one is exactly the case that leaves it behind. Never throws:
 * failing to sweep is residue, failing the run is an outage.
 */
async function sweepTombstones(workdirRoot: string): Promise<void> {
  const entries = await fs.readdir(workdirRoot).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.includes(TOMBSTONE_SUFFIX)) continue;
    await fs
      .rm(path.join(workdirRoot, entry), { recursive: true, force: true })
      .catch(() => {});
  }
}

/**
 * Clone `repoFullName@branch` into a fresh per-run workdir using the short-lived
 * installation token (ADR-003 provision step). The token authenticates via a
 * command-scoped `http.extraHeader` (base64 Basic) rather than being embedded in
 * the remote URL: URL-embedded credentials get persisted into .git/config on disk,
 * the header form does not. Returns the run's paths; the clone is `repo`.
 */
export async function provisionWorkdir({
  repoFullName,
  branch,
  baseBranch,
  workBranch,
  installationToken,
  workdirRoot,
  runId,
  runGit = gitExec,
}: {
  repoFullName: string;
  branch: string;
  /**
   * The PR base branch (e.g. "main"). When set and distinct from `branch`, provision
   * fetches enough of it that `git diff origin/<base>...HEAD` works OFFLINE — see the
   * base-fetch block below (BUG-EXEC-02). Omit/empty for non-PR runs (no base fetch).
   */
  baseBranch?: string;
  /**
   * A task run's own branch, checked out right after the clone so the agent
   * never commits on the base branch: the remote branch when an earlier run
   * already pushed it, else a new branch from the cloned HEAD. Omit for every
   * other run.
   */
  workBranch?: string;
  installationToken: string;
  workdirRoot: string;
  /** Unique per-run directory key — pass threadId, NOT the shared legacy sentinel. */
  runId: string;
  /** Injectable git runner (tests only) — defaults to the real gitExec. */
  runGit?: typeof gitExec;
}): Promise<RunPaths> {
  const paths = runPaths(path.join(workdirRoot, runId));
  const { runDir } = paths;

  // Clear residue from a PRIOR attempt of this same runId — by RENAME, never by
  // removing in place.
  //
  // `force: true` suppresses ENOENT and nothing else. A recursive remove still
  // throws ENOTEMPTY when anything is writing into the tree while it is walked,
  // and that is not hypothetical here: the engine redelivers a run while the
  // previous attempt's agent may still be alive, which is the whole reason this
  // line clears the directory at all. Observed in production 2026-09-28 — a
  // review that had been working for five minutes was redelivered, the new
  // attempt threw
  //
  //   ENOTEMPTY: directory not empty, rmdir '/usr/local/automata/runs/<id>'
  //
  // and the run died with no verdict, surfacing to the user as "Review intent
  // could not be parsed". The repo already learned this for lock directories;
  // this path never got it.
  //
  // rename(2) does not care what is inside or who is writing, so the new attempt
  // always starts on a clean path. The tombstone is then removed best-effort: if
  // a live escapee still holds it, the removal fails, the tombstone remains, and
  // the NEXT run sweeps it — a bounded, visible residue instead of a failed run.
  const stale = await fs.stat(runDir).catch(() => null);
  if (stale) {
    const tombstone = `${runDir}${TOMBSTONE_SUFFIX}${Date.now()}`;
    try {
      await fs.rename(runDir, tombstone);
      await fs.rm(tombstone, { recursive: true, force: true }).catch(() => {});
    } catch {
      // The rename itself can fail where the stale directory is unwritable:
      // macOS updates `..` on a directory rename, so it needs write on the
      // directory being MOVED, not just on its parent. That is a permissions
      // problem, not the redelivery race this guards, and it deserves to
      // surface with its own error rather than be papered over — so fall back
      // to the original in-place removal and let it throw.
      await fs.rm(runDir, { recursive: true, force: true });
    }
  }
  await sweepTombstones(workdirRoot);

  // #205: the run dir is PRIVATE (0700); chmod as well, for a dir that already
  // existed. A run container reaches only the dirs handOverRunDir opens to the
  // rootless daemon's group (ADR-013 "Daemon socket"), by search, never read.
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  await fs.chmod(runDir, 0o700);

  // The clone goes in `<runDir>/repo`, beside the run's HOME staging dir and
  // socket dir (#302). git clone accepts an existing EMPTY destination.
  const workdir = paths.repo;
  await fs.mkdir(workdir);

  const authHeader = `AUTHORIZATION: basic ${Buffer.from(
    `x-access-token:${installationToken}`,
  ).toString("base64")}`;
  const cloneUrl = `https://github.com/${repoFullName}.git`;

  // --depth 1 on the target branch: the working checkout the agent reviews at HEAD.
  await runGit(
    [
      "-c",
      `http.extraHeader=${authHeader}`,
      "clone",
      "--depth",
      "1",
      "--branch",
      branch,
      cloneUrl,
      workdir,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );

  // A task run's own branch. It continues the remote branch when an earlier
  // run of this thread already pushed it (a run whose PR was never recorded,
  // e.g. auto-create off or a failed finish call): starting it again from the
  // base would make the agent's push non-fast-forward and orphan that work.
  const authConfigArgs = ["-c", `http.extraHeader=${authHeader}`];
  if (workBranch) {
    const { stdout: remoteHead } = await runGit([
      "-C",
      workdir,
      ...authConfigArgs,
      "ls-remote",
      "--heads",
      "origin",
      workBranch,
    ]);
    const continuesRemote = String(remoteHead).trim() !== "";
    if (continuesRemote) {
      await runGit([
        "-C",
        workdir,
        ...authConfigArgs,
        "fetch",
        "-q",
        "--depth",
        "1",
        "origin",
        `+refs/heads/${workBranch}:refs/remotes/origin/${workBranch}`,
      ]);
    }
    await runGit([
      "-C",
      workdir,
      "checkout",
      "-q",
      "-b",
      workBranch,
      ...(continuesRemote ? [`origin/${workBranch}`] : []),
    ]);
  }

  // BUG-EXEC-02: make `git diff origin/<base>...HEAD` computable OFFLINE for re-reviews.
  // The token stays out of .git/config via the one-shot `-c http.extraHeader`, as the
  // clone does. See ensureBaseDiffable for the why.
  if (baseBranch && baseBranch !== branch) {
    await ensureBaseDiffable({
      workdir,
      branch,
      baseBranch,
      authConfigArgs,
    });
  }

  return paths;
}

/**
 * Fetch the PR base branch and enough shared history that `git diff origin/<base>...HEAD`
 * works OFFLINE afterwards. Needed because on a re-review (pull_request.synchronize) the
 * review agent runs token-withheld (single-writer) and cannot fetch, yet the shallow
 * head-only clone has neither the base ref nor a merge-base. This runs while the
 * installation token is still present (`authConfigArgs` carries it).
 *
 * A depth-1 base TIP is NOT enough: two-dot `git diff base HEAD` misattributes base-only
 * commits, and three-dot `git diff base...HEAD` fails "no merge base". So deepen head+base
 * until their merge-base connects (bounded). Best-effort: returns whether the merge-base
 * became reachable — a pathologically old merge-base that never connects falls back to the
 * agent's honest COMMENT (the pre-fix behaviour), it does not fail provisioning.
 *
 * `authConfigArgs` are the `git -c ...` pairs prepended to each fetch (the auth header in
 * prod; empty in tests against a local remote).
 */
export async function ensureBaseDiffable({
  workdir,
  branch,
  baseBranch,
  authConfigArgs,
}: {
  workdir: string;
  branch: string;
  baseBranch: string;
  authConfigArgs: string[];
}): Promise<boolean> {
  const gitFetch = (args: string[]) =>
    gitExec(["-C", workdir, ...authConfigArgs, "fetch", ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
  // Base tip into a remote-tracking ref the agent can diff against.
  await gitFetch([
    "--depth",
    "1",
    "origin",
    `${baseBranch}:refs/remotes/origin/${baseBranch}`,
  ]).catch(() => {});
  for (const depth of [0, 5, 20, 100]) {
    if (depth > 0) {
      await gitFetch([
        "--deepen",
        String(depth),
        "origin",
        branch,
        baseBranch,
      ]).catch(() => {});
    }
    if (await mergeBaseResolves(workdir, baseBranch)) return true;
  }
  return false;
}

/**
 * True when `origin/<baseBranch>` and HEAD share a reachable merge-base in the local
 * (shallow) clone — the precondition for an accurate three-dot `git diff base...HEAD`.
 */
async function mergeBaseResolves(
  workdir: string,
  baseBranch: string,
): Promise<boolean> {
  try {
    await execFileAsync("git", [
      "-C",
      workdir,
      "merge-base",
      `origin/${baseBranch}`,
      "HEAD",
    ]);
    return true;
  } catch {
    return false;
  }
}

export interface CleanupWorkdirOpts {
  /** Where the incomplete-cleanup line goes. */
  log?: (line: string) => void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Remove a run's dir — the clone and the HOME staging and socket dirs beside
 * it. Best-effort — a cleanup failure must not fail the run, so this never
 * throws; but it is not SILENT: a run dir that survives the rm is logged once,
 * with the errno. Resolves true when the run dir is gone.
 *
 * What a run container wrote into the bind-mounted checkout belongs to its
 * mapped uid; the container hands it back to the worker's group before its
 * removal (ContainerDaemonProcess.handBackWorkspace), so the rm here reaches it.
 */
export async function cleanupWorkdir(
  runDir: string,
  opts: CleanupWorkdirOpts = {},
): Promise<boolean> {
  const log = opts.log ?? ((line: string) => console.warn(line));
  let rmError: unknown = null;
  try {
    await fs.rm(runDir, { recursive: true, force: true });
  } catch (e) {
    rmError = e;
  }
  if (!(await fs.lstat(runDir).catch(() => null))) return true;
  const code = (rmError as { code?: unknown } | null)?.code;
  log(
    `workdir cleanup incomplete: ${runDir} (${
      typeof code === "string"
        ? code
        : rmError
          ? errorMessage(rmError)
          : "unknown"
    })`,
  );
  return false;
}

/**
 * The names the worker gives run dirs under the workdir root: the thread id (a
 * Postgres `gen_random_uuid()`), optionally with the tombstone suffix a
 * redelivered attempt renames residue to. Nothing else there is ours to sweep.
 */
const RUN_DIR_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.tombstone-\d+)?$/i;

/** A run dir older than this cannot belong to a live run (see sweepStaleRunDirs). */
export const STALE_RUN_DIR_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Total time the boot sweep may spend. The worker awaits the sweep before it
 * registers, and each hand-back may take up to its own timeout, so the sweep is
 * bounded as a whole: past the budget, or after the first dir that could not be
 * removed, the rest wait for the next boot.
 */
export const SWEEP_BUDGET_MS = 60_000;

export interface SweepStaleRunDirsResult {
  removed: number;
  kept: number;
  failed: number;
  /** Stale dirs left for the next boot (budget spent, or a failure stopped the sweep). */
  deferred: number;
}

/**
 * Boot-time sweep of run dirs earlier teardowns could not remove (a worker died
 * mid-run and never reached its finally). Same rm path as a run's own teardown.
 *
 * WHY AGE ALONE IS SAFE. Every run is hard-capped at 30 minutes, so a dir whose
 * mtime is older than 24h cannot belong to a live run. Only DIRECT children of the root are considered, only
 * real directories (a symlink is never followed or removed) whose name is a run
 * dir name; the root itself is never touched.
 *
 * Never throws: residue is a disk-hygiene problem, a worker that refuses to
 * boot over it is an outage.
 */
export async function sweepStaleRunDirs(opts: {
  workdirRoot: string;
  log: (line: string) => void;
  now?: () => number;
}): Promise<SweepStaleRunDirsResult> {
  const { workdirRoot, log } = opts;
  const now = opts.now ?? Date.now;
  const result: SweepStaleRunDirsResult = {
    removed: 0,
    kept: 0,
    failed: 0,
    deferred: 0,
  };
  const startedAt = now();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(workdirRoot, { withFileTypes: true });
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    // No root yet (a fresh box) is not worth a line; anything else is.
    if (code !== "ENOENT") {
      log(`stale run dirs sweep skipped: ${workdirRoot} (${errorMessage(e)})`);
    }
    return result;
  }
  // Sorted, so which dirs a bounded sweep reaches first is deterministic.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  let stopped = false;
  for (const entry of entries) {
    const target = path.join(workdirRoot, entry.name);
    if (!entry.isDirectory() || !RUN_DIR_NAME_RE.test(entry.name)) {
      result.kept += 1;
      continue;
    }
    const st = await fs.lstat(target).catch(() => null);
    if (!st?.isDirectory() || now() - st.mtimeMs < STALE_RUN_DIR_AGE_MS) {
      result.kept += 1;
      continue;
    }
    if (stopped || now() - startedAt >= SWEEP_BUDGET_MS) {
      result.deferred += 1;
      continue;
    }
    const gone = await cleanupWorkdir(target, { log });
    if (gone) {
      result.removed += 1;
    } else {
      result.failed += 1;
      stopped = true;
    }
  }
  log(
    `stale run dirs swept: removed=${result.removed} kept=${result.kept} failed=${result.failed} deferred=${result.deferred}`,
  );
  return result;
}
