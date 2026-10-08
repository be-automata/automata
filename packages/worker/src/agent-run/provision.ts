import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "@terragon/utils/redact";
import {
  applyInheritableAces,
  applyTraverseAce,
  reapplyPathGrant,
  type AceExec,
} from "./agent-uid-fs";
import { runPaths, type RunPaths } from "./run-owned-paths";
import { buildHandBackInvocation, type Invocation } from "./spawn-as-user";

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
  agentUser = "",
  workerLogin = os.userInfo().username,
  aceExec,
  platform,
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
  /**
   * #108: the unix account the agent child runs as. Empty (the default) = no
   * ACLs are touched at all — byte-for-byte today's provisioning.
   */
  agentUser?: string;
  /**
   * The worker's own login, granted alongside the agent so it can still delete
   * agent-created files at cleanup. Defaults to the current user; injectable
   * for tests.
   */
  workerLogin?: string;
  /** Injectable ACE runner (tests only). */
  aceExec?: AceExec;
  /** Injectable platform for the ACL calls (tests only) — defaults to the host's. */
  platform?: NodeJS.Platform;
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

  await fs.mkdir(runDir, { recursive: true });

  // #108: open THIS run's dir to the agent uid, and the shared root by traverse
  // ONLY (namei needs search on every component; an inheritable ACE on the root
  // would expose every OTHER run's credentials to the same uid).
  //
  // ORDERING IS A CORRECTNESS CONSTRAINT, not a style choice: macOS applies
  // inheritance at create time, so anything cloned BEFORE this call would not
  // carry the grant. It must precede the clone.
  if (agentUser) {
    await applyTraverseAce({
      dir: workdirRoot,
      users: [agentUser],
      exec: aceExec,
      platform,
    });
    // BOTH users, exactly as claimRunNamespace does for the rendezvous dir
    // (agent-uid-fs.ts). Granting the agent alone is not enough: every
    // directory the AGENT creates inside the run is owned by the agent uid, and
    // deleting a file needs write on its containing directory — so the worker
    // (uid 501) could not remove them and cleanupWorkdir failed with EACCES.
    // The run's HOME then SURVIVES the run, carrying whatever credential was
    // delivered into it — the precise residue a per-run HOME exists to prevent.
    // Observed on the pilot box: `.claude/projects/...` left undeletable after
    // an otherwise-successful review run.
    await applyInheritableAces({
      dir: runDir,
      users: [agentUser, workerLogin],
      exec: aceExec,
      platform,
    });
  }

  // The clone goes in `<runDir>/repo`, beside the run's HOME, gh-config and
  // tmp (#302). Created HERE, not by `git clone`: under the run dir's default
  // ACL a directory's POSIX mask comes from its creation mode, and git creates
  // the destination 0755 — `r-x` would deny the agent writes at the repo root.
  // mkdir's default 0777 keeps the mask `rwx`, exactly as the run dir had it
  // when it was the clone. git clone accepts an existing EMPTY destination.
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

  // The run's own TMPDIR — the operator's /var/folders/<...>/T is 0700 and
  // untraversable by the agent uid.
  //
  // AFTER the clone, and this ordering is load-bearing in the opposite
  // direction to the ACEs above: `git clone` REFUSES a destination that exists
  // and is non-empty ("fatal: destination path ... already exists and is not an
  // empty directory"), so creating this beforehand broke EVERY agent-uid run at
  // provisioning. Found on the pilot box, not in CI — the unit tests inject a
  // fake `runGit`, so the real emptiness rule was never exercised.
  //
  // Creating it here still inherits the ACE: macOS applies inheritance at
  // create time, and the grant is already on the run dir.
  if (agentUser) {
    const tmp = paths.tmp;
    await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
    // LINUX: the 0700 creation mode zeroes the POSIX ACL mask, so the grant
    // inherited from the run dir's default ACL is born `#effective:---` and
    // the agent cannot use its own TMPDIR. Same trap, same remedy as the run
    // HOME (agent-credentials.ts) and gh-config. No-op on macOS.
    await reapplyPathGrant({
      target: tmp,
      kind: "directory",
      users: [agentUser],
      exec: aceExec,
      platform,
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

/** How the hand-back process ended. `stderrTail` is its last ≤ 200 chars. */
export interface HandBackExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail?: string;
}

/** Runs one agent-uid invocation to completion; rejects only when it cannot start. */
export type RunAsAgent = (inv: Invocation) => Promise<HandBackExit>;

/**
 * Bound on the hand-back. It walks only the run's own tree and chmods only the
 * agent's inodes, so seconds is the norm; a hung sudo/PAM hop must not hold the
 * run's finally (and with it the box lock) open.
 */
const HAND_BACK_TIMEOUT_MS = 30_000;
const HAND_BACK_STDERR_TAIL_CHARS = 200;

/** The default runner: execFile, bounded, SIGKILLed on expiry. */
const runAsAgentViaSudo: RunAsAgent = async (inv) => {
  try {
    await execFileAsync(inv.file, inv.args, {
      timeout: HAND_BACK_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, signal: null };
  } catch (error) {
    const e = error as { code?: unknown; signal?: unknown; stderr?: unknown };
    // A string code (ENOENT, EACCES) is a spawn failure: nothing ran.
    if (typeof e.code === "string") throw error;
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    return {
      code: typeof e.code === "number" ? e.code : null,
      signal:
        typeof e.signal === "string" ? (e.signal as NodeJS.Signals) : null,
      stderrTail: stderr.slice(-HAND_BACK_STDERR_TAIL_CHARS),
    };
  }
};

export interface CleanupWorkdirOpts {
  /** #108: the agent account. Empty (the default) ⇒ no hand-back, rm only. */
  agentUser?: string;
  /** Where the hand-back failure / incomplete-cleanup lines go. */
  log?: (line: string) => void;
  /** Injectable platform (tests only) — defaults to the host's. */
  platform?: NodeJS.Platform;
  /** Injectable agent-uid runner (tests only) — defaults to bounded sudo. */
  runAsAgent?: RunAsAgent;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Agent-uid mode on Linux: chmod every agent-owned inode under `workdir` back
 * into the worker's reach (see HAND_BACK_SCRIPT for the ACL-mask mechanism).
 * Never throws — a failure is logged and the rm that follows reports whatever
 * it then could not remove. No-op without an agent user, off Linux (a macOS
 * allow-ACE survives a 0700/0600 creation mode), or when the dir is gone.
 */
async function handBackAgentFiles(
  workdir: string,
  opts: CleanupWorkdirOpts,
  log: (line: string) => void,
): Promise<void> {
  const agentUser = opts.agentUser ?? "";
  const platform = opts.platform ?? process.platform;
  if (!agentUser || platform !== "linux") return;
  if (!(await fs.lstat(workdir).catch(() => null))) return;
  try {
    const inv = buildHandBackInvocation({ agentUser, workdir });
    if (!inv) return;
    const exit = await (opts.runAsAgent ?? runAsAgentViaSudo)(inv);
    if (exit.code !== 0) {
      log(
        `workdir hand-back incomplete: ${workdir} (exit ${String(exit.code)}${
          exit.signal ? ` ${exit.signal}` : ""
        }${exit.stderrTail ? `: ${exit.stderrTail}` : ""})`,
      );
    }
  } catch (e) {
    log(`workdir hand-back failed: ${workdir} (${errorMessage(e)})`);
  }
}

/**
 * Remove a run's dir — the clone and the HOME, gh-config and tmp beside it.
 * Best-effort — a cleanup failure must not fail the run, so this never throws;
 * but it is no longer SILENT: a run dir that survives the rm is logged once,
 * with the errno. Resolves true when the run dir is gone.
 *
 * In agent-uid mode on Linux the agent first hands its files back (see
 * HAND_BACK_SCRIPT). Without that step every run's HOME — session keys
 * included — outlived the run, and the swallowed EACCES hid it for a week.
 */
export async function cleanupWorkdir(
  runDir: string,
  opts: CleanupWorkdirOpts = {},
): Promise<boolean> {
  const log = opts.log ?? ((line: string) => console.warn(line));
  await handBackAgentFiles(runDir, opts, log);
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
 * removed (a hung sudo/PAM, a broken grant), the rest wait for the next boot.
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
 * Boot-time sweep of run dirs earlier teardowns could not remove (the hand-back
 * above did not exist yet, or a worker died mid-run and never reached its
 * finally). Same hand-back + rm path as a run's own teardown.
 *
 * WHY AGE ALONE IS SAFE. The box runs one agent at a time and every run is
 * hard-capped at 30 minutes, so a dir whose mtime is older than 24h cannot
 * belong to a live run. Only DIRECT children of the root are considered, only
 * real directories (a symlink is never followed or removed) whose name is a run
 * dir name; the root itself is never touched.
 *
 * Never throws: residue is a disk-hygiene problem, a worker that refuses to
 * boot over it is an outage.
 */
export async function sweepStaleRunDirs(opts: {
  workdirRoot: string;
  agentUser: string;
  log: (line: string) => void;
  now?: () => number;
  platform?: NodeJS.Platform;
  runAsAgent?: RunAsAgent;
}): Promise<SweepStaleRunDirsResult> {
  const { workdirRoot, agentUser, log, platform, runAsAgent } = opts;
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
    const gone = await cleanupWorkdir(target, {
      agentUser,
      log,
      platform,
      runAsAgent,
    });
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
