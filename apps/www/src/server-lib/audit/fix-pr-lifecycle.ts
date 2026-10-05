import type { Octokit } from "octokit";

import { db as defaultDb } from "@/lib/db";
import { getPostHogServer } from "@/lib/posthog-server";
import { waitUntil } from "@/lib/wait-until";
import type { DB } from "@terragon/shared/db";
import type { AuditFixAttemptRow } from "@terragon/shared/model/audit-findings";
import { updateFinding } from "@terragon/shared/model/audit-findings";
import {
  claimAttemptLease,
  closeFixAttempt,
  getFindingForAttempt,
  getFixAttemptByPr,
  listUnsettledFixPrs,
  recordFixPrClosed,
  recordFixPrMergeDetail,
  recordFixPrMerged,
  releaseAttemptLease,
  updateFixAttempt,
  type FixChangedRanges,
} from "@terragon/shared/model/audit-fix-attempts";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";
import { recordBreakerEvent } from "@terragon/shared/model/self-heal-breaker";
import { redactSecrets } from "@terragon/utils/redact";

import { logSelfHealDecision, type SelfHealLogMode } from "./decision-log";
import { parseHunkRanges } from "./hunks";
import { createIssueWriter } from "./issue-writer";
import { defaultOpenFixPrDeps, type OpenFixPrDeps } from "./open-fix-pr";
import {
  commentMarker,
  FINDING_LABELS,
  renderAuditComment,
} from "./render-issue";
import { resolveSelfHealEffective } from "./resolve-self-heal";
import {
  withSelfHealCall,
  type CallKind,
  type GithubResponse,
  type SelfHealCallResult,
} from "./with-self-heal-call";

/**
 * The end of a self-heal fix PR (R5, SC4, HUMAN-MERGE-GATE). Observation
 * only: a PERSON merges or closes; this module records what they did.
 *
 *  - merged → merged_at, merge_sha, merged_by, outcome merged, pr_state
 *    merged and a 30-day regression window, exactly once; the finding's
 *    active attempt is cleared. The commits by non-bot authors (the
 *    human-edit signal) and the merged new-side line ranges per file (≤ 50
 *    files) are read from GitHub afterwards (listCommits ≤ 100, listFiles
 *    ≤ 3 pages) — in waitUntil when a webhook delivered the merge.
 *  - closed unmerged → pr_state closed and the attempt COUNTED (a person
 *    rejected the fix); the finding can be attempted again after the
 *    cooldown, and at the attempts cap it goes needs-human-approve.
 *
 * A PR the platform itself closed (a withdrawn draft) arrives here too and
 * is a no-op: its attempt is already closed. Every settled PR records one
 * loop_fix breaker event (pr_merged / pr_closed), so the consecutive
 * pr_expired rule sees the streak broken.
 *
 * Webhook path: one DB lookup by (repo, pr_number) first; a PR that is not
 * a self-heal fix PR costs that one query and nothing else. The tick sweep
 * settles attempts GitHub already showed merged or closed (an adopted PR, a
 * draft the CI evaluator saw a person close) when no webhook did.
 *
 * Nothing here merges; GitHub reads go through withSelfHealCall on the App
 * installation client. Never throws.
 */

export const FIX_PR_COMMITS_PAGE = 100;
export const FIX_PR_FILES_PAGE = 100;
export const FIX_PR_FILES_MAX_PAGES = 3;
export const FIX_PR_RANGES_MAX_FILES = 50;
/** The waitUntil / per-row budget for the GitHub reads. */
export const FIX_PR_LIFECYCLE_BUDGET_MS = 25_000;
export const FIX_PR_SETTLE_LIMIT = 20;
const MIN_ROW_BUDGET_MS = 5_000;
const PRE_MINT_INSTALLATION_KEY = "pending";

export type FixPrSettleOutcome =
  | "merged"
  | "closed"
  /** Already settled (our own withdraw, a repeat delivery, an expiry). */
  | "already"
  /** The sweep found the PR open again: the PR state was put back. */
  | "reopened"
  | "skipped"
  | "error";

export interface FixPrLifecycleDeps {
  db: DB;
  loadContext: OpenFixPrDeps["loadContext"];
  mint: OpenFixPrDeps["mint"];
  callDeps: OpenFixPrDeps["callDeps"];
  botLogin: () => string;
  now: () => Date;
  log: (message: string, fields: Record<string, unknown>) => void;
  /** The pinned decision line (decision-log.ts). */
  line: (line: string) => void;
  capture: (event: string, properties: Record<string, string>) => void;
  schedule: (promise: Promise<unknown>) => void;
}

