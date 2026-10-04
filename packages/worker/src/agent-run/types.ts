import type { DaemonReviewAgent } from "@terragon/daemon/shared";

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

/**
 * Effective review-agent settings (phase 4), resolved control-plane-side for
 * PR-review runs only. Structural mirror of the www-side `ReviewAgentDispatch`
 * per this file's header rule.
 */
export type ReviewAgentShape = {
  mode: "classic" | "orchestrated";
  batteries: string[];
  runTests: boolean;
  runTestsDowngradedReason?: "fork" | "untrusted-author";
  commandTimeoutMs: number;
  /**
   * Limits the lead reviewer's turns. Sub-agent turns are not counted, so this is not a cost limit.
   */
  maxTurns?: number;
};

/**
 * Task-run packs (phase 7), resolved control-plane-side for NON-review runs
 * only. Structural mirror of www `TaskAgentDispatch` per this file's header
 * rule. Consumed by task-agent.ts (07-05); old workers ignore it. A `type`
 * for the same Hatchet JsonObject reason as AgentRunInput below.
 */
export type TaskAgentShape = {
  batteries: string[];
};

/**
 * Phase 8 self-heal audit run: one platform check per finding. Structural
 * mirror of www `SelfHealRunInput`. `type` (not `interface`) for the same
 * Hatchet JsonObject reason as AgentRunInput below.
 */
export type SelfHealCheckShape = {
  fingerprint: string;
  check: string;
  subject: string;
  key?: string;
};

export type SelfHealRunShape = {
  kind: "audit";
  checks: SelfHealCheckShape[];
  /** SECRET, worker-only; never logged. */
  checkToken: string;
};

// `type` (not `interface`): Hatchet's task input/output generics require an
// implicit index signature (JsonObject), which TS infers for type-literal aliases
// but not for interfaces.
export type AgentRunInput = {
  /**
   * Structural mirror of www SelfHealRunInput; old workers ignore it. Phase 9
   * adds a "fix" kind.
   */
  selfHeal?: SelfHealRunShape;
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
  /**
   * Phase 7, SECRET (never logged): a READ-ONLY, single-repo, ≤1h GitHub App
   * token, present only on task runs whose selected packs require
   * `github-read-token`. Mirror of www AgentRunInput.githubReadToken. Consumed
   * only by the 07-07 env gate (GITHUB_TOKEN for brokered non-review runs with
   * a seeded requiring pack); ignored everywhere else.
   */
  githubReadToken?: string;
  /** Not secret: the read token's ISO-8601 expiry (the worker refuses an expired token). */
  githubReadTokenExpiresAt?: string;
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
   * Phase 4 resolution, consumed by Phase 5: bounds-checked first
   * (review-agent-wire.ts), then orchestrated runs seed battery packs into the
   * per-run HOME (batteries-seed.ts) and stamp the daemon wire
   * (PulledDaemonMessage.reviewAgent). runTests is prompt-level and is NOT
   * forwarded (Phase 6). PR-review runs only; old workers ignore it.
   */
  reviewAgent?: ReviewAgentShape;
  /**
   * Phase 7: the battery packs a non-review (manual, scheduled, mention) task
   * run gets in its per-run HOME. Present only when the resolved list is
   * non-empty; review runs never carry it. Seeded by the worker in 07-05.
   */
  taskAgent?: TaskAgentShape;
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

/**
 * Which credential path this run actually took (#209 item 1). Structural
 * mirror of the control plane's `CREDENTIAL_SOURCES`
 * (packages/shared/src/model/credential-source.ts) — never imported across the
 * plane boundary. The type derives from the tuple so the two cannot drift
 * within this plane; `describeCredentialSource` is the exhaustive switch that
 * fails compilation when the mirror drifts from www.
 */
export const CREDENTIAL_SOURCES = [
  "user-credential",
  "built-in-credits",
  "box-key",
] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

/**
 * One LOG line per source — the worker-side wording. The user-facing copy
 * lives only in the control plane's credential-source.ts.
 */
export function describeCredentialSource(source: CredentialSource): string {
  switch (source) {
    case "user-credential":
      return "delivered user credential (run HOME)";
    case "built-in-credits":
      return "built-in credits (control-plane proxy)";
    case "box-key":
      return "box ANTHROPIC_API_KEY";
    default:
      return assertNever(source);
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
  /**
   * Worker-stamped (Phase 5) from AgentRunInput.reviewAgent for in-bounds
   * orchestrated review runs only; NOT part of www's RemoteDaemonMessage.
   * The daemon's own wire type — the daemon runs on this box, so importing
   * it does not cross the control-plane boundary this file's header guards.
   */
  reviewAgent?: DaemonReviewAgent;
}
