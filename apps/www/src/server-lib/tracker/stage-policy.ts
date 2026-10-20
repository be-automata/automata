import { JIRA_SUBTASK_LINK } from "./jira-client";
import {
  ALLOWED_STAGE_TARGETS,
  canonicalStage,
  decidePrimaryTransition,
  decideSiblingPromotion,
  decideSiblingPromotionWith,
  inlineCode,
  isClearedIssue,
  isTerminalIssue,
  sanitizeInline,
  type TransitionDecision,
} from "./merge-audit";
import type { MergeAuditTicket } from "./parse-merge-audit-intent";
import type { TrackerKind } from "./tracker-config";
import type { TrackerIssue, TrackerLinkedIssue } from "./youtrack-client";

/**
 * Per-tracker stage vocabulary for the post-merge audit (ADR-008). Pure.
 *
 * The executor is tracker-agnostic: every place it needs a stage name, a link
 * type or a "has this ticket moved on?" judgement it asks this object. YouTrack
 * keeps the board rules in merge-audit.ts unchanged; Jira's are below.
 */

export interface PrimaryTransitionInput {
  stage: string | null;
  resolved: boolean;
  audit: Pick<MergeAuditTicket, "taskComplete" | "remaining"> | null;
  openSubtasks: readonly TrackerLinkedIssue[];
}

interface StagedIssue {
  stage: string | null;
  resolved: boolean;
}

export interface TrackerStagePolicy {
  readonly kind: TrackerKind;
  /** The ONLY stage targets a decision may name. Checked again at the write. */
  readonly allowedTargets: readonly string[];
  /** Target of a completed merge; only that move probes the dependants. */
  readonly mergedTarget: string;
  /** Where a dependant goes once its final blocker merged. */
  readonly promotionTarget: string;
  /** Link type whose OUTWARD side lists the tickets this one blocks. */
  readonly dependLinkType: string;
  /** Link type whose OUTWARD side lists this ticket's subtasks. */
  readonly subtaskLinkType: string;
  /** Action shown for an open subtask that holds the ticket back. */
  readonly openSubtaskAction: string;
  decidePrimaryTransition(
    input: PrimaryTransitionInput,
  ): TransitionDecision<string>;
  decideSiblingPromotion(input: { mergedKey: string; sibling: TrackerIssue }): {
    promote: boolean;
    reason: string;
  };
  isTerminalIssue(issue: StagedIssue): boolean;
  isClearedIssue(issue: StagedIssue): boolean;
  /**
   * The stage to request for `target`, given the stages the tracker offers
   * right now (`null`: the tracker takes any name). `null` result: no
   * acceptable stage is reachable, so nothing is written.
   */
  resolveTarget(
    target: string,
    available: readonly string[] | null,
  ): string | null;
  /** Read-back: does the tracker now report the requested stage? */
  reached(stageAfter: string | null, requested: string): boolean;
}

// ---------------------------------------------------------------------------
// YouTrack — the board rules in merge-audit.ts, unchanged
// ---------------------------------------------------------------------------

export const youTrackStagePolicy: TrackerStagePolicy = {
  kind: "youtrack",
  allowedTargets: ALLOWED_STAGE_TARGETS,
  mergedTarget: "PR Merged",
  promotionTarget: "To Do",
  dependLinkType: "Depend",
  subtaskLinkType: "Subtask",
  openSubtaskAction: "Open — holds this ticket short of PR Merged",
  decidePrimaryTransition,
  decideSiblingPromotion,
  isTerminalIssue,
  isClearedIssue,
  resolveTarget: (target) => target,
  reached: (stageAfter, requested) => canonicalStage(stageAfter) === requested,
};

// ---------------------------------------------------------------------------
// Jira — the legacy `github-pr-merged-jira` semantics
// ---------------------------------------------------------------------------

/**
 * Jira workflows are per project, so statuses are matched by pattern, not a
 * fixed board. On merge: complete work → `Ready for QA`; work remaining →
 * a review state. Never `Done` — QA and release are human calls.
 */
export const JIRA_READY_FOR_QA = "Ready for QA";
export const JIRA_CODE_REVIEW = "Code Review";

