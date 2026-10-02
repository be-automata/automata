import { escapeRegExp } from "./extract-ticket-keys";
import type {
  CriterionVerdict,
  MergeAuditCriterion,
  MergeAuditTicket,
} from "./parse-merge-audit-intent";
import type { TrackerIssue, TrackerLinkedIssue } from "./youtrack-client";

/**
 * Pure policy + rendering for the post-merge audit (ADR-008). No I/O.
 *
 * Everything that decides WHAT may be written to the tracker lives here, so the
 * rules are unit-testable and cannot be talked around by a skill body: the
 * agent emits verdicts, this module turns them into (at most) one of three
 * stage targets.
 */

/** The board's stages, in workflow order. Matched case-insensitively. */
const STAGE_ORDER = [
  "Backlog",
  "To Do",
  "In Progress",
  "PR Review",
  "PR Merged",
  "Staging (TF)",
  "Done",
  "Won't do",
] as const;

type KnownStage = (typeof STAGE_ORDER)[number];

/**
 * The ONLY stages this feature may ever move a ticket into. `Done` needs
 * production evidence, `Staging (TF)` and `Won't do` are human calls — none of
 * them is reachable from here, whatever the audit says.
 */
export const ALLOWED_STAGE_TARGETS = [
  "In Progress",
  "PR Merged",
  "To Do",
] as const;

export type AllowedStageTarget = (typeof ALLOWED_STAGE_TARGETS)[number];

const TERMINAL_STAGES: ReadonlySet<KnownStage> = new Set(["Done", "Won't do"]);

export function canonicalStage(
  stage: string | null | undefined,
): KnownStage | null {
  if (!stage) return null;
  const wanted = stage.trim().toLowerCase();
  return STAGE_ORDER.find((known) => known.toLowerCase() === wanted) ?? null;
}

function isAtOrPastMerged(stage: KnownStage): boolean {
  return STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf("PR Merged");
}

function isNotStarted(stage: KnownStage): boolean {
  return stage === "Backlog" || stage === "To Do";
}

interface StagedIssue {
  stage: string | null;
  resolved: boolean;
}

export function isTerminalIssue(issue: StagedIssue): boolean {
  const stage = canonicalStage(issue.stage);
  return issue.resolved || (stage !== null && TERMINAL_STAGES.has(stage));
}

/**
 * A blocker (or a subtask) stops holding other work once its code is merged:
 * resolved, or at/past `PR Merged`. Without this a ticket with two blockers is
 * never promoted — when the second merges, the first sits at `PR Merged`, not
 * `Done`, and would still read as open.
 */
export function isClearedIssue(issue: StagedIssue): boolean {
  const stage = canonicalStage(issue.stage);
  return issue.resolved || (stage !== null && isAtOrPastMerged(stage));
}

