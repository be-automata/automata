import {
  ALLOWED_STAGE_TARGETS,
  canonicalStage,
  decidePrimaryTransition,
  inlineCode,
  isClearedIssue,
  isTerminalIssue,
  sanitizeInline,
  type SiblingPromotionVocabulary,
  type TransitionDecision,
} from "./merge-audit";
import type { MergeAuditTicket } from "./parse-merge-audit-intent";
import type { TrackerKind } from "./tracker-config";
import { sameName, type TrackerLinkedIssue } from "./tracker-types";

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

/** The stage to request, and whether it stands in for the target itself. */
export interface ResolvedStage {
  stage: string;
  /**
   * True when the workflow has no transition into the target and the policy
   * chose a lesser stage instead — the target was NOT reached.
   */
  fallback: boolean;
}

interface StagedIssue {
  stage: string | null;
  resolved: boolean;
}

/** Where a dependant goes once its final blocker merged, on every tracker. */
export const PROMOTION_TARGET = "To Do";

export interface TrackerStagePolicy extends SiblingPromotionVocabulary {
  /** The ONLY stage targets a decision may name. Checked again at the write. */
  readonly allowedTargets: readonly string[];
  /** Target of a completed merge; only that move probes the dependants. */
  readonly mergedTarget: string;
  /** Link type whose OUTWARD side lists the tickets this one blocks. */
  readonly dependLinkType: string;
  /** Link type whose OUTWARD side lists this ticket's subtasks. */
  readonly subtaskLinkType: string;
  decidePrimaryTransition(input: PrimaryTransitionInput): TransitionDecision;
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
  ): ResolvedStage | null;
  /** Read-back: does the tracker now report the requested stage? */
  reached(stageAfter: string | null, requested: string): boolean;
}

// ---------------------------------------------------------------------------
// YouTrack — the board rules in merge-audit.ts, unchanged
// ---------------------------------------------------------------------------

export const youTrackStagePolicy: TrackerStagePolicy = {
  allowedTargets: ALLOWED_STAGE_TARGETS,
  mergedTarget: "PR Merged",
  dependLinkType: "Depend",
  subtaskLinkType: "Subtask",
  decidePrimaryTransition,
  isBacklog: (stage) => canonicalStage(stage) === "Backlog",
  isTerminalIssue,
  isClearedIssue,
  resolveTarget: (target) => ({ stage: target, fallback: false }),
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
/** Canonical link-type name the audit policy reads for Jira sub-tasks. */
export const JIRA_SUBTASK_LINK = "Subtask";

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
}: PrimaryTransitionInput): TransitionDecision {
  const unchanged = (note: string): TransitionDecision => ({
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
  allowedTargets: [JIRA_READY_FOR_QA, JIRA_CODE_REVIEW, PROMOTION_TARGET],
  mergedTarget: JIRA_READY_FOR_QA,
  dependLinkType: "Blocks",
  subtaskLinkType: JIRA_SUBTASK_LINK,
  decidePrimaryTransition: decideJiraPrimaryTransition,
  isBacklog: (stage) => /^backlog$/i.test(stage?.trim() ?? ""),
  isTerminalIssue: jiraIsTerminal,
  isClearedIssue: jiraIsCleared,
  resolveTarget(target, available) {
    // Jira always reports its transitions; without them nothing is chosen.
    if (available === null) return null;
    const first = (pattern: RegExp, fallback = false): ResolvedStage | null => {
      const stage = available.find((name) => pattern.test(name));
      return stage === undefined ? null : { stage, fallback };
    };
    switch (target) {
      case JIRA_READY_FOR_QA:
        // A workflow without a QA status still records the merge as reviewed
        // — a fallback: the ticket is NOT ready for QA.
        return first(READY_FOR_QA_RE) ?? first(REVIEW_RE, true);
      case JIRA_CODE_REVIEW:
        return first(REVIEW_RE);
      case PROMOTION_TARGET:
        return first(/^to do$/i);
      default:
        return null;
    }
  },
  reached: (stageAfter, requested) => sameName(stageAfter ?? "", requested),
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
