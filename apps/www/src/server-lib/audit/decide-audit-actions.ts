import { createHash } from "node:crypto";

import type { AuditFindingRow } from "@terragon/shared/model/audit-findings";
import {
  severityRank,
  type SelfHealSeverity,
} from "@terragon/shared/model/self-heal-settings";
import {
  CLOSE_CONSECUTIVE_PASSES,
  getAuditRule,
} from "@terragon/shared/self-heal/audit-rules";

import { hasQuorum, pushSighting } from "@terragon/shared/self-heal/consensus";
import type { ParsedFinding } from "./parse-audit-findings";
import {
  FINDING_LABELS,
  commentMarker,
  sanitizeAgentText,
  type AuditCommentKind,
} from "./render-issue";

/**
 * Pure reconcile of one complete-or-not audit run against the ledger and the
 * GitHub issue state. No IO. Per ledger row the order is: suppression (only
 * when issue state is known) -> paused -> incomplete-run gate -> check outcome
 * -> sighting/absence -> attempts cap / still-present comment.
 *
 * H4-01 failure-path rules: a check "error" or a missing check result never
 * moves a streak; an incomplete run never moves a streak, an absence count or a
 * sighting window; `issues === null` (issues_unknown) disables every decision
 * that depends on GitHub state (close, reopen, needs-human, suppress, update).
 *
 * `record_sighting` also zeroes the row's absent_count (the finding was seen).
 * `status` "needs_human" is the internal DB token; the rendered label is
 * `needs-human-review`.
 */

export type AuditSkipReason =
  | "below_severity"
  | "public_repo_filtered"
  | "open_cap"
  | "consensus_pending"
  | "check_disagrees"
  | "checks_missing"
  | "incomplete_audit_no_progress"
  | "issues_unknown"
  | "create_pending"
  | "paused";

export type CheckOutcome = "pass" | "fail" | "error";

export type AuditAction =
  | {
      kind: "record_candidate";
      fingerprint: string;
      finding: ParsedFinding;
      sightings: boolean[];
    }
  | { kind: "record_sighting"; findingId: string; sightings: boolean[] }
  | {
      kind: "create_issue";
      fingerprint: string;
      finding: ParsedFinding;
      labels: string[];
      status: "open" | "needs_human";
      autoFix: boolean;
    }
  | {
      kind: "update_issue";
      findingId: string;
      issueNumber: number;
      finding: ParsedFinding;
    }
  | {
      kind: "reopen_issue";
      findingId: string;
      issueNumber: number;
      commentMarkerId: string;
    }
  | {
      kind: "close_issue";
      findingId: string;
      issueNumber: number;
      alreadyClosed: boolean;
      commentMarkerId: string;
    }
  | {
      kind: "comment_still_present";
      findingId: string;
      issueNumber: number;
      attempts: number;
      commentMarkerId: string;
    }
  | {
      kind: "mark_needs_human";
      findingId: string;
      issueNumber: number;
      reason: "attempts_cap" | "rubric_absent";
      commentMarkerId: string;
    }
  | {
      kind: "mark_suppressed";
      findingId: string;
      reason: "wontfix_label" | "closed_not_planned";
    }
  | {
      kind: "record_check";
      findingId: string;
      outcome: CheckOutcome;
      consecutivePasses: number;
    }
  | {
      kind: "record_absence";
      findingId: string;
      absentCount: number;
      sightings: boolean[];
    };

export interface IssueSnapshot {
  state: "open" | "closed";
  stateReason: string | null;
  labels: string[];
}

export interface DecideAuditActionsInput {
  run: {
    id: string;
    complete: boolean;
    /** Keyed by finding fingerprint. */
    checkResults: ReadonlyMap<string, CheckOutcome> | null;
  };
  audit: string;
  findings: ParsedFinding[];
  ledger: AuditFindingRow[];
  /** null = the issue listing failed (issues_unknown). */
  issues: ReadonlyMap<number, IssueSnapshot> | null;
  pendingCreateFingerprints: ReadonlySet<string>;
  settings: {
    minSeverity: SelfHealSeverity;
    maxOpenIssues: number;
    maxAttempts: number;
    autoLabel: boolean;
    absentAudits: number;
  };
  isPublicRepo: boolean;
  openIssueCount: number;
}

export interface DecideAuditActionsResult {
  actions: AuditAction[];
  skipped: Partial<Record<AuditSkipReason, number>>;
}

