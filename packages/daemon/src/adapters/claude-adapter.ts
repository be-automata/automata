import { claudeCommand, getAnthropicApiKeyOrNull } from "../claude";
import type { ClaudeMessage } from "../shared";
import { formatError } from "./format-error";
import type {
  BuildArgsConfig,
  HarnessAdapter,
  PrepareEnvContext,
} from "./types";

/**
 * Thin façade over `claude.ts`'s `claudeCommand` / `getAnthropicApiKeyOrNull`.
 * No logic moves except the `reviewPolicyArgs()` extraction already made in
 * `claude.ts` (#75 AC4) — `claudeCommand` still builds the review branch by
 * spreading it, so this adapter's `buildArgs` output is byte-identical to
 * `runClaudeCodeCommand`'s command string (daemon.ts:657-665).
 */
export const claudeAdapter: HarnessAdapter = {
  agent: "claudeCode",
  displayName: "Claude",

  authFilePath: () => ".claude/.credentials.json",

  prepareEnv(ctx: PrepareEnvContext): Record<string, string | undefined> {
    // Mirrors the pre-#76 runClaudeCodeCommand env assembly exactly.
    return {
      ANTHROPIC_API_KEY: ctx.useCredits
        ? ""
        : getAnthropicApiKeyOrNull(ctx.runtime),
      BASH_MAX_TIMEOUT_MS: (60 * 1000).toString(),
      ...(ctx.useCredits
        ? {
            ANTHROPIC_BASE_URL: `${ctx.normalizedUrl}/api/proxy/anthropic`,
            ANTHROPIC_AUTH_TOKEN: ctx.token,
          }
        : {}),
    };
  },

  buildArgs(cfg: BuildArgsConfig): string {
    return claudeCommand({
      runtime: cfg.runtime,
      prompt: cfg.prompt,
      sessionId: cfg.sessionId,
      model: cfg.model,
      mcpConfigPath: cfg.mcpConfigPath ?? null,
      permissionMode: cfg.permissionMode,
      enableMcpPermissionPrompt: cfg.enableMcpPermissionPrompt ?? false,
    });
  },

  normalizeModel: (model: string) => model,

  makeLineParser: (ctx) => ({
    // Mirrors the inline JSON.parse the pre-#76 runClaudeCodeCommand did in
    // its onStdoutLine. Session/isCompleted state tracking and
    // addMessageToBuffer stay in the daemon's generic runAgentCommand —
    // this façade only reproduces the parse step.
    parse(line: string): ClaudeMessage[] {
      try {
        const outputMessage = JSON.parse(line) as ClaudeMessage;
        return [outputMessage];
      } catch (e) {
        ctx.runtime.logger.error("Failed to parse Claude output line", {
          line,
          error: formatError(e),
        });
        return [];
      }
    },
  }),

  capabilities: {
    // Contract (ADR-004/ADR-006): true for every adapter. Claude was the
    // ONLY agent for which daemon.ts's pre-#76 path actually applied this —
    // see the (now-inverted) labelled test in
    // adapters/daemon-golden.test.ts and adapter-golden.test.ts.
    withholdGitCredentialsInReviewMode: true,
    // Only claudeCode fixes up on-disk session logs (pre-spawn, and on
    // process kill via killActiveProcess).
    fixesSessionLogs: true,
    // Any message carrying a session_id sets it; no backfill of later
    // messages within the same stdout batch.
    sessionTracking: "any-message",
  },
};
