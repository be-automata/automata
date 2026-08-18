import fs from "node:fs/promises";
import path from "node:path";
import type { PulledAgentCredentials } from "./www-client";

/**
 * Materialises a run's agent provider credential on the execution box (D1).
 *
 * The agent CLIs authenticate off a file in $HOME (Claude reads
 * ~/.claude/.credentials.json; packages/daemon/src/claude.ts probes exactly that
 * path via `cd && test -f ...`). In a sandbox that HOME belongs to the run. On a
 * worker box it does NOT: daemon-env.ts forwards the operator's ambient HOME, so
 * writing there would (a) collide between concurrent runs, (b) overwrite the
 * operator's own Claude login, and (c) leave one tenant's token readable by the
 * next run. So delivery ALWAYS comes with a per-run HOME — never the box's.
 *
 * Nothing here is written for a "shared" box; the caller decides that (config
 * boxTrust) and simply does not call this.
 */

/** Where each agent's credential file lives, relative to the run HOME. */
const CREDENTIAL_FILE_BY_AGENT: Record<string, string> = {
  claudeCode: ".claude/.credentials.json",
  codex: ".codex/auth.json",
};

export interface MaterialisedCredentials {
  /** HOME for the child process. Always a fresh per-run dir when set. */
  home: string | null;
  /** Extra env the credential needs (Amp's API key). Never logged. */
  env: Record<string, string>;
  /** Remove every credential byte this wrote. Safe to call twice. */
  cleanup: () => Promise<void>;
}

const NOOP: MaterialisedCredentials = {
  home: null,
  env: {},
  cleanup: async () => {},
};

/**
 * Write the credential into a per-run HOME under `runRoot`.
 *
 * `agent` picks the file path; an agent we have no path for degrades to
 * built-in-credits rather than guessing a location.
 */
export async function materialiseAgentCredentials({
  credentials,
  agent,
  runRoot,
}: {
  credentials: PulledAgentCredentials;
  agent: string;
  runRoot: string;
}): Promise<MaterialisedCredentials> {
  if (credentials.type === "built-in-credits") {
    return NOOP;
  }
  if (credentials.type === "env-var") {
    // No file, no HOME override needed — but still nothing to clean up on disk.
    return { home: null, env: { [credentials.key]: credentials.value }, cleanup: async () => {} };
  }

  const relativePath = CREDENTIAL_FILE_BY_AGENT[agent];
  if (!relativePath) {
    console.warn("[agent-run] no credential file path for agent, using credits", {
      agent,
    });
    return NOOP;
  }

  const home = path.join(runRoot, "home");
  const target = path.join(home, relativePath);
  // 0700 on the directories: the credential must not be world- or group-readable
  // even for the instant before the file's own mode is applied.
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, credentials.contents, { mode: 0o600 });
  // writeFile only honours `mode` when it CREATES the file; an existing file
  // (retry into the same run dir) keeps its old mode, so set it explicitly.
  await fs.chmod(target, 0o600);

  return {
    home,
    env: {},
    cleanup: async () => {
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    },
  };
}
