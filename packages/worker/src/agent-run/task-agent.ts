import { ID_OR_NAME } from "./batteries-manifest";
import { resolveRunLane } from "./run-lane";
import type { AgentRunInput } from "./types";

/**
 * Worker-side gate for task-run packs (Phase 7).
 *
 * The control plane resolves which packs a non-review run gets
 * (resolve-task-agent.ts) and ships them as `input.taskAgent`; the worker only
 * bounds-checks the SHAPE before anything reaches the filesystem (the ADR-003
 * mirror rule: wire values are re-checked at the trust boundary, never
 * re-resolved). The review lane never takes task packs, whatever arrives.
 * Well-formed but unknown ids pass: seedBatteries skips them against the
 * verified manifest, which is the authority on pack ids.
 *
 * Rejection reasons name the rule and the index only — never the value.
 */

export const TASK_AGENT_MAX_PACKS = 16;

export type TaskAgentGate =
  | { kind: "none" }
  | { kind: "seed"; batteries: string[]; lane: "task" | "pr" }
  | { kind: "rejected"; lane: "task" | "pr" | "review"; reason: string };

function findShapeError(taskAgent: unknown): string | undefined {
  if (typeof taskAgent !== "object" || taskAgent === null) {
    return "taskAgent must be an object";
  }
  const batteries: unknown = (taskAgent as { batteries?: unknown }).batteries;
  if (!Array.isArray(batteries)) {
    return "batteries must be an array";
  }
  if (batteries.length === 0) {
    return "batteries must not be empty";
  }
  if (batteries.length > TASK_AGENT_MAX_PACKS) {
    return `batteries must hold at most ${TASK_AGENT_MAX_PACKS} ids`;
  }
  const seen = new Set<string>();
  for (const [i, id] of batteries.entries()) {
    if (typeof id !== "string") {
      return `batteries[${i}] must be a string`;
    }
    if (!ID_OR_NAME.test(id)) {
      return `batteries[${i}] must match ${ID_OR_NAME.source}`;
    }
    if (seen.has(id)) {
      return `batteries[${i}] is a duplicate`;
    }
    seen.add(id);
  }
  return undefined;
}

export function taskAgentForRun(
  input: Pick<
    AgentRunInput,
    "taskAgent" | "prKey" | "supersedePolicy" | "prNumber"
  >,
): TaskAgentGate {
  if (input.taskAgent === undefined) {
    return { kind: "none" };
  }
  const lane = resolveRunLane(input);
  if (lane === "review") {
    return { kind: "rejected", lane, reason: "review-lane" };
  }
  const reason = findShapeError(input.taskAgent);
  if (reason !== undefined) {
    return { kind: "rejected", lane, reason };
  }
  return { kind: "seed", batteries: [...input.taskAgent.batteries], lane };
}