export function defaultFixPrLifecycleDeps(): FixPrLifecycleDeps {
  const open = defaultOpenFixPrDeps();
  return {
    db: defaultDb,
    loadContext: open.loadContext,
    mint: open.mint,
    callDeps: open.callDeps,
    botLogin: open.botLogin,
    now: open.now,
    log: open.log,
    line: (line) => console.log(line),
    capture: (event, properties) =>
      getPostHogServer().capture({
        distinctId: "self-heal-lifecycle",
        event,
        properties,
      }),
    schedule: waitUntil,
  };
}

function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** What a person did to the PR, from a webhook payload or pulls.get. */
export interface FixPrEnd {
  merged: boolean;
  mergedAt: Date | null;
  mergeSha: string | null;
  mergedBy: string | null;
}

interface RawCommit {
  sha: string;
  author?: { login?: string; type?: string } | null;
}

interface RawFile {
  filename: string;
  status?: string;
  patch?: string;
}

export interface RawPull {
  state: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  merged_by?: { login?: string } | null;
}

export interface FixPrSession {
  octokit: Octokit;
  installationKey: string;
}

/** A GitHub user that is an App or this platform's bot. */
export function isBotUser(
  user: { login?: string; type?: string } | null | undefined,
  botLogin: string,
): boolean {
  const login = user?.login?.toLowerCase();
  if (user?.type === "Bot") return true;
  if (login === undefined) return false;
  return login === botLogin.toLowerCase() || login.endsWith("[bot]");
}

function isBotAuthor(commit: RawCommit, botLogin: string): boolean {
  return isBotUser(commit.author, botLogin);
}

/**
 * Commits a person added after the gate. The fix run's commits end at the
 * gated head; anything after it in the PR's commit list that a bot did not
 * author is a human edit. Without the gated head in the list (history was
 * rewritten), every non-bot commit counts.
 */
export function countHumanCommits(
  commits: readonly RawCommit[],
  gatedHeadSha: string | null,
  botLogin: string,
): number {
  const gatedAt =
    gatedHeadSha === null
      ? -1
      : commits.findIndex((c) => c.sha === gatedHeadSha);
  const after = gatedAt >= 0 ? commits.slice(gatedAt + 1) : commits;
  return after.filter((c) => !isBotAuthor(c, botLogin)).length;
}

/** New-side ranges per changed file, at most 50 files. */
export function changedRangesOf(files: readonly RawFile[]): FixChangedRanges {
  const out: FixChangedRanges = [];
  for (const file of files) {
    if (out.length >= FIX_PR_RANGES_MAX_FILES) break;
    if (file.status === "removed") continue;
    const ranges = parseHunkRanges(file.patch, "new");
    if (ranges.length > 0) out.push({ file: file.filename, ranges });
  }
  return out;
}

/**
 * One fix PR's lifecycle helper: the effective mode, the App session and
 * the DB transitions. Shared with the expiry sweep (fix-pr-expiry.ts).
 */
export class FixPrLifecycle {
  private session: FixPrSession | "unavailable" | null = null;
  private readonly owner: string;
  private readonly repo: string;
  private readonly deadlineAt: Date;
  private modeCache: SelfHealLogMode | null = null;
  private maxAttempts = 3;
  private prExpiryDays = 7;

  constructor(
    private readonly deps: FixPrLifecycleDeps,
    private attempt: AuditFixAttemptRow,
    deadlineAt?: Date,
  ) {
    const [owner = "", repo = ""] = attempt.repoFullName.split("/");
    this.owner = owner;
    this.repo = repo;
    this.deadlineAt =
      deadlineAt ?? new Date(deps.now().getTime() + FIX_PR_LIFECYCLE_BUDGET_MS);
  }

  private get org(): string {
    return this.attempt.organizationId;
  }

  private get db(): DB {
    return this.deps.db;
  }

  get row(): AuditFixAttemptRow {
    return this.attempt;
  }

  /** The repo's unreviewed-PR window in days; read by mode(). */
  get expiryDays(): number {
    return this.prExpiryDays;
  }

