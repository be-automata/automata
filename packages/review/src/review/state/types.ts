/**
 * Shared types for the review-state bounded context.
 *
 * Implements the type contracts from
 * docs/sparc/cloudflare-stateful-reviewer-lifecycle/3-architecture.md §5.1.
 *
 * Every later module imports from here so there is one source of truth for
 * `LifecycleStatus`, `Severity`, `ReviewVerdictBinary`, `FindingRecord`, and
 * the lifecycle classification shape.
 */

import type { Finding } from '../../types';

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type LifecycleStatus = 'active' | 'fixed' | 'user_resolved' | 'regressed';

export type Severity = 'info' | 'warning' | 'error' | 'critical';

/** v0.3 binary verdict; 4-tier rubric is deferred to v0.5 per Spec §2. */
export type ReviewVerdictBinary = 'APPROVE' | 'REQUEST_CHANGES';

// ---------------------------------------------------------------------------
// FindingRecord — one row in `review_state` (Phase 3 §4.1)
// ---------------------------------------------------------------------------

export interface FindingRecord {
  repo: string;
  prNumber: number;
  /** Stable fingerprint = computeFingerprint(finding). Primary-key suffix. */
  findingId: string;
  firstSeenSha: string;
  lastSeenSha: string;
  status: LifecycleStatus;
  severity: Severity;
  category: string;
  filePath: string | null;
  lineNumber: number | null;
  message: string;
  /** GitHub `pulls/comments/{id}`, set when the inline comment was posted. */
  inlineCommentId: number | null;
  priorVerdict: ReviewVerdictBinary | null;
  breakGlassAt: string | null;
  breakGlassBy: string | null;
  breakGlassReason: string | null;
  /** FR-15: bot login captured at write time. */
  botLogin: string;
}

// ---------------------------------------------------------------------------
// LifecycleClassification — output of LifecycleResolver.classify
// ---------------------------------------------------------------------------

export interface LifecycleClassification {
  fixed: FindingRecord[];
  unfixed: FindingRecord[];
  user_resolved: FindingRecord[];
  regressed: FindingRecord[];
  newly_found: FindingRecord[];
}

// ---------------------------------------------------------------------------
// Break-glass match shape
// ---------------------------------------------------------------------------

export interface BreakGlassMatch {
  matched: boolean;
  /** Reason text truncated to 500 chars per FR-9; null when no `:reason` portion. */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// GitHub permission gate result
// ---------------------------------------------------------------------------

export type GitHubPermission =
  | 'admin'
  | 'maintain'
  | 'write'
  | 'triage'
  | 'read'
  | 'none';

export interface PermissionCheck {
  allowed: boolean;
  permission: GitHubPermission | 'unknown';
  reason?: 'api_error' | 'insufficient_permission';
}

// ---------------------------------------------------------------------------
// Re-export Finding for convenience
// ---------------------------------------------------------------------------

export type { Finding };
