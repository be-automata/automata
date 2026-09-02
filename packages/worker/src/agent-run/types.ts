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
  /**
   * #125 (C2 stamps, C1 consumes): per-PR concurrency key
   * `${orgId}/${repo}/${prNumber}`. Present ONLY on runs dispatched to a
   * policy variant (agent-run-newest / -strict / -discard) — the variants'
   * per-PR CEL entry references `input.prKey` as a field. Absent on the legacy
   * `agent-run` workflow, which has no per-PR entry.
   */
  prKey?: string;
  /**
   * #125: the run's idempotency identity (webhook delivery id, or a synthetic
   * per-dispatch id). The variants' task config dedupes on it (24h TTL).
   */
  deliveryId?: string;
  /**
   * #125: the supersede-policy SNAPSHOT stamped at dispatch — the authority
   * for this run's terminal cause when the engine cancels it. Structural
   * mirror of the www union; absent on legacy runs.
   */
  supersedePolicy?:
    | "newest-wins"
    | "complete-run-queue"
    | "complete-run-discard";
  /** #125 snapshot pass-through; unread by the worker until C4/C5. */
  recheckOnComplete?: boolean;
};

/**
 * Typed terminal causes (#125 C4). Structural mirror of the control plane's
 * `TERMINAL_CAUSES` (packages/shared/src/model/terminal-cause.ts) — never
 * imported across the plane boundary. The type derives from the tuple so the
 * two cannot drift within this plane; `describeTerminalCause` is the
 * exhaustive switch that fails compilation when the mirror drifts from www.
 */
export const TERMINAL_CAUSES = [
  "superseded",
  "discarded",
  "stale-skipped",
  "user-cancelled",
  "timeout",
  "daemon-failed",
  "publish-failed",
  "plane-offline",
] as const;
export type TerminalCause = (typeof TERMINAL_CAUSES)[number];

function assertNever(value: never): never {
  throw new Error(`unexpected value ${String(value)}`);
}

/** One log line per cause — the worker-side exhaustive switch over the union. */
export function describeTerminalCause(cause: TerminalCause): string {
  switch (cause) {
    case "superseded":
      return "cancelled by a newer run (policy)";
    case "discarded":
      return "dropped while an older run was live (policy)";
    case "stale-skipped":
      return "skipped: a newer run was already queued";
    case "user-cancelled":
      return "cancelled by a user";
    case "timeout":
      return "schedule/execution timeout";
    case "daemon-failed":
      return "daemon failed before a verdict";
    case "publish-failed":
      return "verdict could not be published";
    case "plane-offline":
      return "never became visible on the execution plane";
    default:
      return assertNever(cause);
  }
}

export type AgentRunOutput = {
  threadId: string;
  threadChatId: string;
  /** How the run reached a terminal state. */
  outcome:
    | "completed"
    | "nothing-to-run"
    | "cancelled"
    | "stale-skipped"
    /** www put the thread in `stopping` (user Stop): daemon torn down, `user-cancelled` posted. */
    | "stopped";
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
