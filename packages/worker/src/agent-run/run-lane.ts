import {
  resolveRunDisplayLane,
  resolveRunLane,
  type RunLane,
} from "@terragon/utils/run-lane";

import type { AgentRunInput } from "./types";

export { resolveRunLane };
export type { RunLane };

/**
 * #437: does this run's abnormal end get a typed terminal from the worker?
 * Only a task run, and not a self-heal run (which resolves to the task lane but
 * whose outcome the fix check owns). Review and pr runs keep their own posts.
 */
export function ownsAbnormalTerminal(
  input: Pick<
    AgentRunInput,
    "prKey" | "supersedePolicy" | "prNumber" | "selfHeal"
  >,
): boolean {
  return resolveRunLane(input) === "task" && input.selfHeal === undefined;
}

/**
 * The run's first journal line: lane, PR number and repo, so a run can be matched
 * to its GitHub effect without correlating timestamps. Emitted BEFORE the clone,
 * so a run that dies cloning still says what it was. Ids only — never a token,
 * the prompt, or anything else from the input.
 */
export function formatRunStartLine(
  input: Pick<
    AgentRunInput,
    | "prKey"
    | "supersedePolicy"
    | "prNumber"
    | "repoFullName"
    | "branch"
    | "selfHeal"
  >,
): string {
  // OBS-01: audit and fix runs are filterable with `grep lane=self-heal`.
  // Display-only (the taxonomy www stamps in the engine run metadata):
  // resolveRunLane, which gates task packs, is untouched.
  const parts = [`run start: lane=${resolveRunDisplayLane(input)}`];
  if (input.prNumber !== undefined) parts.push(`pr=${input.prNumber}`);
  parts.push(`repo=${input.repoFullName}`, `branch=${input.branch}`);
  if (input.supersedePolicy) parts.push(`policy=${input.supersedePolicy}`);
  return parts.join(" ");
}