  /** Effective mode (and the attempts cap); GitHub is touched only when not off. */
  async mode(): Promise<SelfHealLogMode> {
    if (this.modeCache !== null) return this.modeCache;
    const context = await this.deps.loadContext({
      db: this.db,
      organizationId: this.org,
      repoFullName: this.attempt.repoFullName,
      installationKey: PRE_MINT_INSTALLATION_KEY,
      probeAttemptId: this.attempt.id,
    });
    this.maxAttempts = context.resolved.settings.maxAttempts;
    this.prExpiryDays = context.resolved.settings.prExpiryDays;
    this.modeCache = resolveSelfHealEffective(context).mode;
    return this.modeCache;
  }

  async openSession(): Promise<FixPrSession | "unavailable"> {
    if (this.session !== null) return this.session;
    try {
      const minted = await this.deps.mint({
        owner: this.owner,
        repo: this.repo,
      });
      this.session = {
        octokit: minted.octokit,
        installationKey: String(minted.installationId),
      };
    } catch (error) {
      this.deps.log("[self-heal] fix PR lifecycle token mint failed", {
        attemptId: this.attempt.id,
        error: errorText(error),
      });
      this.session = "unavailable";
    }
    return this.session;
  }

  private read<T>(
    session: FixPrSession,
    call: (signal: AbortSignal) => Promise<GithubResponse<T>>,
  ): Promise<SelfHealCallResult<T>> {
    return this.call<T>(session, "read", "pull_requests", call);
  }

  /** Every GitHub call of this PR goes through withSelfHealCall. */
  call<T>(
    session: FixPrSession,
    kind: CallKind,
    permission: "pull_requests" | "contents",
    call: (signal: AbortSignal) => Promise<GithubResponse<T>>,
    /** A 403 / 422 here is a real lane failure (09-13 loop_fix rule). */
    loopFix = false,
  ): Promise<SelfHealCallResult<T>> {
    return withSelfHealCall<T>({
      kind,
      organizationId: this.org,
      installationKey: session.installationKey,
      signalName: kind === "read" ? "gh_read" : "gh_write",
      permission,
      deadlineAt: this.deadlineAt,
      call,
      deps: { ...this.deps.callDeps, db: this.db },
      ...(loopFix
        ? { loopFixScopeKey: normalizeRepo(this.attempt.repoFullName) }
        : {}),
    });
  }

