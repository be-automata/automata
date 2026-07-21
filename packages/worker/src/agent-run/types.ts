/**
 * The wire contract between the control plane (apps/www) and this worker (ADR-003).
 * These types intentionally MIRROR — they do not import — the www-side shapes
 * (apps/www/src/agent/hatchet/dispatch.ts AgentRunInput and
 * apps/www/src/server-lib/remote-daemon-message.ts RemoteDaemonMessage). The two
 * planes share a wire format, not code: importing across the plane boundary would
 * pull control-plane code onto the customer box. Keep them structurally in sync.
 */

/**
 * Reference-only workflow input (ADR-002 §3). Carries only the two SHORT-LIVED,
 * org-scoped tokens — never the App private key or master key. The prompt is NOT
 * here; the worker pulls it from /api/daemon/next-message.
 */
// `type` (not `interface`): Hatchet's task input/output generics require an
// implicit index signature (JsonObject), which TS infers for type-literal aliases
// but not for interfaces.
export type AgentRunInput = {
  threadId: string;
  threadChatId: string;
  repoFullName: string;
  branch: string;
  /**
   * The PR base branch (e.g. "main"), when this run is a PR review. Provision fetches
   * it alongside the head so the token-withheld review agent can run
   * `git diff origin/<base>...HEAD` offline on a re-review (BUG-EXEC-02). Optional:
   * absent for non-PR runs, in which case no base fetch happens.
   */
  baseBranch?: string;
  /** www's public base URL the daemon calls back to (events + next-message). */
  daemonCallbackUrl: string;
  /** Short-lived, installation-scoped GitHub token for the clone (x-access-token). */
  installationToken: string;
  /** Short-lived, org+thread-scoped daemon token (events + next-message auth). */
  daemonToken: string;
};

export type AgentRunOutput = {
  threadId: string;
  threadChatId: string;
  /** How the run reached a terminal state. */
  outcome: "completed" | "nothing-to-run" | "cancelled";
  /** Final thread status observed from www, when known. */
  finalStatus?: string;
};

/**
 * The `claude` DaemonMessage body served by /api/daemon/next-message, minus the
 * fields the worker already holds (token, threadId, threadChatId). Mirror of
 * www's RemoteDaemonMessage.
 */
export interface PulledDaemonMessage {
  type: "claude";
  model: string;
  agent: string;
  agentVersion: number;
  prompt: string;
  sessionId: string | null;
  permissionMode: "allowAll" | "plan" | "review";
  useCredits?: boolean;
  featureFlags: Record<string, boolean>;
}
