import path from "node:path";

import { gitExec } from "../agent-run/provision";

/** Minimal environment for every mirror git call: nothing from process.env but PATH. */
export function hermeticEnv(scratchHome: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: scratchHome,
    LANG: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
  };
}

/** The installation token reaches git only through these env vars of one process. */
export function tokenEnv(token: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: basic ${Buffer.from(
      `x-access-token:${token}`,
    ).toString("base64")}`,
  };
}

export interface RunMirrorGitOptions {
  /** Extra env (the token env for a fetch). Merged over the hermetic env. */
  env?: NodeJS.ProcessEnv;
  /** Scratch HOME; defaults to the git dir's parent `.home`-less path (a dir that holds no config). */
  scratchHome?: string;
  timeout?: number;
  maxBuffer?: number;
  /** Tests only: local fixtures are file:// remotes. Never read from env. */
  allowFileProtocolForTests?: boolean;
}

export async function runMirrorGit(
  gitDir: string,
  args: string[],
  opts: RunMirrorGitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...hermeticEnv(opts.scratchHome ?? path.dirname(gitDir)),
    ...(opts.env ?? {}),
  };
  const result = await gitExec(
    [
      "--git-dir",
      gitDir,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      `protocol.file.allow=${opts.allowFileProtocolForTests ? "always" : "never"}`,
      "-c",
      "color.ui=never",
      "-c",
      "gc.auto=0",
      ...args,
    ],
    {
      env,
      timeout: opts.timeout ?? 120_000,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    },
  );
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}
