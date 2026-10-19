export { hatchet } from "./hatchet-client";
export { hello } from "./hello/workflow";
export type { HelloInput, HelloOutput } from "./hello/workflow";
// The registered shape is `buildWorkflows(caps)` / `buildAgentRunWorkflows(caps)`
// with the caps loadWorkerConfig validated (#372). `agentRunWorkflow(s)` is the
// 1/1 DEFAULT-caps declaration set, kept for tests and the legacy REST contract
// checks — registering it would ignore WORKER_GLOBAL_MAX_RUNS / _PER_ORG_.
export {
  agentRunWorkflow,
  agentRunWorkflows,
  buildAgentRunWorkflows,
} from "./agent-run/workflow";
export { buildWorkflows } from "./registry";
export type { EngineCaps } from "./agent-run/definition";
export type { AgentRunInput, AgentRunOutput } from "./agent-run/workflow";
