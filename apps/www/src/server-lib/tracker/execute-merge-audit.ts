import { extractTicketKeys } from "./extract-ticket-keys";
import {
  decideSiblingPromotion,
  isBlockerNotice,
  isMergeRecord,
  linksOf,
  type LinkedTicketAction,
  inlineCode,
  mergeAuditMarker,
  renderBlockerNotice,
  renderNoticeComment,
  renderPrComment,
  renderPromotionComment,
  renderTrackerComment,
  type TicketAuditResult,
} from "./merge-audit";
import {
  type MergeAuditIntent,
  parseMergeAuditIntent,
} from "./parse-merge-audit-intent";
import {
  PROMOTION_TARGET,
  type ResolvedStage,
  stagePolicyFor,
  type TrackerStagePolicy,
} from "./stage-policy";
import type { TrackerConfig } from "./tracker-config";
import {
  describeTrackerError,
  type TrackerClient,
  type TrackerIssue,
  type TrackerLinkedIssue,
  TrackerTransitionError,
} from "./youtrack-client";

/**
 * The control-plane executor for the post-merge audit (ADR-008). Called from
 * the thread-finish hook for a `github-pr-merged` skill thread.
 *
 * Single writer: the agent emitted verdicts and nothing else. This function
 * re-derives which tickets the PR DELIVERS from GitHub's own PR fields (a
 * ticket it merely mentions is listed, never audited or written to), re-reads
 * each one, and performs every write — one marker comment on the PR, and
 * (only when the repo's `AUTOMATA_TRACKER_WRITES` is `live`) the tracker
 * comment, the stage move and dependant promotion.
 *
 * The finish hook fires on EVERY terminal turn of the thread — a retry after a
 * rate limit, a follow-up question from the owner, a redelivered webhook's
 * second thread — so re-runs are the normal case, not an edge:
 *   - a ticket is never moved once it is at or past `PR Merged`;
 *   - a tracker comment is skipped when the ticket already carries this
 *     feature's record of the PR;
 *   - a NOTICE (no ticket, no tracker, no usable result) never replaces an
 *     existing audit comment;
 *   - a re-run that changes nothing leaves the existing audit comment alone,
 *     because it could only re-render it with LESS (the original stage move
 *     and linked-ticket actions are no longer observable).
 */

/** Dependants probed per ticket. Past this the ticket is an epic-style hub. */
const MAX_LINKED_TICKETS = 10;

export interface MergedPullRequest {
  title: string;
  body: string | null;
  headBranch: string;
  htmlUrl: string;
  mergedBy: string | null;
}

/**
 * `replace`     — create the bot's marker comment or update it in place;
 * `create-only` — create it, but leave an existing one untouched.
 */
export type MarkerCommentMode = "replace" | "create-only";

export type MarkerCommentResult = "created" | "updated" | "kept_existing";

/** The one GitHub write this feature performs. */
export interface AuditCommentClient {
  upsertMarkerComment(
    marker: string,
    body: string,
    mode: MarkerCommentMode,
  ): Promise<MarkerCommentResult>;
}

export interface MergeAuditLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export type MergeAuditOutcome =
  | {
      outcome: "posted";
      tickets: number;
      /** Tickets the agent emitted an audit for. */
      audited: number;
      transitions: number;
      live: boolean;
    }
  /** An earlier run already did everything; the posted audit was left alone. */
  | { outcome: "skipped_already_recorded"; tickets: number }
  /** This turn had nothing to post, and an earlier comment is already there. */
  | { outcome: "skipped_existing_comment" }
  | { outcome: "degraded_comment"; reason: string }
  | { outcome: "no_ticket" }
  | { outcome: "tracker_unconfigured" };

/**
 * The ONLY place a stage is written, and it always reads the result back: the
 * command API accepts text a workflow then rejects or ignores, so "applied"
 * means the tracker now reports the target — not that the request returned.
 *
 * The runtime allowlist check keeps the policy's closed set of targets true
 * for any caller. A tracker that moves by transitions (Jira) is asked which
 * stages are reachable, and the policy picks the concrete one — or none, and
 * nothing is written.
 */
