import type { Octokit } from "octokit";

import type { DB } from "@terragon/shared/db";
import {
  updateFinding,
  type AuditFindingRow,
  type AuditFixAttemptRow,
} from "@terragon/shared/model/audit-findings";
import {
  claimAttemptLease,
  releaseAttemptLease,
  updateFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";

import { errorText, MIN_ROW_BUDGET_MS } from "./audit-shared";
import { createIssueWriter, type IssueWriter } from "./issue-writer";
import type { OpenFixPrDeps } from "./open-fix-pr";
import {
  commentMarker,
  FINDING_LABELS,
  renderAuditComment,
} from "./render-issue";
import {
  COMPARE_FILE_CAP,
  evaluateFixDiff,
  type FixDiffFile,
  type FixDiffVerdict,
} from "./suppression-guard";
import {
  withSelfHealCall,
  type CallKind,
  type GithubResponse,
  type SelfHealCallDeps,
  type SelfHealCallResult,
} from "./with-self-heal-call";

/**
 * The GitHub plumbing the fix-PR modules share (09-11 opener, 09-12 CI
 * evaluator, 09-14 lifecycle/expiry): one minted session per attempt, every
 * call through withSelfHealCall, the branch delete / PR close writes, the
 * attempts-cap needs-human transition, the attempt row lease, and the
 * deadline-bounded sweep loop. No behaviour of its own beyond what the
 * callers did inline.
 */

type Log = OpenFixPrDeps["log"];

export type FixAttemptGithubDeps = Pick<
  OpenFixPrDeps,
  "mint" | "preflight" | "callDeps" | "botLogin" | "now" | "log"
>;

export interface FixGithubSession {
  octokit: Octokit;
  installationKey: string;
  writer: IssueWriter;
}

type SessionState = FixGithubSession | "unavailable" | "missing";

interface CompareData {
  ahead_by: number;
  files?: FixDiffFile[];
}

export type CompareGuardResult =
  | {
      kind: "failed";
      result: Extract<SelfHealCallResult<unknown>, { ok: false }>;
    }
  | { kind: "empty" }
  | { kind: "guarded"; guard: FixDiffVerdict };

/** A GitHub write bound to the caller's session and call wrapper. */
export type FixGithubWrite = (
  permission: "pull_requests" | "contents",
  call: (signal: AbortSignal) => Promise<GithubResponse<undefined>>,
  loopFix: boolean,
) => Promise<SelfHealCallResult<undefined>>;

export interface FixRefTarget {
  octokit: Octokit;
  owner: string;
  repo: string;
  attemptId: string;
  write: FixGithubWrite;
  log: Log;
}

/** Delete the attempt branch. Already gone (or never pushed) is the desired end state. */
export async function deleteFixBranch(
  target: FixRefTarget,
  branch: string,
): Promise<void> {
  const res = await target.write(
    "contents",
    async (signal) => {
      const out = await target.octokit.rest.git.deleteRef({
        owner: target.owner,
        repo: target.repo,
        ref: `heads/${branch}`,
        request: { signal },
      });
      return { ...out, data: undefined };
    },
    false,
  );
  if (
    !res.ok &&
    res.outcome !== "not_found" &&
    res.outcome !== "unprocessable"
  ) {
    target.log("[self-heal] fix branch delete failed", {
      attemptId: target.attemptId,
      outcome: res.outcome,
    });
  }
}

/** Close the fix PR (a 403 / 422 is a loop_fix failure). True when closed. */
export async function closeFixPull(
  target: FixRefTarget,
  prNumber: number,
  failedMessage: string,
): Promise<boolean> {
  const res = await target.write(
    "pull_requests",
    async (signal) => {
      const out = await target.octokit.rest.pulls.update({
        owner: target.owner,
        repo: target.repo,
        pull_number: prNumber,
        state: "closed",
        request: { signal },
      });
      return { ...out, data: undefined };
    },
    true,
  );
  if (!res.ok) {
    target.log(failedMessage, {
      attemptId: target.attemptId,
      outcome: res.outcome,
    });
  }
  return res.ok;
}

export interface NeedsHumanWrites {
  labels: SelfHealCallResult<void>;
  comment: SelfHealCallResult<"created" | "updated"> | null;
}

/**
 * needs-human-approve: the ledger row first, then (when the issue exists and
 * `writer` yields one) the label swap and, for the attempts cap, the cap
 * comment. null when no GitHub write was made; the caller logs failures.
 */
export async function markFindingNeedsHuman({
  db,
  organizationId,
  finding,
  reason,
  writer,
  capComment,
}: {
  db: DB;
  organizationId: string;
  finding: Pick<AuditFindingRow, "id" | "issueNumber" | "fingerprint">;
  reason: "attempts_cap" | "open_failed";
  /** null = no GitHub write (no session, or the mode is not on). */
  writer: () => Promise<IssueWriter | null>;
  /** The cap comment's fields; null = no comment. */
  capComment: { runId: string; attempts: number; maxAttempts: number } | null;
}): Promise<NeedsHumanWrites | null> {
  await updateFinding({
    db,
    organizationId,
    id: finding.id,
    patch: {
      status: "needs_human",
      autoFixLabeled: false,
      fixReadyAt: null,
      lastDecision: "needs_human",
      lastDecisionReason: reason,
    },
  });
  const issueNumber = finding.issueNumber;
  if (issueNumber === null) return null;
  const issueWriter = await writer();
  if (issueWriter === null) return null;
  const labels = await issueWriter.updateIssue({
    number: issueNumber,
    labelsAdd: [FINDING_LABELS.needsHumanApprove],
    labelsRemove: [FINDING_LABELS.autoFix],
  });
  const comment =
    capComment === null
      ? null
      : await issueWriter.upsertComment({
          number: issueNumber,
          marker: commentMarker({
            fp: finding.fingerprint,
            kind: "needs_human_attempts_cap",
            runId: capComment.runId,
          }),
          body: renderAuditComment("needs_human_attempts_cap", {
            fingerprint: finding.fingerprint,
            ...capComment,
          }),
        });
  return { labels, comment };
}

/**
 * Hold the attempt's row lease around `run`, releasing it whatever happens.
 * `{ leased: false }` when another holder has it. A failed release is logged
 * (the lease then simply expires).
 */
export async function withAttemptLease<T>({
  db,
  organizationId,
  attemptId,
  now,
  log,
  releaseFailedMessage,
  run,
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  now: Date;
  log: Log;
  releaseFailedMessage: string;
  run: () => Promise<T>;
}): Promise<{ leased: false } | { leased: true; value: T }> {
  const leased = await claimAttemptLease({
    db,
    organizationId,
    attemptId,
    now,
  });
  if (!leased) return { leased: false };
  try {
    return { leased: true, value: await run() };
  } finally {
    try {
      await releaseAttemptLease({ db, organizationId, attemptId });
    } catch (error) {
      log(releaseFailedMessage, { attemptId, error: errorText(error) });
    }
  }
}

/**
 * The sweeps' loop: list once (a list failure is logged and ends the sweep),
 * then handle at most `limit` rows in order while at least MIN_ROW_BUDGET_MS
 * of the deadline is left. `each` must not throw past what the caller wants
 * to propagate.
 */
export async function runBoundedSweep<Row>({
  list,
  limit,
  each,
  deadlineAt,
  now,
  log,
  listFailedMessage,
}: {
  list: () => Promise<readonly Row[]>;
  /** Also enforced here, whatever the list returned. */
  limit: number;
  each: (row: Row) => Promise<void>;
  deadlineAt: Date;
  now: () => Date;
  log: Log;
  listFailedMessage: string;
}): Promise<void> {
  let rows: readonly Row[];
  try {
    rows = await list();
  } catch (error) {
    log(listFailedMessage, { error: errorText(error) });
    return;
  }
  for (const row of rows.slice(0, limit)) {
    if (deadlineAt.getTime() - now().getTime() < MIN_ROW_BUDGET_MS) break;
    await each(row);
  }
}

/**
 * One installation-token mint per repo (case-insensitive) for the lifetime of
 * the returned function: the self-heal cron makes one per run, so its sweeps
 * and the dispatcher's probe share a token. A failed mint stays failed for
 * that run (the next run mints again).
 */
export function memoizeMint<T>(
  mint: (args: { owner: string; repo: string }) => Promise<T>,
): (args: { owner: string; repo: string }) => Promise<T> {
  const minted = new Map<string, Promise<T>>();
  return ({ owner, repo }) => {
    const key = `${owner}/${repo}`.toLowerCase();
    let pending = minted.get(key);
    if (pending === undefined) {
      pending = mint({ owner, repo });
      minted.set(key, pending);
    }
    return pending;
  };
}

/** One minted, preflighted GitHub session for one fix attempt. */
export abstract class FixAttemptGithub<D extends FixAttemptGithubDeps> {
  private session: SessionState | null = null;
  protected readonly owner: string;
  protected readonly repo: string;
  protected readonly callDeps: Omit<SelfHealCallDeps, "breaker">;
  protected maxAttempts = 3;

  constructor(
    protected readonly db: DB,
    protected attempt: AuditFixAttemptRow,
    protected readonly finding: AuditFindingRow,
    protected readonly deadlineAt: Date,
    protected readonly deps: D,
    /** "fix PR opener" / "fix CI evaluator": names the log lines. */
    private readonly label: string,
  ) {
    const [owner = "", repo = ""] = attempt.repoFullName.split("/");
    this.owner = owner;
    this.repo = repo;
    this.callDeps = { ...deps.callDeps, db };
  }

  protected get org(): string {
    return this.attempt.organizationId;
  }

  protected now(): Date {
    return this.deps.now();
  }

  /** The open session, or null before (or without) one. Never opens it. */
  protected get gh(): FixGithubSession | null {
    return typeof this.session === "object" ? this.session : null;
  }

  protected call<T>(
    kind: CallKind,
    signalName: string,
    permission: "pull_requests" | "contents" | "checks",
    call: (signal: AbortSignal) => Promise<GithubResponse<T>>,
    /** A 403 / 422 here is a real lane failure (09-13 loop_fix rule). */
    loopFix = false,
  ): Promise<SelfHealCallResult<T>> {
    const session = this.gh;
    if (session === null) {
      throw new Error(`self-heal ${this.label}: GitHub session not open`);
    }
    return withSelfHealCall<T>({
      kind,
      organizationId: this.org,
      installationKey: session.installationKey,
      signalName,
      permission,
      deadlineAt: this.deadlineAt,
      call,
      deps: this.callDeps,
      ...(loopFix
        ? { loopFixScopeKey: normalizeRepo(this.attempt.repoFullName) }
        : {}),
    });
  }

  /** Mint once and run the fixLoop capability preflight. */
  protected async openSession(): Promise<SessionState> {
    if (this.session !== null) return this.session;
    try {
      const minted = await this.deps.mint({
        owner: this.owner,
        repo: this.repo,
      });
      const installationKey = String(minted.installationId);
      const preflight = await this.deps.preflight({
        organizationId: this.org,
        installationKey,
        owner: this.owner,
        repo: this.repo,
        capability: "fixLoop",
        deadlineAt: this.deadlineAt,
        deps: this.callDeps,
      });
      if (!preflight.ok) {
        this.session = "unavailable" in preflight ? "unavailable" : "missing";
        return this.session;
      }
      this.session = {
        octokit: minted.octokit,
        installationKey,
        writer: createIssueWriter({
          octokit: minted.octokit,
          owner: this.owner,
          repo: this.repo,
          botLogin: this.deps.botLogin(),
          organizationId: this.org,
          installationKey,
          deadlineAt: this.deadlineAt,
          deps: this.callDeps,
        }),
      };
    } catch (error) {
      this.deps.log(`[self-heal] ${this.label} token mint failed`, {
        attemptId: this.attempt.id,
        error: errorText(error),
      });
      this.session = "unavailable";
    }
    return this.session;
  }

  protected refTarget(session: FixGithubSession): FixRefTarget {
    return {
      octokit: session.octokit,
      owner: this.owner,
      repo: this.repo,
      attemptId: this.attempt.id,
      log: this.deps.log,
      write: (permission, call, loopFix) =>
        this.call("write", "gh_write", permission, call, loopFix),
    };
  }

  /** compare(<basehead>) and the R4 guard on its files. */
  protected async compareAndGuard(
    session: FixGithubSession,
    basehead: string,
    maxDiffLines: number,
  ): Promise<CompareGuardResult> {
    const compare = await this.call<CompareData>(
      "read",
      "gh_read",
      "contents",
      async (signal) => {
        const res = await session.octokit.rest.repos.compareCommitsWithBasehead(
          {
            owner: this.owner,
            repo: this.repo,
            basehead,
            request: { signal },
          },
        );
        return { ...res, data: res.data as unknown as CompareData };
      },
    );
    if (!compare.ok) return { kind: "failed", result: compare };
    const files = compare.data.files ?? [];
    if (compare.data.ahead_by <= 0 || files.length === 0) {
      return { kind: "empty" };
    }
    return {
      kind: "guarded",
      guard: evaluateFixDiff({
        files,
        planFiles: this.finding.planFiles,
        ruleId: this.finding.ruleId,
        subject: this.finding.subject,
        maxDiffLines,
        truncated: files.length >= COMPARE_FILE_CAP,
      }),
    };
  }

  /** needs-human-approve; `session` null = ledger only (no GitHub write). */
  protected async needsHuman(
    reason: "attempts_cap" | "open_failed",
    session: () => Promise<FixGithubSession | null>,
  ): Promise<void> {
    const writes = await markFindingNeedsHuman({
      db: this.db,
      organizationId: this.org,
      finding: this.finding,
      reason,
      writer: async () => (await session())?.writer ?? null,
      capComment:
        reason === "attempts_cap"
          ? {
              runId: this.attempt.id,
              attempts: this.attempt.attemptNo,
              maxAttempts: this.maxAttempts,
            }
          : null,
    });
    if (writes !== null && !writes.labels.ok) {
      this.deps.log("[self-heal] needs-human label failed", {
        attemptId: this.attempt.id,
        outcome: writes.labels.outcome,
      });
    }
  }

  protected async patch(
    patch: Parameters<typeof updateFixAttempt>[0]["patch"],
  ): Promise<void> {
    const row = await updateFixAttempt({
      db: this.db,
      organizationId: this.org,
      id: this.attempt.id,
      patch,
    });
    if (row) this.attempt = row;
  }
}
