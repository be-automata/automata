import { redactSecrets } from "@terragon/utils/redact";
import {
  CLOSE_CONSECUTIVE_PASSES,
  type AuditRule,
} from "@terragon/shared/self-heal/audit-rules";

import type { ParsedFinding } from "./parse-audit-findings";

/**
 * The platform owns all Markdown published to GitHub for self-heal. Agent text
 * only ever reaches an issue or comment through sanitizeAgentText. Pure: no IO.
 *
 * `needs_human` is the internal DB status token and is never rendered; the
 * only rendered label for the attempts cap and rubric-only findings is
 * `needs-human-approve` (operator decision 2026-10-04).
 */

export const FINDING_LABELS = {
  finding: "automata:finding",
  autoFix: "automata:auto-fix",
  needsHumanApprove: "needs-human-approve",
  wontfix: "automata:wontfix",
  paused: "automata:paused",
  audit: (audit: string): string => `audit:${audit}`,
} as const;

export const MAX_BODY_CHARS = 30_000;
export const MAX_TITLE_CHARS = 200;
const MAX_URLS = 10;
const PLAN_TRUNCATION_MARKER = "\n\n_[plan truncated by the platform]_";

export const FINDING_MARKER_RE = /^<!-- automata-finding:v1 fp=([\w-]+) -->/;
export const COMMENT_MARKER_RE =
  /^<!-- automata-finding-comment:v1 fp=([\w-]+) kind=(\w+) run=([\w-]+) -->/;

export function findingMarker(fingerprint: string): string {
  return `<!-- automata-finding:v1 fp=${fingerprint} -->`;
}

export function commentMarker(input: {
  fp: string;
  kind: string;
  runId: string;
}): string {
  return `<!-- automata-finding-comment:v1 fp=${input.fp} kind=${input.kind} run=${input.runId} -->`;
}

const CLOSING_KEYWORD_RE =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)(?:(?:#|[\w.-]+\/[\w.-]+#)(\d+)|https?:\/\/github\.com\/\S+\/issues\/(\d+))/gi;
const MENTION_RE = /(^|[^\w`/@])@([A-Za-z0-9][\w-]*(?:\/[\w.-]+)?)/g;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;

/** The single gate for untrusted agent text. */
export function sanitizeAgentText(text: string): string {
  let out = redactSecrets(text);
  out = out.replace(/<!--|-->/g, "");
  out = out.replace(
    CLOSING_KEYWORD_RE,
    (_m, keyword: string, _sp: string, num?: string, urlNum?: string) =>
      `${keyword} issue ${num ?? urlNum ?? ""}`.trimEnd(),
  );
  out = out.replace(MENTION_RE, (_m, pre: string, name: string) => {
    return `${pre}\`@${name}\``;
  });
  let urls = 0;
  out = out.replace(URL_RE, (url) => {
    urls += 1;
    return urls > MAX_URLS ? "[link removed]" : url;
  });
  out = out.replace(/^([ \t]*)```/gm, "$1    ```");
  return out;
}

function oneLine(text: string): string {
  return sanitizeAgentText(text).replace(/\s+/g, " ").trim();
}

export function renderIssueTitle(input: {
  audit: string;
  finding: Pick<ParsedFinding, "title">;
}): string {
  return `[${input.audit}] ${oneLine(input.finding.title)}`.slice(
    0,
    MAX_TITLE_CHARS,
  );
}

export function renderIssueBody(input: {
  audit: string;
  fingerprint: string;
  finding: ParsedFinding;
  rule: AuditRule;
}): string {
  const { finding, rule, fingerprint } = input;
  const files = finding.files
    .map((file) => `- \`${oneLine(file).replace(/`/g, "")}\``)
    .join("\n");
  const acceptanceLines =
    rule.checkKind === "script"
      ? [`Deterministic check: ${rule.checkDescription}`]
      : ["Rubric-only: a person confirms resolution"];
  const agentAcceptance = sanitizeAgentText(finding.acceptance).trim();
  if (agentAcceptance) acceptanceLines.push("", agentAcceptance);

  const head = [
    findingMarker(fingerprint),
    "",
    "## Finding",
    "",
    oneLine(finding.title),
    "",
    `- Audit: \`${input.audit}\``,
    `- Rule: \`${rule.id}\``,
    `- Severity: ${finding.severity}`,
    `- Subject: \`${oneLine(finding.subject).replace(/`/g, "")}\``,
    `- Effort: ${finding.effort}`,
    "",
    "## Plan",
    "",
  ].join("\n");
  const tail = [
    "",
    "",
    "## Files",
    "",
    files || "_none listed_",
    "",
    "## Acceptance",
    "",
    acceptanceLines.join("\n").slice(0, 4_000),
    "",
    `Filed by Automata self-heal from audit fingerprint \`${fingerprint}\`. Do not edit the first line.`,
  ].join("\n");

  const budget = MAX_BODY_CHARS - head.length - tail.length;
  let plan = sanitizeAgentText(finding.plan).trim();
  if (plan.length > budget) {
    plan =
      plan.slice(0, Math.max(0, budget - PLAN_TRUNCATION_MARKER.length)) +
      PLAN_TRUNCATION_MARKER;
  }
  return (head + plan + tail).slice(0, MAX_BODY_CHARS);
}

