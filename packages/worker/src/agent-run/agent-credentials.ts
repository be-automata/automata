import fs from "node:fs/promises";
import path from "node:path";
import { authFilePathForAgent } from "@terragon/agent/auth-file";
import type { PulledAgentCredentials } from "./www-client";
import { reapplyPathGrant } from "./agent-uid-fs";
import {
  seedBatteries,
  type SeedBatteriesOptions,
  type SeedBatteriesResult,
} from "./batteries-seed";
import type { BatterySeed } from "./task-agent";

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

export interface MaterialisedCredentials {
  /** HOME for the child process. Always a fresh, trust-seeded per-run dir. */
  home: string;
  /** Whether a provider credential was actually written / injected. */
  delivered: boolean;
  /** Extra env the credential needs (Amp's API key). Never logged. */
  env: Record<string, string>;
  /** Remove every credential byte this wrote. Safe to call twice. */
  cleanup: () => Promise<void>;
  /** Battery seeding outcome — present ONLY for orchestrated review runs and task runs with packs. */
  batteries?: SeedBatteriesResult;
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
  agentUser,
  home,
  workdir,
}: {
  home: string;
  workdir: string;
  /** Role account the agent runs as; empty/absent = agent-uid mode off. */
  agentUser?: string;
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
  const trustFile = path.join(home, ".claude.json");
  await fs.writeFile(trustFile, JSON.stringify(config), {
    mode: 0o600,
  });
  // LINUX ONLY. `mode: 0o600` at CREATION is by itself enough to zero the POSIX
  // ACL mask — no chmod needed — so the agent's grant on this file is born dead
  // and the CLI reports an untrusted workspace, which ends the run in seconds
  // with no output. No-op on macOS. See reapplyFileGrant.
  await reapplyPathGrant({
    target: trustFile,
    kind: "file",
    users: agentUser ? [agentUser] : [],
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
 * `seed` (built by the caller with batterySeedForRun) links battery packs
 * into this HOME through seedBatteries:
 * - ORCHESTRATED review runs (D2): the selected packs plus a hooks-off
 *   `settings.json` at the user layer (`hooksOff: true`). Safe because the
 *   review argv keeps `--setting-sources user`, so the PR's own project
 *   `.claude/` and `.mcp.json` never load (02-FINDINGS Q3).
 * - TASK runs (Phase 7) with admin-selected packs (already shape-gated by
 *   taskAgentForRun): the same fences with `hooksOff: false` — no
 *   settings.json, so the task lane's hook semantics are unchanged.
 * No seed (classic reviews, runs without task packs): HOME exactly as before.
 */
export async function materialiseAgentCredentials({
  credentials,
  agent,
  runRoot,
  agentUser,
  seed,
  batteries,
}: {
  credentials: PulledAgentCredentials;
  agent: string;
  runRoot: string;
  /**
   * The dedicated role account the agent child runs as, when agent-uid mode is
   * on. Empty/absent = default-off, and every grant below is a no-op.
   */
  agentUser?: string;
  /** The packs to seed and whether hooks go off; absent = no seeding. */
  seed?: BatterySeed;
  /** Test/override seam for seedBatteries; production passes only `log`. */
  batteries?: Omit<SeedBatteriesOptions, "agentUser">;
}): Promise<MaterialisedCredentials> {
  const home = path.join(runRoot, "home");
  const users = agentUser ? [agentUser] : [];
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  // 0700 at creation zeroes the POSIX ACL mask on Linux, so the agent cannot
  // TRAVERSE its own HOME — and then every grant on the files inside is moot.
  // Restore the access entry; the inherited default ACL is untouched by mode.
  await reapplyPathGrant({ target: home, kind: "directory", users });
  await seedWorkspaceTrust({ home, workdir: runRoot, agentUser });
  // seedBatteries creates and grants `<home>/.claude` in both modes, so the
  // credential write below does not repeat that.
  const seeded = seed
    ? await seedBatteries(home, seed.batteries, {
        ...batteries,
        log: batteries?.log ?? console.log,
        agentUser,
        hooksOff: seed.hooksOff,
      })
    : undefined;
  const cleanup = async () => {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  };
  const base: MaterialisedCredentials = {
    home,
    delivered: false,
    env: {},
    cleanup,
    batteries: seeded,
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
  const credentialDir = path.dirname(target);
  if (!(seeded && credentialDir === path.join(home, ".claude"))) {
    // 0700 on the directories: the credential must not be world- or
    // group-readable even for the instant before the file's own mode is
    // applied.
    await fs.mkdir(credentialDir, { recursive: true, mode: 0o700 });
    // Same 0700 mask trap one level down (e.g. `<home>/.claude`).
    await reapplyPathGrant({ target: credentialDir, kind: "directory", users });
  }
  await fs.writeFile(target, credentials.contents, { mode: 0o600 });
  // writeFile only honours `mode` when it CREATES the file; an existing file
  // (retry into the same run dir) keeps its old mode, so set it explicitly.
  await fs.chmod(target, 0o600);
  // LINUX ONLY, AND LOAD-BEARING: both lines above land the group-class bits at
  // zero, and on Linux those bits ARE the POSIX ACL mask — so each one on its
  // own is enough to zero the agent's grant on this exact file while `getfacl`
  // still lists the entry. Without this the agent cannot read the credential it
  // was just handed, and the run dies in seconds with no output. No-op on macOS,
  // where an ACE survives chmod. See reapplyFileGrant.
  await reapplyPathGrant({ target, kind: "file", users });

  return { ...base, delivered: true };
}
