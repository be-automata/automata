import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Octokit } from "octokit";

import { db as defaultDb } from "@/lib/db";
import { waitUntil } from "@/lib/wait-until";
import type { DB } from "@terragon/shared/db";
import { auditFixAttempts } from "@terragon/shared/db/schema";
import type {
  AuditFindingRow,
  AuditFixAttemptRow,
} from "@terragon/shared/model/audit-findings";
import {
  closeFixAttempt,
  getFindingForAttempt,
  getFixAttemptById,
  refundFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";
import { withSelfHealTx } from "@terragon/shared/model/self-heal-tx";
import { FIX_BRANCH_PREFIX } from "@terragon/shared/self-heal/fix-paths";

import { defaultOpenFixPrDeps, type OpenFixPrDeps } from "./open-fix-pr";
import {
  commentMarker,
  FINDING_LABELS,
  renderAuditComment,
} from "./render-issue";
import {
  absentAsNull,
  readRequiredChecks,
  selectGateSource,
  summarizeCheckRuns,
  type CheckRunLike,
  type CommitStatusLike,
  type GateSource,
  type RequiredCheckVerdict,
} from "./required-checks";
import { resolveSelfHealEffective } from "./resolve-self-heal";
import { PRE_MINT_INSTALLATION_KEY, errorText } from "./audit-shared";
import {
  closeFixPull,
  deleteFixBranch,
  FixAttemptGithub,
  runBoundedSweep,
  withAttemptLease,
} from "./fix-attempt-session";

/**
 * The CI gate of a self-heal draft (GATE-01 steps 4-5, SC4, R4, KILL-01).
 *
 * A draft opened by the PR writer (09-11) becomes ready for review ONLY when
 *  - the repo's CI gate for the gated head is green, where the gate source
 *    is chosen per head (required-checks.ts): branch protection's required
 *    checks, else every check on the head (+2 min settle), else — no CI at
 *    all within 10 min — the passing finding check alone (the PR then gets
 *    needs-human-approve and a no-repo-CI note);
 *  - GitHub's PR head still equals gated_head_sha;
 *  - the R4 guard still passes on compare(<base>...<gated sha>);
 *  - the effective mode is on.
 * The ready transition is the GraphQL markPullRequestReadyForReview mutation
 * through the App installation client (never the user-token server action),
 * which fires exactly one ready_for_review and so exactly one review.
 *
 * On failure the draft is withdrawn: closed with a marker comment, the branch
 * deleted, one issue comment; red CI, a moved head and a guard rejection are
 * COUNTED, cancelled/stale/startup_failure CI and a draft stuck for an hour
 * are REFUNDED. A kill switch refunds without any GitHub call (KILL-01).
 * Protection absence or removal never withdraws, refunds or blocks a draft.
 *
 * Nothing here merges, enables auto-merge or updates the branch: a person
 * merges (HUMAN-MERGE-GATE, no-merge.static.test.ts). Every GitHub call goes
 * through withSelfHealCall on a createSelfHealOctokit client, under the
 * attempt lease the opener also holds. Never throws.
 */

export type FixCiOutcome =
  | "ready"
  | "pending"
  | "ci_failed"
  | "ci_infra"
  | "guard_rejected"
  | "sha_mismatch"
  | "killed"
  | "lease_held"
  /** Still pending one hour after the open: withdrawn and refunded. */
  | "stuck"
  /** Not a draft awaiting CI (no PR yet, already ready, closed, merged). */
  | "not_draft"
  /** An unexpected error; the attempt is unchanged and the sweep retries. */
  | "error";

/** The waitUntil budget when the caller passes no deadline. */
export const EVALUATE_FIX_CI_BUDGET_MS = 25_000;
/** A draft whose CI is still pending this long after the open is stuck. */
export const FIX_CI_STUCK_MS = 3_600_000;
export const FIX_CI_SWEEP_LIMIT = 20;

/** The opener's deps minus the thread link the evaluator does not need. */
export type EvaluateFixCiDeps = Omit<OpenFixPrDeps, "linkThread">;

const MARK_READY_MUTATION = `mutation ($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
    pullRequest {
      id
      isDraft
    }
  }
}`;

/**
 * The ready transition: one GraphQL mutation on the App installation client.
 * GitHub then emits exactly one pull_request.ready_for_review.
 */
export async function markReadyViaApp(
  octokit: Octokit,
  prNodeId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return octokit.graphql(MARK_READY_MUTATION, {
    pullRequestId: prNodeId,
    ...(signal ? { request: { signal } } : {}),
  });
}

interface RawPull {
  number: number;
  node_id: string;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  head: { sha: string };
  base: { ref: string };
}

interface CiResults {
  gateSource: GateSource | null;
  state: RequiredCheckVerdict["state"];
  failing: string[];
  required: string[];
  checks: number;
  evaluatedAt: string;
}

interface WithdrawSpec {
  counted: boolean;
  reasons: readonly string[];
  ciStatus?: AuditFixAttemptRow["ciStatus"];
  ciResults?: CiResults;
}

/** One evaluation of one leased draft. */
class FixCiEvaluator extends FixAttemptGithub<EvaluateFixCiDeps> {
  private maxDiffLines = 0;

  constructor(
    db: DB,
    attempt: AuditFixAttemptRow,
    finding: AuditFindingRow,
    deadlineAt: Date,
    private readonly stuckIfPending: boolean,
    deps: EvaluateFixCiDeps,
  ) {
    super(db, attempt, finding, deadlineAt, deps, "fix CI evaluator");
  }

  async run(): Promise<FixCiOutcome> {
    const context = await this.deps.loadContext({
      db: this.db,
      organizationId: this.org,
      repoFullName: this.attempt.repoFullName,
      installationKey: PRE_MINT_INSTALLATION_KEY,
      probeAttemptId: this.attempt.id,
    });
    this.maxAttempts = context.resolved.settings.maxAttempts;
    this.maxDiffLines = context.resolved.settings.maxDiffLines;
    const effective = resolveSelfHealEffective(context);
    // KILL-01: an operator stop is never the fix's fault, and it makes no
    // GitHub call; the draft stays for a person to close.
    if (effective.mode !== "on" || !effective.fixAllowed) {
      const reason = effective.fixAllowed ? effective.reason : "loop_fix_open";
      await refundFixAttempt({
        db: this.db,
        organizationId: this.org,
        attemptId: this.attempt.id,
        cause: `fix_ci_${reason}`,
        outcome: "killed",
        now: this.now(),
      });
      return "killed";
    }

    const session = await this.openSession();
    if (session === "missing") {
      await refundFixAttempt({
        db: this.db,
        organizationId: this.org,
        attemptId: this.attempt.id,
        cause: "missing_permission",
        outcome: "ci_infra",
        now: this.now(),
      });
      return "ci_infra";
    }
    if (session === "unavailable") return this.touch();

    const prNumber = this.attempt.prNumber;
    if (prNumber === null) return "not_draft";
    const pull = await this.call<RawPull>(
      "read",
      "gh_read",
      "pull_requests",
      async (signal) => {
        const res = await session.octokit.rest.pulls.get({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          request: { signal },
        });
        return { ...res, data: res.data as unknown as RawPull };
      },
    );
    if (!pull.ok) return this.touch();
    const pr = pull.data;

    // A PR a person closed or merged is the lifecycle's business (09-14).
    if (pr.merged_at || pr.state === "closed") {
      await this.patch({ prState: pr.merged_at ? "merged" : "closed" });
      return "not_draft";
    }
    // T-09-12-2: exactly the checked commit is judged.
    if (pr.head.sha !== this.attempt.gatedHeadSha) {
      return this.withdraw("sha_mismatch", {
        counted: true,
        reasons: ["sha_mismatch"],
      });
    }
    // A person marked it ready already: the review is theirs to start.
    if (pr.draft !== true) {
      const now = this.now();
      await this.patch({ prState: "ready", phase: "ready", readyAt: now });
      return "not_draft";
    }

    const sha = pr.head.sha;
    const base = pr.base.ref;
    const [required, runs, statuses] = await Promise.all([
      readRequiredChecks({
        octokit: session.octokit,
        owner: this.owner,
        repo: this.repo,
        defaultBranch: base,
        organizationId: this.org,
        installationKey: session.installationKey,
        deadlineAt: this.deadlineAt,
        deps: this.callDeps,
      }),
      this.call<CheckRunLike[]>("read", "gh_read", "checks", async (signal) => {
        const res = await session.octokit.rest.checks.listForRef({
          owner: this.owner,
          repo: this.repo,
          ref: sha,
          filter: "latest",
          per_page: 100,
          request: { signal },
        });
        return {
          ...res,
          data: res.data.check_runs as unknown as CheckRunLike[],
        };
      }),
      // Legacy commit statuses; a 403/404 (no statuses permission) reads as none.
      this.call<CommitStatusLike[] | null>(
        "read",
        "gh_read",
        "contents",
        (signal) =>
          absentAsNull(async () => {
            const res =
              await session.octokit.rest.repos.getCombinedStatusForRef({
                owner: this.owner,
                repo: this.repo,
                ref: sha,
                per_page: 100,
                request: { signal },
              });
            return {
              ...res,
              data: res.data.statuses as unknown as CommitStatusLike[],
            };
          }),
      ),
    ]);
    if (!runs.ok || !statuses.ok) return this.touch();

    const now = this.now();
    const requiredNames = "names" in required ? required.names : null;
    const checkRuns = runs.data;
    const commitStatuses = statuses.data ?? [];
    const source = selectGateSource({
      requiredNames,
      checkRuns,
      statuses: commitStatuses,
      pushedAt: this.attempt.prOpenedAt ?? this.attempt.checkReportedAt ?? now,
      now,
    });
    const results = (
      gateSource: GateSource | null,
      verdict: RequiredCheckVerdict,
    ): CiResults => ({
      gateSource,
      state: verdict.state,
      failing: verdict.failing ?? [],
      required: requiredNames ?? [],
      checks: checkRuns.length + commitStatuses.length,
      evaluatedAt: now.toISOString(),
    });
    if (source === "pending") {
      return this.stillPending(results(null, { state: "pending" }));
    }

    const verdict = summarizeCheckRuns({
      source,
      required: requiredNames ?? [],
      checkRuns,
      statuses: commitStatuses,
      now,
    });
    const ciResults = results(source, verdict);
    switch (verdict.state) {
      case "failure":
        return this.withdraw("ci_failed", {
          counted: true,
          reasons: ["ci_failed"],
          ciStatus: "failed",
          ciResults,
        });
      case "infra":
        return this.withdraw("ci_infra", {
          counted: false,
          reasons: ["ci_infra"],
          ciStatus: "failed",
          ciResults,
        });
      case "pending":
        return this.stillPending(ciResults);
      case "success":
        return this.guardThenReady(pr, base, source, ciResults);
    }
  }

  /** R4 on the compare diff, then the ready transition. */
  private async guardThenReady(
    pr: RawPull,
    base: string,
    source: GateSource,
    ciResults: CiResults,
  ): Promise<FixCiOutcome> {
    const session = this.gh;
    if (session === null) return this.touch();
    const checked = await this.compareAndGuard(
      session,
      `${base}...${pr.head.sha}`,
      this.maxDiffLines,
    );
    if (checked.kind === "failed") return this.touch();
    if (checked.kind === "empty") {
      return this.withdraw("guard_rejected", {
        counted: true,
        reasons: ["no_changes"],
        ciStatus: "passed",
        ciResults,
      });
    }
    const guard = checked.guard;
    if (!guard.ok) {
      await this.patch({
        guardStatus: "rejected",
        guardReasons: guard.rejections,
        diffLines: guard.diffLines,
      });
      this.deps.log("[self-heal] fix diff rejected by the guard at CI", {
        attemptId: this.attempt.id,
        reasons: guard.rejections,
        diffLines: guard.diffLines,
      });
      return this.withdraw("guard_rejected", {
        counted: true,
        reasons: guard.rejections,
        ciStatus: "passed",
        ciResults,
      });
    }

    if (source === "finding-check-only") await this.flagNoRepoCi(pr.number);

    const ready = await this.call<unknown>(
      "write",
      "gh_write",
      "pull_requests",
      async (signal) => ({
        data: await markReadyViaApp(session.octokit, pr.node_id, signal),
        status: 200,
        headers: {},
      }),
      true,
    );
    if (!ready.ok) {
      this.deps.log("[self-heal] fix draft ready transition failed", {
        attemptId: this.attempt.id,
        outcome: ready.outcome,
      });
      return this.touch(ciResults);
    }
    const now = this.now();
    await this.patch({
      prState: "ready",
      phase: "ready",
      readyAt: now,
      ciStatus: "passed",
      ciResults,
      ciEvaluatedAt: now,
      guardStatus: "passed",
      guardReasons: [],
      diffLines: guard.diffLines,
      updatedAt: now,
    });
    this.deps.log("[self-heal] fix draft marked ready", {
      attemptId: this.attempt.id,
      prNumber: pr.number,
      gateSource: source,
    });
    return "ready";
  }

  /** No repo CI: the PR carries needs-human-approve and a note. Best effort. */
  private async flagNoRepoCi(prNumber: number): Promise<void> {
    const session = this.gh;
    if (session === null) return;
    const labels = await session.writer.updateIssue({
      number: prNumber,
      labelsAdd: [FINDING_LABELS.needsHumanApprove],
    });
    const note = await session.writer.upsertComment({
      number: prNumber,
      marker: commentMarker({
        fp: this.finding.fingerprint,
        kind: "fix_draft_no_repo_ci",
        runId: this.attempt.id,
      }),
      body: renderAuditComment("fix_draft_no_repo_ci", {
        fingerprint: this.finding.fingerprint,
        runId: this.attempt.id,
      }),
    });
    if (!labels.ok || !note.ok) {
      this.deps.log("[self-heal] no-repo-CI flag failed", {
        attemptId: this.attempt.id,
        label: labels.ok ? "ok" : labels.outcome,
        note: note.ok ? "ok" : note.outcome,
      });
    }
  }

  /** Still pending: record it, or withdraw (refunded) when stuck. */
  private async stillPending(ciResults: CiResults): Promise<FixCiOutcome> {
    if (this.stuckIfPending) {
      return this.withdraw("stuck", {
        counted: false,
        reasons: ["ci_stuck"],
        ciStatus: "stuck",
        ciResults,
      });
    }
    const now = this.now();
    await this.patch({
      ciStatus: "pending",
      ciResults,
      ciEvaluatedAt: now,
    });
    return "pending";
  }

  /**
   * GitHub did not answer (or the session could not open): nothing is
   * decided. The evaluation time moves so the sweep rotates through drafts.
   */
  private async touch(ciResults?: CiResults): Promise<FixCiOutcome> {
    await this.patch({
      ciEvaluatedAt: this.now(),
      ...(ciResults ? { ciResults } : {}),
    });
    return "pending";
  }

  /**
   * Withdraw the draft: close the attempt in the DB first (exactly once via
   * the close CAS), then the PR comment, PR close, branch delete and one
   * issue comment, best effort; a counted outcome at the cap goes
   * needs-human-approve.
   */
  private async withdraw(
    outcome: FixCiOutcome,
    spec: WithdrawSpec,
  ): Promise<FixCiOutcome> {
    const now = this.now();
    await this.patch({
      ...(spec.ciStatus ? { ciStatus: spec.ciStatus } : {}),
      ...(spec.ciResults ? { ciResults: spec.ciResults } : {}),
      ciEvaluatedAt: now,
    });
    // Uncounted is the infra refund (same write as refundFixAttempt).
    const closed = await closeFixAttempt({
      db: this.db,
      organizationId: this.org,
      attemptId: this.attempt.id,
      outcome,
      counted: spec.counted,
      terminalCause: outcome,
      now,
    });
    if (!closed) return outcome;

    const prNumber = this.attempt.prNumber;
    if (prNumber !== null) {
      await this.commentOnPull(prNumber, spec);
      if (await this.closePull(prNumber)) {
        await this.patch({ prState: "closed", updatedAt: this.now() });
      }
    }
    await this.deleteBranch();
    await this.commentOnIssue(spec.reasons, prNumber);
    this.deps.log("[self-heal] fix draft withdrawn", {
      attemptId: this.attempt.id,
      outcome,
      counted: spec.counted,
      gateSource: spec.ciResults?.gateSource ?? null,
    });
    if (spec.counted) {
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
        await this.needsHuman("attempts_cap", async () => this.gh);
      }
    }
    return outcome;
  }

  private async commentOnPull(
    prNumber: number,
    spec: WithdrawSpec,
  ): Promise<void> {
    const session = this.gh;
    if (session === null) return;
    const res = await session.writer.upsertComment({
      number: prNumber,
      marker: commentMarker({
        fp: this.finding.fingerprint,
        kind: "fix_draft_withdrawn",
        runId: this.attempt.id,
      }),
      body: renderAuditComment("fix_draft_withdrawn", {
        fingerprint: this.finding.fingerprint,
        runId: this.attempt.id,
        attempts: this.attempt.attemptNo,
        maxAttempts: this.maxAttempts,
        reasons: spec.reasons,
        counted: spec.counted,
      }),
    });
    if (!res.ok) {
      this.deps.log("[self-heal] fix draft comment failed", {
        attemptId: this.attempt.id,
        outcome: res.outcome,
      });
    }
  }

  private async closePull(prNumber: number): Promise<boolean> {
    const session = this.gh;
    if (session === null) return false;
    return closeFixPull(
      this.refTarget(session),
      prNumber,
      "[self-heal] fix draft close failed",
    );
  }

  private async deleteBranch(): Promise<void> {
    const branch = this.attempt.branch;
    const session = this.gh;
    if (branch === null || session === null) return;
    await deleteFixBranch(this.refTarget(session), branch);
  }

  private async commentOnIssue(
    reasons: readonly string[],
    prNumber: number | null,
  ): Promise<void> {
    const issueNumber = this.finding.issueNumber;
    const session = this.gh;
    if (issueNumber === null || session === null) return;
    const res = await session.writer.upsertComment({
      number: issueNumber,
      marker: commentMarker({
        fp: this.finding.fingerprint,
        kind: "fix_attempt_rejected",
        runId: this.attempt.id,
      }),
      body: renderAuditComment("fix_attempt_rejected", {
        fingerprint: this.finding.fingerprint,
        runId: this.attempt.id,
        attempts: this.attempt.attemptNo,
        maxAttempts: this.maxAttempts,
        reasons,
        ...(prNumber !== null ? { draftNumber: prNumber } : {}),
      }),
    });
    if (!res.ok) {
      this.deps.log("[self-heal] fix attempt comment failed", {
        attemptId: this.attempt.id,
        outcome: res.outcome,
      });
    }
  }
}

