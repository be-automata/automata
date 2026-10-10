import type { DB } from "@terragon/shared/db";
import type {
  AuditEffectRow,
  AuditFindingRow,
} from "@terragon/shared/model/audit-findings";
import type * as outboxModel from "@terragon/shared/model/self-heal-outbox";
import type { EffectInput } from "@terragon/shared/model/self-heal-outbox";
import {
  getAuditRule,
  type AuditRule,
} from "@terragon/shared/self-heal/audit-rules";
import { redactSecrets } from "@terragon/utils/redact";

import {
  applyOutboxEffects,
  type ApplyOutboxDeps,
  type OutboxApplySummary,
} from "./apply-outbox";
import type {
  AuditLedger,
  FindingInsertInput,
  FindingPatch,
  LedgerBatch,
  RunDecision,
} from "./audit-ledger";
import {
  logSelfHealDecision,
  type SelfHealDecisionFields,
  type SelfHealLogMode,
} from "./decision-log";
import {
  decideAuditActions,
  planHash,
  type AuditAction,
  type CheckOutcome,
} from "./decide-audit-actions";
import type { IssueStateMap, IssueWriter } from "./issue-writer";
import type { ParsedAuditBlock, ParsedFinding } from "./parse-audit-findings";
import {
  FINDING_LABELS,
  renderAuditComment,
  renderIssueBody,
  renderIssueTitle,
  sanitizeAgentText,
  type AuditCommentKind,
} from "./render-issue";
import type { ResolvedSelfHeal } from "./resolve-self-heal";

/**
 * The writer's executor, split exactly as OUTBOX-01 requires: (1) decide and
 * persist every ledger change plus the outbox rows for every GitHub effect in
 * ONE bounded transaction, (2) drain this run's outbox under the caller's
 * deadline. A hook cut off at 20-30 s loses nothing: the decisions and the
 * intended effects are already durable and the cron drainer finishes them.
 *
 * `created` counts issues actually created (the applier's hook fired); the
 * other counters count decisions that are now durable, whether or not the
 * matching GitHub effect has been applied yet.
 */

const MAX_SUMMARY_DECISIONS = 100;
const DRAIN_CLAIM_LIMIT = 100;
const NO_FINGERPRINT = "-";

export interface AuditRenderers {
  title: typeof renderIssueTitle;
  body: typeof renderIssueBody;
  comment: typeof renderAuditComment;
}

export const DEFAULT_AUDIT_RENDERERS: AuditRenderers = {
  title: renderIssueTitle,
  body: renderIssueBody,
  comment: renderAuditComment,
};

export interface ActionsToEffectsContext {
  audit: string;
  runId: string;
  maxAttempts: number;
  rows: readonly AuditFindingRow[];
  ruleFor: (ruleId: string) => AuditRule | undefined;
  renderers?: AuditRenderers;
}

