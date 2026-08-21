import type { AIAgent } from "@terragon/agent/types";
import { ampAdapter } from "./amp-adapter";
import { claudeAdapter } from "./claude-adapter";
import { codexAdapter } from "./codex-adapter";
import { geminiAdapter } from "./gemini-adapter";
import { opencodeAdapter } from "./opencode-adapter";
import type { HarnessAdapter } from "./types";

/**
 * One adapter per harness (ADR-006 decision 2). Adding a hypothetical new
 * CLI is one adapter file + one line here — no daemon switch, no five
 * `run*Command` methods. As of #76, `daemon.ts`'s generic `runAgentCommand`
 * reads this registry via `getAdapter(input.agent)` for every dispatch.
 */
export const harnessAdapterRegistry: Record<AIAgent, HarnessAdapter> = {
  claudeCode: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  amp: ampAdapter,
  opencode: opencodeAdapter,
};

export function getAdapter(agent: AIAgent): HarnessAdapter {
  return harnessAdapterRegistry[agent];
}
