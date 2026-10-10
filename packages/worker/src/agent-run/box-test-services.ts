import fs from "node:fs";

import type { RunLane } from "./run-lane";
import type { AgentRunInput } from "./types";

/**
 * Where install-test-postgres.sh writes the box's test-service URLs
 * (root:<worker group> 0640). The values are SECRET: never logged.
 *
 * Self-heal runs never get these. Their check envs are built separately
 * (workflow.ts runSelfHealAuditStep and the fix-check step), and the fix
 * agent's own env comes through DaemonProcess like any run; enabling self-heal
 * means changing all three builders together, or a fix would pass its agent's
 * tests and then fail the platform's check of the same tree.
 */
export const BOX_TEST_SERVICES_ENV_PATH =
  "/etc/automata/agent-test-services.env";

/** The env keys the file may hand a run. Anything else is dropped. */
const ENV_KEYS: ReadonlySet<string> = new Set([
  "TEST_DATABASE_ADMIN_URL",
  "TEST_REDIS_HTTP_URL",
  "TEST_REDIS_HTTP_TOKEN",
]);

/**
 * Comma-separated `owner/repo` list (case-insensitive) of the repos whose runs
 * get the env. Absent or empty = no repo. Never itself handed to a run.
 */
const REPOS_KEY = "TEST_SERVICES_REPOS";

const MAX_BYTES = 64 * 1024;
const LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/;

function refuse(path: string, reason: string): Record<string, string> {
  console.warn(`[box-test-services] ignoring ${path}: ${reason}`);
  return {};
}

function readGuarded(path: string): string | Record<string, string> {
  let fd: number;
  try {
    // O_NOFOLLOW + fstat on the open fd: the lstat checks, without a window
    // between checking the path and reading it.
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "unknown";
    return code === "ENOENT" ? {} : refuse(path, `unreadable (${code})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return refuse(path, "not a regular file");
    if (stat.size > MAX_BYTES) return refuse(path, "larger than 64 KiB");
    if ((stat.mode & 0o007) !== 0) return refuse(path, "world-accessible");
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The box's test-service env for a run of `repoFullName`: `KEY=VALUE` lines,
 * blanks and `#` comments ignored, allowlisted keys only, and only when the
 * file's TEST_SERVICES_REPOS names the repo — the login is shared by every run
 * that gets it, so it is scoped to repos the box operator chose.
 *
 * Read on every call (not cached at boot) so a re-provision takes effect on
 * the next run without a worker restart. A missing file is the normal state
 * off the execution box and yields `{}` silently; a file that is unsafe,
 * unreadable or malformed yields `{}` and one warning naming the path, never a
 * value.
 */
export function readBoxTestServicesEnv(
  repoFullName: string,
  path: string = BOX_TEST_SERVICES_ENV_PATH,
): Record<string, string> {
  const text = readGuarded(path);
  if (typeof text !== "string") return text;

  const env: Record<string, string> = {};
  let repos: string[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = LINE.exec(line);
    if (!match) return refuse(path, `malformed line ${index + 1}`);
    const [, key = "", value = ""] = match;
    if (key === REPOS_KEY) {
      repos = value.split(",").map((repo) => repo.trim().toLowerCase());
    } else if (ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }
  return repos.includes(repoFullName.toLowerCase()) ? env : {};
}

/**
 * Whether a run is one the box's test services may go to: a task or PR
 * (mention) run, never a review (neither the review-plan lane nor a run that
 * carries review-agent settings) and never self-heal. `lane` is the run's
 * resolveRunLane(input), computed once by the caller. Which repos get it is
 * the file's TEST_SERVICES_REPOS, not this gate.
 */
export function receivesBoxTestServices(
  input: Pick<AgentRunInput, "reviewAgent" | "selfHeal">,
  lane: RunLane,
): boolean {
  return (
    lane !== "review" &&
    input.reviewAgent === undefined &&
    input.selfHeal === undefined
  );
}