/** Maps decided actions to the GitHub effects the outbox will carry. */
export function actionsToEffects(
  actions: readonly AuditAction[],
  ctx: ActionsToEffectsContext,
): EffectInput[] {
  const renderers = ctx.renderers ?? DEFAULT_AUDIT_RENDERERS;
  const rowById = new Map(ctx.rows.map((r) => [r.id, r]));
  const rowByFp = new Map(ctx.rows.map((r) => [r.fingerprint, r]));
  const effects: EffectInput[] = [];

  const comment = (
    row: AuditFindingRow,
    kind: AuditCommentKind,
    issueNumber: number,
    marker: string,
  ): EffectInput => ({
    findingId: row.id,
    fingerprint: row.fingerprint,
    action: "upsert_comment",
    payload: {
      issueNumber,
      marker,
      body: renderers.comment(kind, {
        fingerprint: row.fingerprint,
        runId: ctx.runId,
        attempts: row.attempts,
        maxAttempts: ctx.maxAttempts,
      }),
    },
  });

  for (const action of actions) {
    switch (action.kind) {
      case "create_issue": {
        const rule = ctx.ruleFor(action.finding.rule);
        if (!rule) break;
        effects.push({
          findingId: rowByFp.get(action.fingerprint)?.id ?? null,
          fingerprint: action.fingerprint,
          action: "create_issue",
          payload: {
            title: renderers.title({
              audit: ctx.audit,
              finding: action.finding,
            }),
            body: renderers.body({
              audit: ctx.audit,
              fingerprint: action.fingerprint,
              finding: action.finding,
              rule,
            }),
            labels: action.labels,
            status: action.status,
            autoFix: action.autoFix,
            planHash: planHash(action.finding),
          },
        });
        break;
      }
      case "update_issue": {
        const rule = ctx.ruleFor(action.finding.rule);
        if (!rule) break;
        effects.push({
          findingId: action.findingId,
          fingerprint: action.finding.fingerprint,
          action: "update_issue",
          payload: {
            issueNumber: action.issueNumber,
            title: renderers.title({
              audit: ctx.audit,
              finding: action.finding,
            }),
            body: renderers.body({
              audit: ctx.audit,
              fingerprint: action.finding.fingerprint,
              finding: action.finding,
              rule,
            }),
          },
        });
        break;
      }
      case "close_issue": {
        const row = rowById.get(action.findingId);
        if (!row || action.alreadyClosed) break;
        effects.push(
          comment(
            row,
            "closed_check_passed",
            action.issueNumber,
            action.commentMarkerId,
          ),
          {
            findingId: row.id,
            fingerprint: row.fingerprint,
            action: "set_issue_state",
            payload: {
              issueNumber: action.issueNumber,
              state: "closed",
              stateReason: "completed",
            },
          },
        );
        break;
      }
      case "reopen_issue": {
        const row = rowById.get(action.findingId);
        if (!row) break;
        effects.push(
          {
            findingId: row.id,
            fingerprint: row.fingerprint,
            action: "set_issue_state",
            payload: { issueNumber: action.issueNumber, state: "open" },
          },
          comment(
            row,
            "reopened_check_failed",
            action.issueNumber,
            action.commentMarkerId,
          ),
        );
        break;
      }
      case "mark_needs_human": {
        const row = rowById.get(action.findingId);
        if (!row) break;
        effects.push(
          {
            findingId: row.id,
            fingerprint: row.fingerprint,
            action: "set_labels",
            payload: {
              issueNumber: action.issueNumber,
              add: [FINDING_LABELS.needsHumanReview],
              remove: [FINDING_LABELS.autoFix],
            },
          },
          comment(
            row,
            action.reason === "attempts_cap"
              ? "needs_human_attempts_cap"
              : "needs_human_rubric_absent",
            action.issueNumber,
            action.commentMarkerId,
          ),
        );
        break;
      }
      case "comment_still_present": {
        const row = rowById.get(action.findingId);
        if (!row) break;
        effects.push(
          comment(
            row,
            "still_present",
            action.issueNumber,
            action.commentMarkerId,
          ),
        );
        break;
      }
      default:
        break;
    }
  }
  return effects;
}

export type AuditExecutionOutcome =
  | "applied"
  | "applied_partial"
  | "dry_run"
  | "missing-permission"
  | "issues_unknown"
  | "error";

export interface AuditExecutionSummary {
  outcome: AuditExecutionOutcome;
  created: number;
  updated: number;
  closed: number;
  reopened: number;
  needsHuman: number;
  suppressed: number;
  pending: number;
  skipped: number;
  decisions: RunDecision[];
}

export interface ExecuteAuditDeps {
  db: DB;
  /** Numeric installation id as a string; scopes the hourly create count. */
  installationKey: string;
  ledger: AuditLedger;
  writer: IssueWriter;
  outbox: ApplyOutboxDeps["outbox"] &
    Pick<typeof outboxModel, "claimDueEffectsForRun">;
  breakers: ApplyOutboxDeps["breakers"];
  /** A complete line (decision lines) or a message plus structured fields. */
  log: (message: string, fields: Record<string, unknown>) => void;
  capture: (event: string, properties: Record<string, string>) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
  /**
   * Called once the decisions are durable, before the drain's first GitHub
   * write, so a caller cut off by its deadline can still record them.
   */
  onPersisted?: (decisions: RunDecision[]) => void;
}

