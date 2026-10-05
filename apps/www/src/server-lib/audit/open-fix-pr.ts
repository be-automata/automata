import { and, eq } from "drizzle-orm";
import type { Octokit } from "octokit";

import type { DB } from "@terragon/shared/db";
import { thread } from "@terragon/shared/db/schema";
import type {
  AuditFindingRow,
  AuditFixAttemptRow,
} from "@terragon/shared/model/audit-findings";
import { updateFinding } from "@terragon/shared/model/audit-findings";
import {
  closeFixAttempt,
  getFindingForAttempt,
  getFixAttemptById,
  getFixAttemptThreadState,
  listPendingPrOpens,
  refundFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import { upsertGithubPR } from "@terragon/shared/model/github";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";
import {
  GH_CREATE_SIGNAL,
  recordBreakerEvent,
} from "@terragon/shared/model/self-heal-breaker";
import { updateThread } from "@terragon/shared/model/threads";

import { resolveBotLogin } from "../review/bot-login";
import type { FixCheckStatus } from "./plan-self-heal-run";
import { commentMarker, oneLine, renderAuditComment } from "./render-issue";
import {
  loadSelfHealContext,
  resolveSelfHealEffective,
} from "./resolve-self-heal";
import { createSelfHealOctokit } from "./self-heal-octokit";
import { preflightCapabilities } from "./self-heal-preflight";
import type {
  SelfHealCallDeps,
  SelfHealCallResult,
} from "./with-self-heal-call";
import { PRE_MINT_INSTALLATION_KEY, errorText } from "./audit-shared";
import {
  classifyFixTerminal,
  GATE_REFUND_SIGNAL_BY_CAUSE,
  isGateRefundCause,
  type FixTerminalClassification,
} from "./fix-outcome-classify";
import {
  deleteFixBranch,
  FixAttemptGithub,
  runBoundedSweep,
  withAttemptLease,
} from "./fix-attempt-session";

/**
 * The platform PR writer of the fix lane (GATE-01 steps 1-3, SC4, R4, R5,
 * D2, KILL-01, RES-18).
 *
 * After the worker's finding check is recorded, exactly one of these happens
 * per attempt:
 *  - a DRAFT pull request is opened (or adopted) by the App installation
 *    client, from the attempt branch to the default branch, only when the
 *    check passed, the branch head on GitHub is still the gated commit, the
 *    branch is ahead of the base and the R4 guard passes on GitHub's own
 *    compare diff. Drafts are not reviewed; the CI evaluator (09-12) decides
 *    whether it becomes ready. Nothing here merges or enables auto-merge.
 *  - a counted non-PR outcome (guard_rejected, sha_mismatch, no_changes,
 *    no_branch, check_failed, run_failed): the attempt is closed, the branch
 *    deleted and the issue gets one marker-upserted comment;
 *  - a refund (check error, aborted, killed, dry run, missing permission,
 *    drafts unsupported, run_refunded): nothing is held against the finding;
 *  - pending_open: GitHub did not answer the create; the tick sweep retries
 *    after 2 min / 10 min / 1 h, re-listing by head first, and the 4th
 *    failure is open_failed (needs-human-approve).
 *
 * A no_branch / aborted / error verdict is first checked against how the fix
 * RUN ended (classifyFixTerminal, the reconcile's classifier): a run that
 * died on a credential 401/quota is COUNTED as run_failed with terminal cause
 * 'credential' (never refunded, never a breaker input); an infra end is
 * refunded (run_refunded); a stop is killed. Only a run that ended without
 * such evidence keeps the verdict's own outcome.
 *
 * Fix-lane writes do not go through the audit outbox (its rows are keyed to
 * audit runs). They are idempotent by construction (PR adoption by head,
 * comments upserted by marker, labels set-based) and the opener holds a
 * 10-minute lease on the attempt, so the route's waitUntil and the sweep
 * never open twice. Every GitHub call goes through withSelfHealCall on a
 * createSelfHealOctokit client. Never throws.
 */

export type DraftOpenOutcome =
  | "draft_opened"
  | "draft_adopted"
  | "pending_open"
  | "open_failed"
  | "draft_unsupported"
  | "guard_rejected"
  | "sha_mismatch"
  | "no_changes"
  | "no_branch"
  | "check_failed"
  /** The fix run itself ended on a counted error (credential, agent error). */
  | "run_failed"
  /** The fix run itself ended on an infrastructure cause (refunded). */
  | "run_refunded"
  | "check_error"
  | "aborted"
  | "killed"
  | "dry_run"
  | "missing-permission"
  | "lease_held"
  /** The attempt is closed, already has a PR, or has no report yet. */
  | "not_pending"
  /** An unexpected error; the attempt is unchanged and the sweep retries. */
  | "error";

/** RES-18: backoff after the 1st, 2nd and 3rd failed open; the 4th fails. */
export const PR_OPEN_BACKOFF_MS = [120_000, 600_000, 3_600_000] as const;
export const PR_OPEN_MAX_FAILURES = 4;
/** Not GitHub's fault (deadline, breaker, rate limit): retry, uncounted. */
const UNCOUNTED_RETRY_MS = 120_000;
/** The route's waitUntil budget when the caller passes no deadline. */
export const OPEN_FIX_PR_BUDGET_MS = 25_000;
export const FIX_PR_SWEEP_LIMIT = 20;
const MAX_TITLE_CHARS = 200;

export const NEVER_MERGES_LINE =
  "Automata never merges; a person reviews and merges.";

export interface OpenFixPrDeps {
  loadContext: typeof loadSelfHealContext;
  mint: (args: {
    owner: string;
    repo: string;
  }) => Promise<{ octokit: Octokit; installationId: number }>;
  preflight: typeof preflightCapabilities;
  /** Call deps without `db` (the opener passes its own); shared breaker model. */
  callDeps: Omit<SelfHealCallDeps, "db" | "breaker">;
  botLogin: () => string;
  now: () => Date;
  log: (message: string, fields: Record<string, unknown>) => void;
  /** Link the PR to the fix thread (github_pr row + thread PR number). */
  linkThread: (args: {
    db: DB;
    organizationId: string;
    threadId: string;
    repoFullName: string;
    branch: string;
    prNumber: number;
    prStatus: "draft" | "open" | "closed" | "merged";
  }) => Promise<void>;
}

/** The two calls pull-request.ts makes after it creates a PR. */
async function linkThreadToPr({
  db,
  organizationId,
  threadId,
  repoFullName,
  branch,
  prNumber,
  prStatus,
}: Parameters<OpenFixPrDeps["linkThread"]>[0]): Promise<void> {
  const [row] = await db
    .select({ userId: thread.userId })
    .from(thread)
    .where(
      and(eq(thread.id, threadId), eq(thread.organizationId, organizationId)),
    )
    .limit(1);
  if (!row) return;
  await Promise.all([
    upsertGithubPR({
      db,
      repoFullName,
      number: prNumber,
      threadId,
      updates: { status: prStatus },
    }),
    updateThread({
      db,
      userId: row.userId,
      threadId,
      organizationId,
      updates: { branchName: branch, githubPRNumber: prNumber },
    }),
  ]);
}

export function defaultOpenFixPrDeps(): OpenFixPrDeps {
  return {
    loadContext: loadSelfHealContext,
    mint: ({ owner, repo }) => createSelfHealOctokit({ owner, repo }),
    preflight: preflightCapabilities,
    callDeps: {
      now: () => new Date(),
      log: (message, fields) => console.log(message, fields),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      rand: Math.random,
    },
    botLogin: resolveBotLogin,
    now: () => new Date(),
    log: (message, fields) => console.log(message, fields),
    linkThread: linkThreadToPr,
  };
}

interface RawPull {
  number: number;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  user?: { login?: string } | null;
}

/** Verdicts that may hide how the fix run itself ended. */
const RUN_END_VERDICTS: ReadonlySet<FixCheckStatus> = new Set([
  "no_branch",
  "aborted",
  "error",
]);

const FIX_CHECK_STATUSES: readonly FixCheckStatus[] = [
  "passed",
  "failed",
  "error",
  "no_branch",
  "aborted",
];

/** The recorded verdict (check_results.status); unknown reads as error. */
function recordedVerdict(attempt: AuditFixAttemptRow): FixCheckStatus {
  const results = attempt.checkResults;
  const status =
    typeof results === "object" && results !== null && "status" in results
      ? (results as { status: unknown }).status
      : undefined;
  return FIX_CHECK_STATUSES.find((s) => s === status) ?? "error";
}

function pullStatus(pr: RawPull): "draft" | "open" | "closed" | "merged" {
  if (pr.merged_at) return "merged";
  if (pr.state === "closed") return "closed";
  return pr.draft ? "draft" : "open";
}

function attemptPrState(
  pr: RawPull,
): NonNullable<AuditFixAttemptRow["prState"]> {
  const status = pullStatus(pr);
  return status === "open" ? "ready" : status;
}

export function renderFixPrTitle(finding: Pick<AuditFindingRow, "title">) {
  return `[self-heal] ${oneLine(finding.title)}`.slice(0, MAX_TITLE_CHARS);
}

/** Platform-written body: no agent text reaches it. */
export function renderFixPrBody({
  attempt,
  finding,
  issueNumber,
  diffLines,
}: {
  attempt: Pick<AuditFixAttemptRow, "id" | "attemptNo" | "gatedHeadSha">;
  finding: Pick<AuditFindingRow, "ruleId" | "fingerprint">;
  issueNumber: number;
  diffLines: number;
}): string {
  return [
    `<!-- automata-fix-pr:v1 attempt=${attempt.id} -->`,
    `Automated change for issue #${issueNumber}, proposed by Automata self-heal.`,
    "",
    `- Rule: \`${finding.ruleId.replace(/[`\r\n]/g, "")}\``,
    `- Fingerprint: \`${finding.fingerprint}\``,
    `- Attempt: ${attempt.attemptNo}`,
    `- Checked commit: \`${attempt.gatedHeadSha ?? "unknown"}\``,
    "- The finding's deterministic check passed on a clean checkout of this commit.",
    `- Changed lines (lockfiles excluded): ${diffLines}`,
    "",
    "This draft is not reviewed yet. It is marked ready for review only after the repository's CI passes on this commit.",
    "",
    `Fixes #${issueNumber}`,
    "",
    NEVER_MERGES_LINE,
  ].join("\n");
}

