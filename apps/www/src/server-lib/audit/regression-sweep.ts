import type { DB } from "@terragon/shared/db";
import type { AuditFixAttemptRow } from "@terragon/shared/model/audit-findings";
import {
  claimRegressionCheck,
  getFindingForAttempt,
  listRegressionCandidates,
  recordFixRegression,
  regressionRecordOf,
  type FixChangedRanges,
  type RegressionRecord,
} from "@terragon/shared/model/audit-fix-attempts";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";
import { recordBreakerEvent } from "@terragon/shared/model/self-heal-breaker";

import {
  defaultFixPrLifecycleDeps,
  FixPrLifecycle,
  type FixPrLifecycleDeps,
  type FixPrSession,
} from "./fix-pr-lifecycle";
import { renderFixPrTitle } from "./open-fix-pr";
import {
  detectRevert,
  findFollowupOverlaps,
  isBotUser,
  type FollowupCommit,
} from "./regression";
import { errorText } from "./audit-shared";
import { runBoundedSweep } from "./fix-attempt-session";

/**
 * 30-day regression tracking of merged self-heal fixes (R5, BRK-01, SC5).
 * Agent PRs need follow-up fixes markedly more often than human PRs, so
 * for 30 days after a person merges a fix PR a daily, READ-ONLY check
 * records:
 *
 *  - a revert of the merge on the default branch;
 *  - commits by non-bot authors that edit the merged line ranges;
 *  - a reopen of the finding (last_reopened_at > merged_at).
 *
 * Each NEW signal (absent from the previous record) records one loop_fix
 * event — `regressed` for a revert or a follow-up, `reopened` for a reopen
 * — and two in 30 days trip the repo's loop breaker (09-13). The check is
 * taken with a CAS on regression_checked_at, so overlapping runs never emit
 * the same event twice.
 *
 * Bounds (T-09-15-3): ≤ 10 attempts per run, one listCommits page of 100
 * and ≤ 20 getCommit calls per attempt, 24 h between checks. GitHub is read
 * only when the effective mode is not off; this module makes no GitHub
 * write. Never throws.
 */

export const FIX_REGRESSION_LIMIT = 10;
export const FIX_REGRESSION_COMMITS_PAGE = 100;
export const FIX_REGRESSION_GET_COMMIT_CAP = 20;

export type FixRegressionOutcome =
  | "checked"
  | "regressed"
  | "reopened"
  /** Another run holds today's check. */
  | "skipped"
  | "error";

export interface FixRegressionDeps extends FixPrLifecycleDeps {
  list: typeof listRegressionCandidates;
}

export function defaultFixRegressionDeps(): FixRegressionDeps {
  return { ...defaultFixPrLifecycleDeps(), list: listRegressionCandidates };
}

export interface FixRegressionSweepResult {
  checked: number;
  regressed: number;
  reopened: number;
  outcomes: Partial<Record<FixRegressionOutcome, number>>;
}

interface RawListedCommit {
  sha: string;
  commit?: { message?: string } | null;
  author?: { login?: string; type?: string } | null;
}

interface RawCommitDetail {
  files?: Array<{ filename: string; patch?: string }>;
}

/** The stored merged ranges, or null when unknown (09-14: no backfill). */
function changedRangesOf(value: unknown): FixChangedRanges | null {
  if (!Array.isArray(value)) return null;
  const out: FixChangedRanges = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { file, ranges } = entry as { file?: unknown; ranges?: unknown };
    if (typeof file !== "string" || !Array.isArray(ranges)) continue;
    const valid = ranges.filter(
      (r): r is [number, number] =>
        Array.isArray(r) &&
        r.length === 2 &&
        typeof r[0] === "number" &&
        typeof r[1] === "number",
    );
    out.push({ file, ranges: valid });
  }
  return out;
}

interface GithubView {
  reverted: boolean;
  revertSha?: string;
  newFollowups: string[];
}

class RegressionCheck {
  private readonly lifecycle: FixPrLifecycle;
  private readonly owner: string;
  private readonly repo: string;