export type AuditCommentKind =
  | "reopened_check_failed"
  | "closed_check_passed"
  | "still_present"
  | "needs_human_attempts_cap"
  | "needs_human_rubric_absent"
  | "fix_attempt_rejected"
  | "fix_draft_withdrawn"
  | "fix_draft_no_repo_ci"
  | "fix_pr_expired";

/**
 * Why a self-heal change attempt did not become a pull request. Only these
 * platform tokens are ever rendered; anything else is dropped.
 */
export const FIX_ATTEMPT_REJECTION_TEXT: Readonly<Record<string, string>> = {
  suppression_comment: "it added a comment that silences a linter or scanner",
  test_edit: "it changed or deleted an existing test",
  ci_edit: "it changed a CI definition",
  audit_config_edit: "it changed audit or lint configuration",
  deleted_flagged_code: "it deleted the flagged code without a replacement",
  out_of_plan_file: "it changed files outside the plan",
  denied_path: "it changed a protected path",
  diff_too_large: "the change is larger than the configured limit",
  patch_unavailable: "GitHub did not return a diff that could be inspected",
  sha_mismatch: "the branch moved after the check ran",
  no_changes: "the branch has no changes against the default branch",
  no_branch: "no branch was pushed",
  check_failed: "the finding's check did not pass on the pushed commit",
  open_failed: "a draft pull request could not be opened",
  ci_failed: "the repository's CI failed on the draft pull request",
  ci_infra:
    "the repository's CI was cancelled or could not start (not counted against the limit)",
  ci_stuck:
    "the repository's CI did not finish within an hour (not counted against the limit)",
};

export interface AuditCommentData {
  fingerprint: string;
  runId: string;
  attempts?: number;
  maxAttempts?: number;
  /** fix_attempt_rejected: platform reason tokens (FIX_ATTEMPT_REJECTION_TEXT). */
  reasons?: readonly string[];
  /** fix_attempt_rejected: the attempt branch, when it is kept for a person. */
  keptBranch?: string;
  /** fix_attempt_rejected / fix_draft_withdrawn: a draft PR existed. */
  draftNumber?: number;
  /** fix_draft_withdrawn: whether the attempt counts toward the limit. */
  counted?: boolean;
  /** fix_pr_expired: the repo's unreviewed-PR expiry window in days. */
  expiryDays?: number;
}

function rejectionLines(reasons: readonly string[] | undefined): string[] {
  const lines = (reasons ?? [])
    .map((reason) => FIX_ATTEMPT_REJECTION_TEXT[reason])
    .filter((line): line is string => line !== undefined)
    .map((line) => `- ${line}`);
  return lines.length > 0 ? lines : ["- unspecified"];
}

export function renderAuditComment(
  kind: AuditCommentKind,
  data: AuditCommentData,
): string {
  const marker = commentMarker({
    fp: data.fingerprint,
    kind,
    runId: data.runId,
  });
  const attempts = data.attempts ?? 0;
  const max = data.maxAttempts ?? attempts;
  let text: string;
  switch (kind) {
    case "reopened_check_failed":
      text =
        "The deterministic check for this finding fails again on the latest complete audit, so this issue is reopened.";
      break;
    case "closed_check_passed":
      text = `The deterministic check passed on ${CLOSE_CONSECUTIVE_PASSES} consecutive complete audits; this issue is now complete.`;
      break;
    case "still_present":
      text = `The finding is still present after attempt ${attempts} of ${max}.`;
      break;
    case "needs_human_attempts_cap":
      text = `Automated attempts reached the cap (${attempts} of ${max}). Labelled \`${FINDING_LABELS.needsHumanApprove}\`; a person needs to take over.`;
      break;
    case "needs_human_rubric_absent":
      text = `Later audits no longer report this rubric-only finding. Only a person can confirm resolution; labelled \`${FINDING_LABELS.needsHumanApprove}\`.`;
      break;
    case "fix_attempt_rejected": {
      const branch =
        data.keptBranch !== undefined
          ? `The branch \`${data.keptBranch.replace(/[`\r\n]/g, "")}\` is kept for a person to pick up.`
          : data.draftNumber !== undefined
            ? `The draft pull request #${data.draftNumber} was withdrawn before review and the attempt branch was deleted.`
            : "No pull request was opened and the attempt branch was deleted.";
      text = [
        `Automated change attempt ${attempts} of ${max} was not proposed:`,
        "",
        ...rejectionLines(data.reasons),
        "",
        branch,
      ].join("\n");
      break;
    }
    case "fix_draft_withdrawn":
      text = [
        `Automata self-heal withdrew this draft before review (attempt ${attempts} of ${max}):`,
        "",
        ...rejectionLines(data.reasons),
        "",
        "The attempt branch was deleted.",
        data.counted === false
          ? "This attempt does not count against the limit."
          : "This attempt counts against the limit.",
      ].join("\n");
      break;
    case "fix_draft_no_repo_ci":
      text = [
        "No repository CI reported a check on this commit within 10 minutes, so the only gate was the finding's own deterministic check on a clean checkout.",
        "",
        `Labelled \`${FINDING_LABELS.needsHumanApprove}\`: a person should run the project's tests before merging.`,
      ].join("\n");
      break;
    case "fix_pr_expired":
      text = `Withdrawn: no human review within ${data.expiryDays ?? 0} days. The finding stays open and may be retried.`;
      break;
  }
  return `${marker}\n${text}`;
}
