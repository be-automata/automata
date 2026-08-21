import {
  getOpencodeApiKeyOrNull,
  opencodeCommand,
  parseOpencodeLine,
} from "../opencode";
import type {
  BuildArgsConfig,
  HarnessAdapter,
  PrepareEnvContext,
} from "./types";

/**
 * Thin façade over `opencode.ts`. `normalizeModel` is identity in A1 —
 * opencode's legacy inline prefix rewrite (`opencode/` -> `terry/`, etc.,
 * opencode.ts:312-326) stays inside `opencodeCommand` and is NOT hoisted
 * here or applied twice.
 */
export const opencodeAdapter: HarnessAdapter = {
  agent: "opencode",
  displayName: "Opencode",

  // Not populated today (CREDENTIAL_FILE_BY_AGENT has no opencode entry) —
  // populating it is #77's job, not #75's.
  authFilePath: () => null,

  prepareEnv(ctx: PrepareEnvContext): Record<string, string | undefined> {
    // Mirrors daemon.ts:730-732.
    return {
      OPENCODE_API_KEY: getOpencodeApiKeyOrNull(ctx.runtime),
    };
  },

  buildArgs(cfg: BuildArgsConfig): string {
    return opencodeCommand({
      runtime: cfg.runtime,
      prompt: cfg.prompt,
      model: cfg.model,
      sessionId: cfg.sessionId,
    });
  },

  normalizeModel: (model: string) => model,

  makeLineParser: (ctx) => ({
    // isWorking is read at CALL time (per ParseLineCallContext), not
    // captured when the parser is constructed — parseOpencodeLine's
    // step_start handling (daemon.ts:735-739) needs the process state as of
    // THIS line, which changes as earlier lines are processed.
    parse(line, callCtx) {
      return parseOpencodeLine({
        line,
        runtime: ctx.runtime,
        isWorking: callCtx.isWorking,
      });
    },
  }),

  capabilities: {
    withholdGitCredentialsInReviewMode: true,
    mockSuccessResult: "Opencode successfully completed",
  },
};
