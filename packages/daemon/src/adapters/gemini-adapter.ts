import { authFilePathForAgent } from "@terragon/agent/auth-file";
import {
  createGeminiParserState,
  geminiCommand,
  geminiReviewPolicyArgs,
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
 * `parserState.accumulatedContent` — mirroring the `onClose` handler the
 * pre-#76 `runGeminiCommand` registered. Without `finalize`, the last
 * accumulated delta chunk would be silently dropped when the process closes,
 * which is exactly the byte-identical-output hazard #76's cutover must avoid.
 */
export const geminiAdapter: HarnessAdapter = {
  agent: "gemini",
  displayName: "Gemini",

  authFilePath: () => authFilePathForAgent("gemini"),

  prepareEnv(ctx: PrepareEnvContext): Record<string, string | undefined> {
    // Mirrors the pre-#76 runGeminiCommand env assembly.
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
      permissionMode: cfg.permissionMode,
    });
  },

  normalizeModel: (model: string) => model,

  makeLineParser: (ctx) => {
    const state = createGeminiParserState();
    return {
      parse(line) {
        return parseGeminiLine({ line, runtime: ctx.runtime, state });
      },
      // Mirrors the onClose flush the pre-#76 runGeminiCommand registered.
      // Note: the flushed message's session_id there is read from
      // activeProcessState — a daemon-owned field this façade does not have
      // access to, so it is intentionally left "" here; the generic
      // runAgentCommand overwrites it with the real session_id
      // (activeProcessState?.sessionId || "") when wiring this up, byte-
      // identically to the deleted onClose handler.
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
    // Only a type: "system" message with a session_id sets the tracked
    // session; assistant/user messages get backfilled from the snapshot.
    sessionTracking: "system-init-with-backfill",
  },

  // [] + documented reason — see gemini.ts's geminiReviewPolicyArgs() JSDoc
  // for the verification against the pinned gemini-cli 0.20.0 (#88).
  reviewPolicyArgs: geminiReviewPolicyArgs,
};