/** A draft awaiting its CI verdict. */
function isEvaluable(
  attempt: AuditFixAttemptRow | null,
): attempt is AuditFixAttemptRow {
  return (
    attempt !== null &&
    attempt.phase === "ci_pending" &&
    attempt.prState === "draft" &&
    attempt.prNumber !== null &&
    attempt.gatedHeadSha !== null &&
    attempt.branch !== null
  );
}

export async function evaluateFixCi({
  db,
  organizationId,
  attemptId,
  deadlineAt,
  stuckIfPending = false,
  deps = defaultOpenFixPrDeps(),
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  deadlineAt?: Date;
  /** The stuck sweep: a draft still pending is withdrawn and refunded. */
  stuckIfPending?: boolean;
  deps?: EvaluateFixCiDeps;
}): Promise<FixCiOutcome> {
  const deadline =
    deadlineAt ?? new Date(deps.now().getTime() + EVALUATE_FIX_CI_BUDGET_MS);
  try {
    const before = await getFixAttemptById({
      db,
      organizationId,
      id: attemptId,
    });
    if (!isEvaluable(before)) return "not_draft";
    const leased = await withAttemptLease({
      db,
      organizationId,
      attemptId,
      now: deps.now(),
      log: deps.log,
      releaseFailedMessage: "[self-heal] fix CI evaluator lease release failed",
      run: async (): Promise<FixCiOutcome> => {
        // Re-read under the lease: another holder may have finished meanwhile.
        const attempt = await getFixAttemptById({
          db,
          organizationId,
          id: attemptId,
        });
        if (!isEvaluable(attempt)) return "not_draft";
        const finding = await getFindingForAttempt({
          db,
          organizationId,
          findingId: attempt.findingId,
        });
        if (finding === null) return "not_draft";
        const outcome = await new FixCiEvaluator(
          db,
          attempt,
          finding,
          deadline,
          stuckIfPending,
          deps,
        ).run();
        deps.log("[self-heal] fix CI evaluator", { attemptId, outcome });
        return outcome;
      },
    });
    return leased.leased ? leased.value : "lease_held";
  } catch (error) {
    deps.log("[self-heal] fix CI evaluator failed", {
      attemptId,
      error: errorText(error),
    });
    return "error";
  }
}

