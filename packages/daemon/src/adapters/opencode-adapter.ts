import { authFilePathForAgent } from "@terragon/agent/auth-file";
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

  authFilePath: () => authFilePathForAgent("opencode"),

  prepareEnv(ctx: PrepareEnvContext): Record<string, string | undefined> {
    // Mirrors the pre-#76 runOpencodeCommand env assembly.
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
    // step_start handling needs the process state as of THIS line, which
    // changes as earlier lines in the same stdout batch are processed.
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
    // Only a type: "system" message with a session_id sets the tracked
    // session; assistant/user messages get backfilled from the snapshot.
    sessionTracking: "system-init-with-backfill",
  },
};