async function applyStage(
  policy: TrackerStagePolicy,
  tracker: TrackerClient,
  key: string,
  target: string,
): Promise<{
  applied: boolean;
  stageAfter: string | null;
  requested: ResolvedStage;
}> {
  if (!policy.allowedTargets.includes(target)) {
    throw new Error(`stage target not allowed: ${String(target)}`);
  }
  const available = tracker.listStageTargets
    ? await tracker.listStageTargets(key)
    : null;
  const requested = policy.resolveTarget(target, available);
  if (requested === null) {
    throw new TrackerTransitionError(target);
  }
  await tracker.setStage(key, requested.stage);
  const stageAfter = await tracker.getStage(key);
  return {
    applied: policy.reached(stageAfter, requested.stage),
    stageAfter,
    requested,
  };
}

/** An intent that parses AND is about this PR — not the skill's example. */
function parseUsableIntent(
  terminalText: string,
  prNumber: number,
): { ok: true; intent: MergeAuditIntent } | { ok: false; reason: string } {
  const parsed = parseMergeAuditIntent(terminalText);
  if (parsed.ok && parsed.intent.pr !== prNumber) {
    return {
      ok: false,
      reason: `intent is for PR #${parsed.intent.pr}, not #${prNumber}`,
    };
  }
  return parsed;
}

interface AuditContext {
  policy: TrackerStagePolicy;
  tracker: TrackerClient;
  prUrl: string;
  live: boolean;
  logger: MergeAuditLogger;
}

/** One ticket that depended on the merged one: notify its owner, or promote it. */
async function probeDependant(
  { policy, tracker, prUrl, live }: AuditContext,
  mergedKey: string,
  dependant: TrackerLinkedIssue,
): Promise<Pick<LinkedTicketAction, "stage" | "action">> {
  if (policy.isTerminalIssue(dependant)) {
    return { stage: dependant.stage, action: "Skipped (already resolved)" };
  }
  const sibling = await tracker.getIssue(dependant.key);
  const { stage } = sibling;
  if (
    sibling.comments.some((comment) => isBlockerNotice(comment.text, prUrl))
  ) {
    return { stage, action: "Already notified" };
  }
  const promotion = decideSiblingPromotion(policy, { mergedKey, sibling });
  if (!promotion.promote) {
    if (live) {
      await tracker.addComment(
        sibling.key,
        renderBlockerNotice(mergedKey, prUrl, promotion.reason),
      );
    }
    return {
      stage,
      action: `${live ? "Notified" : "Would notify"} — ${promotion.reason}`,
    };
  }
  const target = PROMOTION_TARGET;
  if (!live) {
    return {
      stage,
      action: `Would promote → ${target} (final blocker merged)`,
    };
  }
  const { applied } = await applyStage(policy, tracker, sibling.key, target);
  if (!applied) {
    return { stage, action: `Promotion to ${target} did not apply` };
  }
  await tracker.addComment(
    sibling.key,
    renderPromotionComment(mergedKey, prUrl),
  );
  return { stage, action: `Promoted → ${target} (final blocker merged)` };
}

/**
 * Tickets that depend on the just-merged one. Probed concurrently — each is an
 * independent chain of requests against a different ticket — and capped.
 */
async function probeDependants(
  context: AuditContext,
  issue: TrackerIssue,
): Promise<LinkedTicketAction[]> {
  const dependants = [
    ...new Map(
      linksOf(issue, context.policy.dependLinkType, "OUTWARD")
        .filter((dependant) => dependant.key !== issue.key)
        .map((dependant) => [dependant.key, dependant]),
    ).values(),
  ];
  return await Promise.all(
    dependants.map(async (dependant, index) => {
      const base = { key: dependant.key, relation: "depends on this ticket" };
      if (index >= MAX_LINKED_TICKETS) {
        return {
          ...base,
          stage: dependant.stage,
          action: "Not probed (over cap)",
        };
      }
      try {
        return {
          ...base,
          ...(await probeDependant(context, issue.key, dependant)),
        };
      } catch (error) {
        const detail = describeTrackerError(error);
        context.logger.warn("dependant probe failed", {
          key: dependant.key,
          error: detail,
        });
        return {
          ...base,
          stage: dependant.stage,
          action: `Tracker error: ${detail}`,
        };
      }
    }),
  );
}

interface TicketOutcome {
  result: TicketAuditResult;
  /** An earlier run recorded this PR on the ticket and left nothing to move. */
  settled: boolean;
}