export interface ExecuteAuditInput {
  organizationId: string;
  repoFullName: string;
  runId: string;
  audit: string;
  mode: "dry-run" | "on";
  block: ParsedAuditBlock;
  complete: boolean;
  /** Keyed by finding fingerprint. */
  checkResults: ReadonlyMap<string, CheckOutcome> | null;
  /** null = the issue listing failed (issues_unknown). */
  issues: IssueStateMap | null;
  settings: ResolvedSelfHeal;
  isPublicRepo: boolean;
  deadlineAt: Date;
}

interface DescribedDecision {
  fingerprint: string;
  decision: SelfHealDecisionFields["decision"];
  reason: string;
}

/** Decisions whose GitHub write is only intended in dry-run. */
const WOULD: Partial<
  Record<AuditAction["kind"], SelfHealDecisionFields["decision"]>
> = {
  create_issue: "would_create",
  update_issue: "would_update",
  close_issue: "would_close",
  reopen_issue: "would_reopen",
  mark_needs_human: "would_needs_human",
  comment_still_present: "would_comment",
};

function describeAction(
  action: AuditAction,
  rowById: ReadonlyMap<string, AuditFindingRow>,
  dryRun: boolean,
): DescribedDecision {
  const fpOf = (findingId: string): string =>
    rowById.get(findingId)?.fingerprint ?? NO_FINGERPRINT;
  const pick = (
    live: SelfHealDecisionFields["decision"],
  ): SelfHealDecisionFields["decision"] =>
    dryRun ? (WOULD[action.kind] ?? live) : live;
  switch (action.kind) {
    case "record_candidate":
      return {
        fingerprint: action.fingerprint,
        decision: "candidate",
        reason: "first_sighting",
      };
    case "record_sighting":
      return {
        fingerprint: fpOf(action.findingId),
        decision: "sighting",
        reason: action.sightings[0] === false ? "absent" : "seen",
      };
    case "create_issue":
      return {
        fingerprint: action.fingerprint,
        decision: pick("create"),
        reason: action.status === "needs_human" ? "rubric_only" : "consensus",
      };
    case "update_issue":
      return {
        fingerprint: fpOf(action.findingId),
        decision: pick("update"),
        reason: "plan_changed",
      };
    case "reopen_issue":
      return {
        fingerprint: fpOf(action.findingId),
        decision: pick("reopen"),
        reason: "check_failed",
      };
    case "close_issue":
      return {
        fingerprint: fpOf(action.findingId),
        decision: pick("close"),
        reason: action.alreadyClosed ? "already_closed" : "check_passed",
      };
    case "comment_still_present":
      return {
        fingerprint: fpOf(action.findingId),
        decision: pick("comment"),
        reason: "still_present",
      };
    case "mark_needs_human":
      return {
        fingerprint: fpOf(action.findingId),
        decision: pick("needs_human"),
        reason: action.reason,
      };
    case "mark_suppressed":
      return {
        fingerprint: fpOf(action.findingId),
        decision: "suppress",
        reason: action.reason,
      };
    case "record_check":
      return {
        fingerprint: fpOf(action.findingId),
        decision: "check",
        reason: action.outcome,
      };
    case "record_absence":
      return {
        fingerprint: fpOf(action.findingId),
        decision: "absence",
        reason: "rubric_absent",
      };
  }
}

function firstLine(text: string): string {
  return sanitizeAgentText(text).replace(/\s+/g, " ").trim();
}

