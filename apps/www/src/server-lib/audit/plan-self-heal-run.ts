import { createHash, randomBytes } from "node:crypto";

import type { DB } from "@terragon/shared/db";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";
import {
  createAuditRunAtDispatch,
  listFindingsForRepo,
} from "@terragon/shared/model/audit-findings";
import {
  getAuditRule,
  type AuditCheckKind,
} from "@terragon/shared/self-heal/audit-rules";

import { AUDIT_FINDINGS_SKILL_NAME } from "../review/review-skill";
import {
  loadSelfHealContext,
  resolveSelfHealEffective,
} from "./resolve-self-heal";

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
const PRE_MINT_INSTALLATION_KEY = "pending";
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

export interface SelfHealRunInput {
  kind: "audit";
  checks: SelfHealCheckRequest[];
  checkToken: string;
}

export function mintSelfHealToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSelfHealToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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
}: PlanSelfHealAuditRunInput): Promise<{ selfHeal?: SelfHealRunInput }> {
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