  /** The sweep's view of the PR (pulls.get), or null when unreadable. */
  async readPull(): Promise<RawPull | null> {
    const prNumber = this.attempt.prNumber;
    if (prNumber === null || (await this.mode()) === "off") return null;
    const session = await this.openSession();
    if (session === "unavailable") return null;
    const res = await this.read<RawPull>(session, async (signal) => {
      const out = await session.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        request: { signal },
      });
      return { ...out, data: out.data as unknown as RawPull };
    });
    return res.ok ? res.data : null;
  }

  async settle(
    end: FixPrEnd,
    detail: "schedule" | "await",
  ): Promise<FixPrSettleOutcome> {
    if (end.merged) return this.merged(end, detail);
    return this.closed();
  }

  private async merged(
    end: FixPrEnd,
    detail: "schedule" | "await",
  ): Promise<FixPrSettleOutcome> {
    if (this.attempt.mergedAt !== null) return "already";
    const now = this.deps.now();
    const recorded = await recordFixPrMerged({
      db: this.db,
      organizationId: this.org,
      attemptId: this.attempt.id,
      mergedAt: end.mergedAt ?? now,
      mergeSha: end.mergeSha,
      mergedBy: end.mergedBy,
      humanCommitCount: null,
      changedRanges: null,
      now,
    });
    if (!recorded) return "already";
    await this.lifecycleEvent("success", "pr_merged");
    await this.decision("merged");
    this.deps.log("[self-heal] fix PR merged", {
      attemptId: this.attempt.id,
      prNumber: this.attempt.prNumber,
    });
    const work = this.readMergeDetail();
    if (detail === "schedule") this.deps.schedule(work);
    else await work;
    return "merged";
  }

  private async closed(): Promise<FixPrSettleOutcome> {
    const now = this.deps.now();
    await recordFixPrClosed({
      db: this.db,
      organizationId: this.org,
      attemptId: this.attempt.id,
      state: "closed",
      now,
    });
    const counted = await closeFixAttempt({
      db: this.db,
      organizationId: this.org,
      attemptId: this.attempt.id,
      outcome: "pr_closed",
      counted: true,
      terminalCause: "closed_unmerged",
      now,
    });
    if (!counted) return "already";
    await this.lifecycleEvent("failure", "pr_closed");
    await this.decision("closed_unmerged");
    this.deps.log("[self-heal] fix PR closed unmerged", {
      attemptId: this.attempt.id,
      prNumber: this.attempt.prNumber,
    });
    await this.capCheck();
    return "closed";
  }

  /** 09-13: lifecycle events break (or extend) the pr_expired streak. */
  async lifecycleEvent(
    outcome: "success" | "failure",
    signal: "pr_merged" | "pr_closed" | "pr_expired",
  ): Promise<void> {
    try {
      await recordBreakerEvent({
        db: this.db,
        organizationId: this.org,
        scopeKind: "loop_fix",
        scopeKey: normalizeRepo(this.attempt.repoFullName),
        outcome,
        signal,
        now: this.deps.now(),
      });
    } catch (error) {
      this.deps.log("[self-heal] fix PR lifecycle event failed", {
        attemptId: this.attempt.id,
        signal,
        error: errorText(error),
      });
    }
  }

  async decision(
    reason: "merged" | "closed_unmerged" | "expired",
  ): Promise<void> {
    try {
      const finding = await getFindingForAttempt({
        db: this.db,
        organizationId: this.org,
        findingId: this.attempt.findingId,
      });
      if (finding === null) return;
      logSelfHealDecision(
        { log: this.deps.line, capture: this.deps.capture },
        {
          organizationId: this.org,
          repoFullName: normalizeRepo(this.attempt.repoFullName),
          runId: this.attempt.id,
          fingerprint: finding.fingerprint,
          decision: "pr_open",
          reason,
          mode: await this.mode(),
        },
      );
    } catch (error) {
      this.deps.log("[self-heal] decision log failed", {
        attemptId: this.attempt.id,
        error: errorText(error),
      });
    }
  }

  /** Human-edit signal and merged hunks. Best effort; never throws. */
  private async readMergeDetail(): Promise<void> {
    try {
      const prNumber = this.attempt.prNumber;
      if (prNumber === null || (await this.mode()) === "off") return;
      const session = await this.openSession();
      if (session === "unavailable") return;
      const commits = await this.read<RawCommit[]>(session, async (signal) => {
        const out = await session.octokit.rest.pulls.listCommits({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          per_page: FIX_PR_COMMITS_PAGE,
          request: { signal },
        });
        return { ...out, data: out.data as unknown as RawCommit[] };
      });
      const files: RawFile[] = [];
      let filesOk = true;
      for (let page = 1; page <= FIX_PR_FILES_MAX_PAGES; page += 1) {
        const res = await this.read<RawFile[]>(session, async (signal) => {
          const out = await session.octokit.rest.pulls.listFiles({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            per_page: FIX_PR_FILES_PAGE,
            page,
            request: { signal },
          });
          return { ...out, data: out.data as unknown as RawFile[] };
        });
        if (!res.ok) {
          filesOk = false;
          break;
        }
        files.push(...res.data);
        if (res.data.length < FIX_PR_FILES_PAGE) break;
      }
      const humanCommitCount = commits.ok
        ? countHumanCommits(
            commits.data,
            this.attempt.gatedHeadSha,
            this.deps.botLogin(),
          )
        : null;
      const changedRanges = filesOk ? changedRangesOf(files) : null;
      await recordFixPrMergeDetail({
        db: this.db,
        organizationId: this.org,
        attemptId: this.attempt.id,
        humanCommitCount,
        changedRanges,
      });
      this.deps.log("[self-heal] fix PR merge detail", {
        attemptId: this.attempt.id,
        humanCommitCount,
        files: changedRanges?.length ?? null,
      });
    } catch (error) {
      this.deps.log("[self-heal] fix PR merge detail failed", {
        attemptId: this.attempt.id,
        error: errorText(error),
      });
    }
  }

  /** The attempts cap after a counted close: needs-human-approve. */
  async capCheck(): Promise<void> {
    const finding = await getFindingForAttempt({
      db: this.db,
      organizationId: this.org,
      findingId: this.attempt.findingId,
    });
    const mode = await this.mode();
    if (
      finding === null ||
      finding.status !== "open" ||
      finding.attempts < this.maxAttempts
    ) {
      return;
    }
    await updateFinding({
      db: this.db,
      organizationId: this.org,
      id: finding.id,
      patch: {
        status: "needs_human",
        autoFixLabeled: false,
        fixReadyAt: null,
        lastDecision: "needs_human",
        lastDecisionReason: "attempts_cap",
      },
    });
    const issueNumber = finding.issueNumber;
    // KILL-01: an operator stop (or dry-run) makes no GitHub write.
    if (issueNumber === null || mode !== "on") return;
    const session = await this.openSession();
    if (session === "unavailable") return;
    const writer = createIssueWriter({
      octokit: session.octokit,
      owner: this.owner,
      repo: this.repo,
      botLogin: this.deps.botLogin(),
      organizationId: this.org,
      installationKey: session.installationKey,
      deadlineAt: this.deadlineAt,
      deps: { ...this.deps.callDeps, db: this.db },
    });
    const labels = await writer.updateIssue({
      number: issueNumber,
      labelsAdd: [FINDING_LABELS.needsHumanApprove],
      labelsRemove: [FINDING_LABELS.autoFix],
    });
    const comment = await writer.upsertComment({
      number: issueNumber,
      marker: commentMarker({
        fp: finding.fingerprint,
        kind: "needs_human_attempts_cap",
        runId: this.attempt.id,
      }),
      body: renderAuditComment("needs_human_attempts_cap", {
        fingerprint: finding.fingerprint,
        runId: this.attempt.id,
        attempts: this.attempt.attemptNo,
        maxAttempts: this.maxAttempts,
      }),
    });
    if (!labels.ok || !comment.ok) {
      this.deps.log("[self-heal] needs-human write failed", {
        attemptId: this.attempt.id,
        label: labels.ok ? "ok" : labels.outcome,
        comment: comment.ok ? "ok" : comment.outcome,
      });
    }
  }

  /** The sweep found the PR open again: put the PR state back. */
  async reopened(pull: RawPull): Promise<FixPrSettleOutcome> {
    const row = await updateFixAttempt({
      db: this.db,
      organizationId: this.org,
      id: this.attempt.id,
      patch: {
        prState: pull.draft === true ? "draft" : "ready",
        updatedAt: this.deps.now(),
      },
    });
    if (row) this.attempt = row;
    return "reopened";
  }
}

