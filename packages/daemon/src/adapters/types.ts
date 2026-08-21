import type { AIAgent, AIAgentCredentials } from "@terragon/agent/types";
import type { IDaemonRuntime } from "../runtime";
import type { ClaudeMessage } from "../shared";

/**
 * HarnessAdapter contract (#75, ADR-006).
 *
 * SHAPE-not-KIND boundary: everything below the control plane consumes only
 * an agent identity + the values the daemon wire message already carries
 * (DaemonMessageClaudeSchema, shared.ts:17-32 — token/useCredits/permissionMode,
 * NOT a credential kind). `AIAgentCredentials` (the KIND union: env-var |
 * json-file | built-in-credits) is re-exported here ONLY so adapter authors can
 * read its shape in docs/JSDoc — no HarnessAdapter method accepts it, a
 * userId, or an organizationId. A new CLI's adapter may branch on `agent`
 * identity and the resolved SHAPE only. See ADR-006 anti-deviation invariants.
 */
export type { AIAgentCredentials };

/**
 * Context passed to `prepareEnv`. This is intentionally narrow: it mirrors
 * exactly what reaches the daemon over the wire (`DaemonMessageClaudeSchema`)
 * plus the runtime handle needed to shell out for on-box credential files
 * (e.g. `getAnthropicApiKeyOrNull`). It must NEVER grow a `creds:
 * AIAgentCredentials`, `boxApiKey`, `userId`, or `organizationId` field — the
 * ticket's originally proposed shape included fields that do not exist on
 * the daemon message schema and would violate the SHAPE-not-KIND boundary.
 */
export interface PrepareEnvContext {
  runtime: IDaemonRuntime;
  useCredits: boolean;
  token: string;
  normalizedUrl: string;
}

/** Config passed to `buildArgs` — the union of every `*Command()` builder's params today. */
export interface BuildArgsConfig {
  runtime: IDaemonRuntime;
  prompt: string;
  sessionId: string | null;
  model: string;
  permissionMode?: "allowAll" | "plan" | "review";
  mcpConfigPath?: string | null;
  enableMcpPermissionPrompt?: boolean;
  useCredits?: boolean;
}

/** Context passed once when a run's line parser is constructed. */
export interface MakeLineParserContext {
  runtime: IDaemonRuntime;
}

/**
 * Per-call context passed to `parse`. `isWorking` must be read at CALL time,
 * not capture time: opencode's `step_start` handling (daemon.ts:735-739)
 * decides whether to emit a synthetic `system init` message based on the
 * active process state *at the moment each line arrives*, which changes
 * mid-run as earlier lines are parsed.
 */
export interface ParseLineCallContext {
  isWorking: boolean;
}

/**
 * A per-run line parser. `parse` is called once per stdout line and returns
 * zero or more `ClaudeMessage`s. `finalize` is optional and called once when
 * the child process closes, for harnesses that need to flush accumulated
 * state — e.g. gemini's `parserState.accumulatedContent` (daemon.ts:872,
 * 915-947) or codex's is_error flush (daemon.ts:860-862, handled by the
 * caller today; codex's adapter has no finalize because the flush there is a
 * message-buffer side effect, not parser state).
 */
export interface HarnessLineParser {
  parse(line: string, ctx: ParseLineCallContext): ClaudeMessage[];
  finalize?(): ClaudeMessage[];
}

/**
 * Security + behavior capabilities every adapter must declare.
 *
 * `withholdGitCredentialsInReviewMode` is the contract (ADR-004 / ADR-006):
 * every adapter reports `true` here, and as of #76's cutover to the generic
 * `runAgentCommand`, daemon.ts reads this field uniformly for every agent
 * (`withholdGitCredentials: input.permissionMode === "review" &&
 * adapter.capabilities.withholdGitCredentialsInReviewMode`) — closing the
 * pre-#76 gap where only `runClaudeCodeCommand` actually withheld
 * credentials. See the (now-inverted) test in `daemon-golden.test.ts`.
 *
 * Three additive capabilities close the remaining per-agent quirks the
 * generic runner needs to reproduce byte-identically (#76):
 *
 * - `fixesSessionLogs`: true ONLY for claudeCode. The generic runner calls
 *   `maybeFixLogsForSessionId` before spawn when set (mirrors the deleted
 *   `runClaudeCodeCommand`'s pre-spawn call), and `killActiveProcess`'s
 *   session-log cleanup now branches on this flag via `getAdapter(...)`
 *   instead of `agent === "claudeCode"`.
 * - `flushBufferOnErrorResult`: true ONLY for codex. After a `result`
 *   message with `is_error: true` is added to the buffer, the generic
 *   runner flushes immediately — preserving codex's exact ordering
 *   (addMessageToBuffer first, then isCompleted, then flush). This must NOT
 *   generalize to Claude: daemon.test.ts pins that Claude's `is_error`
 *   result does NOT trigger a custom flush.
 * - `sessionTracking`: `"any-message"` (claudeCode — any message carrying a
 *   `session_id` sets it, no backfill), `"system-init-with-backfill"`
 *   (codex/gemini/opencode — only a `type: "system"` message with
 *   `session_id` sets it; assistant/user messages get backfilled from the
 *   snapshot when it already has one), or `"none"` (amp — never touches
 *   `sessionId`/`isWorking`). These three policies are NOT unified; the
 *   generic runner branches on this field per line.
 */
export interface HarnessCapabilities {
  withholdGitCredentialsInReviewMode: boolean;
  mockSuccessResult?: string;
  fixesSessionLogs?: boolean;
  flushBufferOnErrorResult?: boolean;
  sessionTracking: "any-message" | "system-init-with-backfill" | "none";
}

export interface HarnessAdapter {
  agent: AIAgent;
  /** Exact `agentName` string passed to `spawnAgentProcess`/logging today. */
  displayName: string;
  /**
   * Path (relative to the run's HOME) of this agent's on-disk credential
   * file, or null if the agent has none. Sourced from the single shared map,
   * `AUTH_FILE_BY_AGENT` / `authFilePathForAgent` in `@terragon/agent/auth-file`
   * (#77) — see that module's JSDoc for why gemini/amp/opencode are null.
   */
  authFilePath(): string | null;
  prepareEnv(ctx: PrepareEnvContext): Record<string, string | undefined>;
  buildArgs(cfg: BuildArgsConfig): string;
  /**
   * Identity in A1: `(model) => model`. Model-string rewriting stays where
   * it lives today — opencode's legacy inline prefix rewrite
   * (opencode.ts:312-326) and codex's 30-case model switch (inside
   * `codexCommand`, codex.ts:258-363) are NOT hoisted here; applying either
   * twice (once here, once inside the existing builder) would be a
   * double-application hazard.
   */
  normalizeModel(model: string): string;
  makeLineParser(ctx: MakeLineParserContext): HarnessLineParser;
  capabilities: HarnessCapabilities;
}