/** One opener execution for one leased attempt. */
class FixPrOpener extends FixAttemptGithub<OpenFixPrDeps> {
  constructor(
    db: DB,
    attempt: AuditFixAttemptRow,
    finding: AuditFindingRow,
    deadlineAt: Date,
    deps: OpenFixPrDeps,
  ) {
    super(db, attempt, finding, deadlineAt, deps, "fix PR opener");
  }

  private async refund(
    outcome: DraftOpenOutcome,
    cause: string,
    onRefunded?: () => Promise<void>,
  ): Promise<DraftOpenOutcome> {
    const refunded = await refundFixAttempt({
      db: this.db,
      organizationId: this.org,
      attemptId: this.attempt.id,
      cause,
      outcome,
      now: this.now(),
    });
    if (!refunded) return outcome;
    // R2: a finding check that keeps failing to run must not re-run forever.
    if (isGateRefundCause(cause)) {
      await this.recordGateRefund(GATE_REFUND_SIGNAL_BY_CAUSE[cause]);
    }
    await onRefunded?.();
    return outcome;
  }

  /**
   * R1: how the fix run ended, when its thread carries evidence (a typed
   * terminal cause, an error, a stop). null when the run completed or left
   * no evidence; the verdict then decides.
   */
  private async runEnd(): Promise<FixTerminalClassification | null> {
    const state = await getFixAttemptThreadState({
      db: this.db,
      organizationId: this.org,
      attemptId: this.attempt.id,
    });
    const t = state?.thread ?? null;
    if (t === null || t.status === "complete") return null;
    const stopped = t.status === "stopped" || t.status === "working-stopped";
    if (t.terminalCause === null && t.errorMessage === null && !stopped) {
      return null;
    }
    return classifyFixTerminal({
      terminalCause: t.terminalCause,
      errorMessage: t.errorMessage,
      status: t.status,
      hasCheckReport: false,
      killed: false,
    });
  }

