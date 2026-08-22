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
/**
 * Per-repo egress policy SHAPE (#66) — level + FINAL allowlist, fully resolved
 * control-plane-side (system entries already merged). Structural mirror of the
 * www-side field per this file's header rule — declared here, never imported
 * across the plane boundary. Consumed by egress-proxy.ts / workflow.ts.
 */
export type EgressPolicyShape = {
  level: "none" | "ip_port" | "domain";
  allowlist: string[];
};

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
  /**
   * The run's org identity — NON-EMPTY for every run (dispatch computes
   * `thread.organizationId ?? \`u:${userId}\`` so a personal/no-org thread still
   * has a stable key). It is the per-org fairness dimension for the workflow
   * concurrency key (Phase 2) and the #7 SLO dimension. The worker never has to
   * synthesise a fallback — dispatch guarantees it.
   */
  orgId: string;
  /** The PR number when this run is a PR review (from thread.githubPRNumber). */
  prNumber?: number;
  /**
   * W3C `traceparent` for the end-to-end OTel trace join (#7). Injected at
   * dispatch (generateTraceparent) on every remote run and stamped on the worker's
   * run-span logs + forwarded on every www call. Optional only because the wire
   * type is shared with pre-#7 / non-dispatch inputs; a live remote dispatch always
   * sets it.
   */
  traceparent?: string;
  /**
   * Per-repo egress policy SHAPE (#66). The worker learns ONLY this shape:
   * never the settings table, model, or provenance. Absent = no enforcement.
   * Consumed by workflow.ts: it starts the per-run filtering forward proxy
   * (egress-proxy.ts) and daemon-env points the child at it.
   */
  egressPolicy?: EgressPolicyShape;
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