/**
 * UNFENCED: drafts awaiting a CI verdict across all orgs with a free lease,
 * least recently evaluated first. Rows carry organizationId; every later
 * call re-fences on it.
 */
async function listCiPendingDrafts({
  db,
  now,
  limit,
}: {
  db: DB;
  now: Date;
  limit: number;
}): Promise<AuditFixAttemptRow[]> {
  return withSelfHealTx(db, (tx) =>
    tx
      .select()
      .from(auditFixAttempts)
      .where(
        and(
          eq(auditFixAttempts.phase, "ci_pending"),
          eq(auditFixAttempts.prState, "draft"),
          isNotNull(auditFixAttempts.prNumber),
          isNotNull(auditFixAttempts.gatedHeadSha),
          or(
            isNull(auditFixAttempts.ciStatus),
            eq(auditFixAttempts.ciStatus, "pending"),
          ),
          or(
            isNull(auditFixAttempts.leaseUntil),
            lte(auditFixAttempts.leaseUntil, now),
          ),
        ),
      )
      .orderBy(
        sql`${auditFixAttempts.ciEvaluatedAt} asc nulls first`,
        asc(auditFixAttempts.prOpenedAt),
      )
      .limit(limit),
  );
}

export interface FixCiSweepResult {
  processed: number;
  outcomes: Partial<Record<FixCiOutcome, number>>;
}

