import type { RunLane } from "./run-lane";
import type { AgentRunInput } from "./types";

/**
 * Worker-side gate for task-run packs (Phase 7).
 *
 * The control plane resolves which packs a non-review run asks for
 * (resolve-task-agent.ts) and ships them as `input.taskAgent`; the worker only
 * bounds-checks the SHAPE (the ADR-003 mirror rule: wire values are re-checked
 * at the trust boundary, never re-resolved). The review lane never takes task
 * packs, whatever arrives.
 *
 * Since ADR-013 every battery is image contents, installed for every lane, so
 * nothing is linked per run: the gate's outcome only reaches the run's
 * `batteries:` log line. Rejection reasons name the rule and the index only —
 * never the value.
 */

export const TASK_AGENT_MAX_PACKS = 16;

/** A pack id: lowercase, digits and dashes, not starting with a dash. */
export const PACK_ID = /^[a-z0-9][a-z0-9-]*$/;

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
    if (!PACK_ID.test(id)) {
      return `batteries[${i}] must match ${PACK_ID.source}`;
    }
    if (seen.has(id)) {
      return `batteries[${i}] is a duplicate`;
    }
    seen.add(id);
  }
  return undefined;
}

/** `lane` is the run's resolveRunLane(input), computed once by the caller. */
export function taskAgentForRun(
  taskAgent: AgentRunInput["taskAgent"],
  lane: RunLane,
): TaskAgentGate {
  if (taskAgent === undefined) {
    return { kind: "none" };
  }
  if (lane === "review") {
    return { kind: "rejected", lane, reason: "review-lane" };
  }
  const reason = findShapeError(taskAgent);
  if (reason !== undefined) {
    return { kind: "rejected", lane, reason };
  }
  return { kind: "seed", batteries: [...taskAgent.batteries], lane };
}

/**
 * The run's one `batteries:` line (ADR-013): the image digest every battery
 * comes from, the lane, and — when the run carried task packs — which ids it
 * asked for (all of them are already in the image) or why they were refused.
 */
export function formatBatteriesLine({
  imageDigest,
  lane,
  taskGate,
}: {
  imageDigest: string;
  lane: RunLane;
  taskGate: TaskAgentGate;
}): string {
  const base = `batteries: image=${imageDigest.replace(/^sha256:/, "").slice(0, 12)} lane=${lane}`;
  if (taskGate.kind === "seed") {
    return `${base} task-packs=${taskGate.batteries.join(",")}`;
  }
  if (taskGate.kind === "rejected" && taskGate.lane !== "review") {
    return `${base} task-packs=invalid`;
  }
  return base;
}
