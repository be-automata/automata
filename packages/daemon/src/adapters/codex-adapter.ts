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
    // Codex needs no per-agent env (daemon.ts:818-828 passes none).
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
  },
};
