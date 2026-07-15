/**
 * Approve severity floor — the pure, server-side policy kernel (no I/O).
 *
 * Two review paths need a severity threshold and must agree on ONE ordering:
 *   1. the deterministic `ReviewGate` (its own thresholds), and
 *   2. the external `emit_review` approve floor (the locked stricter policy).
 *
 * Both express their threshold as an {@link ApproveSeverityPolicy} over the
 * shared {@link Severity} union and run it through {@link classifySeverities},
 * which collapses a set of finding severities into a NEUTRAL kernel tier
 * (`block | surface | clean`). Two thin adapters map that neutral tier into
 * each caller's own vocabulary — the gate adapter ({@link tierToGateStatus})
 * yields `fail | conditional | pass`; the verdict adapter
 * ({@link tierToVerdict}) yields `request_changes | comment | approve`. GitHub's
 * own vocabulary (`APPROVE`/`CHANGES_REQUESTED`/`COMMENTED`) never enters this
 * bounded context.
 *
 * The locked policy (user-decided): `critical|error|warning` → block
 * (`request_changes`); `info` (and untagged comments) → NON-gating — surfaced in
 * the review body but the verdict stays `approve`. So the default has NO
 * withhold-only (`comment`) band: block threshold = `warning` AND surface
 * threshold = `warning` (nothing sits between them). The `comment` band exists
 * only for the operator relaxation (`REVIEW_APPROVE_BLOCK_SEVERITY=error`,
 * `REVIEW_APPROVE_SURFACE_SEVERITY=warning`), where a warning surfaces without
 * blocking. An untagged comment defaults to `info` (non-gating).
 */

import type { Severity } from './state/types';

export type { Severity };

/**
 * Severity tiers in ascending order — the array index IS the rank. The single
 * source of truth for "is X at least as severe as Y".
 */
export const SEVERITY_ORDER: readonly Severity[] = ['info', 'warning', 'error', 'critical'];

/** An untagged comment / absent `severity` defaults to `info`. */
export const DEFAULT_SEVERITY: Severity = 'info';

/** Membership guard over the severity vocabulary (for untrusted strings). */
export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITY_ORDER as readonly string[]).includes(value);
}

/** Rank of a severity (higher = more severe). Unknown values fall back to `info`. */
export function severityRank(severity: Severity): number {
  const idx = SEVERITY_ORDER.indexOf(severity);
  return idx < 0 ? 0 : idx;
}

/** The neutral kernel tier — deliberately free of gate/verdict/GitHub vocabulary. */
export type SeverityTier = 'block' | 'surface' | 'clean';

/**
 * The per-repository REQUESTED_CHANGES tolerance an operator can pick from the
 * dashboard. Each value names the LOWEST severity that blocks:
 * `error` = only error/critical block; `warning` = today's default;
 * `info` = every finding blocks. `critical`-only is deliberately not offered.
 */
export type BlockTolerance = 'info' | 'warning' | 'error';

export const BLOCK_TOLERANCES: readonly BlockTolerance[] = ['info', 'warning', 'error'];

export function isBlockTolerance(value: unknown): value is BlockTolerance {
  return typeof value === 'string' && (BLOCK_TOLERANCES as readonly string[]).includes(value);
}

/**
 * Expand a tolerance into a full {@link ApproveSeverityPolicy}:
 *   - `error`   → block `error`+, surface `warning` (the sanctioned operator
 *     relaxation documented above — a warning still shows up as a withheld
 *     `comment`, it just no longer blocks).
 *   - `warning` → bit-for-bit {@link DEFAULT_APPROVE_SEVERITY_POLICY}.
 *   - `info`    → everything blocks; the surface band is unreachable (nothing
 *     ranks below `info`), so `surface = 'info'` keeps `surface <= block` well-formed.
 * A tolerance is a COMPLETE policy: when a repo has one, the env surface
 * override is intentionally ignored for that repo.
 */
export function toleranceToPolicy(tolerance: BlockTolerance): ApproveSeverityPolicy {
  switch (tolerance) {
    case 'error':
      return { blockSeverity: 'error', surfaceSeverity: 'warning' };
    case 'warning':
      return { blockSeverity: 'warning', surfaceSeverity: 'warning' };
    case 'info':
      return { blockSeverity: 'info', surfaceSeverity: 'info' };
  }
}

/**
 * Whether a finding's severity blocks under `policy` (rank at or above the
 * block threshold). An absent severity defaults to `info` — meaning under an
 * `info` tolerance even untagged comments block.
 */
export function isBlockingUnderPolicy(
  severity: Severity | undefined,
  policy: ApproveSeverityPolicy,
): boolean {
  return severityRank(severity ?? DEFAULT_SEVERITY) >= severityRank(policy.blockSeverity);
}

/**
 * A severity threshold pair. A finding at or above `blockSeverity` blocks; one
 * at or above `surfaceSeverity` (but below block) is surfaced; anything below is
 * clean.
 */
export interface ApproveSeverityPolicy {
  /** Findings at or above this severity BLOCK (max of the set decides). */
  blockSeverity: Severity;
  /** Findings at or above this severity (but below block) are SURFACED. */
  surfaceSeverity: Severity;
}