/**
 * The tick's CI sweep: evaluate every draft still awaiting CI (≤ 20 per
 * tick, bounded by the tick's deadline). A draft whose CI is still pending
 * an hour after the open is evaluated once more and, still pending, marked
 * stuck: withdrawn and refunded. The sweep is also what moves a draft whose
 * last check completed without a later webhook (the all-checks settle
 * window) and a repo with no CI at all (finding-check-only). Never throws.
 */
export async function runStuckDraftSweep({
  db,
  now,
  deadlineAt,
  limit = FIX_CI_SWEEP_LIMIT,
  deps = defaultOpenFixPrDeps(),
}: {
  db: DB;
  now: Date;
  deadlineAt: Date;
  limit?: number;
  deps?: EvaluateFixCiDeps;
}): Promise<FixCiSweepResult> {
  const result: FixCiSweepResult = { processed: 0, outcomes: {} };
  const stuckBefore = now.getTime() - FIX_CI_STUCK_MS;
  await runBoundedSweep({
    limit,
    list: () => listCiPendingDrafts({ db, now, limit }),
    deadlineAt,
    now: deps.now,
    log: deps.log,
    listFailedMessage: "[self-heal] fix CI sweep list failed",
    each: async (row) => {
      const outcome = await evaluateFixCi({
        db,
        organizationId: row.organizationId,
        attemptId: row.id,
        deadlineAt,
        stuckIfPending:
          row.prOpenedAt !== null && row.prOpenedAt.getTime() <= stuckBefore,
        deps,
      });
      result.processed += 1;
      result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
    },
  });
  return result;
}

