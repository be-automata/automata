import {
  createGeminiParserState,
  geminiCommand,
  parseGeminiLine,
} from "../gemini";
import type { ClaudeMessage } from "../shared";
import type {
  BuildArgsConfig,
  HarnessAdapter,
  PrepareEnvContext,
} from "./types";

/**
 * Thin façade over `gemini.ts`. Gemini needs per-run parser state
 * (`createGeminiParserState()`) plus a `finalize()` that flushes
 * `parserState.accumulatedContent` — mirroring the `onClose` handler in
 * `runGeminiCommand` (daemon.ts:872, 923-947). Without `finalize`, the last
 * accumulated delta chunk would be silently dropped when the process closes,
 * which is exactly the byte-identical-output hazard A2 must avoid.
 */
export const geminiAdapter: HarnessAdapter = {
  agent: "gemini",
  displayName: "Gemini",

  // Not populated today — #77's job.
  authFilePath: () => null,

  prepareEnv(ctx: PrepareEnvContext): Record<string, string | undefined> {
    // Mirrors daemon.ts:882-885.
    return {
      GOOGLE_GEMINI_BASE_URL: `${ctx.normalizedUrl}/api/proxy/google`,
      GEMINI_API_KEY: ctx.token,
    };
  },

  buildArgs(cfg: BuildArgsConfig): string {
    return geminiCommand({
      runtime: cfg.runtime,
      prompt: cfg.prompt,
      model: cfg.model,
      sessionId: cfg.sessionId,
    });
  },

  normalizeModel: (model: string) => model,

  makeLineParser: (ctx) => {
    const state = createGeminiParserState();
    return {
      parse(line) {
        return parseGeminiLine({ line, runtime: ctx.runtime, state });
      },
      // Mirrors the onClose flush in runGeminiCommand (daemon.ts:923-947).
      // Note: the flushed message's session_id there is read from
      // activeProcessState — a daemon-owned field this façade does not have
      // access to, so it is intentionally left "" here; #76's generic
      // runAgentCommand supplies the real session_id when wiring this up.
      finalize(): ClaudeMessage[] {
        if (!state.accumulatedContent) {
          return [];
        }
        const content = state.accumulatedContent;
        state.accumulatedContent = "";
        return [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: content }],
            },
            parent_tool_use_id: null,
            session_id: "",
          },
        ];
      },
    };
  },

  capabilities: {
    withholdGitCredentialsInReviewMode: true,
  },
};