interface ClosedPrTarget extends FixPrEnd {
  repo: string;
  prNumber: number;
  headRef: string | null;
}

interface ClosedPrPayload {
  action?: unknown;
  pull_request?: {
    number?: unknown;
    merged?: unknown;
    merged_at?: unknown;
    merge_commit_sha?: unknown;
    merged_by?: { login?: unknown } | null;
    head?: { ref?: unknown } | null;
  } | null;
  repository?: { full_name?: unknown } | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** What pulls.get shows a person did to a closed PR. */
export function endOfPull(pull: RawPull): FixPrEnd {
  const mergedAt = stringOrNull(pull.merged_at);
  return {
    merged: pull.merged === true || mergedAt !== null,
    mergedAt: mergedAt === null ? null : new Date(mergedAt),
    mergeSha: stringOrNull(pull.merge_commit_sha),
    mergedBy: stringOrNull(pull.merged_by?.login),
  };
}

function closedPrTarget(payload: unknown): ClosedPrTarget | null {
  if (typeof payload !== "object" || payload === null) return null;
  const event = payload as ClosedPrPayload;
  if (event.action !== "closed") return null;
  const pr = event.pull_request;
  const repo = stringOrNull(event.repository?.full_name);
  if (!pr || repo === null) return null;
  if (typeof pr.number !== "number" || !Number.isInteger(pr.number)) {
    return null;
  }
  const mergedAtText = stringOrNull(pr.merged_at);
  const mergedAt = mergedAtText === null ? null : new Date(mergedAtText);
  const merged =
    pr.merged === true ||
    (mergedAt !== null && !Number.isNaN(mergedAt.getTime()));
  return {
    repo,
    prNumber: pr.number,
    headRef: stringOrNull(pr.head?.ref),
    merged,
    mergedAt:
      mergedAt !== null && !Number.isNaN(mergedAt.getTime()) ? mergedAt : null,
    mergeSha: stringOrNull(pr.merge_commit_sha),
    mergedBy: stringOrNull(pr.merged_by?.login),
  };
}

/**
 * pull_request.closed (R5): a sibling of the existing closed handlers. ONE
 * DB lookup by (repo, pr_number); a PR that is not a self-heal fix PR ends
 * there (no GitHub call, no write). A fix PR is settled in the DB at once;
 * the GitHub reads of a merge run in waitUntil. Never throws.
 */
export async function handleSelfHealPrClosed(
  payload: unknown,
  overrides: Partial<FixPrLifecycleDeps> = {},
): Promise<void> {
  const target = closedPrTarget(payload);
  if (target === null) return;
  const deps: FixPrLifecycleDeps = {
    ...defaultFixPrLifecycleDeps(),
    ...overrides,
  };
  try {
    const attempt = await getFixAttemptByPr({
      db: deps.db,
      repoFullName: target.repo,
      prNumber: target.prNumber,
    });
    if (attempt === null) return;
    // T-09-14-1: the PR must be the attempt's branch, not just its number.
    if (
      target.headRef !== null &&
      attempt.branch !== null &&
      target.headRef !== attempt.branch
    ) {
      deps.log("[self-heal] fix PR close ignored: branch mismatch", {
        attemptId: attempt.id,
        prNumber: target.prNumber,
      });
      return;
    }
    const outcome = await new FixPrLifecycle(deps, attempt).settle(
      target,
      "schedule",
    );
    deps.log("[self-heal] fix PR lifecycle", {
      attemptId: attempt.id,
      outcome,
    });
  } catch (error) {
    deps.log("[self-heal] fix PR lifecycle failed", {
      prNumber: target.prNumber,
      error: errorText(error),
    });
  }
}

export interface FixPrSettleSweepResult {
  processed: number;
  outcomes: Partial<Record<FixPrSettleOutcome, number>>;
}

async function settleOne(
  deps: FixPrLifecycleDeps,
  row: AuditFixAttemptRow,
  deadlineAt: Date,
): Promise<FixPrSettleOutcome> {
  const organizationId = row.organizationId;
  const leased = await claimAttemptLease({
    db: deps.db,
    organizationId,
    attemptId: row.id,
    now: deps.now(),
  });
  if (!leased) return "skipped";
  try {
    const lifecycle = new FixPrLifecycle(deps, row, deadlineAt);
    const pull = await lifecycle.readPull();
    if (pull === null) return "skipped";
    if (pull.state !== "closed") return lifecycle.reopened(pull);
    return await lifecycle.settle(endOfPull(pull), "await");
  } finally {
    try {
      await releaseAttemptLease({
        db: deps.db,
        organizationId,
        attemptId: row.id,
      });
    } catch (error) {
      deps.log("[self-heal] fix PR lifecycle lease release failed", {
        attemptId: row.id,
        error: errorText(error),
      });
    }
  }
}

/**
 * The tick's settle sweep: attempts still open whose PR GitHub already
 * showed merged or closed (≤ 20 per tick, bounded by the tick's deadline).
 * Each is re-read with pulls.get and settled exactly like a webhook would.
 * Never throws.
 */
export async function runFixPrSettleSweep({
  db,
  now,
  deadlineAt,
  limit = FIX_PR_SETTLE_LIMIT,
  deps: overrides = {},
}: {
  db: DB;
  now: Date;
  deadlineAt: Date;
  limit?: number;
  deps?: Partial<FixPrLifecycleDeps>;
}): Promise<FixPrSettleSweepResult> {
  const deps: FixPrLifecycleDeps = {
    ...defaultFixPrLifecycleDeps(),
    ...overrides,
    db,
  };
  const result: FixPrSettleSweepResult = { processed: 0, outcomes: {} };
  let rows: AuditFixAttemptRow[];
  try {
    rows = await listUnsettledFixPrs({ db, now, limit });
  } catch (error) {
    deps.log("[self-heal] fix PR settle sweep list failed", {
      error: errorText(error),
    });
    return result;
  }
  for (const row of rows.slice(0, limit)) {
    if (deadlineAt.getTime() - deps.now().getTime() < MIN_ROW_BUDGET_MS) {
      break;
    }
    let outcome: FixPrSettleOutcome;
    try {
      outcome = await settleOne(deps, row, deadlineAt);
    } catch (error) {
      deps.log("[self-heal] fix PR settle failed", {
        attemptId: row.id,
        error: errorText(error),
      });
      outcome = "error";
    }
    result.processed += 1;
    result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
  }
  return result;
}
