import type { DB } from "@terragon/shared/db";
import type { AuditFixAttemptRow } from "@terragon/shared/model/audit-findings";
import {
  closeFixAttempt,
  listOpenReadyFixPrs,
  recordFixPrClosed,
} from "@terragon/shared/model/audit-fix-attempts";
import { SELF_HEAL_BOUNDS } from "@terragon/shared/model/self-heal-settings";

import {
  defaultFixPrLifecycleDeps,
  endOfPull,
  FixPrLifecycle,
  type FixPrLifecycleDeps,
  type FixPrSession,
} from "./fix-pr-lifecycle";
import { isBotUser } from "./regression";
import { commentMarker, renderAuditComment } from "./render-issue";
import { errorText } from "./audit-shared";
import {
  closeFixPull,
  deleteFixBranch,
  runBoundedSweep,
  withAttemptLease,
} from "./fix-attempt-session";

/**
 * Expiry of unreviewed fix PRs (R5, BRK-01). Unreviewed PRs are the largest
 * single cause of failed agent PRs, so a ready fix PR nobody reviewed within
 * the repo's selfHealPrExpiryDays is withdrawn by the platform:
 *
 *  - any human review (any state) exempts the PR, for good;
 *  - a PR GitHub already shows merged or closed is settled by the 09-14
 *    lifecycle recorders instead (no close call);
 *  - a PR turned back into a draft is the stuck-draft sweep's (09-12);
 *  - otherwise the attempt is recorded expired and closed (counted) FIRST,
 *    so the pull_request.closed webhook our own close fires is a no-op; then
 *    one marker comment, the PR close and the branch delete, best effort;
 *    one loop_fix `pr_expired` event (two in a row trip the breaker, 09-13).
 *
 * Only the effective mode `on` acts: off, dry-run, the kill switch and
 * disabled side effects make no GitHub call and no write (KILL-01). A
 * loop_fix breaker does not stop expiry: withdrawing stale PRs only narrows.
 * ≤ 20 PRs per run, bounded by the cron deadline. Nothing here merges.
 * Never throws.
 */

export const FIX_PR_EXPIRY_LIMIT = 20;
export const FIX_PR_REVIEWS_PAGE = 100;
const DAY_MS = 86_400_000;

export type FixPrExpiryOutcome =
  | "expired"
  /** A person reviewed it: exempt. */
  | "reviewed"
  /** Not older than the repo's window yet. */
  | "young"
  /** Mode not on, or the lease is held. */
  | "skipped"
  /** pulls.get or listReviews could not be read. */
  | "unreadable"
  /** A person turned it back into a draft. */
  | "draft"
  /** GitHub already showed it merged / closed: settled by the lifecycle. */
  | "merged"
  | "closed"
  | "already"
  | "reopened"
  | "error";

export interface FixPrExpiryDeps extends FixPrLifecycleDeps {
  list: typeof listOpenReadyFixPrs;
}

export function defaultFixPrExpiryDeps(): FixPrExpiryDeps {
  return { ...defaultFixPrLifecycleDeps(), list: listOpenReadyFixPrs };
}

export interface FixPrExpirySweepResult {
  checked: number;
  expired: number;
  outcomes: Partial<Record<FixPrExpiryOutcome, number>>;
}

interface RawReview {
  user?: { login?: string; type?: string } | null;
}

class Expiry {
  private readonly lifecycle: FixPrLifecycle;
  private readonly owner: string;
  private readonly repo: string;

  constructor(
    private readonly deps: FixPrExpiryDeps,
    private readonly attempt: AuditFixAttemptRow,
    deadlineAt: Date,
  ) {
    this.lifecycle = new FixPrLifecycle(deps, attempt, deadlineAt);
    const [owner = "", repo = ""] = attempt.repoFullName.split("/");
    this.owner = owner;
    this.repo = repo;
  }

  private get org(): string {
    return this.attempt.organizationId;
  }

  async run(): Promise<FixPrExpiryOutcome> {
    const mode = await this.lifecycle.mode();
    if (mode !== "on") {
      this.deps.log("[self-heal] fix PR expiry skipped", {
        attemptId: this.attempt.id,
        mode,
      });
      return "skipped";
    }
    const days = this.lifecycle.expiryDays;
    const readyAt = this.attempt.readyAt;
    if (
      readyAt === null ||
      this.deps.now().getTime() - readyAt.getTime() < days * DAY_MS
    ) {
      return "young";
    }

    const pull = await this.lifecycle.readPull();
    if (pull === null) return "unreadable";
    if (pull.state === "closed") {
      return this.lifecycle.settle(endOfPull(pull), "await");
    }
    if (pull.draft === true) return "draft";

    const session = await this.lifecycle.openSession();
    if (session === "unavailable") return "unreadable";
    const reviewed = await this.humanReviewed(session);
    if (reviewed === null) return "unreadable";
    if (reviewed) return "reviewed";

    return this.expire(session, days);
  }

