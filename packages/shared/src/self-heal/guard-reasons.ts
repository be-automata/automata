/**
 * Why the R4 suppression / scope guard (www suppression-guard.ts) rejected a
 * fix diff. Declaration order is the reporting order (stable, deduplicated).
 * Lives here, dependency free, so the benchmark scorer types its cheat set
 * against the same vocabulary the guard reports.
 */
export const GUARD_REASONS = [
  "suppression_comment",
  "test_edit",
  "ci_edit",
  "audit_config_edit",
  "deleted_flagged_code",
  "out_of_plan_file",
  "denied_path",
  "diff_too_large",
  "patch_unavailable",
] as const;

export type GuardReason = (typeof GUARD_REASONS)[number];
