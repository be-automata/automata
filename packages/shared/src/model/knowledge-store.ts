import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { DraftOpKind, RejectedOp } from "@terragon/knowledge";

import { DB } from "../db";
import {
  knowledgeClaim,
  knowledgeIntent,
  knowledgeOp,
  knowledgePin,
} from "../db/schema";
import {
  assertIntentFields,
  assertPinFields,
  assertStatement,
  assertStoredProposal,
  MAX_URI_CHARS,
  MinimizationError,
} from "./knowledge-minimize";

/**
 * Org-fenced knowledge store (ADR-001): organizationId is required, every
 * predicate is fenced on it, and a foreign row is indistinguishable from an
 * absent one.
 *
 * Every write validates with knowledge-minimize first (OPS-04), so nothing
 * reaches the database when validation fails.
 *
 * UNGATED: these are building blocks. Callers outside `model/knowledge*.ts`
 * must go through `forKnowledge` (12-05), which applies the kill switch; a
 * static test there forbids importing this module elsewhere.
 */

const ID_TOKEN_RE = /^[A-Za-z0-9_.:/-]{1,256}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const PAGE_FORBIDDEN_RE = /[\s\u0000-\u001f\u007f]/;

export class KnowledgeClaimNotFoundError extends Error {
  readonly claimId: string;

  constructor(claimId: string) {
    super(`knowledge claim not found: ${claimId}`);
    this.name = "KnowledgeClaimNotFoundError";
    this.claimId = claimId;
  }
}

function assertIdToken(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID_TOKEN_RE.test(value)) {
    throw new MinimizationError(path, "must be an id token");
  }
  return value;
}

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

