/**
 * The display lane of an agent run (#373 OD-0): the one taxonomy shared by the
 * control plane's engine run metadata (apps/www transport.ts) and the
 * execution plane's run-start journal line (packages/worker run-lane.ts), so
 * the growth-trigger evaluator and a `grep lane=` see the same values.
 */
export type RunDisplayLane =
  | "review"
  | "pr"
  | "task"
  | "self-heal-audit"
  | "self-heal-fix";

export interface RunDisplayLaneInput {
  selfHeal?: { kind: "audit" | "fix" } | null;
  prKey?: string;
  supersedePolicy?: string;
  prNumber?: number;
}

/**
 * A self-heal plan wins (`self-heal-<kind>`); then the review plan's stamps
 * (`prKey` / `supersedePolicy`, written only by the review plan) mean
 * `review`; then a PR number means `pr` (e.g. an @-mention on a PR); else
 * `task`.
 */
export function resolveRunDisplayLane(
  input: RunDisplayLaneInput,
): RunDisplayLane {
  if (input.selfHeal) return `self-heal-${input.selfHeal.kind}`;
  if (input.prKey || input.supersedePolicy) return "review";
  if (input.prNumber !== undefined) return "pr";
  return "task";
}

/**
 * Which lane a run belongs to, as far as its input can tell. Shared by the
 * control plane (dispatch decides whether to mark a run for a cell) and the
 * worker (the executor selector refuses a marked run that is not a task), so
 * both sides read the same signals.
 *
 * - `review`: dispatched through the control plane's review plan. Only that plan
 *   stamps `prKey` / `supersedePolicy` (apps/www/src/agent/hatchet/dispatch.ts
 *   planReviewRun), so their presence is the review signal.
 * - `pr`: PR-scoped but not a review-plan run: an @-mention on a PR, or a review
 *   in a personal (no-org) scope, which dispatch keeps on the legacy plan.
 * - `task`: no PR at all.
 */
export type RunLane = "review" | "pr" | "task";

export function resolveRunLane(input: {
  prKey?: string;
  supersedePolicy?: string;
  prNumber?: number;
}): RunLane {
  if (input.prKey || input.supersedePolicy) return "review";
  if (input.prNumber !== undefined) return "pr";
  return "task";
}
