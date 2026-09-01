/**
 * Fail-closed version floor for node's built-in env-proxy support (#108, A5).
 *
 * `NODE_USE_ENV_PROXY` / `--use-env-proxy` landed in **22.21.0** and **24.0.0**
 * (nodejs CHANGELOG_V22 / CHANGELOG_V24; doc/api/cli.md, Stability 1.1). Node 20
 * does not have it at all and went End-of-Life 2026-04-30; node 23 never got the
 * backport and is likewise EOL.
 *
 * Why this is a HARD boot gate in agent-uid mode: under the PF anchor the agent
 * CLI child has no direct route to 443. The daemon itself no longer depends on
 * the flag (proxy-fetch.ts proxies explicitly), but the CLI child does, and its
 * failure mode is not an error — evidence E1 from the pilot box: with a proxy it
 * cannot reach, `claude -p` produced ZERO output and ZERO stderr for 90 seconds
 * before being killed. A box on the wrong node would therefore turn every run
 * into an unexplainable silent stall. Refusing to boot is the only honest answer.
 */

export const NODE_ENV_PROXY_FLOOR = ">=22.21.0 (22.x) or >=24.0.0";

/** Parse `v22.22.1` / `22.22.1` into [major, minor, patch]. Null if unparseable. */
export function parseNodeVersion(
  raw: string,
): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!m) {
    return null;
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * True iff this version documents NODE_USE_ENV_PROXY. Unparseable input is
 * FALSE (fail closed) — an unknown runtime is not evidence of support.
 */
export function nodeSupportsEnvProxy(raw: string): boolean {
  const parsed = parseNodeVersion(raw);
  if (!parsed) {
    return false;
  }
  const [major, minor] = parsed;
  if (major >= 24) {
    return true;
  }
  // 23.x is EOL and never received the backport — treat it as unsupported.
  if (major === 22) {
    return minor >= 21;
  }
  return false;
}

/**
 * Probe `nodeBin --version` and throw when it is below the floor. `exec` is
 * injectable so the unit suite never runs a binary.
 */
export async function assertNodeBinSupportsEnvProxy(opts: {
  nodeBin: string;
  exec: (file: string, args: string[]) => Promise<{ stdout: string }>;
}): Promise<void> {
  const { nodeBin, exec } = opts;
  let stdout: string;
  try {
    ({ stdout } = await exec(nodeBin, ["--version"]));
  } catch (err) {
    throw new Error(
      `WORKER_AGENT_USER is set but ${nodeBin} --version could not be probed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!nodeSupportsEnvProxy(stdout)) {
    throw new Error(
      `WORKER_AGENT_USER is set but ${nodeBin} reports ${stdout.trim()}, which has no ` +
        `NODE_USE_ENV_PROXY support (floor: ${NODE_ENV_PROXY_FLOOR}). Under the egress ` +
        `anchor the agent CLI child would hang with no output instead of failing. ` +
        `Point WORKER_NODE_BIN at a supported node.`,
    );
  }
}
