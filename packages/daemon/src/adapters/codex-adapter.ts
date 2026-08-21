import { codexCommand, parseCodexLine } from "../codex";
import type {
  BuildArgsConfig,
  HarnessAdapter,
  PrepareEnvContext,
} from "./types";

/**
 * Thin façade over `codex.ts`. `normalizeModel` is identity in A1 — codex's
 * 30-case model switch stays INSIDE `codexCommand` (codex.ts:258-363) and is
 * NOT hoisted here; useCredits' `-c 'model_provider="terry"'` flag
 * (codex.ts:364-366) likewise stays in `codexCommand`.
 */
export const codexAdapter: HarnessAdapter = {
  agent: "codex",
  displayName: "Codex",

  authFilePath: () => ".codex/auth.json",

  prepareEnv(_ctx: PrepareEnvContext): Record<string, string | undefined> {
    // Codex needs no per-agent env (the pre-#76 runCodexCommand passed none).
    return {};
  },

  buildArgs(cfg: BuildArgsConfig): string {
    return codexCommand({
      runtime: cfg.runtime,
      prompt: cfg.prompt,
      model: cfg.model,
      sessionId: cfg.sessionId,
      useCredits: !!cfg.useCredits,
    });
  },

  normalizeModel: (model: string) => model,

  makeLineParser: (ctx) => ({
    parse(line) {
      return parseCodexLine({ line, runtime: ctx.runtime });
    },
  }),

  capabilities: {
    withholdGitCredentialsInReviewMode: true,
    mockSuccessResult: "Codex successfully completed",
    // codex is the ONLY agent that flushes the message buffer immediately
    // when a result message arrives with is_error: true (the generic
    // runner preserves the exact ordering: addMessageToBuffer first, then
    // isCompleted, then this flush). Do NOT generalize to other agents —
    // daemon.test.ts pins that Claude's is_error result does NOT flush.
    flushBufferOnErrorResult: true,
    // Only a type: "system" message with a session_id sets the tracked
    // session; assistant/user messages get backfilled from the snapshot.
    sessionTracking: "system-init-with-backfill",
  },
};
