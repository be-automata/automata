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
  /** HOME for the child process. Always a fresh, trust-seeded per-run dir. */
  home: string;
  /** Whether a provider credential was actually written / injected. */
  delivered: boolean;
  /** Extra env the credential needs (Amp's API key). Never logged. */
  env: Record<string, string>;
  /** Remove every credential byte this wrote. Safe to call twice. */
  cleanup: () => Promise<void>;
}

/**
 * Mark the run's clone as a trusted workspace inside its own HOME.
 *
 * A fresh HOME has no `~/.claude.json`, so the agent CLI treats the workdir as
 * untrusted: it ignores `.claude/settings.json` permission entries and, in
 * `--permission-mode default`, has no way to grant a tool. REVIEW runs are the
 * only ones that use that mode — deliberately, so the agent has no GitHub-write
 * outlet (packages/daemon/src/claude.ts) — while every other run passes
 * `--dangerously-skip-permissions` and never notices. That asymmetry is why
 * giving every run a fresh HOME killed reviews and nothing else: the runs died
 * in seconds with no output at all, and the control plane could only report
 * "review intent could not be parsed".
 *
 * The CLI names this remedy in its own error text: set
 * `projects["<workdir>"].hasTrustDialogAccepted`. Trust is scoped to THIS run's
 * clone, so it grants nothing beyond the directory the run already owns.
 *
 * SECURITY — hooks are NOT gated by this seed. A repo's own
 * `.claude/settings.json` hooks (arbitrary shell wired to lifecycle events)
 * execute in `-p` mode WHETHER OR NOT the workspace is trusted — verified
 * empirically on Claude Code 2.1.235: a SessionStart hook in a scratch repo
 * fired under a seeded HOME and under a completely unseeded one, both times
 * before auth (zero API calls, "Not logged in"). The trust seed therefore adds
 * no hook exposure, and scoping it away from review runs would break them
 * while mitigating nothing. Repo-controlled hook execution is a pre-existing
 * property of running the agent CLI over a checkout at all; box-level
 * mitigation (e.g. the CLI's `--bare`, which skips hooks) is a separate,
 * run-mode-level decision tracked outside this module.
 */
async function seedWorkspaceTrust({
  home,
  workdir,
}: {
  home: string;
  workdir: string;
}): Promise<void> {
  // The CLI keys trust by the RESOLVED cwd. On macOS os.tmpdir() returns
  // /var/folders/…, a symlink to /private/var/folders/…, so seeding the
  // symlinked spelling misses: the agent still printed "this workspace has not
  // been trusted" with the /private path, made zero API calls and exited 1.
  // Seed both spellings — the realpath is the one that matters, the raw one is
  // insurance against a CLI that does not resolve.
  const resolved = await fs.realpath(workdir).catch(() => workdir);
  const trust = {
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  const config = {
    hasCompletedOnboarding: true,
    projects: {
      [workdir]: trust,
      [resolved]: trust,
    },
  };
  await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify(config), {
    mode: 0o600,
  });
}

/**
 * Give EVERY run a fresh HOME under `runRoot`, seeded as a trusted workspace,
 * and write the run's credential into it when it has one.
 *
 * Called unconditionally for every run (see workflow.ts). A run with no
 * credential to deliver (`credentials.type === "built-in-credits"`, i.e. the
 * proxy/box-key paths) still gets the fresh HOME and trust seed — it just has
 * nothing written into it (`delivered: false`).
 *
 * The fresh HOME is what makes "this run uses its own credential" true: on macOS
 * the CLI keeps OAuth in the login Keychain, so a run on the operator's HOME can
 * authenticate as the OPERATOR. The trust seed is equally load-bearing: an
 * unseeded HOME makes review runs hang on a permission they cannot prompt for.
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
  const home = path.join(runRoot, "home");
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await seedWorkspaceTrust({ home, workdir: runRoot });
  const cleanup = async () => {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  };
  const empty: MaterialisedCredentials = {
    home,
    delivered: false,
    env: {},
    cleanup,
  };

  if (credentials.type === "built-in-credits") {
    return empty;
  }
  if (credentials.type === "env-var") {
    return {
      home,
      delivered: true,
      env: { [credentials.key]: credentials.value },
      cleanup,
    };
  }

  const relativePath = CREDENTIAL_FILE_BY_AGENT[agent];
  if (!relativePath) {
    console.warn(
      "[agent-run] no credential file path for agent, using credits",
      {
        agent,
      },
    );
    return empty;
  }

  const target = path.join(home, relativePath);
  // 0700 on the directories: the credential must not be world- or group-readable
  // even for the instant before the file's own mode is applied.
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, credentials.contents, { mode: 0o600 });
  // writeFile only honours `mode` when it CREATES the file; an existing file
  // (retry into the same run dir) keeps its old mode, so set it explicitly.
  await fs.chmod(target, 0o600);

  return { home, delivered: true, env: {}, cleanup };
}