  async run(): Promise<DraftOpenOutcome> {
    const verdict = recordedVerdict(this.attempt);
    const runEnd = RUN_END_VERDICTS.has(verdict) ? await this.runEnd() : null;
    if (runEnd !== null && runEnd.class === "infra") {
      const plane = runEnd.execPlaneSignal;
      return this.refund(
        runEnd.outcome === "killed" ? "killed" : "run_refunded",
        runEnd.reason,
        // The same plane evidence the reconcile records for an unreported end.
        async () => {
          if (!plane) return;
          await recordBreakerEvent({
            db: this.db,
            organizationId: this.org,
            scopeKind: "exec_plane",
            scopeKey: "*",
            outcome: "failure",
            signal: runEnd.reason,
            now: this.now(),
          });
        },
      );
    }
    // A check that could not run says nothing about the fix.
    if (runEnd === null && verdict === "error") {
      return this.refund("check_error", "check_error");
    }
    if (runEnd === null && verdict === "aborted") {
      return this.refund("aborted", "check_aborted");
    }

    const context = await this.deps.loadContext({
      db: this.db,
      organizationId: this.org,
      repoFullName: this.attempt.repoFullName,
      installationKey: PRE_MINT_INSTALLATION_KEY,
      probeAttemptId: this.attempt.id,
    });
    this.maxAttempts = context.resolved.settings.maxAttempts;
    const effective = resolveSelfHealEffective(context);
    if (runEnd !== null) {
      // Counted whatever the mode (credential is never refunded); GitHub is
      // only written while the loop may write.
      return this.counted("run_failed", ["run_failed"], {
        deleteBranch: verdict !== "no_branch",
        terminalCause: runEnd.reason,
        github: effective.mode === "on" && effective.fixAllowed,
      });
    }
    // KILL-01: an operator stop or a missing permission is never the fix's fault.
    if (effective.mode === "off") {
      return effective.reason === "missing_permission"
        ? this.refund("missing-permission", "missing_permission")
        : this.refund("killed", `fix_open_${effective.reason}`);
    }
    if (!effective.fixAllowed) {
      return this.refund("killed", "fix_open_loop_fix_open");
    }
    if (effective.mode === "dry-run") {
      return this.refund("dry_run", `fix_open_${effective.reason}`);
    }

    if (verdict === "no_branch") {
      return this.counted("no_branch", ["no_branch"], { deleteBranch: false });
    }
    if (verdict === "failed") {
      return this.counted("check_failed", ["check_failed"]);
    }
    return this.openDraft(context.resolved.settings.maxDiffLines);
  }