  /** null when the review list could not be read. */
  private async humanReviewed(session: FixPrSession): Promise<boolean | null> {
    const prNumber = this.attempt.prNumber;
    if (prNumber === null) return null;
    const res = await this.lifecycle.call<RawReview[]>(
      session,
      "read",
      "pull_requests",
      async (signal) => {
        const out = await session.octokit.rest.pulls.listReviews({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          per_page: FIX_PR_REVIEWS_PAGE,
          request: { signal },
        });
        return { ...out, data: out.data as unknown as RawReview[] };
      },
    );
    if (!res.ok) return null;
    const botLogin = this.deps.botLogin();
    return res.data.some(
      (review) =>
        typeof review.user?.login === "string" &&
        !isBotUser(review.user, botLogin),
    );
  }

  private async expire(
    session: FixPrSession,
    days: number,
  ): Promise<FixPrExpiryOutcome> {
    const now = this.deps.now();
    await recordFixPrClosed({
      db: this.deps.db,
      organizationId: this.org,
      attemptId: this.attempt.id,
      state: "expired",
      now,
    });
    const closed = await closeFixAttempt({
      db: this.deps.db,
      organizationId: this.org,
      attemptId: this.attempt.id,
      outcome: "pr_expired",
      counted: true,
      terminalCause: "pr_expired",
      now,
    });
    if (!closed) return "already";

    await this.comment(session, days);
    await this.closePull(session);
    await this.deleteBranch(session);
    await this.lifecycle.lifecycleEvent("failure", "pr_expired");
    await this.lifecycle.decision("expired");
    this.deps.log("[self-heal] fix PR expired", {
      attemptId: this.attempt.id,
      prNumber: this.attempt.prNumber,
      expiryDays: days,
    });
    await this.lifecycle.capCheck();
    return "expired";
  }

  private async comment(session: FixPrSession, days: number): Promise<void> {
    const prNumber = this.attempt.prNumber;
    if (prNumber === null) return;
    const finding = await this.lifecycle.finding();
    if (finding === null) return;
    const res = await this.lifecycle.issueWriter(session).upsertComment({
      number: prNumber,
      marker: commentMarker({
        fp: finding.fingerprint,
        kind: "fix_pr_expired",
        runId: this.attempt.id,
      }),
      body: renderAuditComment("fix_pr_expired", {
        fingerprint: finding.fingerprint,
        runId: this.attempt.id,
        expiryDays: days,
      }),
    });
    if (!res.ok) {
      this.deps.log("[self-heal] fix PR expiry comment failed", {
        attemptId: this.attempt.id,
        outcome: res.outcome,
      });
    }
  }

  private async closePull(session: FixPrSession): Promise<void> {
    const prNumber = this.attempt.prNumber;
    if (prNumber === null) return;
    await closeFixPull(
      this.lifecycle.refTarget(session),
      prNumber,
      "[self-heal] fix PR expiry close failed",
    );
  }

  private async deleteBranch(session: FixPrSession): Promise<void> {
    const branch = this.attempt.branch;
    if (branch === null) return;
    await deleteFixBranch(this.lifecycle.refTarget(session), branch);
  }
}

async function expireOne(
  deps: FixPrExpiryDeps,
  row: AuditFixAttemptRow,
  deadlineAt: Date,
): Promise<FixPrExpiryOutcome> {
  const leased = await withAttemptLease({
    db: deps.db,
    organizationId: row.organizationId,
    attemptId: row.id,
    now: deps.now(),
    log: deps.log,
    releaseFailedMessage: "[self-heal] fix PR expiry lease release failed",
    run: () => new Expiry(deps, row, deadlineAt).run(),
  });
  return leased.leased ? leased.value : "skipped";
}

/**
 * The hourly expiry sweep: ready fix PRs (≥ 1 day ready, the smallest
 * window any repo can set), ≤ 20 per run, each checked against its repo's
 * own window. Never throws.
 */
export async function runFixPrExpirySweep({
  db,
  now,
  deadlineAt,
  limit = FIX_PR_EXPIRY_LIMIT,
  deps: overrides = {},
}: {
  db: DB;
  now: Date;
  deadlineAt: Date;
  limit?: number;
  deps?: Partial<FixPrExpiryDeps>;
}): Promise<FixPrExpirySweepResult> {
  const deps: FixPrExpiryDeps = {
    ...defaultFixPrExpiryDeps(),
    ...overrides,
    db,
  };
  const result: FixPrExpirySweepResult = {
    checked: 0,
    expired: 0,
    outcomes: {},
  };
  const cap = Math.min(limit, FIX_PR_EXPIRY_LIMIT);
  await runBoundedSweep({
    limit: cap,
    list: () =>
      deps.list({
        db,
        now,
        readyBefore: new Date(
          now.getTime() - SELF_HEAL_BOUNDS.prExpiryDays.min * DAY_MS,
        ),
        limit: cap,
      }),
    deadlineAt,
    now: deps.now,
    log: deps.log,
    listFailedMessage: "[self-heal] fix PR expiry list failed",
    each: async (row) => {
      let outcome: FixPrExpiryOutcome;
      try {
        outcome = await expireOne(deps, row, deadlineAt);
      } catch (error) {
        deps.log("[self-heal] fix PR expiry failed", {
          attemptId: row.id,
          error: errorText(error),
        });
        outcome = "error";
      }
      result.checked += 1;
      if (outcome === "expired") result.expired += 1;
      result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
    },
  });
  return result;
}
