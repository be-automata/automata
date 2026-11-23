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
  return resolveRunLane(input);
}

export type RunLane = "review" | "pr" | "task";

/**
 * Which lane a run belongs to, as far as its input can tell. Shared by the
 * control plane and the worker, so both sides read the same signals.
 *
 * - `review`: dispatched through the control plane's review plan. Only that plan
 *   stamps `prKey` / `supersedePolicy` (apps/www/src/agent/hatchet/dispatch.ts
 *   planReviewRun), so their presence is the review signal.
 * - `pr`: PR-scoped but not a review-plan run: an @-mention on a PR, or a review
 *   in a personal (no-org) scope, which dispatch keeps on the legacy plan.
 * - `task`: no PR at all.
 */
export function resolveRunLane(
  input: Omit<RunDisplayLaneInput, "selfHeal">,
): RunLane {
  if (input.prKey || input.supersedePolicy) return "review";
  if (input.prNumber !== undefined) return "pr";
  return "task";
}

/**
 * #757: may a run with this input execute in a cell? Only a plain task run: the
 * task lane, no self-heal plan, no review agent. The worker refuses a marked run
 * that fails it (`cell_lane_refused`) and dispatch marks only runs that pass it,
 * so the two sides cannot drift apart again.
 */
export function isCellEligibleLane(
  input: Omit<RunDisplayLaneInput, "selfHeal"> & {
    selfHeal?: unknown;
    reviewAgent?: unknown;
  },
): boolean {
  return (
    resolveRunLane(input) === "task" &&
    input.selfHeal === undefined &&
    input.reviewAgent === undefined
  );
}
