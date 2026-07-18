import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Fail-closed `gh auth status` precondition (ported from orch-agents
 * src/execution/verify-worktree-gh-auth.ts). Run in the run's workdir with the
 * SANITIZED daemon env BEFORE spawning the agent: if gh cannot confirm it is
 * authenticated (misconfigured box, missing gh, network failure), BLOCK the run
 * rather than let the agent silently post as the wrong identity — or fail to push.
 *
 * Run through `bash -lc` (not execFile('gh', …)) on purpose: the daemon spawns the
 * agent CLI via a LOGIN shell, so a box profile that re-exports GH_TOKEN would clobber
 * our injected token. Running the check the same way surfaces that here instead of at
 * runtime. The exec runner is injected so tests drive both paths without a real shell.
 */

export interface VerifyGhAuthArgs {
  workdir: string;
  /** The sanitized child env (buildDaemonEnv output) — must carry the bot GH_TOKEN. */
  env: NodeJS.ProcessEnv;
  exec?: (
    command: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

export type VerifyGhAuthResult =
  | { ok: true }
  | { ok: false; detail: string };

export async function verifyGhAuth(
  args: VerifyGhAuthArgs,
): Promise<VerifyGhAuthResult> {
  const exec = args.exec ?? defaultExec;
  try {
    await exec("bash", ["-lc", "gh auth status"], {
      cwd: args.workdir,
      env: args.env,
      timeout: 10_000,
    });
    return { ok: true };
  } catch (err) {
    const stderr = ((err as { stderr?: unknown }).stderr ?? "") as string;
    const message = err instanceof Error ? err.message : String(err);
    const detail = stderr.trim().length > 0 ? stderr.trim() : message;
    return { ok: false, detail: detail.slice(0, 500) };
  }
}

async function defaultExec(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeout,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
