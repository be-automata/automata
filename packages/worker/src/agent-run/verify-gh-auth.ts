import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
 *
 * HOME is a throwaway dir of the worker's, never the run's (#302). gh writes
 * `~/.local/state/gh/device-id` even for `auth status`, and this check runs as the
 * WORKER uid: in the run HOME it left a worker-owned 0755 `.local` that the agent uid
 * cannot write into, so the agent's `pnpm install` died `EACCES: mkdir
 * <home>/.local/share`. Verified on the execution box. Nothing gh needs here lives in
 * HOME: the token is GH_TOKEN and the config is GH_CONFIG_DIR.
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

export type VerifyGhAuthResult = { ok: true } | { ok: false; detail: string };

export async function verifyGhAuth(
  args: VerifyGhAuthArgs,
): Promise<VerifyGhAuthResult> {
  const exec = args.exec ?? defaultExec;
  // Outside the try: a tmpdir that cannot be written is a box fault, not a
  // "wrong identity" verdict, so it surfaces as its own error.
  const scratchHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "automata-gh-preflight-"),
  );
  try {
    await exec("bash", ["-lc", "gh auth status"], {
      cwd: args.workdir,
      env: { ...args.env, HOME: scratchHome },
      timeout: 10_000,
    });
    return { ok: true };
  } catch (err) {
    const stderr = ((err as { stderr?: unknown }).stderr ?? "") as string;
    const message = err instanceof Error ? err.message : String(err);
    const detail = stderr.trim().length > 0 ? stderr.trim() : message;
    return { ok: false, detail: detail.slice(0, 500) };
  } finally {
    // Residue here is a worker-private dir in the worker's tmpdir; it must not
    // turn a passed check into a failed run.
    await fs.rm(scratchHome, { recursive: true, force: true }).catch((e) => {
      console.warn(
        `[agent-run] gh preflight scratch HOME not removed: ${scratchHome} (${e instanceof Error ? e.message : String(e)})`,
      );
    });
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