  constructor(
    private readonly deps: FixRegressionDeps,
    private readonly attempt: AuditFixAttemptRow,
    private readonly now: Date,
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

  async run(): Promise<{ regressed: boolean; reopened: boolean } | null> {
    const mergedAt = this.attempt.mergedAt;
    const windowEndsAt = this.attempt.regressionWindowEndsAt;
    if (mergedAt === null || windowEndsAt === null) return null;
    const claimed = await claimRegressionCheck({
      db: this.deps.db,
      organizationId: this.org,
      attemptId: this.attempt.id,
      now: this.now,
    });
    if (!claimed) return null;

    const previous = regressionRecordOf(this.attempt.regression);
    const finding = await getFindingForAttempt({
      db: this.deps.db,
      organizationId: this.org,
      findingId: this.attempt.findingId,
    });
    const lastReopenedAt = finding?.lastReopenedAt ?? null;
    const reopenedNow =
      lastReopenedAt !== null && lastReopenedAt.getTime() > mergedAt.getTime();

    const known = previous?.followupShas ?? [];
    const view =
      (await this.lifecycle.mode()) === "off"
        ? null
        : await this.readGithub(mergedAt, known, finding?.title ?? null);

    const reverted = (previous?.reverted ?? false) || (view?.reverted ?? false);
    const revertSha = previous?.revertSha ?? view?.revertSha;
    const record: RegressionRecord = {
      reverted,
      ...(revertSha !== undefined ? { revertSha } : {}),
      followupShas: [...known, ...(view?.newFollowups ?? [])],
      reopened: (previous?.reopened ?? false) || reopenedNow,
      checkedAt: this.now.toISOString(),
      windowComplete: this.now.getTime() >= windowEndsAt.getTime(),
    };
    await recordFixRegression({
      db: this.deps.db,
      organizationId: this.org,
      attemptId: this.attempt.id,
      regression: record,
      now: this.now,
    });

    const regressed =
      (record.reverted && !(previous?.reverted ?? false)) ||
      (view?.newFollowups.length ?? 0) > 0;
    const reopened = record.reopened && !(previous?.reopened ?? false);
    if (regressed) await this.event("regressed");
    if (reopened) await this.event("reopened");
    this.deps.log("[self-heal] fix regression check", {
      attemptId: this.attempt.id,
      reverted: record.reverted,
      followups: record.followupShas.length,
      reopened: record.reopened,
      windowComplete: record.windowComplete,
      newSignal: regressed || reopened,
    });
    return { regressed, reopened };
  }

  /** Read-only; null on any read failure (the previous record stands). */
  private async readGithub(
    mergedAt: Date,
    known: readonly string[],
    findingTitle: string | null,
  ): Promise<GithubView | null> {
    const session = await this.lifecycle.openSession();
    if (session === "unavailable") return null;
    const listed = await this.lifecycle.call<RawListedCommit[]>(
      session,
      "read",
      "contents",
      async (signal) => {
        const out = await session.octokit.rest.repos.listCommits({
          owner: this.owner,
          repo: this.repo,
          since: mergedAt.toISOString(),
          per_page: FIX_REGRESSION_COMMITS_PAGE,
          request: { signal },
        });
        return { ...out, data: out.data as unknown as RawListedCommit[] };
      },
    );
    if (!listed.ok) {
      this.deps.log("[self-heal] fix regression read failed", {
        attemptId: this.attempt.id,
        outcome: listed.outcome,
      });
      return null;
    }
    const commits = listed.data.slice(0, FIX_REGRESSION_COMMITS_PAGE);
    const prNumber = this.attempt.prNumber ?? 0;
    const verdict = detectRevert(
      commits.map((c) => ({ sha: c.sha, message: c.commit?.message ?? "" })),
      {
        mergeSha: this.attempt.mergeSha,
        prNumber,
        prTitle:
          findingTitle === null
            ? null
            : renderFixPrTitle({ title: findingTitle }),
      },
    );
    const newFollowups = await this.followups(
      session,
      commits,
      known,
      verdict.revertSha,
    );
    return {
      reverted: verdict.reverted,
      ...(verdict.revertSha !== undefined
        ? { revertSha: verdict.revertSha }
        : {}),
      newFollowups,
    };
  }

  /** Non-bot commits not seen before, ≤ 20 getCommit reads. */
  private async followups(
    session: FixPrSession,
    commits: readonly RawListedCommit[],
    known: readonly string[],
    revertSha: string | undefined,
  ): Promise<string[]> {
    const ranges = changedRangesOf(this.attempt.changedRanges);
    if (ranges === null || ranges.length === 0) return [];
    const botLogin = this.deps.botLogin();
    const candidates = commits
      .filter(
        (c) =>
          !isBotUser(c.author, botLogin) &&
          c.sha !== this.attempt.mergeSha &&
          c.sha !== revertSha &&
          !known.includes(c.sha),
      )
      .slice(0, FIX_REGRESSION_GET_COMMIT_CAP);
    const detailed: FollowupCommit[] = [];
    for (const commit of candidates) {
      const res = await this.lifecycle.call<RawCommitDetail>(
        session,
        "read",
        "contents",
        async (signal) => {
          const out = await session.octokit.rest.repos.getCommit({
            owner: this.owner,
            repo: this.repo,
            ref: commit.sha,
            request: { signal },
          });
          return { ...out, data: out.data as unknown as RawCommitDetail };
        },
      );
      if (!res.ok) {
        this.deps.log("[self-heal] fix regression commit read failed", {
          attemptId: this.attempt.id,
          outcome: res.outcome,
        });
        continue;
      }
      detailed.push({
        sha: commit.sha,
        authorLogin: commit.author?.login ?? null,
        files: res.data.files ?? [],
      });
    }
    return findFollowupOverlaps(detailed, ranges, botLogin);
  }

  private async event(signal: "regressed" | "reopened"): Promise<void> {
    try {
      await recordBreakerEvent({
        db: this.deps.db,
        organizationId: this.org,
        scopeKind: "loop_fix",
        scopeKey: normalizeRepo(this.attempt.repoFullName),
        outcome: "failure",
        signal,
        now: this.now,
      });
    } catch (error) {
      this.deps.log("[self-heal] fix regression event failed", {
        attemptId: this.attempt.id,
        signal,
        error: errorText(error),
      });
    }
  }
}

/**
 * The daily regression sweep, run on the hourly cron: merged fixes whose
 * window is open and that were not checked in the last 24 h, ≤ 10 per run,
 * bounded by the cron deadline. Never throws.
 */
export async function runFixRegressionSweep({
  db,
  now,
  deadlineAt,
  limit = FIX_REGRESSION_LIMIT,
  deps: overrides = {},
}: {
  db: DB;
  now: Date;
  deadlineAt: Date;
  limit?: number;
  deps?: Partial<FixRegressionDeps>;
}): Promise<FixRegressionSweepResult> {
  const deps: FixRegressionDeps = {
    ...defaultFixRegressionDeps(),
    ...overrides,
    db,
  };
  const result: FixRegressionSweepResult = {
    checked: 0,
    regressed: 0,
    reopened: 0,
    outcomes: {},
  };
  const cap = Math.min(limit, FIX_REGRESSION_LIMIT);
  await runBoundedSweep({
    limit: cap,
    list: () => deps.list({ db, now, limit: cap }),
    deadlineAt,
    now: deps.now,
    log: deps.log,
    listFailedMessage: "[self-heal] fix regression list failed",
    each: async (row) => {
      let outcome: FixRegressionOutcome;
      try {
        const seen = await new RegressionCheck(
          deps,
          row,
          now,
          deadlineAt,
        ).run();
        if (seen === null) outcome = "skipped";
        else {
          result.checked += 1;
          if (seen.regressed) result.regressed += 1;
          if (seen.reopened) result.reopened += 1;
          outcome = seen.regressed
            ? "regressed"
            : seen.reopened
              ? "reopened"
              : "checked";
        }
      } catch (error) {
        deps.log("[self-heal] fix regression check failed", {
          attemptId: row.id,
          error: errorText(error),
        });
        outcome = "error";
      }
      result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
    },
  });
  return result;
}