function unreadableTicket(
  tracker: TrackerClient,
  key: string,
  detail: string,
): TicketOutcome {
  return {
    settled: false,
    result: {
      key,
      url: tracker.issueUrl(key),
      summary: "(ticket could not be read)",
      stageBefore: null,
      stageAfter: null,
      decision: { target: null, note: "Stage unchanged." },
      transitionApplied: false,
      audit: null,
      linked: [],
      errors: [detail],
    },
  };
}

/**
 * Everything for one ticket, in the order the writes depend on each other:
 * stage move → dependants (only once the move is real) → the ticket's record,
 * which reports the move.
 */
async function auditTicket(
  context: AuditContext,
  issue: TrackerIssue,
  { intent, mergedBy }: { intent: MergeAuditIntent; mergedBy: string | null },
): Promise<TicketOutcome> {
  const { policy, tracker, prUrl, live, logger } = context;
  const audit =
    intent.tickets.find(
      (ticket) => ticket.key.trim().toUpperCase() === issue.key,
    ) ?? null;
  const openSubtasks = linksOf(issue, policy.subtaskLinkType, "OUTWARD").filter(
    (child) => !policy.isClearedIssue(child),
  );
  const decision = policy.decidePrimaryTransition({
    stage: issue.stage,
    resolved: issue.resolved,
    audit,
    openSubtasks,
  });

  const result: TicketAuditResult = {
    key: issue.key,
    url: tracker.issueUrl(issue.key),
    summary: issue.summary,
    stageBefore: issue.stage,
    stageAfter: issue.stage,
    decision,
    transitionApplied: false,
    audit,
    linked: openSubtasks.map((child) => ({
      key: child.key,
      relation: "subtask",
      stage: child.stage,
      action: `Open — holds this ticket short of ${policy.mergedTarget}`,
    })),
    errors: [],
  };
  const recordFailure = (message: string, error: unknown) => {
    const detail = describeTrackerError(error);
    logger.warn(message, { key: issue.key, error: detail });
    result.errors.push(detail);
  };

  // Live: true only once the tracker reads back the merged target itself — a
  // fallback stage (Jira with no QA status) leaves the ticket short of it.
  let reachedMergedTarget = false;
  if (decision.target !== null && live) {
    try {
      const { applied, stageAfter, requested } = await applyStage(
        policy,
        tracker,
        issue.key,
        decision.target,
      );
      result.stageAfter = stageAfter;
      result.transitionApplied = applied;
      reachedMergedTarget =
        applied &&
        !requested.fallback &&
        decision.target === policy.mergedTarget;
      if (requested.fallback) {
        // The workflow has no transition into the target itself; the policy
        // chose its fallback. Report the stage actually requested.
        result.decision = {
          target: requested.stage,
          note: `${decision.note} No \`${decision.target}\` transition exists; moved to ${inlineCode(requested.stage)} instead.`,
        };
      }
    } catch (error) {
      recordFailure("stage move failed", error);
    }
  }

  // Dependants are probed only by the merge that completes the ticket
  // (`PR Merged` on YouTrack) — a later release PR naming the same key stays
  // quiet, and so does a move that fell back short of the merged target.
  if (live ? reachedMergedTarget : decision.target === policy.mergedTarget) {
    result.linked.push(...(await probeDependants(context, issue)));
  }

  const alreadyRecorded = issue.comments.some((comment) =>
    isMergeRecord(comment.text, prUrl),
  );
  // No record without an audit: the record is the idempotency marker, and one
  // saying "nothing auditable" on a ticket the agent never saw could not be
  // corrected by a later good run.
  if (live && !alreadyRecorded && audit !== null) {
    try {
      await tracker.addComment(
        issue.key,
        renderTrackerComment({ prUrl, mergedBy, result }),
      );
    } catch (error) {
      recordFailure("ticket comment failed", error);
    }
  }

  return { result, settled: alreadyRecorded && decision.target === null };
}