  private async openDraft(maxDiffLines: number): Promise<DraftOpenOutcome> {
    const session = await this.openSession();
    if (session === "missing") {
      return this.refund("missing-permission", "missing_permission");
    }
    // GitHub (or the token mint) did not answer: a counted open failure, so
    // a removed installation ends in open_failed instead of retrying forever.
    if (session === "unavailable") return this.pending(true);

    const { branch, gatedHeadSha } = this.attempt;
    const issueNumber = this.finding.issueNumber;
    if (branch === null || issueNumber === null) {
      // Dispatch never starts a fix without both; nothing to hold against it.
      return this.refund("check_error", "attempt_incomplete");
    }
    if (gatedHeadSha === null) {
      return this.counted("sha_mismatch", ["sha_mismatch"]);
    }

    // T-09-11-3: the head GitHub holds now must be the commit that was checked.
    const ref = await this.call(
      "read",
      "gh_read",
      "contents",
      async (signal) => {
        const res = await session.octokit.rest.git.getRef({
          owner: this.owner,
          repo: this.repo,
          ref: `heads/${branch}`,
          request: { signal },
        });
        return { ...res, data: res.data.object.sha };
      },
    );
    if (!ref.ok) {
      if (ref.outcome === "not_found") {
        return this.counted("no_branch", ["no_branch"], {
          deleteBranch: false,
        });
      }
      return this.failedCall(ref);
    }
    if (ref.data !== gatedHeadSha) {
      return this.counted("sha_mismatch", ["sha_mismatch"]);
    }

    const repoInfo = await this.call(
      "read",
      "gh_read",
      "contents",
      async (signal) => {
        const res = await session.octokit.rest.repos.get({
          owner: this.owner,
          repo: this.repo,
          request: { signal },
        });
        return { ...res, data: res.data.default_branch };
      },
    );
    if (!repoInfo.ok) return this.failedCall(repoInfo);
    const base = repoInfo.data;

    const checked = await this.compareAndGuard(
      session,
      `${base}...${gatedHeadSha}`,
      maxDiffLines,
    );
    if (checked.kind === "failed") return this.failedCall(checked.result);
    if (checked.kind === "empty") {
      return this.counted("no_changes", ["no_changes"]);
    }
    const guard = checked.guard;
    await this.patch({
      guardStatus: guard.ok ? "passed" : "rejected",
      guardReasons: guard.ok ? [] : guard.rejections,
      diffLines: guard.diffLines,
    });
    if (!guard.ok) {
      this.deps.log("[self-heal] fix diff rejected by the guard", {
        attemptId: this.attempt.id,
        reasons: guard.rejections,
        diffLines: guard.diffLines,
      });
      return this.counted("guard_rejected", guard.rejections);
    }

    // RES-18: one PR per attempt. Adopt before create, every time.
    const existing = await this.findPull(branch);
    if (existing === "error") return this.pending(true);
    if (existing === "foreign") return this.openFailed();
    if (existing !== null) return this.recordPull(existing, "draft_adopted");

    let createError: unknown;
    const created = await this.call<RawPull>(
      "create",
      GH_CREATE_SIGNAL,
      "pull_requests",
      async (signal) => {
        try {
          const res = await session.octokit.rest.pulls.create({
            owner: this.owner,
            repo: this.repo,
            title: renderFixPrTitle(this.finding),
            body: renderFixPrBody({
              attempt: this.attempt,
              finding: this.finding,
              issueNumber,
              diffLines: guard.diffLines,
            }),
            head: branch,
            base,
            draft: true,
            maintainer_can_modify: false,
            request: { signal },
          });
          return { ...res, data: res.data as unknown as RawPull };
        } catch (error) {
          createError = error;
          throw error;
        }
      },
    );
    if (created.ok) return this.recordPull(created.data, "draft_opened");

    switch (created.outcome) {
      case "unprocessable":
        return this.onCreate422(branch, createError);
      case "permission":
        return this.refund("missing-permission", "missing_permission");
      case "deadline":
      case "breaker_open":
      case "rate_limited":
      case "primary_quota_reserve":
        return this.pending(false);
      default:
        return this.pending(true);
    }
  }

