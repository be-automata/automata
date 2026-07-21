import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
}): Promise<string> {
  const workdir = path.join(workdirRoot, runId);
  await fs.rm(workdir, { recursive: true, force: true });
  await fs.mkdir(workdir, { recursive: true });

  const authHeader = `AUTHORIZATION: basic ${Buffer.from(
    `x-access-token:${installationToken}`,
  ).toString("base64")}`;
  const cloneUrl = `https://github.com/${repoFullName}.git`;

  // --depth 1 on the target branch: the working checkout the agent reviews at HEAD.
  await execFileAsync(
    "git",
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
    execFileAsync("git", ["-C", workdir, ...authConfigArgs, "fetch", ...args], {
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
      await gitFetch(["--deepen", String(depth), "origin", branch, baseBranch]).catch(
        () => {},
      );
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
