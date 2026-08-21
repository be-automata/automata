import { authFilePathForAgent } from "@terragon/agent/auth-file";
import { ampCommand, ampReviewPolicyArgs, getAmpApiKeyOrNull } from "../amp";
import type { ClaudeMessage } from "../shared";
import type {
  BuildArgsConfig,
  HarnessAdapter,
  PrepareEnvContext,
} from "./types";

/** Thin façade over `amp.ts`. No logic moves. */
export const ampAdapter: HarnessAdapter = {
  agent: "amp",
  displayName: "Amp",

  authFilePath: () => authFilePathForAgent("amp"),

  prepareEnv(ctx: PrepareEnvContext): Record<string, string | undefined> {
    // Mirrors the pre-#76 runAmpCommand env assembly.
    return { AMP_API_KEY: getAmpApiKeyOrNull(ctx.runtime) };
  },

  buildArgs(cfg: BuildArgsConfig): string {
    return ampCommand({
      runtime: cfg.runtime,
      prompt: cfg.prompt,
      sessionId: cfg.sessionId,
      permissionMode: cfg.permissionMode,
    });
  },

  normalizeModel: (model: string) => model,

  makeLineParser: (ctx) => ({
    // Mirrors the inline JSON.parse the pre-#76 runAmpCommand did in its
    // onStdoutLine, including dropping amp's echoed first user message (the
    // CLI re-emits the prompt the daemon just sent it as a "user" role
    // message; forwarding it would duplicate the prompt in the thread).
    parse(line: string): ClaudeMessage[] {
      try {
        const outputMessage = JSON.parse(line) as ClaudeMessage & {
          type: string;
          message?: { role?: string; content?: Array<{ type?: string }> };
        };
        if (
          outputMessage.type === "user" &&
          outputMessage.message?.role === "user" &&
          outputMessage.message?.content?.[0]?.type === "text"
        ) {
          ctx.runtime.logger.debug("Ignoring Amp user message", {
            message: outputMessage,
          });
          return [];
        }
        return [outputMessage];
      } catch (e) {
        // Logs the raw error (not formatError-wrapped), matching the
        // pre-#76 runAmpCommand behavior exactly.
        ctx.runtime.logger.error("Failed to parse Amp output line", {
          line,
          error: e,
        });
        return [];
      }
    },
  }),

  capabilities: {
    withholdGitCredentialsInReviewMode: true,
    // amp never touches sessionId/isWorking from parsed messages.
    sessionTracking: "none",
  },

  // [] + documented reason — see amp.ts's ampReviewPolicyArgs() JSDoc for
  // the verification against the pinned amp 0.0.1765471542-g74e231 (#88).
  reviewPolicyArgs: ampReviewPolicyArgs,
};