  private async onCreate422(
    branch: string,
    error: unknown,
  ): Promise<DraftOpenOutcome> {
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    const detail = JSON.stringify(
      (error as { response?: { data?: unknown } } | null)?.response?.data ?? "",
    );
    const text = `${message} ${detail}`;
    if (/already exists/i.test(text)) {
      const existing = await this.findPull(branch);
      if (existing === "error" || existing === null) return this.pending(true);
      if (existing === "foreign") return this.openFailed();
      return this.recordPull(existing, "draft_adopted");
    }
    if (/draft/i.test(text)) {
      // A private repo on a plan without drafts: never a ready PR instead.
      await recordBreakerEvent({
        db: this.db,
        organizationId: this.org,
        scopeKind: "loop_fix",
        scopeKey: normalizeRepo(this.attempt.repoFullName),
        outcome: "failure",
        signal: "draft_unsupported",
        now: this.now(),
      });
      await this.deleteBranch();
      return this.refund("draft_unsupported", "draft_unsupported");
    }
    if (/no commits between/i.test(text)) {
      return this.counted("no_changes", ["no_changes"]);
    }
    return this.openFailed();
  }

  /** The attempt branch's PR in any state; "foreign" when not ours. */
  private async findPull(
    branch: string,
  ): Promise<RawPull | "foreign" | "error" | null> {
    const session = this.gh;
    if (session === null) return "error";
    const listed = await this.call<RawPull[]>(
      "read",
      "gh_read",
      "pull_requests",
      async (signal) => {
        const res = await session.octokit.rest.pulls.list({
          owner: this.owner,
          repo: this.repo,
          head: `${this.owner}:${branch}`,
          state: "all",
          per_page: 10,
          request: { signal },
        });
        return { ...res, data: res.data as unknown as RawPull[] };
      },
    );
    if (!listed.ok) return "error";
    const pull = listed.data[0];
    if (!pull) return null;
    const bot = this.deps.botLogin().toLowerCase();
    return pull.user?.login?.toLowerCase() === bot ? pull : "foreign";
  }

  private async recordPull(
    pr: RawPull,
    outcome: "draft_opened" | "draft_adopted",
  ): Promise<DraftOpenOutcome> {
    const now = this.now();
    await this.patch({
      prNumber: pr.number,
      prState: attemptPrState(pr),
      prOpenedAt: this.attempt.prOpenedAt ?? now,
      phase: "ci_pending",
      nextPrOpenAt: null,
      updatedAt: now,
    });
    await updateFinding({
      db: this.db,
      organizationId: this.org,
      id: this.finding.id,
      patch: { prNumber: pr.number },
    });
    if (this.attempt.threadId !== null && this.attempt.branch !== null) {
      try {
        await this.deps.linkThread({
          db: this.db,
          organizationId: this.org,
          threadId: this.attempt.threadId,
          repoFullName: this.attempt.repoFullName,
          branch: this.attempt.branch,
          prNumber: pr.number,
          prStatus: pullStatus(pr),
        });
      } catch (error) {
        // Bookkeeping only: the attempt already records the PR.
        this.deps.log("[self-heal] fix PR thread link failed", {
          attemptId: this.attempt.id,
          error: errorText(error),
        });
      }
    }
    this.deps.log("[self-heal] fix draft PR recorded", {
      attemptId: this.attempt.id,
      prNumber: pr.number,
      outcome,
    });
    return outcome;
  }

