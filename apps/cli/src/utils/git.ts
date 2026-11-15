import { execFile as execFileCallback } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCallback);

// Characters allowed in a branch name we hand to git. Stricter than git's own
// rules (which `check-ref-format` enforces on top of this) so the name stays a
// plain token wherever it is displayed or reused.
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/+-]+$/;

export interface RunGitOptions {
  cwd?: string;
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
}

export class InvalidBranchNameError extends Error {
  constructor(branchName: string) {
    super(`Invalid branch name: ${JSON.stringify(branchName)}`);
    this.name = "InvalidBranchNameError";
  }
}

/**
 * Runs git with the given arguments, each passed to the process as its own
 * argument (no shell is involved).
 */
export async function runGit(
  args: string[],
  opts: RunGitOptions = {},
): Promise<RunGitResult> {
  const { stdout, stderr } = await execFile("git", args, {
    cwd: opts.cwd,
    encoding: "utf8",
  });
  return { stdout, stderr };
}

/**
 * Whether `name` is a local branch (a tag or commit with that name does not
 * count).
 */
export async function localBranchExists(
  name: string,
  opts: RunGitOptions = {},
): Promise<boolean> {
  try {
    await runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
      opts,
    );
    return true;
  } catch (err) {
    // show-ref exits 1 when the ref is missing; anything else is a real error.
    if (err instanceof Error && (err as { code?: unknown }).code === 1) {
      return false;
    }
    throw err;
  }
}

/**
 * Throws InvalidBranchNameError unless `name` is a valid git branch name made
 * only of [A-Za-z0-9._/+-] that cannot be read as a command-line option.
 */
export async function assertSafeBranchName(name: string): Promise<void> {
  if (!name || name.startsWith("-") || !BRANCH_NAME_PATTERN.test(name)) {
    throw new InvalidBranchNameError(name);
  }
  try {
    await runGit(["check-ref-format", "--branch", name]);
  } catch (err) {
    // A non-zero git exit carries a numeric code; spawn failures (e.g. git
    // missing from PATH) carry a string code and are rethrown unchanged.
    if (
      err instanceof Error &&
      typeof (err as { code?: unknown }).code === "number"
    ) {
      throw new InvalidBranchNameError(name);
    }
    throw err;
  }
}