/** The issues linked to `issue` by one link type, read from one side. */
export function linksOf(
  issue: TrackerIssue,
  typeName: string,
  direction: "OUTWARD" | "INWARD",
): TrackerLinkedIssue[] {
  return issue.links
    .filter(
      (link) => link.typeName === typeName && link.direction === direction,
    )
    .flatMap((link) => link.issues);
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

interface AuditScore {
  /** met + partial + notMet — the denominator. */
  verifiable: number;
  /** met + 0.5 × partial. */
  points: number;
  /** Rounded percentage, or null when nothing was verifiable from code. */
  percent: number | null;
  notVerifiable: number;
  /** partial / not_met criteria with no recorded conscious acceptance. */
  unacknowledgedMisses: number;
}

function isMiss(criterion: MergeAuditCriterion): boolean {
  return criterion.verdict === "partial" || criterion.verdict === "not_met";
}

export function scoreCriteria(
  criteria: readonly MergeAuditCriterion[],
): AuditScore {
  const count = (verdict: CriterionVerdict) =>
    criteria.filter((criterion) => criterion.verdict === verdict).length;
  const met = count("met");
  const partial = count("partial");
  const verifiable = met + partial + count("not_met");
  const points = met + partial * 0.5;
  return {
    verifiable,
    points,
    percent: verifiable === 0 ? null : Math.round((points / verifiable) * 100),
    notVerifiable: count("not_verifiable"),
    unacknowledgedMisses: criteria.filter(
      (criterion) => isMiss(criterion) && !criterion.acceptedBy?.trim(),
    ).length,
  };
}

export function formatScore(score: AuditScore): string {
  const parts = [
    score.percent === null
      ? "no criteria verifiable from code"
      : `${score.points}/${score.verifiable} verifiable criteria met (${score.percent}%)`,
  ];
  if (score.notVerifiable > 0) {
    parts.push(`${score.notVerifiable} not verifiable from code`);
  }
  if (score.unacknowledgedMisses > 0) {
    parts.push(
      `${score.unacknowledgedMisses} unacknowledged miss${score.unacknowledgedMisses === 1 ? "" : "es"}`,
    );
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Stage decisions
// ---------------------------------------------------------------------------

export interface TransitionDecision {
  target: AllowedStageTarget | null;
  /** One line explaining the decision, shown in both comments. */
  note: string;
}

export function decidePrimaryTransition({
  stage,
  resolved,
  audit,
  openSubtasks,
}: {
  stage: string | null;
  resolved: boolean;
  /** The agent's audit entry for this ticket, if it emitted one. */
  audit: Pick<MergeAuditTicket, "taskComplete" | "remaining"> | null;
  openSubtasks: readonly TrackerLinkedIssue[];
}): TransitionDecision {
  const unchanged = (note: string): TransitionDecision => ({
    target: null,
    note,
  });

  const current = canonicalStage(stage);
  if (current === null) {
    return unchanged(
      `Unrecognised stage ${inlineCode(stage ?? "none")}; left as is.`,
    );
  }
  if (isAtOrPastMerged(current)) {
    return unchanged(
      current === "PR Merged"
        ? "Already there, no move needed."
        : "Merged after the ticket reached this stage; a human decides whether to reopen.",
    );
  }
  if (resolved) {
    return unchanged(
      "The ticket is already resolved; a human decides whether to reopen.",
    );
  }
  if (audit === null) {
    return unchanged("No audit was emitted for this ticket.");
  }

  // `remaining` is agent-authored and lands in both comments via the note, so
  // it is sanitised here, at the one place it enters.
  const incompleteReason = !audit.taskComplete
    ? sanitizeInline(audit.remaining ?? "", 200) ||
      "work remaining on this ticket"
    : openSubtasks.length > 0
      ? `open subtasks: ${openSubtasks.map((issue) => issue.key).join(", ")}`
      : null;

  if (incompleteReason !== null) {
    // Forward-only: a held ticket still reflects that work started.
    return isNotStarted(current)
      ? {
          target: "In Progress",
          note: `Held short of \`PR Merged\` — ${incompleteReason}. Moved to \`In Progress\` to reflect active work.`,
        }
      : unchanged(`Held in \`${current}\` — ${incompleteReason}.`);
  }

  return {
    target: "PR Merged",
    note: isNotStarted(current)
      ? `Merged straight from \`${current}\` — \`In Progress\` and \`PR Review\` were skipped.`
      : "`Done` still needs production evidence.",
  };
}

/**
 * A `Backlog` ticket that depends on the just-merged one is promoted to
 * `To Do` only when this merge cleared its LAST open blocker.
 *
 * Anti-vacuous guard: the merged key must itself appear among the sibling's
 * blockers. That also makes the rule safe against a mis-read link direction —
 * if the relation were the other way round, the guard fails and nothing moves.
 */
export function decideSiblingPromotion({
  mergedKey,
  sibling,
}: {
  mergedKey: string;
  sibling: TrackerIssue;
}): { promote: boolean; reason: string } {
  if (canonicalStage(sibling.stage) !== "Backlog") {
    return {
      promote: false,
      reason: `in ${inlineCode(sibling.stage ?? "unknown")}, not \`Backlog\``,
    };
  }
  const blockers = linksOf(sibling, "Depend", "INWARD");
  if (!blockers.some((blocker) => blocker.key === mergedKey)) {
    return {
      promote: false,
      reason: `${mergedKey} is not listed among its blockers`,
    };
  }
  const stillOpen = blockers.filter(
    (blocker) => blocker.key !== mergedKey && !isClearedIssue(blocker),
  );
  if (stillOpen.length > 0) {
    return {
      promote: false,
      reason: `other blockers still open: ${stillOpen.map((blocker) => blocker.key).join(", ")}`,
    };
  }
  return { promote: true, reason: "final blocker merged" };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const MAX_CRITERIA_ROWS = 20;
const MAX_PR_COMMENT_CHARS = 60_000;

/** Written as a code point so the source carries no invisible character. */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

const VERDICT_LABEL: Record<CriterionVerdict, string> = {
  met: "met",
  partial: "partially met",
  not_met: "not met",
  not_verifiable: "not verifiable from code",
};

/** Table-only: a mark to scan a long criteria table by, misses in bold. */
const VERDICT_CELL: Record<CriterionVerdict, string> = {
  met: "✅ met",
  partial: "🟡 **partially met**",
  not_met: "❌ **not met**",
  // Short: the full phrase wraps to four lines in the verdict column, and the
  // completion line above the table already spells it out.
  not_verifiable: "➖ not verifiable",
};

/** So `AC-1` does not wrap as `AC-` / `1` in a narrow first column. */
const NON_BREAKING_HYPHEN = String.fromCharCode(0x2011);

/** First line of the record left on a ticket — see `isMergeRecord`. */
const MERGE_RECORD_PREFIX = "PR merged: ";
/** Phrase shared by both notices left on a dependant — see `isBlockerNotice`. */
const BLOCKER_NOTICE_PHRASE = "merged via ";

/** Hidden marker that makes the PR comment a single, updatable record. */
export function mergeAuditMarker(prNumber: number): string {
  return `<!-- automata:pr-merged-audit:${prNumber} -->`;
}

/**
 * Cuts at the last space inside the window so a line never ends mid-word
 * ("no devel…"). A single long token with no usable space is hard-cut.
 */
function clipAtWord(text: string, maxLength: number): string {
  const window = text.slice(0, maxLength - 1);
  const lastSpace = window.lastIndexOf(" ");
  const cut =
    lastSpace >= maxLength * 0.6 ? window.slice(0, lastSpace) : window;
  return `${cut.replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * Agent- and ticket-authored text is rendered into comments posted under the
 * bot's name, so it is treated as untrusted: collapsed to one line, truncated,
 * `<` escaped, and `@mentions` defused so an audit can never page anyone.
 *
 * Escaping `<` does two jobs. It keeps the hidden marker unique (no injected
 * HTML comment), and it keeps the text intact: Markdown renderers treat
 * `<sha>` or `<date>` as an HTML tag and drop it, which silently turned
 * `--send <sha>` into `--send` in real evidence.
 */
export function sanitizeInline(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const clipped =
    collapsed.length > maxLength ? clipAtWord(collapsed, maxLength) : collapsed;
  // Escaped after clipping, so an entity is never cut in half.
  return (
    clipped
      .replace(/</g, "&lt;")
      // No live link or image under the bot's name from ticket or agent text.
      .replace(/[[\]]/g, "\\$&")
      .replace(/@(?=[A-Za-z0-9_-])/g, `@${ZERO_WIDTH_SPACE}`)
  );
}

function tableCell(text: string, maxLength: number): string {
  // Backslashes first: an existing `\|` would otherwise become `\\|`, which
  // renders as a literal backslash followed by a cell break.
  return sanitizeInline(text, maxLength)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

/** Tracker- or agent-supplied text shown as inline code. */
function inlineCode(text: string): string {
  return `\`${sanitizeInline(text, 40).replace(/`/g, "'")}\``;
}

function followUpSuffix(followUp: string | undefined): string {
  return followUp?.trim() ? ` → follow-up ${sanitizeInline(followUp, 80)}` : "";
}

/** `AC-3 — not met`, the shared head of a miss line in either comment. */
function missHead(criterion: MergeAuditCriterion): string {
  return `${sanitizeInline(criterion.id, 40)} — ${VERDICT_LABEL[criterion.verdict]}`;
}

export interface LinkedTicketAction {
  key: string;
  relation: string;
  stage: string | null;
  action: string;
}

export interface TicketAuditResult {
  key: string;
  url: string;
  summary: string;
  stageBefore: string | null;
  stageAfter: string | null;
  decision: TransitionDecision;
  /** True when the stage write was performed and read back as the target. */
  transitionApplied: boolean;
  audit: MergeAuditTicket | null;
  linked: LinkedTicketAction[];
  /** Tracker failures for this ticket (status only — never a response body). */
  errors: string[];
}

function renderStageLine(result: TicketAuditResult, live: boolean): string {
  const before = inlineCode(result.stageBefore ?? "unknown");
  const { target, note } = result.decision;
  if (target === null) {
    return `**Stage:** ${before} (unchanged) — ${note}`;
  }
  if (!live) {
    return `**Stage:** ${before} → would move to \`${target}\` — ${note}`;
  }
  if (!result.transitionApplied) {
    return `**Stage:** ${before} → ${inlineCode(result.stageAfter ?? "unknown")} (move to \`${target}\` did not apply) — ${note}`;
  }
  return `**Stage:** ${before} → \`${target}\` — ${note}`;
}

function renderMissLine(criterion: MergeAuditCriterion): string {
  const accepted = criterion.acceptedBy?.trim();
  return accepted
    ? `- ${missHead(criterion)} — accepted: "${sanitizeInline(accepted, 200)}"${followUpSuffix(criterion.followUp)}`
    : `- ${missHead(criterion)} — **not acknowledged** in the PR or the ticket`;
}

function renderTicketSection(result: TicketAuditResult, live: boolean): string {
  const lines: string[] = [
    `### [${result.key}](${result.url}) · ${sanitizeInline(result.summary, 120)}`,
    "",
    renderStageLine(result, live),
  ];

  const { audit } = result;
  if (audit === null) {
    lines.push("", "_No audit was emitted for this ticket._");
  } else if (audit.criteria.length === 0) {
    lines.push(
      "",
      "_No auditable acceptance criteria were found on the ticket._",
    );
  } else {
    const source =
      audit.acSource === "formal"
        ? ""
        : " _(no formal acceptance criteria; audited against the summary and description)_";
    lines.push(
      `**Completion:** ${formatScore(scoreCriteria(audit.criteria))}${source}`,
      "",
      "| # | Criterion | Verdict | Evidence |",
      "|---|---|---|---|",
    );
    for (const criterion of audit.criteria.slice(0, MAX_CRITERIA_ROWS)) {
      lines.push(
        `| ${tableCell(criterion.id, 40).replace(/-/g, NON_BREAKING_HYPHEN)} | ${tableCell(criterion.text, 160)} | ${VERDICT_CELL[criterion.verdict]} | ${tableCell(criterion.evidence ?? "", 240)} |`,
      );
    }
    if (audit.criteria.length > MAX_CRITERIA_ROWS) {
      lines.push(
        `| … | ${audit.criteria.length - MAX_CRITERIA_ROWS} more criteria not shown | | |`,
      );
    }
    const misses = audit.criteria.filter(isMiss);
    if (misses.length > 0) {
      lines.push(
        "",
        "**Misses**",
        ...misses.slice(0, MAX_CRITERIA_ROWS).map(renderMissLine),
      );
    }
  }

  const deviations = audit?.deviations ?? [];
  if (deviations.length > 0) {
    lines.push(
      "",
      "**Deviations from the ticket**",
      ...deviations
        .slice(0, MAX_CRITERIA_ROWS)
        .map(
          (deviation) =>
            `- ${sanitizeInline(deviation.summary, 200)} — ${deviation.acknowledged ? "acknowledged" : "**not acknowledged**"}${followUpSuffix(deviation.followUp)}`,
        ),
    );
  }

  if (result.linked.length > 0) {
    lines.push(
      "",
      "**Linked tickets**",
      "| Key | Relation | Stage | Action |",
      "|---|---|---|---|",
      ...result.linked.map(
        (linked) =>
          `| ${tableCell(linked.key, 40)} | ${tableCell(linked.relation, 40)} | ${tableCell(linked.stage ?? "unknown", 40)} | ${tableCell(linked.action, 120)} |`,
      ),
    );
  }

  if (result.errors.length > 0) {
    lines.push(
      "",
      ...result.errors.map(
        (error) => `> Tracker error: ${sanitizeInline(error, 160)}`,
      ),
    );
  }
  return lines.join("\n");
}

function commentHeader(prNumber: number): string[] {
  return [mergeAuditMarker(prNumber), "## Post-merge ticket audit"];
}

export function renderPrComment({
  prNumber,
  results,
  live,
  truncatedKeys,
  referenced = [],
}: {
  prNumber: number;
  results: readonly TicketAuditResult[];
  live: boolean;
  /** True when the PR delivers more tickets than the cap. */
  truncatedKeys: boolean;
  /** Tickets the PR only mentions: listed with a link, never audited. */
  referenced?: ReadonlyArray<{ key: string; url: string }>;
}): string {
  const lines = commentHeader(prNumber);
  if (!live) {
    lines.push(
      "",
      "> Shadow mode — no tracker writes were made. Stage moves and ticket comments below are what a live run would do.",
    );
  }
  for (const result of results) {
    lines.push("", renderTicketSection(result, live));
  }
  if (referenced.length > 0) {
    lines.push(
      "",
      `Also referenced, not audited: ${referenced.map(({ key, url }) => `[${key}](${url})`).join(", ")}`,
    );
  }
  if (truncatedKeys) {
    lines.push(
      "",
      "_This PR references more tickets than are audited automatically; the rest need a manual check._",
    );
  }
  // GitHub rejects a comment over 65,536 characters, after the tracker
  // writes are already done.
  return lines.join("\n").slice(0, MAX_PR_COMMENT_CHARS);
}

/** A PR comment that carries a single notice instead of an audit. */
export function renderNoticeComment(prNumber: number, notice: string): string {
  return [...commentHeader(prNumber), "", notice].join("\n");
}

/**
 * True when a ticket comment is THIS feature's record of the given PR's merge.
 *
 * Matches the bot's own first line, not a bare URL: a developer pasting the PR
 * link into the ticket must not suppress the audit record, and `(?!\d)` keeps
 * `/pull/41` from matching inside `/pull/412`.
 */
export function isMergeRecord(commentText: string, prUrl: string): boolean {
  return new RegExp(
    `(?:^|\\n)${escapeRegExp(MERGE_RECORD_PREFIX + prUrl)}(?!\\d)`,
  ).test(commentText);
}

/** The same test for either notice left on a ticket that depended on the merge. */
export function isBlockerNotice(commentText: string, prUrl: string): boolean {
  return new RegExp(
    `${escapeRegExp(BLOCKER_NOTICE_PHRASE + prUrl)}(?!\\d)`,
  ).test(commentText);
}

export function renderPromotionComment(
  mergedKey: string,
  prUrl: string,
): string {
  return `Auto-promoted: Backlog → To Do — final blocker ${mergedKey} ${BLOCKER_NOTICE_PHRASE}${prUrl} and no other blockers remain.`;
}

export function renderBlockerNotice(
  mergedKey: string,
  prUrl: string,
  reason: string,
): string {
  return `Blocker ${mergedKey} was ${BLOCKER_NOTICE_PHRASE}${prUrl}. Not promoted automatically: ${reason.replace(/`/g, "")}.`;
}

/**
 * The short record left on the ticket. Lists misses only — watchers should not
 * have to re-read the full checklist. Its first line is the idempotency marker
 * `isMergeRecord` looks for.
 */
export function renderTrackerComment({
  prUrl,
  mergedBy,
  result,
}: {
  prUrl: string;
  mergedBy: string | null;
  result: TicketAuditResult;
}): string {
  const by = mergedBy ? ` (merged by ${sanitizeInline(mergedBy, 40)})` : "";
  const { target, note } = result.decision;
  const stageLine =
    target !== null && result.transitionApplied
      ? `Stage: ${sanitizeInline(result.stageBefore ?? "unknown", 40)} → ${target}.`
      : `Stage: ${sanitizeInline(result.stageAfter ?? result.stageBefore ?? "unknown", 40)} (unchanged).`;
  const lines: string[] = [
    `${MERGE_RECORD_PREFIX}${prUrl}${by}`,
    `${stageLine} ${note.replace(/`/g, "")}`,
    "",
  ];

  const criteria = result.audit?.criteria ?? [];
  if (criteria.length === 0) {
    lines.push("No auditable acceptance criteria were found on this ticket.");
  } else {
    lines.push(`Completion: ${formatScore(scoreCriteria(criteria))}.`);
    const misses = criteria.filter(isMiss);
    for (const criterion of misses) {
      const accepted = criterion.acceptedBy?.trim();
      lines.push(
        `- [ ] ${missHead(criterion)}: ${sanitizeInline(criterion.text, 240)}${
          accepted
            ? ` (accepted: "${sanitizeInline(accepted, 160)}"${followUpSuffix(criterion.followUp)})`
            : " (not acknowledged in the PR)"
        }`,
      );
    }
    if (misses.length === 0) {
      lines.push("All criteria verifiable from code are met.");
    }
  }

  const unacknowledged = (result.audit?.deviations ?? []).filter(
    (deviation) => !deviation.acknowledged,
  );
  if (unacknowledged.length > 0) {
    lines.push(
      "",
      "Changes in the PR not described by this ticket:",
      ...unacknowledged.map(
        (deviation) => `- ${sanitizeInline(deviation.summary, 200)}`,
      ),
    );
  }

  lines.push("", `[Full audit with evidence on the PR](${prUrl})`);
  return lines.join("\n");
}
