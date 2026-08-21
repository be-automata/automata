import type { BlockTolerance } from "@terragon/review/severity-policy";

/**
 * UI semantics for the per-repo REQUESTED_CHANGES tolerance, replicated from the
 * server policy kernel (`@terragon/review/severity-policy` → `toleranceToPolicy`)
 * so the dashboard's consequence matrix stays cell-for-cell consistent with what
 * the reviewer actually enforces:
 *   - `error`   → block `error`+, surface `warning`.
 *   - `warning` → block `warning`+ (info non-gating). The locked default.
 *   - `info`    → every finding blocks.
 * Findings carry a fourth severity (`critical`) that is never a selectable
 * tolerance but always blocks — it's a matrix ROW, not a column.
 */

/** Radio-card order: strictest → most lenient. */
export const TOLERANCE_ORDER: BlockTolerance[] = ["info", "warning", "error"];

export type Severity = "info" | "warning" | "error" | "critical";

/** Severity chips shown on each radio card, weakest → strongest. */
export const SEVERITY_CHIPS: Severity[] = [
  "info",
  "warning",
  "error",
  "critical",
];

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

/** Severity at/above which a finding forces Request changes under a tolerance. */
const TOLERANCE_BLOCK_RANK: Record<BlockTolerance, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

/** Severity at/above which a below-block finding is surfaced as a Comment. */
const TOLERANCE_SURFACE_RANK: Record<BlockTolerance, number> = {
  info: 0,
  warning: 1,
  error: 1,
};

/** True when `target` is less strict (looser) than `current` — higher block rank = looser. */
export function isLooser(
  target: BlockTolerance,
  current: BlockTolerance,
): boolean {
  return TOLERANCE_BLOCK_RANK[target] > TOLERANCE_BLOCK_RANK[current];
}

/**
 * Org-floor variant of `isLooser` where `null` means "no floor" — the loosest
 * possible state (repos may configure anything). Setting a floor where none
 * existed is always a tighten; clearing an existing floor is always a loosen.
 */
export function isLooserOrgFloor(
  target: BlockTolerance | null,
  current: BlockTolerance | null,
): boolean {
  if (target === current) return false;
  if (target === null) return current !== null;
  if (current === null) return false;
  return isLooser(target, current);
}

export type Consequence = "Request changes" | "Comment" | "Approve";

/** Verdict a finding of `severity` produces under a repo's `tolerance`. */
export function consequenceFor(
  tolerance: BlockTolerance,
  severity: Severity,
): Consequence {
  const rank = SEVERITY_RANK[severity];
  if (rank >= TOLERANCE_BLOCK_RANK[tolerance]) return "Request changes";
  if (rank >= TOLERANCE_SURFACE_RANK[tolerance]) return "Comment";
  return "Approve";
}

/** True when a finding of `severity` blocks (forces Request changes) under `tolerance`. */
export function blocksUnder(
  tolerance: BlockTolerance,
  severity: Severity,
): boolean {
  return SEVERITY_RANK[severity] >= TOLERANCE_BLOCK_RANK[tolerance];
}

/** The system-wide default a repo runs on with no explicit override. */
export const DEFAULT_TOLERANCE: BlockTolerance = "warning";

export const TOLERANCE_DESCRIPTOR: Record<BlockTolerance, string> = {
  info: "strictest",
  warning: "default",
  error: "most lenient",
};

export const TOLERANCE_COPY: Record<BlockTolerance, string> = {
  info: "Any finding, even informational, forces Request changes. Nothing is approved unless the review is completely clean.",
  warning:
    "Warning, error, and critical findings force Request changes. Info-only findings still allow Approve. This is the current default behavior.",
  error:
    "Only error and critical findings force Request changes. Warning findings are surfaced as review comments but don't block approval.",
};

export const INFO_WARNING_NOTE =
  "Info findings require verbatim quotes — expect stricter and occasionally noisier request-changes verdicts.";