const HEAD_SHA_RE = /^[0-9a-f]{40}$/;
/** More drafts than this on one head sha is not a real state; bound it. */
const CI_EVENT_MATCH_LIMIT = 5;

export interface SelfHealCiEventDeps {
  db: DB;
  evaluate: typeof evaluateFixCi;
  schedule: (promise: Promise<unknown>) => void;
}

interface CiEventPayload {
  check_suite?: { head_sha?: unknown; head_branch?: unknown } | null;
  workflow_run?: { head_sha?: unknown; head_branch?: unknown } | null;
  repository?: { full_name?: unknown } | null;
}

function ciEventTarget(
  payload: unknown,
): { headSha: string; repo: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const event = payload as CiEventPayload;
  // A draft's head is always on its automata/fix-* branch: an event naming
  // another branch is not one of ours (no branch named: still looked up).
  const headBranch =
    event.check_suite?.head_branch ?? event.workflow_run?.head_branch;
  if (
    typeof headBranch === "string" &&
    !headBranch.startsWith(FIX_BRANCH_PREFIX)
  ) {
    return null;
  }
  const headSha =
    event.check_suite?.head_sha ?? event.workflow_run?.head_sha ?? null;
  const repo = event.repository?.full_name;
  if (typeof headSha !== "string" || !HEAD_SHA_RE.test(headSha)) return null;
  if (typeof repo !== "string" || repo.length === 0) return null;
  return { headSha, repo: normalizeRepo(repo) };
}

