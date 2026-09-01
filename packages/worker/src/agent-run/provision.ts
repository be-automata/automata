import { execFile } from "node:child_process";
import fs from "node:fs/promises";
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
  /** Injectable ACE runner (tests only). */
  aceExec?: AceExec;
  /** Injectable git runner (tests only) — defaults to the real gitExec. */
  runGit?: typeof gitExec;
}): Promise<string> {
  const workdir = path.join(workdirRoot, runId);
  await fs.rm(workdir, { recursive: true, force: true });
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
    await applyInheritableAces({
      dir: workdir,
      users: [agentUser],
      exec: aceExec,
    });
    // The run's own TMPDIR, inheriting the grant above. The operator's
    // /var/folders/<...>/T is 0700 and untraversable by the agent uid.
    await fs.mkdir(path.join(workdir, "tmp"), { recursive: true, mode: 0o700 });
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
