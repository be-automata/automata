import { hello } from "./hello/workflow";
import { agentRunWorkflows } from "./agent-run/workflow";

/**
 * The set of workflows this worker registers with the engine. The worker bootstrap
 * (src/hello/worker.ts) registers exactly this array — a workflow the control plane
 * dispatches but that no live worker has registered is unassignable and dies at
 * SCHEDULING_TIMED_OUT (ADR-002 §7). Add new workflows here so bootstrap picks them
 * up automatically.
 *
 * Ownership boundary: workflow authors (agent-run steps) append their exported task
 * here; they do not need to touch the worker bootstrap.
 */
export const workflows = [hello, ...agentRunWorkflows];
