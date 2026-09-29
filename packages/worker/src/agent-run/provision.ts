import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  applyInheritableAces,
  applyTraverseAce,
  type AceExec,
} from "./agent-uid-fs";
import { redactSecrets } from "./redact";

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
  opts: { maxBuffer?: number } = {},
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
 * the header form does not. Returns the absolute workdir path.
 */
export async function provisionWorkdir({
  repoFullName,
  branch,
  baseBranch,
  installationToken,
  workdirRoot,
  runId,
  agentUser = "",
  workerLogin = os.userInfo().username,
  aceExec,
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
  /** Injectable git runner (tests only) — defaults to the real gitExec. */
  runGit?: typeof gitExec;
}): Promise<string> {
  const workdir = path.join(workdirRoot, runId);

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
  const stale = await fs.stat(workdir).catch(() => null);
  if (stale) {
    const tombstone = `${workdir}${TOMBSTONE_SUFFIX}${Date.now()}`;
    try {
      await fs.rename(workdir, tombstone);
      await fs.rm(tombstone, { recursive: true, force: true }).catch(() => {});
    } catch {
      // The rename itself can fail where the stale directory is unwritable:
      // macOS updates `..` on a directory rename, so it needs write on the
      // directory being MOVED, not just on its parent. That is a permissions
      // problem, not the redelivery race this guards, and it deserves to
      // surface with its own error rather than be papered over — so fall back
      // to the original in-place removal and let it throw.
      await fs.rm(workdir, { recursive: true, force: true });
    }
  }
  await sweepTombstones(workdirRoot);

  await fs.mkdir(workdir, { recursive: true });

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
      dir: workdir,
      users: [agentUser, workerLogin],
      exec: aceExec,
    });
  }

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

  // BUG-EXEC-02: make `git diff origin/<base>...HEAD` computable OFFLINE for re-reviews.
  // The token stays out of .git/config via the one-shot `-c http.extraHeader`, as the
  // clone does. See ensureBaseDiffable for the why.
  if (baseBranch && baseBranch !== branch) {
    await ensureBaseDiffable({
      workdir,
      branch,
      baseBranch,
      authConfigArgs: ["-c", `http.extraHeader=${authHeader}`],
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
  // create time, and the grant is already on `workdir`.
  if (agentUser) {
    await fs.mkdir(path.join(workdir, "tmp"), { recursive: true, mode: 0o700 });
  }

  return workdir;
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

/** Remove a run's workdir. Best-effort — a cleanup failure must not fail the run. */
export async function cleanupWorkdir(workdir: string): Promise<void> {
  await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
}