  /** RES-18: keep the branch and retry from the tick sweep. */
  private async failedCall(
    result: Extract<SelfHealCallResult<unknown>, { ok: false }>,
  ): Promise<DraftOpenOutcome> {
    if (result.outcome === "permission") {
      return this.refund("missing-permission", "missing_permission");
    }
    const uncounted =
      result.outcome === "deadline" ||
      result.outcome === "breaker_open" ||
      result.outcome === "rate_limited" ||
      result.outcome === "primary_quota_reserve";
    return this.pending(!uncounted);
  }

  private async pending(countsAsFailure: boolean): Promise<DraftOpenOutcome> {
    const failures = this.attempt.prOpenAttempts + (countsAsFailure ? 1 : 0);
    if (failures >= PR_OPEN_MAX_FAILURES) return this.openFailed(failures);
    const delay = countsAsFailure
      ? (PR_OPEN_BACKOFF_MS[failures - 1] ?? UNCOUNTED_RETRY_MS)
      : UNCOUNTED_RETRY_MS;
    const now = this.now();
    await this.patch({
      prState: "pending_open",
      prOpenAttempts: failures,
      nextPrOpenAt: new Date(now.getTime() + delay),
      updatedAt: now,
    });
    this.deps.log("[self-heal] fix draft PR open pending", {
      attemptId: this.attempt.id,
      failures,
    });
    return "pending_open";
  }

  /** The check passed but no draft can be opened: a person takes over. */
  private async openFailed(failures?: number): Promise<DraftOpenOutcome> {
    const now = this.now();
    await this.patch({
      prState: "open_failed",
      ...(failures !== undefined ? { prOpenAttempts: failures } : {}),
      nextPrOpenAt: null,
      updatedAt: now,
    });
    const closed = await closeFixAttempt({
      db: this.db,
      organizationId: this.org,
      attemptId: this.attempt.id,
      outcome: "open_failed",
      counted: true,
      terminalCause: "pr_open_failed",
      now,
    });
    if (closed) {
      await this.comment(["open_failed"], this.attempt.branch ?? undefined);
      await this.markNeedsHuman("open_failed");
    }
    return "open_failed";
  }

  /** A counted non-PR outcome: close, delete the branch, one comment, cap. */
  private async counted(
    outcome: DraftOpenOutcome,
    reasons: readonly string[],
    {
      deleteBranch = true,
      terminalCause = outcome,
      github = true,
    }: {
      deleteBranch?: boolean;
      terminalCause?: string;
      github?: boolean;
    } = {},
  ): Promise<DraftOpenOutcome> {
    const closed = await closeFixAttempt({
      db: this.db,
      organizationId: this.org,
      attemptId: this.attempt.id,
      outcome,
      counted: true,
      terminalCause,
      now: this.now(),
    });
    if (!closed || !github) return outcome;
    if (deleteBranch) await this.deleteBranch();
    await this.comment(reasons);
    const finding = await getFindingForAttempt({
      db: this.db,
      organizationId: this.org,
      findingId: this.finding.id,
    });
    if (
      finding !== null &&
      finding.status === "open" &&
      finding.attempts >= this.maxAttempts
    ) {
      await this.markNeedsHuman("attempts_cap");
    }
    return outcome;
  }

  private async deleteBranch(): Promise<void> {
    const branch = this.attempt.branch;
    if (branch === null) return;
    const session = await this.openSession();
    if (typeof session !== "object") return;
    await deleteFixBranch(this.refTarget(session), branch);
  }