export async function executeMergeAudit({
  prNumber,
  pr,
  terminalText,
  config,
  tracker,
  comments,
  logger,
}: {
  prNumber: number;
  pr: MergedPullRequest;
  /** The agent's final message — where the emitted intent lives. */
  terminalText: string;
  config: TrackerConfig | null;
  tracker: TrackerClient | null;
  comments: AuditCommentClient;
  logger: MergeAuditLogger;
}): Promise<MergeAuditOutcome> {
  const marker = mergeAuditMarker(prNumber);
  // A notice must never overwrite a comment an earlier turn already posted.
  // When one is there, this turn simply had nothing to add — a follow-up
  // question, not a failed audit — and the outcome says so.
  const postNotice = async <T extends MergeAuditOutcome>(
    notice: string,
    outcome: T,
  ): Promise<T | { outcome: "skipped_existing_comment" }> => {
    const posted = await comments.upsertMarkerComment(
      marker,
      renderNoticeComment(prNumber, notice),
      "create-only",
    );
    return posted === "kept_existing"
      ? { outcome: "skipped_existing_comment" }
      : outcome;
  };

  if (config === null || tracker === null) {
    return await postNotice(
      "The post-merge audit is enabled for this repository, but no tracker is configured. Set `YOUTRACK_URL` and `YOUTRACK_TOKEN` (or, for Jira, `JIRA_URL`, `JIRA_USERNAME` and `JIRA_API_TOKEN`) on the organization environment (Environments → Organization) or on this repository's environment. Personal Global variables are not read by the audit.",
      { outcome: "tracker_unconfigured" },
    );
  }

  // Authority for WHICH tickets may be touched: GitHub's PR fields, re-read by
  // the control plane. Keys the agent names are used only to look up verdicts.
  const extraction = extractTicketKeys({
    title: pr.title,
    body: pr.body,
    headBranch: pr.headBranch,
    projects: config.projects,
  });
  if (extraction.auditKeys.length === 0) {
    return await postNotice(
      extraction.referencedKeys.length === 0
        ? `No ticket reference was found in this PR's title, description or branch name. If a ticket exists, reference it (e.g. \`${config.projects[0] ?? "PROJ"}-123\`) so future merges are audited against it.`
        : `This PR mentions ${extraction.referencedKeys.join(", ")} but names none as the ticket it delivers. Put the ticket key in the title or branch name, or use a closing keyword (\`Closes ${extraction.referencedKeys[0]}\`), so the merge is audited against it.`,
      { outcome: "no_ticket" },
    );
  }

  const parsed = parseUsableIntent(terminalText, prNumber);
  if (!parsed.ok) {
    logger.warn("audit intent not usable", { reason: parsed.reason });
    return await postNotice(
      `The audit run for ${extraction.auditKeys.join(", ")} did not produce a usable result, so no ticket was changed. Check the acceptance criteria by hand.`,
      { outcome: "degraded_comment", reason: parsed.reason },
    );
  }

  const live = config.writes === "live";
  const context: AuditContext = {
    policy: stagePolicyFor(config.kind),
    tracker,
    prUrl: pr.htmlUrl,
    live,
    logger,
  };

  // Reads are independent; the write chains run one ticket at a time, because
  // a PR can name two tickets that are linked to each other.
  const issues = await Promise.allSettled(
    extraction.auditKeys.map((key) => tracker.getIssue(key)),
  );
  const outcomes: TicketOutcome[] = [];
  for (const [index, key] of extraction.auditKeys.entries()) {
    const fetched = issues[index];
    if (fetched?.status !== "fulfilled") {
      const detail = describeTrackerError(fetched?.reason);
      logger.warn("ticket fetch failed", { key, error: detail });
      outcomes.push(unreadableTicket(tracker, key, detail));
      continue;
    }
    outcomes.push(
      await auditTicket(context, fetched.value, {
        intent: parsed.intent,
        mergedBy: pr.mergedBy,
      }),
    );
  }
  const results = outcomes.map((outcome) => outcome.result);

  // Every ticket already carries this PR's record and nothing was left to
  // move: an earlier run did the work. Re-rendering now would drop the stage
  // move and linked-ticket actions that run reported. (Shadow mode leaves no
  // record to detect, so a shadow re-run just re-renders the same comment.)
  if (live && outcomes.every((outcome) => outcome.settled)) {
    logger.info("merge audit already recorded", { prNumber });
    return { outcome: "skipped_already_recorded", tickets: results.length };
  }

  await comments.upsertMarkerComment(
    marker,
    renderPrComment({
      prNumber,
      results,
      live,
      truncatedKeys: extraction.truncated,
      referenced: extraction.referencedKeys.map((key) => ({
        key,
        url: tracker.issueUrl(key),
      })),
    }),
    "replace",
  );
  const summary = {
    tickets: results.length,
    audited: results.filter((result) => result.audit !== null).length,
    transitions: results.filter((result) => result.transitionApplied).length,
    live,
  };
  logger.info("merge audit posted", { prNumber, ...summary });
  return { outcome: "posted", ...summary };
}
