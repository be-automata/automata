/**
 * Pure resolution of the per-repo approve-severity floor from a (possibly
 * absent) stored tolerance override, with a well-defined precedence:
 *
 *   stored per-repo row (dashboard)  >  env-derived policy  >  locked default
 *
 * This module is deliberately I/O-free: the caller (apps/www) reads the Neon
 * `repo_review_settings` row for the run's `(organizationId, repoFullName)` and
 * hands the result here. Keeping it pure means the precedence is unit-testable in
 * the review package without a database, and `@terragon/shared` never has to
 * depend on `@terragon/review`.
 *
 * The store is read LIVE on every dispatched review run — a dashboard write
 * applies to the next run with no restart.
 */

import {
  DEFAULT_APPROVE_SEVERITY_POLICY,
  isBlockTolerance,
  toleranceToPolicy,
  type ApproveSeverityPolicy,
} from "../review/severity-policy";

/** The minimal shape of a stored override this resolver reads. */
export interface StoredReviewTolerance {
  /** The persisted tolerance string; validated here (untrusted DB text). */
  blockTolerance: string;
}

/**
 * Resolve the effective approve-floor policy for one review run.
 *
 * - A stored row with a VALID tolerance wins — it is a complete policy, so the
 *   env surface override is intentionally ignored for that repo.
 * - A stored row with an unrecognized tolerance string (corruption / a value
 *   written by a newer version) is treated as absent — we fall back rather than
 *   crash the review.
 * - No row → the env-derived policy if provided, else the locked default.
 */
export function resolveApproveFloorPolicy(
  setting: StoredReviewTolerance | null | undefined,
  envPolicy?: ApproveSeverityPolicy,
): ApproveSeverityPolicy {
  const fallback = envPolicy ?? DEFAULT_APPROVE_SEVERITY_POLICY;
  if (setting && isBlockTolerance(setting.blockTolerance)) {
    return toleranceToPolicy(setting.blockTolerance);
  }
  return fallback;
}
