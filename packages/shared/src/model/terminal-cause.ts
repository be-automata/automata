import { assertNever } from "../utils";

/**
 * Typed terminal causes for remote review runs (#125 C4). ONE union, used by
 * the worker's terminal post (mirrored structurally in
 * packages/worker/src/agent-run/types.ts — never imported across planes), the
 * supersede sweep, the generation fence, and the thread-view chips (C5).
 * Adding a cause without mapping it below fails compilation (assertNever).
 */
export const TERMINAL_CAUSES = [
  "superseded",
  "discarded",
  "stale-skipped",
  "user-cancelled",
  "timeout",
  "daemon-failed",
  "publish-failed",
  "plane-offline",
] as const;
export type TerminalCause = (typeof TERMINAL_CAUSES)[number];

export function isTerminalCause(value: string): value is TerminalCause {
  return (TERMINAL_CAUSES as readonly string[]).includes(value);
}

/**
 * Human wording per cause — the single place the chips and audit read. The
 * exhaustive switch is the compile-time guard the AC asks for.
 */
export function describeTerminalCause(cause: TerminalCause): {
  label: string;
  detail: string;
} {
  switch (cause) {
    case "superseded":
      return {
        label: "Superseded",
        detail: "A newer commit started a new review; this run was cancelled.",
      };
    case "discarded":
      return {
        label: "Discarded",
        detail:
          "A review was already running for this PR; this newer run was dropped by policy.",
      };
    case "stale-skipped":
      return {
        label: "Skipped (stale)",
        detail:
          "A newer run was already queued for this PR, so this one skipped itself before starting.",
      };
    case "user-cancelled":
      return { label: "Cancelled", detail: "Cancelled by a user." };
    case "timeout":
      return {
        label: "Timed out",
        detail: "The run exceeded its schedule or execution timeout.",
      };
    case "daemon-failed":
      return {
        label: "Failed",
        detail: "The agent daemon failed before reaching a verdict.",
      };
    case "publish-failed":
      return {
        label: "Publish failed",
        detail: "The verdict was produced but could not be posted to GitHub.",
      };
    case "plane-offline":
      return {
        label: "Execution plane offline",
        detail:
          "The run was dispatched but never became visible on the execution plane.",
      };
    default:
      return assertNever(cause);
  }
}

/**
 * Causes that mean the run was ABANDONED before it could produce a verdict —
 * by policy (a newer run took the PR) or by a user. Nothing it did or didn't
 * say is evidence about the PR, so the review sweep must never speak for it:
 * treating one of these as "a stalled run whose verdict got lost" makes the
 * sweep post a `⚠️ intent could not be parsed` COMMENT at whatever the live
 * HEAD happens to be — a false "a human should review this PR" alarm on a
 * commit the abandoned run never saw (observed on #140, 2026-08-25).
 *
 * The complement (`timeout`, `daemon-failed`, `publish-failed`, and a NULL
 * cause — a dropped finish event) IS sweepable: that run owned the PR and
 * either has a persisted verdict to republish or genuinely failed to reach one.
 */
export const ABANDONED_TERMINAL_CAUSES = [
  "superseded",
  "discarded",
  "stale-skipped",
  "user-cancelled",
  "plane-offline",
] as const satisfies readonly TerminalCause[];

/** True when a terminal cause means the run was abandoned (see above). */
export function isAbandonedTerminalCause(cause: string | null): boolean {
  return (
    cause !== null &&
    (ABANDONED_TERMINAL_CAUSES as readonly string[]).includes(cause)
  );
}