/**
 * The locked EXTERNAL approve-floor policy: `warning`+ blocks; `info`/nits are
 * NON-gating (verdict stays `approve`, findings still surface in the body).
 * `surfaceSeverity === blockSeverity === 'warning'` on purpose — there is no
 * withhold-only band by default; `info` classifies as `clean`. Used by the
 * `emit_review` approve floor.
 */
export const DEFAULT_APPROVE_SEVERITY_POLICY: ApproveSeverityPolicy = {
  blockSeverity: 'warning',
  surfaceSeverity: 'warning',
};

/**
 * The deterministic `ReviewGate`'s thresholds. Aligned with the external approve
 * floor so `warning` blocks CONSISTENTLY at both layers: `warning`+
 * (warning/error/critical) blocks → `fail`; `info`/empty → `pass`. There is no
 * `conditional` band anymore — a warning is a hard fail, matching the
 * GitHub-verdict path where a warning yields `request_changes`.
 *
 * INTENTIONALLY NOT per-repo: the gate is the orchestrator's quality bar on its
 * OWN generated changes (apply → test → commit), a different concern from the
 * per-repo {@link BlockTolerance} governing verdicts posted on EXTERNAL PRs.
 * A repo relaxing its PR-review tolerance must not silently weaken the internal
 * gate. If per-repo gate strictness is ever wanted it must be a separate,
 * explicitly named setting.
 */
export const GATE_SEVERITY_POLICY: ApproveSeverityPolicy = {
  blockSeverity: 'warning',
  surfaceSeverity: 'warning',
};

/**
 * Collapse a set of finding severities into the neutral kernel tier. The MAX
 * severity in the set decides. An empty set is `clean`.
 */
export function classifySeverities(
  severities: readonly Severity[],
  policy: ApproveSeverityPolicy,
): SeverityTier {
  if (severities.length === 0) return 'clean';
  const maxRank = Math.max(...severities.map(severityRank));
  if (maxRank >= severityRank(policy.blockSeverity)) return 'block';
  if (maxRank >= severityRank(policy.surfaceSeverity)) return 'surface';
  return 'clean';
}

/** Gate adapter: neutral tier → the gate's `fail | conditional | pass` status. */
export function tierToGateStatus(tier: SeverityTier): 'pass' | 'conditional' | 'fail' {
  switch (tier) {
    case 'block':
      return 'fail';
    case 'surface':
      return 'conditional';
    case 'clean':
      return 'pass';
  }
}

/** The three review verdicts the approve floor may resolve to (no GitHub vocabulary). */
export type FloorVerdict = 'approve' | 'request_changes' | 'comment';

/** Verdict adapter: neutral tier → `request_changes | comment | approve`. */
export function tierToVerdict(tier: SeverityTier): FloorVerdict {
  switch (tier) {
    case 'block':
      return 'request_changes';
    case 'surface':
      return 'comment';
    case 'clean':
      return 'approve';
  }
}

/** The minimal intent shape the approve floor reads/rewrites. */
export interface SeverityFloorIntent {
  verdict: FloorVerdict;
  /**
   * `suppressGating` marks a finding whose quote failed verify-before-block
   * verification: it is surfaced to humans (annotated) but excluded from the
   * floor's severity set, so it can never gate — even under an `info`
   * tolerance where a severity downgrade alone could not de-fang it.
   * Orchestrator-internal; stripped before the GitHub post.
   */
  comments?: ReadonlyArray<{ severity?: Severity; suppressGating?: boolean }>;
}

/**
 * Server-side enforcement of the approve severity floor.
 *
 * ONLY acts when the incoming verdict is `approve` — an LLM-issued `comment` or
 * `request_changes` is returned untouched (the floor never UPGRADES a verdict,
 * only downgrades a too-generous approve). When it does act it recomputes the
 * verdict from the findings' severities:
 *   - `block`   → `request_changes`
 *   - `surface` → `comment`
 *   - `clean`   → `approve` (unchanged)
 *
 * Draft cap (`opts.isDraft`): a draft PR must NEVER receive a `request_changes`.
 * When the floor would block on a draft it caps the output at `comment`.
 *
 * Returns the SAME object when nothing changes (referential stability), or a
 * shallow copy with only `verdict` rewritten.
 */
export function applyApproveSeverityFloor<T extends SeverityFloorIntent>(
  intent: T,
  policy: ApproveSeverityPolicy,
  opts?: { isDraft?: boolean },
): T {
  // Invariant: only downgrade an `approve`. Leave comment/request_changes alone.
  if (intent.verdict !== 'approve') return intent;

  const severities = (intent.comments ?? [])
    .filter((c) => !c.suppressGating)
    .map((c) => c.severity ?? DEFAULT_SEVERITY);
  let nextVerdict = tierToVerdict(classifySeverities(severities, policy));

  // Draft cap: never promote approve → request_changes on a draft PR.
  if (opts?.isDraft && nextVerdict === 'request_changes') {
    nextVerdict = 'comment';
  }

  if (nextVerdict === intent.verdict) return intent;
  return { ...intent, verdict: nextVerdict };
}
