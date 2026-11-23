# fix(dispatch): www marks PR-scoped runs for a cell, and the worker refuses every one (cell_lane_refused)

## Context and why

On 2026-11-23 at 11:44 UTC a PR merged in a client backend repository, and the post-merge ticket audit commented:

> The audit run for <KEY> did not produce a usable result, so no ticket was changed.

The audit agent never ran. The box worker refused the run before admission:

```
Task run failed: cell_lane_refused: only a plain task run may execute in a cell
  at selectRunExecutor (packages/worker/src/agent-run/run-executor.ts:84)
```

The run ended with no terminal text, so `executeMergeAudit` found no intent and posted the generic "unusable result" notice (`apps/www/src/server-lib/tracker/execute-merge-audit.ts:533`).

This started when cells were turned on for that org (`opensandboxCells`) to run issue-mention missions. Since 2026-11-15 the box journal shows exactly **3 runs** refused with `cell_lane_refused`, all in that repository and all PR-scoped:

| When (UTC) | Thread | What |
|---|---|---|
| 2026-11-21 17:29 | `a95fc34d` | a PR thread (PR #675 of that repo) |
| 2026-11-22 21:20 | `a820ad26` | post-merge audit, PR #679 |
| 2026-11-23 11:44 | `44499e85` | post-merge audit, PR #680 |

Each one is lost: the run never starts, and nothing retries it, because `cell_lane_refused` is a "named" refusal (`packages/worker/src/agent-run/cell-refusal-text.ts:55`, where a resend fails the same way).

## Root cause (verified at `main` @ `d3efdab8`)

www and the worker use two different definitions of a "plain task run".

| Side | Rule | Where |
|---|---|---|
| www (marks the run for a cell) | `isPlainTaskRun = taskPlan !== undefined && !selfHeal && !isCompanionRun`, then `cellMarker` when the org is eligible | `apps/www/src/agent/hatchet/dispatch.ts:1167-1170`, `:1250-1262` |
| worker (accepts the marker) | `resolveRunLane(input) === "task"`, which is false whenever `prNumber` is set, plus no `selfHeal` and no `reviewAgent` | `packages/worker/src/agent-run/run-executor.ts:74-85`, `packages/worker/src/agent-run/run-lane.ts:17-23` |

`baseInput.prNumber` is the thread's `githubPRNumber` (`dispatch.ts:1051`, `:1066`). A merge-audit thread, a PR-mention thread and any other non-review PR thread on an org has a `taskPlan` and a `prNumber`. www marks it, and the worker refuses it every time. The `cell_decision` row for `44499e85` shows `lane: "pr"`, so the shadow resolver already saw the lane correctly.

`resolveRunLane` exists only in the worker. `packages/utils/src/run-lane.ts:27` holds the shared *display* lane (`resolveRunDisplayLane`), which applies the same `prNumber → "pr"` rule.

## Scope

1. Move `resolveRunLane` (and its `RunLane` type) into `packages/utils/src/run-lane.ts`, next to `resolveRunDisplayLane`. `packages/worker/src/agent-run/run-lane.ts` re-exports it, so worker call sites (`run-executor.ts`, `run-budget.ts`, `cell-run.ts`, `task-agent.ts`) don't change.
2. In `dispatch.ts`, set the cell marker only when the run's lane, from that shared `resolveRunLane`, is `task`, on top of the current `isPlainTaskRun` and eligibility checks. A PR-scoped run is then never marked and stays on the box, as it did before cells.
3. Tests (below).

## Out of scope

- Falling back to the box when the worker refuses a cell plan. That is a separate follow-up; this issue makes www stop sending runs the worker refuses.
- Running PR-scoped runs (mentions on PRs, merge audits) in cells. That needs the worker's cell executor to support the `pr` lane.
- The wording of the merge-audit notice for a run that never started.
- Re-running the lost runs. That is an operator step after the deploy (see DoD).

## Steps

1. Move `resolveRunLane` and `RunLane` into `packages/utils/src/run-lane.ts`, with its doc comment; re-export from the worker's `run-lane.ts`.
2. In `dispatch.ts`, compute the lane from the same fields the worker reads (`prKey`, `supersedePolicy`, `prNumber` of the final input) and add `lane === "task"` to the `cellMarker` condition. Explain in the comment that the worker refuses any other lane (`run-executor.ts`).
3. Add the tests below.

## Acceptance criteria

1. A dispatch for an org thread with `githubPRNumber` set, eligible for cells otherwise, produces an input **without** `cell`.
2. A dispatch for an org thread with no PR number, eligible for cells, still produces `cell: "opensandbox"` (the issue-mention / task path is unchanged).
3. `resolveRunLane` has exactly one implementation, in `@terragon/utils`, which both www and the worker import.
4. Every input www marks for a cell passes the worker's lane check in `selectRunExecutor`. A test pins this by running the worker's check on www's marked inputs, or by sharing one table of cases between the two.
5. In production, after the deploy, a merge of a PR on a cells-on org runs its post-merge audit on the box and posts a real audit.

## Tests

- `packages/utils/src/run-lane.test.ts`: `resolveRunLane` cases (`prKey` → review, `supersedePolicy` → review, `prNumber` → pr, none → task).
- www dispatch test: a PR-numbered org thread on a cells-on org is not marked; a no-PR one is.
- Worker: the existing `run-executor` tests still pass unchanged.
- Gates: `pnpm turbo tsc-check`, `pnpm turbo lint`, and the www, worker and utils vitest suites.

## Risks and rollback

- Low. The change only removes the cell marker from runs the worker already refuses, so no run that works today changes route.
- Rollback: revert the PR. Turning cells off for the org at `/internal/admin/organizations` also stops the refusals, at the cost of issue-mention missions going back to the box.

## Definition of done

- The PR is merged, and www and the worker are deployed (worker first, per the deploy order).
- The post-merge audits for the two lost merges are re-run by redelivering their `pull_request` `closed` webhook deliveries, and each posts a real audit.
- AC-5 is observed and recorded on this issue.

## References

- `#634` (cell marker), `#708` (org cells switch), `#705` (egress eligibility), `#718` (`cell-eligibility.ts`): the conditions the marker already checks.
- `#437`, `packages/worker/src/agent-run/run-lane.ts:31-38`: `ownsAbnormalTerminal` uses the same lane rule.

