import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { errorFromResponse } from "./error-from-response";
import { splitRepoFullName } from "./review-settings-queries";

/**
 * Admin activity view of the audit self-heal loop (OBS-01) and its operator
 * controls (KILL-01, BRK-01). Backed by `/api/self-heal/{owner}/{repo}` and
 * `/api/self-heal/actions`; both are org-admin gated server-side, so the UI is
 * never the control. Dates arrive as ISO strings (JSON).
 */

export type SelfHealBreakerScopeKind =
  | "github_write"
  | "github_read"
  | "permission"
  | "hatchet_dispatch"
  | "exec_plane"
  | "loop_fix"
  | "loop_audit";

export type SelfHealBreakerStateName =
  | "closed"
  | "open"
  | "half_open"
  | "paused_manual";

export interface SelfHealBreakerDto {
  scopeKind: SelfHealBreakerScopeKind;
  scopeKey: string;
  state: SelfHealBreakerStateName;
  openUntil: string | null;
  lastTripReason: string | null;
}

export interface SelfHealRunDecisionDto {
  fingerprint: string;
  decision: string;
  reason: string;
}

export interface SelfHealRunDto {
  id: string;
  createdAt: string;
  mode: string | null;
  outcome: string | null;
  createdCount: number;
  updatedCount: number;
  closedCount: number;
  /** `{ count: n }` or `{ <reason>: n }`; shape is not guaranteed. */
  skipped: unknown;
  decisions: unknown;
}

export interface SelfHealFindingDto {
  id: string;
  ruleId: string;
  severity: string;
  status: string;
  issueNumber: number | null;
  attempts: number;
  consecutiveCheckPasses: number;
  lastDecision: string | null;
  lastDecisionReason: string | null;
}

export interface SelfHealAdminLogDto {
  id: string;
  actorUserId: string;
  action: string;
  createdAt: string;
}

export interface SelfHealChurnDto {
  fromRunId: string;
  toRunId: string;
  churn: number;
}

/** computeSelfHealMetrics (@terragon/shared/self-heal/metrics); rates are 0..1 or null. */
export interface SelfHealMetricsDto {
  prsOpened: number;
  ready: number;
  merged: number;
  mergedByNonTrigger: number;
  mergeRate: number | null;
  humanEditRatio: number | null;
  reopenRate: number | null;
  regressionRate30d: number | null;
  meanAttemptsToClose: number | null;
  expiredRate: number | null;
  refunded: number;
  counted: number;
  admissionDeferrals: number;
  mergeRateBasis: "bot-and-owner" | "bot-only";
}

export type SelfHealGateSourceDto =
  | "protection"
  | "all-checks"
  | "finding-check-only";

/** One fix attempt's path (server-lib/audit/attempt-timeline.ts). */
export interface SelfHealAttemptTimelineDto {
  attemptId: string;
  findingId: string;
  attemptNo: number;
  prNumber: number | null;
  prUrl: string | null;
  phase: string;
  prState: string | null;
  ciStatus: string | null;
  /** Null while the CI gate source is undecided. */
  gateSource: SelfHealGateSourceDto | null;
  outcome: string | null;
  infraRefunded: boolean;
  steps: {
    claim: string | null;
    dispatch: string | null;
    check: string | null;
    draft: string | null;
    ci: string | null;
    ready: string | null;
    merged: string | null;
    closed: string | null;
  };
}

export interface SelfHealActivityDto {
  effective: { mode: string; reason: string };
  runs: SelfHealRunDto[];
  findings: SelfHealFindingDto[];
  outbox: {
    pending: number;
    failed: number;
    oldestPendingAt: string | null;
  };
  breakers: {
    repo: { loopAudit: SelfHealBreakerDto; loopFix: SelfHealBreakerDto };
    installation: SelfHealBreakerDto[];
  };
  adminLog: SelfHealAdminLogDto[];
  churn: SelfHealChurnDto[];
  /** Absent from servers older than the metrics view. */
  metrics?: SelfHealMetricsDto;
  attemptTimeline?: SelfHealAttemptTimelineDto[];
}

export interface SelfHealDrainResultDto {
  killSwitchSet: boolean;
  cancelled: string[];
  lookupFailed: string[];
  cancelFailed: string[];
  nothingInFlight: boolean;
}

export type SelfHealActionInput =
  | { action: "drain" }
  | {
      action: "reset_breaker";
      scopeKind: SelfHealBreakerScopeKind;
      scopeKey: string;
    };

export const selfHealQueryKeys = {
  all: () => ["self-heal"] as const,
  activity: (repoFullName: string) =>
    ["self-heal", "activity", repoFullName] as const,
};

async function fetchSelfHealActivity(
  repoFullName: string,
): Promise<SelfHealActivityDto> {
  const [owner, repo] = splitRepoFullName(repoFullName);
  const res = await fetch(
    `/api/self-heal/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
  if (!res.ok) {
    throw await errorFromResponse(res);
  }
  return (await res.json()) as SelfHealActivityDto;
}

/** `repoFullName` null disables the query (no repo picked yet). */
export function useSelfHealActivityQuery(repoFullName: string | null) {
  return useQuery({
    queryKey: selfHealQueryKeys.activity(repoFullName ?? ""),
    queryFn: () => fetchSelfHealActivity(repoFullName ?? ""),
    enabled: repoFullName !== null && repoFullName !== "",
  });
}

export function useSelfHealActionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: SelfHealActionInput,
    ): Promise<SelfHealDrainResultDto | { reset: true }> => {
      const res = await fetch("/api/self-heal/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw await errorFromResponse(res);
      }
      return (await res.json()) as SelfHealDrainResultDto | { reset: true };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: selfHealQueryKeys.all() });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}
