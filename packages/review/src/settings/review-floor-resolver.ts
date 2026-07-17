/**
 * Composes the per-repo approve-floor resolver injected into the coordinator
 * dispatcher (`resolveReviewApproveFloor`). Extracted from index.ts so the
 * precedence chain is unit-testable:
 *
 *   settings-store row (dashboard) > env-derived policy > locked default
 *
 * The store is read LIVE on every call — a dashboard write applies to the
 * next dispatched run with no restart.
 */

import {
  DEFAULT_APPROVE_SEVERITY_POLICY,
  toleranceToPolicy,
  type ApproveSeverityPolicy,
} from "../review/severity-policy";
import type { RepoReviewSettingsStore } from "./types";

export interface ReviewFloorResolverDeps {
  store: Pick<RepoReviewSettingsStore, "get">;
  /** The env-derived policy assembled from loadConfig (absent ⇒ locked default). */
  envPolicy?: ApproveSeverityPolicy;
}

export function createReviewApproveFloorResolver(
  deps: ReviewFloorResolverDeps,
): (repo: string) => ApproveSeverityPolicy {
  const fallback = deps.envPolicy ?? DEFAULT_APPROVE_SEVERITY_POLICY;
  return (repo: string): ApproveSeverityPolicy => {
    const setting = deps.store.get(repo);
    return setting ? toleranceToPolicy(setting.blockTolerance) : fallback;
  };
}
