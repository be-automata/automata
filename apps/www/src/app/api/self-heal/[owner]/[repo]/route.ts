import { NextRequest, NextResponse } from "next/server";

import {
  listAuditRunsForRepo,
  listEffectsForRepo,
  listFindingsForRepo,
  listFixAttemptsForRepo,
  summarizeOutbox,
} from "@terragon/shared/model/audit-findings";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";
import {
  getBreakerState,
  listInstallationBreakers,
} from "@terragon/shared/model/self-heal-breaker";
import { listSelfHealAdminActions } from "@terragon/shared/model/self-heal-admin-log";

import { getTenantContextOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { isOrgAdmin } from "@/lib/org-role";
import { computeFingerprintChurn } from "@/server-lib/audit/fingerprint-churn";
import {
  loadSelfHealContext,
  resolveSelfHealEffective,
} from "@/server-lib/audit/resolve-self-heal";

/**
 * GET /api/self-heal/[owner]/[repo]
 *
 * The admin activity view of the audit lane (OBS-01): runs with their
 * decisions, the ledger, the outbox backlog, breaker state, the effective mode
 * with its reason, the actor log and the fingerprint churn that gates
 * dry-run -> on. Org admins only; every read is fenced to the session's active
 * organization. Token hashes are never selected (the shared reads omit them).
 *
 * `?format=export` returns the org-fenced ledger, runs, effects and fix
 * attempts as JSON. The export feeds the Phase 9 benchmark scorer.
 */

const ACTIVITY_RUN_LIMIT = 20;
const ACTIVITY_ATTEMPT_LIMIT = 50;
const ACTIVITY_ADMIN_LOG_LIMIT = 20;
const EXPORT_LIMIT = 500;
/** Runs read to compute churn: enough consecutive complete runs, still bounded. */
const CHURN_RUN_LIMIT = 50;

function repoFromParams(owner: string, repo: string): string {
  return normalizeRepo(
    `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fingerprints named by a run's stored decisions (no placeholders). */
function decisionFingerprints(decisions: unknown): string[] {
  if (!Array.isArray(decisions)) return [];
  const seen = new Set<string>();
  for (const entry of decisions) {
    if (!isRecord(entry)) continue;
    const fingerprint = entry.fingerprint;
    if (typeof fingerprint === "string" && fingerprint !== "-") {
      seen.add(fingerprint);
    }
  }
  return [...seen];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string }> },
): Promise<NextResponse> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ctx.organizationId) {
    return NextResponse.json(
      { error: "No active organization" },
      { status: 400 },
    );
  }
  const organizationId = ctx.organizationId;
  if (!(await isOrgAdmin({ db, organizationId, userId: ctx.userId }))) {
    return NextResponse.json(
      { error: "Only organization admins can view self-heal activity." },
      { status: 403 },
    );
  }

  const format = request.nextUrl.searchParams.get("format");
  if (format !== null && format !== "export") {
    return NextResponse.json(
      { error: "format must be 'export' when provided" },
      { status: 400 },
    );
  }

  const { owner, repo } = await params;
  const repoFullName = repoFromParams(owner, repo);
  const base = { db, organizationId, repoFullName };

  if (format === "export") {
    const [runs, findings, effects, attempts] = await Promise.all([
      listAuditRunsForRepo({ ...base, limit: EXPORT_LIMIT }),
      listFindingsForRepo(base),
      listEffectsForRepo({ ...base, limit: EXPORT_LIMIT }),
      listFixAttemptsForRepo({ ...base, limit: EXPORT_LIMIT }),
    ]);
    return NextResponse.json({
      exportedAt: new Date().toISOString(),
      repoFullName,
      runs,
      findings,
      effects,
      attempts,
    });
  }

  const [
    churnRuns,
    findings,
    attempts,
    outbox,
    adminLog,
    loopAudit,
    loopFix,
    installationBreakers,
    selfHealContext,
  ] = await Promise.all([
    listAuditRunsForRepo({ ...base, limit: CHURN_RUN_LIMIT }),
    listFindingsForRepo(base),
    listFixAttemptsForRepo({ ...base, limit: ACTIVITY_ATTEMPT_LIMIT }),
    summarizeOutbox(base),
    listSelfHealAdminActions({
      db,
      organizationId,
      limit: ACTIVITY_ADMIN_LOG_LIMIT,
    }),
    getBreakerState({
      db,
      organizationId,
      scopeKind: "loop_audit",
      scopeKey: repoFullName,
    }),
    getBreakerState({
      db,
      organizationId,
      scopeKind: "loop_fix",
      scopeKey: repoFullName,
    }),
    listInstallationBreakers({ db, organizationId }),
    // The installation key is only used to read permission breakers; the
    // admin view reads those from the installation list below instead, so no
    // GitHub call (or token mint) is needed to render this page.
    loadSelfHealContext({
      db,
      organizationId,
      repoFullName,
      installationKey: "none",
    }),
  ]);

  const permissionLatched = installationBreakers.some(
    (b) => b.scopeKind === "permission" && b.state !== "closed",
  );
  const effective = resolveSelfHealEffective({
    ...selfHealContext,
    breakers: { ...selfHealContext.breakers, permissionLatched },
  });

  const churn = computeFingerprintChurn(
    [...churnRuns].reverse().map((run) => ({
      id: run.id,
      complete: run.complete === true,
      fingerprints: decisionFingerprints(run.decisions),
    })),
  );

  return NextResponse.json({
    effective: { mode: effective.mode, reason: effective.reason },
    runs: churnRuns.slice(0, ACTIVITY_RUN_LIMIT),
    findings,
    attempts,
    outbox,
    breakers: {
      repo: { loopAudit, loopFix },
      installation: installationBreakers,
    },
    adminLog,
    churn,
  });
}
