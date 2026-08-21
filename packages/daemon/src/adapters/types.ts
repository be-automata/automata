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
 * `withholdGitCredentialsInReviewMode` is the TARGET contract (ADR-004 /
 * ADR-006): every adapter reports `true` here. This is deliberately NOT a
 * mirror of daemon.ts's CURRENT behavior — today only `runClaudeCodeCommand`
 * passes `withholdGitCredentials` (daemon.ts:656); the other four run
 * methods omit it. That gap is closed by #76's cutover to the generic
 * `runAgentCommand`, which will read this field uniformly. A1 (#75) only
 * defines the contract and pins the gap with an explicitly-labelled test —
 * daemon.ts itself is untouched here.
 */
export interface HarnessCapabilities {
  withholdGitCredentialsInReviewMode: boolean;
  mockSuccessResult?: string;
}

export interface HarnessAdapter {
  agent: AIAgent;
  /** Exact `agentName` string passed to `spawnAgentProcess`/logging today. */
  displayName: string;
  /**
   * Path (relative to the run's HOME) of this agent's on-disk credential
   * file, or null if the agent has none. Mirrors
   * `packages/worker/src/agent-run/agent-credentials.ts`
   * `CREDENTIAL_FILE_BY_AGENT` (CONTEXT ONLY, not modified here) — only
   * claudeCode and codex have an entry today; populating gemini/amp/opencode
   * is #77's job, not #75's.
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