async function requireClaim(
  tx: Tx,
  organizationId: string,
  claimId: string,
): Promise<typeof knowledgeClaim.$inferSelect> {
  const [claim] = await tx
    .select()
    .from(knowledgeClaim)
    .where(
      and(
        eq(knowledgeClaim.id, claimId),
        eq(knowledgeClaim.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!claim) throw new KnowledgeClaimNotFoundError(claimId);
  return claim;
}

export async function insertKnowledgeClaim({
  db,
  organizationId,
  claim,
}: {
  db: DB;
  organizationId: string;
  claim: {
    id: string;
    repoFullName: string;
    page: string;
    statement: string;
    ownerUserId?: string | null;
  };
}): Promise<{ inserted: boolean }> {
  assertIdToken(claim.id, "claim.id");
  const statement = assertStatement(claim.statement, "claim.statement");
  if (
    typeof claim.repoFullName !== "string" ||
    !REPO_RE.test(claim.repoFullName)
  ) {
    throw new MinimizationError("claim.repoFullName", "must be owner/name");
  }
  if (
    typeof claim.page !== "string" ||
    claim.page.length === 0 ||
    claim.page.length > MAX_URI_CHARS ||
    PAGE_FORBIDDEN_RE.test(claim.page)
  ) {
    throw new MinimizationError("claim.page", "must be a page token");
  }
  const rows = await db
    .insert(knowledgeClaim)
    .values({
      id: claim.id,
      organizationId,
      repoFullName: claim.repoFullName,
      page: claim.page,
      statement,
      ownerUserId: claim.ownerUserId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: knowledgeClaim.id });
  return { inserted: rows.length > 0 };
}

export async function insertKnowledgePins({
  db,
  organizationId,
  claimId,
  pins,
}: {
  db: DB;
  organizationId: string;
  claimId: string;
  pins: { uri: string; hash: string; observedRev: string }[];
}): Promise<{ written: number }> {
  const checked = pins.map((pin) => assertPinFields(pin));
  return db.transaction(async (tx) => {
    const claim = await requireClaim(tx, organizationId, claimId);
    let written = 0;
    for (const pin of checked) {
      await tx
        .insert(knowledgePin)
        .values({
          organizationId,
          claimId,
          repoFullName: claim.repoFullName,
          uri: pin.uri,
          hash: pin.hash,
          observedRev: pin.observedRev,
        })
        .onConflictDoUpdate({
          target: [knowledgePin.claimId, knowledgePin.uri],
          set: { hash: pin.hash, observedRev: pin.observedRev },
          setWhere: eq(knowledgePin.organizationId, organizationId),
        });
      written += 1;
    }
    return { written };
  });
}

export async function insertKnowledgeOp({
  db,
  organizationId,
  op,
}: {
  db: DB;
  organizationId: string;
  op: {
    id: string;
    claimId: string;
    kind: string;
    baseVersion: number;
    mergeRev: string;
    proposal: unknown;
  };
}): Promise<{ inserted: boolean }> {
  const p = assertStoredProposal(op.proposal);
  if (p.id !== op.id) throw new Error("proposal.id does not match op id");
  if (p.claimId !== op.claimId) {
    throw new Error("proposal.claimId does not match op claimId");
  }
  if (p.op !== op.kind) throw new Error("proposal.op does not match op kind");
  return db.transaction(async (tx) => {
    const claim = await requireClaim(tx, organizationId, op.claimId);
    const rows = await tx
      .insert(knowledgeOp)
      .values({
        id: op.id,
        organizationId,
        claimId: op.claimId,
        repoFullName: claim.repoFullName,
        kind: op.kind,
        baseVersion: op.baseVersion,
        mergeRev: op.mergeRev,
        proposal: p,
        evidenceFingerprint: p.evidenceFingerprint ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: knowledgeOp.id });
    return { inserted: rows.length > 0 };
  });
}

export async function getKnowledgeClaim({
  db,
  organizationId,
  claimId,
}: {
  db: DB;
  organizationId: string;
  claimId: string;
}): Promise<
  | (typeof knowledgeClaim.$inferSelect & {
      pins: (typeof knowledgePin.$inferSelect)[];
    })
  | undefined
> {
  const [claim] = await db
    .select()
    .from(knowledgeClaim)
    .where(
      and(
        eq(knowledgeClaim.id, claimId),
        eq(knowledgeClaim.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!claim) return undefined;
  const pins = await db
    .select()
    .from(knowledgePin)
    .where(
      and(
        eq(knowledgePin.claimId, claimId),
        eq(knowledgePin.organizationId, organizationId),
      ),
    );
  return { ...claim, pins };
}

export async function listKnowledgeClaims({
  db,
  organizationId,
  repoFullName,
  page,
  limit = 500,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  page?: string;
  limit?: number;
}): Promise<(typeof knowledgeClaim.$inferSelect)[]> {
  return db
    .select()
    .from(knowledgeClaim)
    .where(
      and(
        eq(knowledgeClaim.organizationId, organizationId),
        eq(knowledgeClaim.repoFullName, repoFullName),
        page === undefined ? undefined : eq(knowledgeClaim.page, page),
      ),
    )
    .orderBy(asc(knowledgeClaim.createdAt), asc(knowledgeClaim.id))
    .limit(limit);
}

export async function listOpenKnowledgeOps({
  db,
  organizationId,
  repoFullName,
  limit = 200,
}: {
  db: DB;
  organizationId: string;
  repoFullName?: string;
  limit?: number;
}): Promise<(typeof knowledgeOp.$inferSelect)[]> {
  return db
    .select()
    .from(knowledgeOp)
    .where(
      and(
        eq(knowledgeOp.organizationId, organizationId),
        inArray(knowledgeOp.state, ["proposed", "reopened"]),
        repoFullName === undefined
          ? undefined
          : eq(knowledgeOp.repoFullName, repoFullName),
      ),
    )
    .orderBy(asc(knowledgeOp.createdAt), asc(knowledgeOp.id))
    .limit(limit);
}

/**
 * The latest rejected op per claim (Phase 11 ENG-02 hand-off). Phase 13 passes
 * the result as `ReconcileOptions.rejected`; dropping a rejection once a later
 * reconcile saw the claim fresh is Phase 13 logic. Rows come from the decision
 * ledger state (set by decideKnowledgeOp), never from request input
 * (T-11-05-01). The mapping mirrors `rejectionOf` in @terragon/knowledge
 * without a runtime import; the store test pins the equality.
 */
export async function loadLatestKnowledgeRejections({
  db,
  organizationId,
  claimIds,
}: {
  db: DB;
  organizationId: string;
  claimIds: readonly string[];
}): Promise<RejectedOp[]> {
  if (claimIds.length === 0) return [];
  const rows = await db
    .selectDistinctOn([knowledgeOp.claimId], {
      id: knowledgeOp.id,
      claimId: knowledgeOp.claimId,
      kind: knowledgeOp.kind,
      evidenceFingerprint: knowledgeOp.evidenceFingerprint,
      proposal: knowledgeOp.proposal,
    })
    .from(knowledgeOp)
    .where(
      and(
        eq(knowledgeOp.organizationId, organizationId),
        inArray(knowledgeOp.claimId, [...claimIds]),
        eq(knowledgeOp.state, "rejected"),
        sql`${knowledgeOp.evidenceFingerprint} IS NOT NULL`,
      ),
    )
    .orderBy(
      asc(knowledgeOp.claimId),
      sql`${knowledgeOp.updatedAt} DESC`,
      sql`${knowledgeOp.id} DESC`,
    );
  const out: RejectedOp[] = [];
  for (const row of rows) {
    if (row.evidenceFingerprint === null) continue;
    const p = assertStoredProposal(row.proposal);
    out.push({
      opId: row.id,
      claimId: row.claimId,
      op: row.kind as DraftOpKind,
      evidenceFingerprint: row.evidenceFingerprint,
      ...(p.locatedEvidence ? { locatedEvidence: p.locatedEvidence } : {}),
    });
  }
  return out;
}

export async function insertKnowledgeIntent({
  db,
  organizationId,
  repoFullName,
  defaultBranch,
  targetSha,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  defaultBranch: string;
  targetSha: string;
}): Promise<{ id: string; inserted: boolean }> {
  const fields = assertIntentFields({ repoFullName, defaultBranch, targetSha });
  const id = `intent:${organizationId}:${fields.repoFullName}@${fields.targetSha}`;
  const rows = await db
    .insert(knowledgeIntent)
    .values({
      id,
      organizationId,
      repoFullName: fields.repoFullName,
      defaultBranch: fields.defaultBranch,
      targetSha: fields.targetSha,
    })
    .onConflictDoNothing()
    .returning({ id: knowledgeIntent.id });
  return { id, inserted: rows.length > 0 };
}

export async function listPendingKnowledgeIntents({
  db,
  organizationId,
  now = new Date(),
  limit = 50,
}: {
  db: DB;
  organizationId: string;
  now?: Date;
  limit?: number;
}): Promise<(typeof knowledgeIntent.$inferSelect)[]> {
  return db
    .select()
    .from(knowledgeIntent)
    .where(
      and(
        eq(knowledgeIntent.organizationId, organizationId),
        eq(knowledgeIntent.state, "pending"),
        lte(knowledgeIntent.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(knowledgeIntent.createdAt), asc(knowledgeIntent.id))
    .limit(limit);
}
