import { authFilePathForAgent } from "@terragon/agent/auth-file";
import {
  claudeCommand,
  getAnthropicApiKeyOrNull,
  reviewPolicyArgs,
} from "../claude";
import type { ClaudeMessage } from "../shared";
import { formatError } from "./format-error";
import { createResultHold } from "./result-hold";
import type {
  BuildArgsConfig,
  HarnessAdapter,
  PrepareEnvContext,
} from "./types";

/**
 * The Bash tool's timeouts for every non-review run, in every sandbox provider
 * (#302). The CLI clamps a requested timeout to max(BASH_MAX_TIMEOUT_MS,
 * BASH_DEFAULT_TIMEOUT_MS) and its default is 120s, so the old 60000 capped a
 * task agent's `pnpm test` or hooked `git push` at 2 minutes however long it
 * asked for, then moved the command to the background — which the
 * foreground-only hook makes the agent poll by hand. The default is raised as
 * well, so a command the agent gives no timeout (a `git push` whose pre-push
 * hook runs the suite) is not cut either. Reviews keep theirs: classic stays
 * 60000 with the CLI default, orchestrated takes the payload's.
 */
export const TASK_BASH_MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const TASK_BASH_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function bashTimeoutEnv(ctx: PrepareEnvContext): Record<string, string> {
  if (ctx.orchestratedReview) {
    return {
      BASH_MAX_TIMEOUT_MS: String(ctx.orchestratedReview.commandTimeoutMs),
    };
  }
  if (ctx.permissionMode === "review") {
    return { BASH_MAX_TIMEOUT_MS: String(60 * 1000) };
  }
  return {
    BASH_MAX_TIMEOUT_MS: String(TASK_BASH_MAX_TIMEOUT_MS),
    BASH_DEFAULT_TIMEOUT_MS: String(TASK_BASH_DEFAULT_TIMEOUT_MS),
  };
}

/**
 * Thin façade over `claude.ts`'s `claudeCommand` / `getAnthropicApiKeyOrNull`.
 * No logic moves except the `reviewPolicyArgs()` extraction already made in
 * `claude.ts` (#75 AC4) — `claudeCommand` still builds the review branch by
 * spreading it, so this adapter's `buildArgs` output is byte-identical to
 * `runClaudeCodeCommand`'s command string (daemon.ts:657-665).
 *
 * Phase 5: an orchestrated review run (the daemon-resolved
 * `orchestratedReview`) gets the D2 policy from `claudeCommand` and its
 * payload `BASH_MAX_TIMEOUT_MS`; a non-review run gets the task timeouts.
 * The line parser also holds results after a lead background sub-agent
 * (result-hold.ts).
 */
export const claudeAdapter: HarnessAdapter = {
  agent: "claudeCode",
  displayName: "Claude",

  authFilePath: () => authFilePathForAgent("claudeCode"),

  prepareEnv(ctx: PrepareEnvContext): Record<string, string | undefined> {
    // Mirrors the pre-#76 runClaudeCodeCommand env assembly exactly.
    return {
      ANTHROPIC_API_KEY: ctx.useCredits
        ? ""
        : getAnthropicApiKeyOrNull(ctx.runtime),
      ...bashTimeoutEnv(ctx),
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
      orchestratedReview: cfg.orchestratedReview,
      enableMcpPermissionPrompt: cfg.enableMcpPermissionPrompt ?? false,
    });
  },

  normalizeModel: (model: string) => model,

  makeLineParser: (ctx) => {
    const hold = createResultHold();
    return {
      // Mirrors the inline JSON.parse the pre-#76 runClaudeCodeCommand did in
      // its onStdoutLine. Session/isCompleted state tracking and
      // addMessageToBuffer stay in the daemon's generic runAgentCommand —
      // this façade only reproduces the parse step, plus the Phase 5 hold:
      // a held result is swallowed here and signalled via onResultHeld.
      parse(line, callCtx): ClaudeMessage[] {
        let outputMessage: ClaudeMessage;
        try {
          outputMessage = JSON.parse(line) as ClaudeMessage;
        } catch (e) {
          ctx.runtime.logger.error("Failed to parse Claude output line", {
            line,
            error: formatError(e),
          });
          return [];
        }
        const observed = hold.observe(outputMessage);
        if (observed.held) {
          callCtx.onResultHeld?.(outputMessage, observed.replacedEarlier);
          return [];
        }
        return [outputMessage];
      },
      drainHeld: () => hold.drain(),
    };
  },

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

  // SHIPPED (#88): exposes claude.ts's existing named seam through the
  // adapter contract — no behavior change. `claudeCommand` already spreads
  // this same function's output when permissionMode === "review"
  // (claude.ts:277-278), so this is the SAME policy, not a duplicate one.
  reviewPolicyArgs,
};
