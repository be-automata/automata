import fs from "node:fs/promises";
import path from "node:path";
import { authFilePathForAgent } from "@terragon/agent/auth-file";
import { CONTAINER_WORKSPACE } from "./container-argv";
import type { PulledAgentCredentials } from "./www-client";
import type { RunPaths } from "./run-owned-paths";

/**
 * Materialises a run's agent provider credential on the execution box (D1),
 * into the run's HOME STAGING dir: ContainerDaemonProcess copies that dir into
 * the run container's HOME volume before it starts (ADR-013 Decision 4), then
 * the staging dir goes with the run dir.
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
 *
 * THE ONLY WRITER of `~/.claude.json` (it overwrites). The clone is always at
 * `/workspace` in the container, so one key covers it (no realpath spelling).
 */
async function seedWorkspaceTrust({
  home,
  workdir,
}: {
  home: string;
  workdir: string;
}): Promise<void> {
  const trust = {
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  const config = {
    hasCompletedOnboarding: true,
    projects: { [workdir]: trust },
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
 * `agent` picks the file path via `authFilePathForAgent`
 * (`@terragon/agent/auth-file` — the shared source of truth for both this
 * worker and the daemon's per-agent adapters, #77); an agent we have no path
 * for degrades to built-in-credits rather than guessing a location.
 *
 * The batteries are image contents (ADR-013): nothing is linked here, and the
 * run's settings (deny rules, the foreground-only guard, the lane's share of
 * the image's hooks) are composed per lane at copy-in (container-policy.ts).
 */
export async function materialiseAgentCredentials({
  credentials,
  agent,
  run,
  trustWorkdir = CONTAINER_WORKSPACE,
}: {
  credentials: PulledAgentCredentials;
  agent: string;
  /** The run's paths: the HOME is created at `home`, `repo` is marked trusted. */
  run: RunPaths;
  /** The path the agent sees its clone at (default `/workspace`, ADR-013). */
  trustWorkdir?: string;
}): Promise<MaterialisedCredentials> {
  const home = run.home;
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await seedWorkspaceTrust({ home, workdir: trustWorkdir });
  const cleanup = async () => {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  };
  const base: MaterialisedCredentials = {
    home,
    delivered: false,
    env: {},
    cleanup,
  };

  if (credentials.type === "built-in-credits") {
    return base;
  }
  if (credentials.type === "env-var") {
    return {
      ...base,
      delivered: true,
      env: { [credentials.key]: credentials.value },
    };
  }

  const relativePath = authFilePathForAgent(agent);
  if (!relativePath) {
    console.warn(
      "[agent-run] no credential file path for agent, using credits",
      {
        agent,
      },
    );
    return base;
  }

  const target = path.join(home, relativePath);
  // 0700 on the directories: the credential must not be world- or
  // group-readable even for the instant before the file's own mode is applied.
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, credentials.contents, { mode: 0o600 });
  // writeFile only honours `mode` when it CREATES the file; an existing file
  // (retry into the same run dir) keeps its old mode, so set it explicitly.
  await fs.chmod(target, 0o600);

  return { ...base, delivered: true };
}