function candidateInsert(
  repoFullName: string,
  runId: string,
  finding: ParsedFinding,
  rule: AuditRule | undefined,
  audit: string,
  sightings: boolean[],
): FindingInsertInput {
  return {
    repoFullName,
    fingerprint: finding.fingerprint,
    audit,
    ruleId: finding.rule,
    section: finding.section,
    severity: finding.severity,
    checkKind: rule?.checkKind ?? "rubric",
    title: firstLine(finding.title),
    subject: firstLine(finding.subject),
    findingKey: finding.key ?? null,
    planMd: sanitizeAgentText(finding.plan),
    acceptanceMd: sanitizeAgentText(finding.acceptance),
    planFiles: finding.files,
    status: "candidate",
    recentSightings: sightings,
    lastSeenRunId: runId,
    lastDecision: "candidate",
    lastDecisionReason: "first_sighting",
  };
}

interface BatchParts {
  inserts: FindingInsertInput[];
  patches: Map<string, FindingPatch>;
}

/**
 * Ledger bookkeeping for the decided actions. Dry-run keeps evidence
 * (sightings, streaks, absences, suppression read from GitHub) and skips every
 * status change that would diverge from a GitHub state nothing was written to.
 */
function buildBookkeeping({
  actions,
  rows,
  input,
  dryRun,
  now,
}: {
  actions: readonly AuditAction[];
  rows: readonly AuditFindingRow[];
  input: ExecuteAuditInput;
  dryRun: boolean;
  now: Date;
}): BatchParts {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const rowByFp = new Map(rows.map((r) => [r.fingerprint, r]));
  const inserts: FindingInsertInput[] = [];
  const patches = new Map<string, FindingPatch>();
  const patch = (findingId: string, next: FindingPatch): void => {
    patches.set(findingId, { ...patches.get(findingId), ...next });
  };
  const inserted = new Set<string>();

  for (const action of actions) {
    switch (action.kind) {
      case "record_candidate":
        inserted.add(action.fingerprint);
        inserts.push(
          candidateInsert(
            input.repoFullName,
            input.runId,
            action.finding,
            getAuditRule(action.finding.rule),
            input.audit,
            action.sightings,
          ),
        );
        break;
      case "record_sighting": {
        const seen = action.sightings[0] !== false;
        patch(action.findingId, {
          recentSightings: action.sightings,
          ...(seen ? { absentCount: 0, lastSeenRunId: input.runId } : {}),
        });
        break;
      }
      case "record_check":
        patch(action.findingId, {
          lastCheckOutcome: action.outcome,
          consecutiveCheckPasses: action.consecutivePasses,
        });
        break;
      case "record_absence":
        patch(action.findingId, {
          absentCount: action.absentCount,
          recentSightings: action.sightings,
        });
        break;
      case "mark_suppressed":
        patch(action.findingId, {
          status: "suppressed",
          autoFixLabeled: false,
          fixReadyAt: null,
          lastDecision: "suppress",
          lastDecisionReason: action.reason,
        });
        break;
      case "create_issue": {
        // A create always follows a candidate row (quorum needs two
        // sightings); insert one defensively so the effect has a finding.
        if (
          !rowByFp.has(action.fingerprint) &&
          !inserted.has(action.fingerprint)
        ) {
          inserted.add(action.fingerprint);
          inserts.push(
            candidateInsert(
              input.repoFullName,
              input.runId,
              action.finding,
              getAuditRule(action.finding.rule),
              input.audit,
              [true],
            ),
          );
        }
        break;
      }
      default:
        break;
    }
    if (dryRun) continue;
    switch (action.kind) {
      case "update_issue":
        patch(action.findingId, {
          planHash: planHash(action.finding),
          planMd: sanitizeAgentText(action.finding.plan),
          acceptanceMd: sanitizeAgentText(action.finding.acceptance),
          planFiles: action.finding.files,
          title: firstLine(action.finding.title),
          lastDecision: "update",
          lastDecisionReason: "plan_changed",
        });
        break;
      case "close_issue":
        patch(action.findingId, {
          status: "resolved",
          lastCheckOutcome: "pass",
          consecutiveCheckPasses:
            (rowById.get(action.findingId)?.consecutiveCheckPasses ?? 0) + 1,
          autoFixLabeled: false,
          fixReadyAt: null,
          lastDecision: "close",
          lastDecisionReason: "check_passed",
        });
        break;
      case "reopen_issue":
        patch(action.findingId, {
          status: "open",
          lastReopenedAt: now,
          lastDecision: "reopen",
          lastDecisionReason: "check_failed",
        });
        break;
      case "mark_needs_human":
        patch(action.findingId, {
          status: "needs_human",
          autoFixLabeled: false,
          fixReadyAt: null,
          lastDecision: "needs_human",
          lastDecisionReason: action.reason,
        });
        break;
      case "comment_still_present":
        patch(action.findingId, {
          lastDecision: `still_present:${action.attempts}`,
          lastDecisionReason: "still_present",
        });
        break;
      default:
        break;
    }
  }
  return { inserts, patches };
}