const READY_FOR_QA_RE = /ready for qa/i;
const REVIEW_RE = /\b(?:code review|in review|ready for review|pr review)\b/i;
/** At or past QA: the merge has nothing left to move. */
const QA_OR_PAST_RE =
  /\b(?:qa|test(?:ing)?|uat|staging|ready for release|released?|deployed|done|closed|resolved|won'?t do|cancell?ed)\b/i;
const TERMINAL_RE = /\b(?:done|closed|resolved|won'?t do|cancell?ed)\b/i;
const NOT_STARTED_RE =
  /^(?:backlog|to do|todo|open|new|selected for development)$/i;

function jiraIsTerminal(issue: StagedIssue): boolean {
  return issue.resolved || TERMINAL_RE.test(issue.stage ?? "");
}

/** A blocker stops holding other work once its code is merged and in QA. */
function jiraIsCleared(issue: StagedIssue): boolean {
  return issue.resolved || QA_OR_PAST_RE.test(issue.stage ?? "");
}

export function decideJiraPrimaryTransition({
  stage,
  resolved,
  audit,
  openSubtasks,
}: PrimaryTransitionInput): TransitionDecision<string> {
  const unchanged = (note: string): TransitionDecision<string> => ({
    target: null,
    note,
  });
  const current = stage?.trim() ?? "";
  if (!current) {
    return unchanged("The ticket has no status; left as is.");
  }
  if (resolved) {
    return unchanged(
      "The ticket is already resolved; a human decides whether to reopen.",
    );
  }
  if (QA_OR_PAST_RE.test(current)) {
    return unchanged(
      READY_FOR_QA_RE.test(current)
        ? "Already there, no move needed."
        : "Merged after the ticket reached this status; a human decides whether to reopen.",
    );
  }
  if (audit === null) {
    return unchanged("No audit was emitted for this ticket.");
  }

  const incompleteReason = !audit.taskComplete
    ? sanitizeInline(audit.remaining ?? "", 200) ||
      "work remaining on this ticket"
    : openSubtasks.length > 0
      ? `open subtasks: ${openSubtasks.map((issue) => issue.key).join(", ")}`
      : null;

  if (incompleteReason !== null) {
    // Split across PRs: the merged part waits in review, never in QA or Done.
    return REVIEW_RE.test(current)
      ? unchanged(`Held in ${inlineCode(current)} — ${incompleteReason}.`)
      : {
          target: JIRA_CODE_REVIEW,
          note: `Held short of \`${JIRA_READY_FOR_QA}\` — ${incompleteReason}. Moved to review while the rest of the ticket is delivered.`,
        };
  }

  return {
    target: JIRA_READY_FOR_QA,
    note: NOT_STARTED_RE.test(current)
      ? `Merged straight from ${inlineCode(current)} — \`In Progress\` and review were skipped.`
      : "`Done` still needs QA and a human sign-off.",
  };
}

export const jiraStagePolicy: TrackerStagePolicy = {
  kind: "jira",
  allowedTargets: [JIRA_READY_FOR_QA, JIRA_CODE_REVIEW, "To Do"],
  mergedTarget: JIRA_READY_FOR_QA,
  promotionTarget: "To Do",
  dependLinkType: "Blocks",
  subtaskLinkType: JIRA_SUBTASK_LINK,
  openSubtaskAction: `Open — holds this ticket short of ${JIRA_READY_FOR_QA}`,
  decidePrimaryTransition: decideJiraPrimaryTransition,
  decideSiblingPromotion: ({ mergedKey, sibling }) =>
    decideSiblingPromotionWith({
      mergedKey,
      sibling,
      isBacklog: (stage) => /^backlog$/i.test(stage?.trim() ?? ""),
      dependLinkType: "Blocks",
      isCleared: jiraIsCleared,
    }),
  isTerminalIssue: jiraIsTerminal,
  isClearedIssue: jiraIsCleared,
  resolveTarget(target, available) {
    // Jira always reports its transitions; without them nothing is chosen.
    if (available === null) return null;
    const first = (pattern: RegExp) =>
      available.find((name) => pattern.test(name)) ?? null;
    switch (target) {
      case JIRA_READY_FOR_QA:
        // A workflow without a QA status still records the merge as reviewed.
        return first(READY_FOR_QA_RE) ?? first(REVIEW_RE);
      case JIRA_CODE_REVIEW:
        return first(REVIEW_RE);
      case "To Do":
        return first(/^to do$/i);
      default:
        return null;
    }
  },
  reached: (stageAfter, requested) =>
    (stageAfter ?? "").trim().toLowerCase() === requested.trim().toLowerCase(),
};

export function stagePolicyFor(kind: TrackerKind): TrackerStagePolicy {
  switch (kind) {
    case "youtrack":
      return youTrackStagePolicy;
    case "jira":
      return jiraStagePolicy;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unsupported tracker kind: ${String(exhaustive)}`);
    }
  }
}