/** Hash of what the issue body is rendered from, to detect plan drift. */
export function planHash(
  finding: Pick<ParsedFinding, "plan" | "acceptance">,
): string {
  return createHash("sha256")
    .update(sanitizeAgentText(finding.plan))
    .update("\n")
    .update(sanitizeAgentText(finding.acceptance))
    .digest("hex");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function decideAuditActions(
  input: DecideAuditActionsInput,
): DecideAuditActionsResult {
  const { run, settings, issues } = input;
  const actions: AuditAction[] = [];
  const skipped: Partial<Record<AuditSkipReason, number>> = {};
  const skip = (reason: AuditSkipReason): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  const findingsByFp = new Map<string, ParsedFinding>();
  for (const finding of [...input.findings].sort((a, b) =>
    compareText(a.fingerprint, b.fingerprint),
  )) {
    if (!findingsByFp.has(finding.fingerprint)) {
      findingsByFp.set(finding.fingerprint, finding);
    }
  }
  const rowsByFp = new Map<string, AuditFindingRow>();
  for (const row of [...input.ledger].sort((a, b) =>
    compareText(a.fingerprint, b.fingerprint),
  )) {
    if (row.audit === input.audit) rowsByFp.set(row.fingerprint, row);
  }

  const comment = (row: AuditFindingRow, kind: AuditCommentKind): string =>
    commentMarker({ fp: row.fingerprint, kind, runId: run.id });

  const fingerprints = [
    ...new Set([...findingsByFp.keys(), ...rowsByFp.keys()]),
  ].sort(compareText);

  interface Eligible {
    fingerprint: string;
    finding: ParsedFinding;
    row: AuditFindingRow | undefined;
    sightings: boolean[];
    script: boolean;
  }
  const eligible: Eligible[] = [];

  for (const fingerprint of fingerprints) {
    const finding = findingsByFp.get(fingerprint);
    const row = rowsByFp.get(fingerprint);
    const rule = getAuditRule(row?.ruleId ?? finding?.rule ?? "");
    if (!rule) continue;
    if (row?.status === "suppressed") continue;

    const tracked = row !== undefined && row.status !== "candidate";

    if (tracked) {
      reconcileTracked(row, finding, rule.checkKind === "script");
      continue;
    }

    // Candidate path: a finding with no row, or a row still a candidate.
    if (!run.complete) {
      skip("incomplete_audit_no_progress");
      continue;
    }
    if (!finding) {
      if (row) {
        actions.push({
          kind: "record_sighting",
          findingId: row.id,
          sightings: pushSighting(row.recentSightings, false),
        });
      }
      continue;
    }
    if (severityRank(finding.severity) < severityRank(settings.minSeverity)) {
      skip("below_severity");
      continue;
    }
    if (input.isPublicRepo && !rule.publicSafe) {
      skip("public_repo_filtered");
      continue;
    }
    const sightings = pushSighting(row?.recentSightings ?? [], true);
    const recordSighting = (): void => {
      actions.push(
        row
          ? { kind: "record_sighting", findingId: row.id, sightings }
          : { kind: "record_candidate", fingerprint, finding, sightings },
      );
    };
    if (!hasQuorum(sightings)) {
      skip("consensus_pending");
      recordSighting();
      continue;
    }
    const script = rule.checkKind === "script";
    if (script) {
      const outcome = run.checkResults?.get(fingerprint);
      if (outcome === undefined || outcome === "error") {
        skip("checks_missing");
        recordSighting();
        continue;
      }
      if (outcome === "pass") {
        skip("check_disagrees");
        recordSighting();
        continue;
      }
    }
    if (input.pendingCreateFingerprints.has(fingerprint)) {
      skip("create_pending");
      recordSighting();
      continue;
    }
    if (issues === null && input.pendingCreateFingerprints.size > 0) {
      skip("issues_unknown");
      recordSighting();
      continue;
    }
    eligible.push({ fingerprint, finding, row, sightings, script });
  }

  // Open-issue cap: highest severity first, then fingerprint ascending.
  eligible.sort(
    (a, b) =>
      severityRank(b.finding.severity) - severityRank(a.finding.severity) ||
      compareText(a.fingerprint, b.fingerprint),
  );
  let slots = Math.max(0, settings.maxOpenIssues - input.openIssueCount);
  for (const item of eligible) {
    const { fingerprint, finding, row, sightings, script } = item;
    if (row) {
      actions.push({ kind: "record_sighting", findingId: row.id, sightings });
    }
    if (slots <= 0) {
      skip("open_cap");
      continue;
    }
    slots -= 1;
    const autoFix = script && settings.autoLabel;
    const labels = [
      FINDING_LABELS.finding,
      FINDING_LABELS.audit(input.audit),
      ...(script ? [] : [FINDING_LABELS.needsHumanReview]),
      ...(autoFix ? [FINDING_LABELS.autoFix] : []),
    ];
    actions.push({
      kind: "create_issue",
      fingerprint,
      finding,
      labels,
      status: script ? "open" : "needs_human",
      autoFix,
    });
  }

  return { actions, skipped };

  function reconcileTracked(
    row: AuditFindingRow,
    finding: ParsedFinding | undefined,
    script: boolean,
  ): void {
    const seen = finding !== undefined;
    const issueNumber = row.issueNumber;
    const gh =
      issues !== null && issueNumber !== null
        ? issues.get(issueNumber)
        : undefined;

    if (gh && issueNumber !== null) {
      if (gh.labels.includes(FINDING_LABELS.wontfix)) {
        actions.push({
          kind: "mark_suppressed",
          findingId: row.id,
          reason: "wontfix_label",
        });
        return;
      }
      if (gh.state === "closed" && gh.stateReason === "not_planned") {
        actions.push({
          kind: "mark_suppressed",
          findingId: row.id,
          reason: "closed_not_planned",
        });
        return;
      }
      if (gh.labels.includes(FINDING_LABELS.paused)) {
        skip("paused");
        return;
      }
    }

    if (!run.complete) {
      skip("incomplete_audit_no_progress");
      return;
    }

    const recordSeen = (): void => {
      if (seen) {
        actions.push({
          kind: "record_sighting",
          findingId: row.id,
          sightings: pushSighting(row.recentSightings, true),
        });
      }
    };

    if (issueNumber === null) {
      recordSeen();
      return;
    }
    if (!gh) {
      skip("issues_unknown");
      recordSeen();
      return;
    }

    recordSeen();
    if (
      finding &&
      gh.state === "open" &&
      (row.status === "open" || row.status === "needs_human") &&
      row.planHash !== planHash(finding)
    ) {
      actions.push({
        kind: "update_issue",
        findingId: row.id,
        issueNumber,
        finding,
      });
    }

    let stillPresent = false;
    if (script) {
      const outcome = run.checkResults?.get(row.fingerprint);
      if (outcome === undefined) {
        skip("checks_missing");
        return;
      }
      if (outcome === "error") return;
      if (outcome === "pass") {
        if (row.status === "resolved") return;
        const next = row.consecutiveCheckPasses + 1;
        if (next >= CLOSE_CONSECUTIVE_PASSES) {
          actions.push({
            kind: "close_issue",
            findingId: row.id,
            issueNumber,
            alreadyClosed: gh.state === "closed",
            commentMarkerId: comment(row, "closed_check_passed"),
          });
        } else {
          actions.push({
            kind: "record_check",
            findingId: row.id,
            outcome: "pass",
            consecutivePasses: next,
          });
        }
        return;
      }
      // outcome === "fail"
      if (gh.state === "closed") {
        actions.push({
          kind: "reopen_issue",
          findingId: row.id,
          issueNumber,
          commentMarkerId: comment(row, "reopened_check_failed"),
        });
        actions.push({
          kind: "record_check",
          findingId: row.id,
          outcome: "fail",
          consecutivePasses: 0,
        });
        return;
      }
      if (row.consecutiveCheckPasses !== 0 || row.lastCheckOutcome !== "fail") {
        actions.push({
          kind: "record_check",
          findingId: row.id,
          outcome: "fail",
          consecutivePasses: 0,
        });
      }
      stillPresent = true;
    } else {
      if (gh.state !== "open") return;
      if (!seen) {
        if (row.status !== "open") return;
        const absentCount = row.absentCount + 1;
        if (absentCount >= settings.absentAudits) {
          actions.push({
            kind: "mark_needs_human",
            findingId: row.id,
            issueNumber,
            reason: "rubric_absent",
            commentMarkerId: comment(row, "needs_human_rubric_absent"),
          });
        } else {
          actions.push({
            kind: "record_absence",
            findingId: row.id,
            absentCount,
            sightings: pushSighting(row.recentSightings, false),
          });
        }
        return;
      }
      stillPresent = true;
    }

    if (!stillPresent || row.status === "needs_human") return;
    if (row.attempts >= settings.maxAttempts) {
      actions.push({
        kind: "mark_needs_human",
        findingId: row.id,
        issueNumber,
        reason: "attempts_cap",
        commentMarkerId: comment(row, "needs_human_attempts_cap"),
      });
    } else if (
      row.attempts >= 1 &&
      row.lastDecision !== `still_present:${row.attempts}`
    ) {
      actions.push({
        kind: "comment_still_present",
        findingId: row.id,
        issueNumber,
        attempts: row.attempts,
        commentMarkerId: comment(row, "still_present"),
      });
    }
  }
}
