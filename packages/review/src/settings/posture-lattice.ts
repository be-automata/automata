/**
 * The pure posture lattice (ADR-005) — a per-field, monotone "tighten" meet
 * over strictness controls composed across scopes (org, repo, trigger, …).
 *
 * Two axes live here today:
 *   - the review-severity floor (`blockSeverity` / `surfaceSeverity`, already
 *     shipped as {@link ApproveSeverityPolicy} in `../review/severity-policy`)
 *   - the trusted-author threshold (`trustedAuthorThreshold`, net-new — the
 *     vocabulary is defined HERE, not in `@terragon/shared`)
 *
 * `tighten(a, b)` combines two postures field-by-field, and EACH FIELD HAS ITS
 * OWN STRICTNESS DIRECTION — this is not a bare `Math.min` applied uniformly:
 *
 *   - `blockSeverity` / `surfaceSeverity`: lower severity rank = "blocks more
 *     content" = STRICTER, so the meet is `argmin` by {@link severityRank}
 *     (ADR-005 §1: `critical ⊐ error ⊐ warning ⊐ info`, strictest = lowest
 *     rank triggers on more findings).
 *   - `trustedAuthorThreshold`: HIGHER trust rank = "admits fewer authors" =
 *     STRICTER, so the meet is `argmax` by {@link trustRank}. **This direction
 *     inversion is the top footgun in this module.** `T_eff = max(T_org,
 *     T_repo)` (ADR-005 §4) — a repo can only RAISE the bar, never lower it. A
 *     `Math.min`-shaped meet here would let a repo admit an author the org
 *     explicitly excluded, which is exactly the hole ADR-005 §4 closes.
 *
 * `tighten` always operates on EXPANDED policies (full {@link ReviewPosture}
 * records), never on raw tolerance/threshold strings min'd and re-expanded —
 * expanding first and composing second keeps the well-formedness invariant
 * (`surfaceSeverity` rank ≤ `blockSeverity` rank) provable by a per-field min
 * argument (see the property tests).
 */

import {
  severityRank,
  type ApproveSeverityPolicy,
  type Severity,
} from "../review/severity-policy";

export type { ApproveSeverityPolicy };

/**
 * `author_association` trust vocabulary, ordered strictest-loosest ascending
 * (index = trust rank). Net-new for this ticket — nothing in `@terragon/shared`
 * or elsewhere in this package already defines this order; it is defined here
 * because it is a posture-lattice concern, not a GitHub-API-shape concern.
 */
export const TRUST_ORDER = [
  "NONE",
  "FIRST_TIME_CONTRIBUTOR",
  "CONTRIBUTOR",
  "COLLABORATOR",
  "MEMBER",
  "OWNER",
] as const;

export type TrustedAuthorThreshold = (typeof TRUST_ORDER)[number];

/** Membership guard over the trust vocabulary (for untrusted DB/config strings). */
export function isTrustedAuthorThreshold(
  value: unknown,
): value is TrustedAuthorThreshold {
  return (
    typeof value === "string" &&
    (TRUST_ORDER as readonly string[]).includes(value)
  );
}

/** Rank of a trust level (higher = more trusted / admits fewer authors below it). */
export function trustRank(threshold: TrustedAuthorThreshold): number {
  const idx = TRUST_ORDER.indexOf(threshold);
  return idx < 0 ? 0 : idx;
}

/**
 * The resolver default when neither org nor repo configures a threshold
 * (ADR-005 §4: `T = MEMBER`, whitelist `{OWNER, MEMBER}`).
 */
export const DEFAULT_TRUSTED_AUTHOR_THRESHOLD: TrustedAuthorThreshold =
  "MEMBER";

/**
 * A full posture: every monotone strictness field this lattice currently
 * composes. Extending the lattice with a new axis (ADR-005 §4's closing
 * point) means adding a field here plus one line in {@link tighten} — never a
 * new code path.
 */
export interface ReviewPosture {
  blockSeverity: Severity;
  surfaceSeverity: Severity;
  trustedAuthorThreshold: TrustedAuthorThreshold;
}

/** argmin by {@link severityRank} — ties keep `a` (idempotent). */
function stricterSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) <= severityRank(b) ? a : b;
}

/**
 * The monotone meet: the strictest value per field, independent of argument
 * order (commutative) and independent of grouping across ≥3 scopes
 * (associative) — see the property tests for the algebraic-law proofs.
 * Composed from the two per-axis meets below — one delegation per field.
 */
export function tighten(a: ReviewPosture, b: ReviewPosture): ReviewPosture {
  return {
    ...tightenSeverityPolicy(a, b),
    trustedAuthorThreshold: tightenTrustedAuthorThreshold(
      a.trustedAuthorThreshold,
      b.trustedAuthorThreshold,
    ),
  };
}

/**
 * Meet restricted to the two severity fields, for callers (like the resolver)
 * that only ever hand this an {@link ApproveSeverityPolicy} — kept as a
 * standalone export so `resolveComposedFloorPolicy` never has to fabricate a
 * fake trust field just to call the full lattice meet.
 */
export function tightenSeverityPolicy(
  a: ApproveSeverityPolicy,
  b: ApproveSeverityPolicy,
): ApproveSeverityPolicy {
  return {
    blockSeverity: stricterSeverity(a.blockSeverity, b.blockSeverity),
    surfaceSeverity: stricterSeverity(a.surfaceSeverity, b.surfaceSeverity),
  };
}

/**
 * Meet restricted to the trust field — `T_eff = max(T_org, T_repo)`
 * (ADR-005 §4), exported standalone for callers that only ever compose the
 * trust axis. argmax by {@link trustRank} — ties keep `a` (idempotent).
 * NOTE: inverted vs. severity.
 */
export function tightenTrustedAuthorThreshold(
  a: TrustedAuthorThreshold,
  b: TrustedAuthorThreshold,
): TrustedAuthorThreshold {
  return trustRank(a) >= trustRank(b) ? a : b;
}
