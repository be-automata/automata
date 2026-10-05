import type { AgentRunInput } from "./types";

/**
 * Which lane a run belongs to, as far as the worker can tell from its input.
 *
 * - `review`: dispatched through the control plane's review plan. Only that plan
 *   stamps `prKey` / `supersedePolicy` (apps/www/src/agent/hatchet/dispatch.ts
 *   planSupersede), so their presence is the review signal.
 * - `pr`: PR-scoped but not a review-plan run — an @-mention on a PR, or a review
 *   in a personal (no-org) scope, which dispatch keeps on the legacy plan.
 * - `task`: no PR at all.
 */
export type RunLane = "review" | "pr" | "task";

export function resolveRunLane(
  input: Pick<AgentRunInput, "prKey" | "supersedePolicy" | "prNumber">,
): RunLane {
  if (input.prKey || input.supersedePolicy) return "review";
  if (input.prNumber !== undefined) return "pr";
  return "task";
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
  // Display-only: resolveRunLane (which gates task packs) is untouched.
  const lane = input.selfHeal
    ? `self-heal-${input.selfHeal.kind}`
    : resolveRunLane(input);
  const parts = [`run start: lane=${lane}`];
  if (input.prNumber !== undefined) parts.push(`pr=${input.prNumber}`);
  parts.push(`repo=${input.repoFullName}`, `branch=${input.branch}`);
  if (input.supersedePolicy) parts.push(`policy=${input.supersedePolicy}`);
  return parts.join(" ");
}
