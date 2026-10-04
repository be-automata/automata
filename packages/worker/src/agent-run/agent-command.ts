import { spawn as nodeSpawn } from "node:child_process";

import { assertAgentUser, SH_BIN, SUDO_BIN } from "./spawn-as-user";

export interface AgentCommandResult {
  /** null when the child was killed (timeout, abort) or could not start. */
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  truncated: boolean;
}

interface ChildLike {
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): unknown } | null;
  on(event: "close", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (
  file: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: Array<"ignore" | "pipe">;
  },
) => ChildLike;

interface RunAsAgentArgs {
  /** "" (dev) runs /bin/sh directly; otherwise sudo -n -u <agentUser>. */
  agentUser: string;
  cwd: string;
  /** A module-constant script. Never built from agent-derived text. */
  script: string;
  /** Positional arguments ($1..). Agent-derived values go here, only here. */
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  spawn?: SpawnLike;
}

export type RunAsAgent = (args: RunAsAgentArgs) => Promise<AgentCommandResult>;

const DEFAULT_MAX_STDOUT_BYTES = 2_000_000;

/**
 * Run a constant `/bin/sh -c <script> sh ...args` as the agent uid. The script
 * is never interpolated with caller data; values travel as positional args so
 * a hostile subject stays one argv element. stderr is discarded (a check must
 * never leak secrets into logs). Never `bash -lc`: noisy login shells.
 */
export const runAsAgent: RunAsAgent = async (opts) => {
  const maxStdoutBytes = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const spawnFn: SpawnLike =
    opts.spawn ?? ((file, args, o) => nodeSpawn(file, args, o) as ChildLike);

  let file: string;
  let argv: string[];
  if (opts.agentUser === "") {
    file = SH_BIN;
    argv = ["-c", opts.script, "sh", ...opts.args];
  } else {
    assertAgentUser(opts.agentUser);
    file = SUDO_BIN;
    argv = [
      "-n",
      "-u",
      opts.agentUser,
      "-E",
      "--",
      SH_BIN,
      "-c",
      opts.script,
      "sh",
      ...opts.args,
    ];
  }

  return new Promise<AgentCommandResult>((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let killed = false;
    let settled = false;

    const child = spawnFn(file, argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "ignore"],
    });

    const kill = () => {
      killed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: killed ? null : exitCode,
        stdout: Buffer.concat(chunks).toString("utf8"),
        timedOut,
        truncated,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const room = maxStdoutBytes - bytes;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        bytes += room;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.on("close", (code) => finish(code));
    child.on("error", () => finish(null));
  });
};
