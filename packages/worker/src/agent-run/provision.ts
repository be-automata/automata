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
  installationToken,
  workdirRoot,
  threadChatId,
}: {
  repoFullName: string;
  branch: string;
  installationToken: string;
  workdirRoot: string;
  threadChatId: string;
}): Promise<string> {
  const workdir = path.join(workdirRoot, threadChatId);
  await fs.rm(workdir, { recursive: true, force: true });
  await fs.mkdir(workdir, { recursive: true });

  const authHeader = `AUTHORIZATION: basic ${Buffer.from(
    `x-access-token:${installationToken}`,
  ).toString("base64")}`;
  const cloneUrl = `https://github.com/${repoFullName}.git`;

  // --depth 1 on the target branch: pilot runs need the branch head, not history.
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

  return workdir;
}

/** Remove a run's workdir. Best-effort — a cleanup failure must not fail the run. */
export async function cleanupWorkdir(workdir: string): Promise<void> {
  await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
}
