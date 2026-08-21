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
import {
  DEFAULT_TRUSTED_AUTHOR_THRESHOLD,
  isTrustedAuthorThreshold,
  tightenSeverityPolicy,
  tightenTrustedAuthorThreshold,
  type TrustedAuthorThreshold,
} from "./posture-lattice";

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

/**
 * Compose the org-level severity floor with the repo-tier resolution
 * (ADR-005 §1/§4) via {@link tighten}. `base = resolveApproveFloorPolicy(repoSetting,
 * envPolicy)` reproduces today's precedence exactly (repo row > envPolicy >
 * locked default) — an ABSENT or INVALID `orgSetting` returns `base`
 * unchanged, which is the identity edge (AC2): today's behavior is
 * reproduced bit-for-bit when no org floor is configured, including the
 * envPolicy tier still applying underneath it.
 *
 * A VALID `orgSetting` is expanded into its full {@link ApproveSeverityPolicy}
 * and tightened against `base` — the org floor can only make the effective
 * policy stricter (lower `blockSeverity`/`surfaceSeverity` rank), never
 * looser, matching ADR-005 §1's meet-lattice shape.
 *
 * Returns the same 2-field {@link ApproveSeverityPolicy} shape as
 * {@link resolveApproveFloorPolicy} — deliberately NOT widened, so the
 * single production caller (`apps/www/src/server-lib/review/resolve-approve-floor.ts`,
 * which now IS this function's caller — issue #73) and its existing assertions
 * are untouched.
 */
export function resolveComposedFloorPolicy(
  orgSetting: StoredReviewTolerance | null | undefined,
  repoSetting: StoredReviewTolerance | null | undefined,
  envPolicy?: ApproveSeverityPolicy,
): ApproveSeverityPolicy {
  const base = resolveApproveFloorPolicy(repoSetting, envPolicy);
  if (!orgSetting || !isBlockTolerance(orgSetting.blockTolerance)) {
    return base;
  }
  const orgFloor = toleranceToPolicy(orgSetting.blockTolerance);
  return tightenSeverityPolicy(orgFloor, base);
}

/** The minimal shape of a stored trusted-author-threshold override this resolver reads. */
export interface StoredTrustedAuthorThreshold {
  /** The persisted threshold string; validated here (untrusted DB text). */
  trustedAuthorThreshold: string;
}

/**
 * Resolve the effective trusted-author threshold `T_eff = max(T_org, T_repo)`
 * by trust rank (ADR-005 §4) — a repo may only RAISE the bar an org sets,
 * never lower it (the direction is inverted vs. the severity axis: higher
 * trust rank = stricter here).
 *
 * Validation mirrors the existing repo-tier precedent in
 * {@link resolveApproveFloorPolicy}: an invalid/unrecognized stored string is
 * treated as ABSENT (fail open to "no override from this scope"), never as a
 * crash and never as a silently-trusted value. Both absent ⇒
 * {@link DEFAULT_TRUSTED_AUTHOR_THRESHOLD} ("MEMBER" is a RESOLVER default per
 * ADR-005 §4, not a lattice element) — and that default participates as the
 * org-absent base, so `resolveComposedTrustedAuthorThreshold(absent, absent)`
 * reproduces the documented default rather than falling through to `NONE`.
 */
export function resolveComposedTrustedAuthorThreshold(
  orgValue: StoredTrustedAuthorThreshold | null | undefined,
  repoValue: StoredTrustedAuthorThreshold | null | undefined,
): TrustedAuthorThreshold {
  const org =
    orgValue && isTrustedAuthorThreshold(orgValue.trustedAuthorThreshold)
      ? orgValue.trustedAuthorThreshold
      : DEFAULT_TRUSTED_AUTHOR_THRESHOLD;
  const repo =
    repoValue && isTrustedAuthorThreshold(repoValue.trustedAuthorThreshold)
      ? repoValue.trustedAuthorThreshold
      : undefined;
  if (repo === undefined) return org;
  return tightenTrustedAuthorThreshold(org, repo);
}
