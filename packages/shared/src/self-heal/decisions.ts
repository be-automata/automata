/**
 * The self-heal decision vocabulary of the pinned decision log (www
 * decision-log.ts, LOG-01). Type-only and dependency free, so the benchmark
 * scorer reads stored decisions against the same literals the log writes.
 */

export type SelfHealDecision =
  | "create"
  | "update"
  | "close"
  | "reopen"
  | "skip"
  | "suppress"
  | "needs_human"
  | "comment"
  | "candidate"
  | "sighting"
  | "check"
  | "absence"
  | "claim"
  | "dispatch"
  | "pr_open"
  | "gate"
  | "guard"
  | "breaker";

/** Decisions that would have written to GitHub; logged as would_* in dry-run. */
export type SelfHealWouldDecision =
  | "would_create"
  | "would_update"
  | "would_close"
  | "would_reopen"
  | "would_needs_human"
  | "would_comment"
  | "would_dispatch";
