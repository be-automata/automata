import { AIAgentSchema, type AIAgent } from "./types";

/**
 * Single source of truth for where each agent's file-based credential lives,
 * relative to the run's HOME. Shared by `packages/worker` (which writes the
 * file, `agent-credentials.ts`) and `packages/daemon` (whose adapters report
 * the path via `authFilePath()`) so the two layers can never drift apart —
 * this is the #77 fix for what used to be a worker-only
 * `CREDENTIAL_FILE_BY_AGENT` map duplicated (by comment reference only) in
 * `packages/daemon/src/adapters/types.ts`.
 *
 * `gemini`, `amp`, and `opencode` map to `null` — permanently, not as a TODO.
 * `apps/www/src/agent/credentials.ts:111-116` can only ever resolve those
 * three agents to a `built-in-credits` or `env-var` credential SHAPE; there is
 * no code path that produces a `json-file` credential for them today. Adding
 * one is a control-plane change (a new credential SHAPE resolution), not
 * something this map can anticipate — see the amendment on
 * be-automata/automata#77 ("Validation gate: BLOCK → spec amended").
 */
export const AUTH_FILE_BY_AGENT: Record<AIAgent, string | null> = {
  claudeCode: ".claude/.credentials.json",
  codex: ".codex/auth.json",
  gemini: null,
  amp: null,
  opencode: null,
};

/**
 * Resolve the on-disk credential path for an agent identity.
 *
 * Accepts `string`, not `AIAgent` — load-bearing, not a laziness shortcut.
 * The worker's `PulledAgentCredentialsResult.agent` field is a plain
 * `string` (`packages/worker/src/agent-run/www-client.ts:107-115`), and
 * `workflow.ts:242` passes `""` for the no-credential (`built-in-credits`
 * without a box-trust pull) path. Narrowing the parameter to `AIAgent` would
 * force every caller to cast or throw on those legitimate inputs. An unknown
 * or empty string degrades to `null`, same as a known agent with no file.
 */
export function authFilePathForAgent(agent: string): string | null {
  const parsed = AIAgentSchema.safeParse(agent);
  if (!parsed.success) {
    return null;
  }
  return AUTH_FILE_BY_AGENT[parsed.data];
}
