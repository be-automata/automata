import fs from "node:fs";

import { resolveRunLane } from "./run-lane";
import type { AgentRunInput } from "./types";

/**
 * Where install-test-postgres.sh writes the box's test-service URLs
 * (root:<worker group> 0640). The values are SECRET: never logged.
 */
export const BOX_TEST_SERVICES_ENV_PATH =
  "/etc/automata/agent-test-services.env";

/**
 * The only keys the file may set. Anything else is dropped, so the file can
 * never steer the runtime (PATH, NODE_OPTIONS, credentials) of a run.
 */
const BOX_TEST_SERVICES_KEYS: ReadonlySet<string> = new Set([
  "TEST_DATABASE_ADMIN_URL",
  "TEST_REDIS_HTTP_URL",
  "TEST_REDIS_HTTP_TOKEN",
]);

const LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/;

type ReadFileSync = (path: string, encoding: "utf8") => string;
type Warn = (message: string, detail?: Record<string, unknown>) => void;

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error) {
    const { code } = error as NodeJS.ErrnoException;
    return code;
  }
  return undefined;
}

/**
 * The box's test-service env for an agent run: `KEY=VALUE` lines, blanks and
 * `#` comments ignored, allowlisted keys only.
 *
 * Read on every call (not cached at boot) so a re-provision takes effect on
 * the next run without a worker restart. A missing file is the normal state
 * off the execution box and yields `{}` silently; an unreadable or malformed
 * one yields `{}` and a warning that names the path and line number, never a
 * value.
 */
export function readBoxTestServicesEnv(
  path: string = BOX_TEST_SERVICES_ENV_PATH,
  fsImpl: { readFileSync: ReadFileSync } = fs,
  warn: Warn = (message, detail) => console.warn(message, detail),
): Record<string, string> {
  let text: string;
  try {
    text = fsImpl.readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      warn("[box-test-services] cannot read the env file — ignoring it", {
        path,
        code: errorCode(error) ?? "unknown",
      });
    }
    return {};
  }

  const env: Record<string, string> = {};
  const ignored: string[] = [];
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = LINE.exec(line);
    if (!match) {
      warn("[box-test-services] malformed env file — ignoring all of it", {
        path,
        line: index + 1,
      });
      return {};
    }
    const [, key = "", value = ""] = match;
    if (BOX_TEST_SERVICES_KEYS.has(key)) {
      env[key] = value;
    } else {
      ignored.push(key);
    }
  }
  if (ignored.length > 0) {
    warn("[box-test-services] ignoring keys outside the allowlist", {
      path,
      keys: ignored,
    });
  }
  return env;
}

/**
 * Whether a run gets the box's test-service env: exactly the runs the control
 * plane hands an owner's repo environment to. Mirrors `isPlainTaskRun` in
 * apps/www/src/agent/hatchet/dispatch.ts — no review plan (no prKey /
 * supersedePolicy), an org thread (orgSettings is only read for one; a
 * personal thread's orgId is the `u:<userId>` fallback), and not self-heal.
 * Gated on the lane rather than on `input.repoEnv` being present, because
 * dispatch omits an empty repoEnv and a task run with no owner variables must
 * still reach the test database.
 */
export function receivesBoxTestServices(
  input: Pick<
    AgentRunInput,
    "prKey" | "supersedePolicy" | "prNumber" | "orgId" | "selfHeal"
  >,
): boolean {
  return (
    resolveRunLane(input) !== "review" &&
    !input.orgId.startsWith("u:") &&
    input.selfHeal === undefined
  );
}
