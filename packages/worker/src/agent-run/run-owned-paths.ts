import path from "node:path";

/**
 * The layout of one run's directory, `<workdirRoot>/<runId>/`:
 *
 *   repo/       the clone — the agent's cwd
 *   home/       per-run HOME (agent-credentials.ts) — carries the credential
 *   gh-config/  agent-uid gh config dir (daemon-process.ts createGhConfigDir)
 *   tmp/        agent-uid TMPDIR (provision.ts)
 *   fix-check/  self-heal fix-check scratch HOME/TMPDIR (self-heal-fix-check.ts)
 *
 * The worker's dirs sit BESIDE the clone, never in it (#302). Nested inside
 * the checkout they were git-excluded, but every tool that walks `.` without
 * reading git's ignore rules still found them: a repo's pre-push `eslint .`
 * walked into `home/.cache`, ran out of memory, and reported 1146 errors that
 * were all the run's own HOME — so the agent pushed with `--no-verify`.
 *
 * They still inherit the per-run grant: provisioning puts it on the run dir,
 * the common parent of all of them. The names are defined once, here.
 */
const RUN_REPO_DIR = "repo";
const RUN_HOME_DIR = "home";
const RUN_GH_CONFIG_DIR = "gh-config";
const RUN_TMP_DIR = "tmp";
const RUN_FIX_CHECK_DIR = "fix-check";

export interface RunPaths {
  /** `<workdirRoot>/<runId>` — what cleanup removes and the grant sits on. */
  runDir: string;
  /** The clone. */
  repo: string;
  home: string;
  ghConfig: string;
  tmp: string;
  fixCheck: string;
}

export function runPaths(runDir: string): RunPaths {
  return {
    runDir,
    repo: path.join(runDir, RUN_REPO_DIR),
    home: path.join(runDir, RUN_HOME_DIR),
    ghConfig: path.join(runDir, RUN_GH_CONFIG_DIR),
    tmp: path.join(runDir, RUN_TMP_DIR),
    fixCheck: path.join(runDir, RUN_FIX_CHECK_DIR),
  };
}

/** The run paths of a clone provisionWorkdir made (`<runDir>/repo`). */
export function runPathsForRepo(repo: string): RunPaths {
  return runPaths(path.dirname(repo));
}
