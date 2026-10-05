import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { DB } from "@terragon/shared/db";
import { auditFindings } from "@terragon/shared/db/schema";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";
import {
  createAuditRunAtDispatch,
  listFindingsForRepo,
} from "@terragon/shared/model/audit-findings";
import {
  bindFixAttemptThread,
  getFixAttemptById,
  refundFixAttempt,
  updateFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";
import {
  getAuditRule,
  type AuditCheckKind,
} from "@terragon/shared/self-heal/audit-rules";
import { denyExceptionsFor } from "@terragon/shared/self-heal/fix-paths";

import {
  AUDIT_FINDINGS_SKILL_NAME,
  AUDIT_FIX_SKILL_NAME,
} from "../review/review-skill";
import { fixBranchName } from "./fix-run-prompt";
import {
  loadSelfHealContext,
  resolveSelfHealEffective,
} from "./resolve-self-heal";
import { PRE_MINT_INSTALLATION_KEY } from "./audit-shared";

/**
 * Control-plane half of the audit lane's deterministic checks (R2, FORGE-01).
 *
 * At dispatch of an audit-stamped run www picks the platform-defined checks the
 * worker must run on a checkout the agent has not touched, creates the
 * audit_runs row, and mints a per-run check token. Only the sha256 of the token
 * is stored. The token travels in the run payload to the worker process only:
 * it is never placed in the daemon or agent environment and never logged, so
 * nothing in the run, including the agent, can post a forged "pass".
 */

const MAX_CHECKS = 50;
const CHECK_TOKEN_TTL_MS = 45 * 60 * 1000;
/** The fix gate token outlives the 30 min run plus the report retries. */
export const FIX_GATE_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const ELIGIBLE_STATUSES = [
  "candidate",
  "open",
  "needs_human",
  "resolved",
] as const;
const SEVERITY_RANK: Record<string, number> = { high: 2, medium: 1, low: 0 };

export interface SelfHealCheckRequest {
  fingerprint: string;
  check: AuditCheckKind;
  subject: string;
  key?: string;
}

export interface SelfHealAuditRunInput {
  kind: "audit";
  checks: SelfHealCheckRequest[];
  checkToken: string;
}

/**
 * Phase 9 fix run (mirrored structurally by the worker's SelfHealRunShape).
 * `branch` is the attempt branch, exactly fixBranchName(): the only ref the
 * git broker lets this run push. The run itself clones the BASE branch (the
 * thread's branch); the agent creates the attempt branch and pushes it, and
 * the fence allows that create. SECRET: gateToken is never logged.
 */
export interface SelfHealFixRunInput {
  kind: "fix";
  attemptId: string;
  branch: string;
  baseBranch: string;
  checks: SelfHealCheckRequest[];
  denyExceptions: string[];
  gateToken: string;
}

export type SelfHealRunInput = SelfHealAuditRunInput | SelfHealFixRunInput;

export function mintSelfHealToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSelfHealToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time check of a presented token against its stored hash. */
export function selfHealTokenMatches(
  presented: string,
  storedHash: string,
): boolean {
  const a = Buffer.from(hashSelfHealToken(presented), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface PlanSelfHealAuditRunInput {
  db: DB;
  organizationId: string;
  repoFullName: string;
  threadId: string;
  sourceMetadata: ThreadSourceMetadata | null | undefined;
  now?: Date;
}

/** `{}` unless this is an audit-stamped run whose effective mode is dry-run or on. Never throws. */
export async function planSelfHealAuditRun({
  db,
  organizationId,
  repoFullName,
  threadId,
  sourceMetadata,
  now = new Date(),
}: PlanSelfHealAuditRunInput): Promise<{ selfHeal?: SelfHealAuditRunInput }> {
  if (
    sourceMetadata?.type !== "automation-skill" ||
    sourceMetadata.skillName !== AUDIT_FINDINGS_SKILL_NAME
  ) {
    return {};
  }
  try {
    const ctx = await loadSelfHealContext({
      db,
      organizationId,
      repoFullName,
      installationKey: PRE_MINT_INSTALLATION_KEY,
    });
    const effective = resolveSelfHealEffective({
      ...ctx,
    });
    if (effective.mode === "off") return {};

    const rows = await listFindingsForRepo({
      db,
      organizationId,
      repoFullName,
      statuses: [...ELIGIBLE_STATUSES],
    });
    const checks: SelfHealCheckRequest[] = [];
    const ordered = rows
      .filter((row) => row.checkKind === "script" && row.subject !== null)
      .sort(
        (a, b) =>
          (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
          b.updatedAt.getTime() - a.updatedAt.getTime(),
      );
    for (const row of ordered) {
      const check = getAuditRule(row.ruleId)?.check;
      if (check === null || check === undefined || row.subject === null) {
        continue;
      }
      checks.push({
        fingerprint: row.fingerprint,
        check,
        subject: row.subject,
        ...(row.findingKey !== null ? { key: row.findingKey } : {}),
      });
      if (checks.length >= MAX_CHECKS) break;
    }

    const checkToken = mintSelfHealToken();
    await createAuditRunAtDispatch({
      db,
      organizationId,
      repoFullName,
      threadId,
      audit: "security-audit",
      requestedChecks: checks,
      checkTokenHash: hashSelfHealToken(checkToken),
      checkTokenExpiresAt: new Date(now.getTime() + CHECK_TOKEN_TTL_MS),
    });
    return { selfHeal: { kind: "audit", checks, checkToken } };
  } catch (error) {
    console.warn(
      "[hatchet] self-heal: audit planning failed — dispatching without checks",
      {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return {};
  }
}

/** True for a thread stamped by the fix lane (the only stamp planSelfHealFixRun plans). */
export function isAuditFixStamp(
  sourceMetadata: ThreadSourceMetadata | null | undefined,
): boolean {
  return (
    sourceMetadata?.type === "automation-skill" &&
    sourceMetadata.skillName === AUDIT_FIX_SKILL_NAME
  );
}

export type SelfHealFixAbort = "killed" | "planning_failed" | "no_attempt";

export type PlanSelfHealFixResult =
  | { selfHeal?: SelfHealFixRunInput }
  | { abort: SelfHealFixAbort };

export interface PlanSelfHealFixRunInput {
  db: DB;
  organizationId: string;
  repoFullName: string;
  threadId: string;
  sourceMetadata: ThreadSourceMetadata | null | undefined;
  /** The thread's branch: the base the fix starts from and the PR targets. */
  baseBranch: string;
  now?: Date;
}

/**
 * Plan the dispatch of an audit-fix thread (RACE-01, GATE-01, KILL-01).
 *
 * The attempt id comes from the thread stamp, never from a lookup by thread,
 * so the planner cannot race the dispatcher's bind: it binds the thread
 * itself (idempotent CAS; the same thread is a no-op). Every way this can
 * fail is an `abort`, and the caller must NOT start the run: a fix agent
 * without a gate token and a fenced branch is never launched.
 *
 * - effective mode not on (flag off, kill switch, dry-run, shadow, loop_fix
 *   open) → `killed`, attempt refunded with outcome "killed";
 * - attempt missing, of another org/repo, bound to another thread, already
 *   closed or already reported → `no_attempt`, attempt left alone;
 * - anything else (finding unusable, branch drift, DB error) →
 *   `planning_failed`, attempt refunded with outcome "planning_failed".
 *
 * `{}` for a thread without the audit-fix stamp. Never throws. Only the
 * sha256 of the gate token is stored (2 h expiry).
 */
export async function planSelfHealFixRun({
  db,
  organizationId,
  repoFullName,
  threadId,
  sourceMetadata,
  baseBranch,
  now = new Date(),
}: PlanSelfHealFixRunInput): Promise<PlanSelfHealFixResult> {
  if (
    sourceMetadata?.type !== "automation-skill" ||
    sourceMetadata.skillName !== AUDIT_FIX_SKILL_NAME
  ) {
    return {};
  }
  const attemptId = sourceMetadata.selfHealAttemptId;
  const refuse = (
    abort: SelfHealFixAbort,
    reason: string,
  ): { abort: SelfHealFixAbort } => {
    console.warn("[hatchet] self-heal: fix dispatch refused", {
      threadId,
      attemptId: attemptId ?? null,
      abort,
      reason,
    });
    return { abort };
  };
  if (attemptId === undefined || attemptId.length === 0) {
    return refuse("no_attempt", "stamp_without_attempt");
  }

  /** Refund only an attempt that is unbound or bound to THIS thread. */
  let refundable = false;
  const refund = async (outcome: SelfHealFixAbort, cause: string) => {
    if (!refundable) return;
    try {
      await refundFixAttempt({
        db,
        organizationId,
        attemptId,
        cause,
        outcome,
        now,
      });
    } catch (error) {
      console.error("[hatchet] self-heal: fix attempt refund failed", {
        threadId,
        attemptId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  try {
    const attempt = await getFixAttemptById({
      db,
      organizationId,
      id: attemptId,
    });
    if (
      attempt === null ||
      normalizeRepo(attempt.repoFullName) !== normalizeRepo(repoFullName)
    ) {
      return refuse("no_attempt", "attempt_not_found");
    }
    if (attempt.threadId !== null && attempt.threadId !== threadId) {
      return refuse("no_attempt", "attempt_bound_elsewhere");
    }
    refundable = true;

    const ctx = await loadSelfHealContext({
      db,
      organizationId,
      repoFullName,
      installationKey: PRE_MINT_INSTALLATION_KEY,
      probeAttemptId: attemptId,
    });
    const effective = resolveSelfHealEffective({ ...ctx });
    if (effective.mode !== "on" || !effective.fixAllowed) {
      const reason =
        effective.mode === "on" ? "loop_fix_open" : effective.reason;
      await refund("killed", `fix_dispatch_${reason}`);
      return refuse("killed", reason);
    }

    const bound = await bindFixAttemptThread({
      db,
      organizationId,
      attemptId,
      threadId,
      now,
    });
    if (!bound) {
      refundable = false;
      return refuse("no_attempt", "bind_lost");
    }

    const [finding] = await db
      .select()
      .from(auditFindings)
      .where(
        and(
          eq(auditFindings.id, attempt.findingId),
          eq(auditFindings.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!finding) throw new Error("finding not found");
    const check = getAuditRule(finding.ruleId)?.check;
    if (
      finding.checkKind !== "script" ||
      check === null ||
      check === undefined ||
      finding.subject === null
    ) {
      throw new Error("finding has no deterministic check");
    }
    if (finding.issueNumber === null) {
      throw new Error("finding has no issue number");
    }
    const branch = fixBranchName({
      issueNumber: finding.issueNumber,
      fingerprint: finding.fingerprint,
      attemptNo: attempt.attemptNo,
    });
    if (attempt.branch !== branch) {
      throw new Error("attempt branch does not match fixBranchName");
    }

    const gateToken = mintSelfHealToken();
    const updated = await updateFixAttempt({
      db,
      organizationId,
      id: attemptId,
      patch: {
        gateTokenHash: hashSelfHealToken(gateToken),
        gateTokenExpiresAt: new Date(now.getTime() + FIX_GATE_TOKEN_TTL_MS),
      },
    });
    // The bind wrote 'dispatched'; a reconcile refund or an earlier report
    // in between means this run must not start (a re-dispatch of a finished
    // attempt included).
    if (
      updated === null ||
      updated.phase !== "dispatched" ||
      updated.threadId !== threadId ||
      updated.checkReportedAt !== null
    ) {
      refundable = false;
      return refuse("no_attempt", "attempt_not_dispatchable");
    }

    return {
      selfHeal: {
        kind: "fix",
        attemptId,
        branch,
        baseBranch,
        checks: [
          {
            fingerprint: finding.fingerprint,
            check,
            subject: finding.subject,
            ...(finding.findingKey !== null ? { key: finding.findingKey } : {}),
          },
        ],
        denyExceptions: denyExceptionsFor({
          ruleId: finding.ruleId,
          planFiles: finding.planFiles,
        }),
        gateToken,
      },
    };
  } catch (error) {
    await refund("planning_failed", "planning_failed");
    return refuse(
      "planning_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export type FixWorkerStatus = "completed" | "aborted" | "error" | "no_branch";
export type FixCheckOutcome = "pass" | "fail" | "error";
export type FixCheckStatus =
  | "passed"
  | "failed"
  | "error"
  | "no_branch"
  | "aborted";

/**
 * The gate verdict of one worker report (GATE-01). `passed` only when the
 * worker completed, the finding check passed and no denied path was touched;
 * a touched denied path is a deterministic failure even when the check
 * errored. A check error is never a pass. Pure.
 */
export function deriveFixCheckStatus({
  workerStatus,
  checkOutcome,
  deniedPaths,
}: {
  workerStatus: FixWorkerStatus;
  checkOutcome: FixCheckOutcome | null;
  deniedPaths: readonly string[];
}): FixCheckStatus {
  switch (workerStatus) {
    case "no_branch":
      return "no_branch";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    case "completed":
      if (deniedPaths.length > 0) return "failed";
      if (checkOutcome === "pass") return "passed";
      if (checkOutcome === "fail") return "failed";
      return "error";
  }
}
