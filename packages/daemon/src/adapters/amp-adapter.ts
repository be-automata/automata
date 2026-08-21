import { ampCommand, getAmpApiKeyOrNull } from "../amp";
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

  // Not populated today — #77's job.
  authFilePath: () => null,

  prepareEnv(ctx: PrepareEnvContext): Record<string, string | undefined> {
    // Mirrors daemon.ts:780.
    return { AMP_API_KEY: getAmpApiKeyOrNull(ctx.runtime) };
  },

  buildArgs(cfg: BuildArgsConfig): string {
    return ampCommand({
      runtime: cfg.runtime,
      prompt: cfg.prompt,
      sessionId: cfg.sessionId,
    });
  },

  normalizeModel: (model: string) => model,

  makeLineParser: (ctx) => ({
    // Mirrors the inline JSON.parse in runAmpCommand's onStdoutLine
    // (daemon.ts:782-813), including dropping amp's echoed first user
    // message (the CLI re-emits the prompt the daemon just sent it as a
    // "user" role message; forwarding it would duplicate the prompt in the
    // thread).
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
        // daemon.ts:808-813 logs the raw error (not formatError-wrapped) here.
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
  },
};