/**
 * check_suite.completed / workflow_run.completed (GATE-01, T-09-12-5): ONE
 * indexed lookup (gated_head_sha) for drafts awaiting CI on this head; a
 * match hands the evaluation to waitUntil and returns. An event whose head
 * branch is not an automata/fix-* branch costs nothing. No GitHub call is
 * made inside the webhook, and a non-matching event costs one query. The
 * payload's conclusion is never trusted: the evaluator re-reads the checks
 * from GitHub for the gated sha (T-09-12-1). Never throws.
 */
export async function handleSelfHealCiEvent(
  payload: unknown,
  overrides: Partial<SelfHealCiEventDeps> = {},
): Promise<void> {
  const deps: SelfHealCiEventDeps = {
    db: defaultDb,
    evaluate: evaluateFixCi,
    schedule: waitUntil,
    ...overrides,
  };
  const target = ciEventTarget(payload);
  if (target === null) return;
  try {
    const rows = await withSelfHealTx(deps.db, (tx) =>
      tx
        .select({
          id: auditFixAttempts.id,
          organizationId: auditFixAttempts.organizationId,
        })
        .from(auditFixAttempts)
        .where(
          and(
            eq(auditFixAttempts.gatedHeadSha, target.headSha),
            eq(auditFixAttempts.phase, "ci_pending"),
            eq(auditFixAttempts.prState, "draft"),
            sql`lower(${auditFixAttempts.repoFullName}) = ${target.repo}`,
          ),
        )
        .limit(CI_EVENT_MATCH_LIMIT),
    );
    for (const row of rows) {
      deps.schedule(
        deps.evaluate({
          db: deps.db,
          organizationId: row.organizationId,
          attemptId: row.id,
        }),
      );
    }
  } catch (error) {
    console.error("[self-heal] CI event lookup failed", {
      headSha: target.headSha,
      error: errorText(error),
    });
  }
}