function countKind(
  actions: readonly AuditAction[],
  kind: AuditAction["kind"],
): number {
  return actions.filter((a) => a.kind === kind).length;
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export async function executeAuditFindings({
  deps,
  input,
}: {
  deps: ExecuteAuditDeps;
  input: ExecuteAuditInput;
}): Promise<AuditExecutionSummary> {
  const dryRun = input.mode === "dry-run";
  const logMode: SelfHealLogMode = input.mode;
  const summary: AuditExecutionSummary = {
    outcome: "error",
    created: 0,
    updated: 0,
    closed: 0,
    reopened: 0,
    needsHuman: 0,
    suppressed: 0,
    pending: 0,
    skipped: 0,
    decisions: [],
  };

  // ---- 1. decide (pure) over the ledger as it stands
  let rows: AuditFindingRow[];
  let actions: AuditAction[];
  let skippedByReason: Record<string, number>;
  try {
    const [listed, pendingCreates, openIssueCount] = await Promise.all([
      deps.ledger.list(),
      deps.ledger.pendingCreateFingerprints(),
      deps.ledger.countOpenIssues(),
    ]);
    rows = listed;
    const decided = decideAuditActions({
      run: {
        id: input.runId,
        complete: input.complete,
        checkResults: input.checkResults,
      },
      audit: input.audit,
      findings: input.block.findings,
      ledger: rows,
      issues: input.issues,
      pendingCreateFingerprints: pendingCreates,
      settings: {
        minSeverity: input.settings.minSeverity,
        maxOpenIssues: input.settings.maxOpenIssues,
        maxAttempts: input.settings.maxAttempts,
        autoLabel: input.settings.autoLabel,
        absentAudits: input.settings.absentAudits,
      },
      isPublicRepo: input.isPublicRepo,
      openIssueCount,
    });
    actions = decided.actions;
    skippedByReason = decided.skipped;
  } catch (error: unknown) {
    deps.log("[self-heal:execute] reading the ledger failed", {
      error: errorMessage(error),
    });
    return summary;
  }

  const rowById = new Map(rows.map((r) => [r.id, r]));
  const described = actions.map((a) => describeAction(a, rowById, dryRun));
  summary.decisions = described.slice(0, MAX_SUMMARY_DECISIONS).map((d) => ({
    fingerprint: d.fingerprint,
    action: d.decision,
    reason: d.reason,
  }));
  summary.updated = countKind(actions, "update_issue");
  summary.closed = countKind(actions, "close_issue");
  summary.reopened = countKind(actions, "reopen_issue");
  summary.needsHuman = countKind(actions, "mark_needs_human");
  summary.suppressed = countKind(actions, "mark_suppressed");
  summary.skipped = Object.values(skippedByReason).reduce(
    (sum, n) => sum + (n ?? 0),
    0,
  );

  // ---- 2. persist: bookkeeping + effects + decisions in ONE transaction
  const { inserts, patches } = buildBookkeeping({
    actions,
    rows,
    input,
    dryRun,
    now: deps.now(),
  });
  const effects = dryRun
    ? []
    : actionsToEffects(actions, {
        audit: input.audit,
        runId: input.runId,
        maxAttempts: input.settings.maxAttempts,
        rows,
        ruleFor: getAuditRule,
      });
  const batch: LedgerBatch = {
    inserts,
    patches: [...patches].map(([findingId, patch]) => ({ findingId, patch })),
    effects,
    runDecisions: summary.decisions,
  };
  try {
    await deps.ledger.persist(batch);
  } catch (error: unknown) {
    deps.log("[self-heal:execute] persisting the decisions failed", {
      error: errorMessage(error),
    });
    return summary;
  }
  deps.onPersisted?.(summary.decisions);

  // ---- 3. one log line + event per durable decision
  const emit = (fields: Omit<SelfHealDecisionFields, "mode">): void => {
    try {
      logSelfHealDecision(
        { log: (line) => deps.log(line, {}), capture: deps.capture },
        {
          ...fields,
          mode: logMode,
        },
      );
    } catch (error: unknown) {
      deps.log("[self-heal:execute] decision log failed", {
        error: errorMessage(error),
      });
    }
  };
  const base = {
    organizationId: input.organizationId,
    repoFullName: input.repoFullName,
    runId: input.runId,
  };
  for (const d of described) emit({ ...base, ...d });
  for (const [reason, count] of Object.entries(skippedByReason)) {
    for (let i = 0; i < (count ?? 0); i++) {
      emit({
        ...base,
        fingerprint: NO_FINGERPRINT,
        decision: "skip",
        reason,
      });
    }
  }

  if (dryRun) {
    summary.outcome = "dry_run";
    return summary;
  }

  // ---- 4. drain this run's outbox until the deadline
  let applied: OutboxApplySummary;
  try {
    const claimed = await deps.outbox.claimDueEffectsForRun({
      db: deps.db,
      organizationId: input.organizationId,
      runId: input.runId,
      now: deps.now(),
      limit: DRAIN_CLAIM_LIMIT,
    });
    if (claimed.length > 0) {
      await ensureLabelsBestEffort(deps, claimed);
    }
    applied = await applyOutboxEffects({
      effects: claimed,
      writer: deps.writer,
      deadlineAt: input.deadlineAt,
      mode: "on",
      deps: {
        db: deps.db,
        installationKey: deps.installationKey,
        outbox: deps.outbox,
        breakers: deps.breakers,
        now: deps.now,
        sleep: deps.sleep,
        rand: deps.rand,
        log: deps.log,
        onIssueCreated: async (effect, issueNumber) => {
          await deps.ledger.markIssueCreated(effect, issueNumber, deps.now());
          summary.created += 1;
        },
        issueNumberFor: (effect) => deps.ledger.issueNumberFor(effect),
      },
    });
  } catch (error: unknown) {
    deps.log("[self-heal:execute] draining the outbox failed", {
      error: errorMessage(error),
    });
    return summary;
  }

  summary.pending = applied.pending;
  if (applied.stoppedBy === "permission") {
    summary.outcome = "missing-permission";
  } else if (input.issues === null) {
    summary.outcome = "issues_unknown";
  } else if (applied.pending > 0) {
    summary.outcome = "applied_partial";
  } else {
    summary.outcome = "applied";
  }
  return summary;
}

/** Labels are created before use; a failure here surfaces on the write itself. */
export async function ensureLabelsBestEffort(
  deps: Pick<ExecuteAuditDeps, "writer" | "log">,
  claimed: readonly AuditEffectRow[],
): Promise<void> {
  const labels = new Set<string>();
  for (const effect of claimed) {
    const payload =
      typeof effect.payload === "object" && effect.payload !== null
        ? (effect.payload as Record<string, unknown>)
        : {};
    const source =
      effect.action === "create_issue"
        ? payload.labels
        : effect.action === "set_labels"
          ? payload.add
          : undefined;
    if (!Array.isArray(source)) continue;
    for (const label of source) {
      if (typeof label === "string") labels.add(label);
    }
  }
  if (labels.size === 0) return;
  const result = await deps.writer.ensureLabels([...labels]);
  if (!result.ok) {
    deps.log("[self-heal:execute] ensuring labels failed", {
      outcome: result.outcome,
    });
  }
}