  private async comment(
    reasons: readonly string[],
    keptBranch?: string,
  ): Promise<void> {
    const issueNumber = this.finding.issueNumber;
    if (issueNumber === null) return;
    const session = await this.openSession();
    if (typeof session !== "object") return;
    const data = {
      fingerprint: this.finding.fingerprint,
      runId: this.attempt.id,
      attempts: this.attempt.attemptNo,
      maxAttempts: this.maxAttempts,
      reasons,
      ...(keptBranch !== undefined ? { keptBranch } : {}),
    };
    const res = await session.writer.upsertComment({
      number: issueNumber,
      marker: commentMarker({
        fp: data.fingerprint,
        kind: "fix_attempt_rejected",
        runId: data.runId,
      }),
      body: renderAuditComment("fix_attempt_rejected", data),
    });
    if (!res.ok) {
      this.deps.log("[self-heal] fix attempt comment failed", {
        attemptId: this.attempt.id,
        outcome: res.outcome,
      });
    }
  }

  /** needs-human-approve (RES-18 open_failed, or the attempts cap). */
  private async markNeedsHuman(
    reason: "attempts_cap" | "open_failed",
  ): Promise<void> {
    await this.needsHuman(reason, async () => {
      const session = await this.openSession();
      return typeof session === "object" ? session : null;
    });
  }
}

/** Attempts the opener may act on: reported, not closed, no PR yet. */
function isOpenable(
  attempt: AuditFixAttemptRow | null,
): attempt is AuditFixAttemptRow {
  return (
    attempt !== null &&
    attempt.phase !== "closed" &&
    attempt.checkReportedAt !== null &&
    (attempt.prState === null || attempt.prState === "pending_open")
  );
}

export async function openDraftFixPr({
  db,
  organizationId,
  attemptId,
  deadlineAt,
  deps = defaultOpenFixPrDeps(),
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  deadlineAt?: Date;
  deps?: OpenFixPrDeps;
}): Promise<DraftOpenOutcome> {
  const deadline =
    deadlineAt ?? new Date(deps.now().getTime() + OPEN_FIX_PR_BUDGET_MS);
  try {
    const before = await getFixAttemptById({
      db,
      organizationId,
      id: attemptId,
    });
    if (!isOpenable(before)) return "not_pending";
    const leased = await withAttemptLease({
      db,
      organizationId,
      attemptId,
      now: deps.now(),
      log: deps.log,
      releaseFailedMessage: "[self-heal] fix PR opener lease release failed",
      run: async (): Promise<DraftOpenOutcome> => {
        // Re-read under the lease: another holder may have finished meanwhile.
        const attempt = await getFixAttemptById({
          db,
          organizationId,
          id: attemptId,
        });
        if (!isOpenable(attempt)) return "not_pending";
        const finding = await getFindingForAttempt({
          db,
          organizationId,
          findingId: attempt.findingId,
        });
        if (finding === null) return "not_pending";
        const outcome = await new FixPrOpener(
          db,
          attempt,
          finding,
          deadline,
          deps,
        ).run();
        deps.log("[self-heal] fix PR opener", { attemptId, outcome });
        return outcome;
      },
    });
    return leased.leased ? leased.value : "lease_held";
  } catch (error) {
    deps.log("[self-heal] fix PR opener failed", {
      attemptId,
      error: errorText(error),
    });
    return "error";
  }
}

export interface FixPrOpenSweepResult {
  processed: number;
  outcomes: Partial<Record<DraftOpenOutcome, number>>;
}

/**
 * RES-18 on the tick: resume due pending opens and reports whose route
 * waitUntil was cut off. ≤ 20 rows, bounded by the tick's deadline; each row
 * is fenced again by its own organizationId. Never throws.
 */
export async function runFixPrOpenSweep({
  db,
  now,
  deadlineAt,
  limit = FIX_PR_SWEEP_LIMIT,
  deps = defaultOpenFixPrDeps(),
}: {
  db: DB;
  now: Date;
  deadlineAt: Date;
  limit?: number;
  deps?: OpenFixPrDeps;
}): Promise<FixPrOpenSweepResult> {
  const result: FixPrOpenSweepResult = { processed: 0, outcomes: {} };
  await runBoundedSweep({
    limit,
    list: () => listPendingPrOpens({ db, now, limit }),
    deadlineAt,
    now: deps.now,
    log: deps.log,
    listFailedMessage: "[self-heal] fix PR sweep list failed",
    each: async (row) => {
      const outcome = await openDraftFixPr({
        db,
        organizationId: row.organizationId,
        attemptId: row.id,
        deadlineAt,
        deps,
      });
      result.processed += 1;
      result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
    },
  });
  return result;
}
