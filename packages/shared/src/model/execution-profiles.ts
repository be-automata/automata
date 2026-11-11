import { and, asc, desc, eq } from "drizzle-orm";
import type { DB } from "../db";
import { cellDecision, executionProfile, profileEvidence } from "../db/schema";
import type {
  CellDecisionInsert,
  ExecutionProfile,
  ProfileEvidence,
} from "../db/types";
import type { CellPolicyProfile } from "../cell-policy/cell-policy";

/**
 * ADR-014 execution profiles, their evidence and the record of allow_cell
 * decisions. Catalog and evidence rows are operator- or probe-written; the
 * control plane only reads them, and writes `cell_decision`.
 */

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 (hex) of the canonical JSON of a profile configuration. */
export async function executionProfileConfigHash(
  configuration: Record<string, unknown>,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(configuration)),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The catalog row for exactly this (provider, tier, configuration), if any. */
export async function getExecutionProfileByConfiguration({
  db,
  provider,
  tier,
  configuration,
}: {
  db: DB;
  provider: string;
  tier: ExecutionProfile["tier"];
  configuration: Record<string, unknown>;
}): Promise<ExecutionProfile | undefined> {
  const configHash = await executionProfileConfigHash(configuration);
  const rows = await db
    .select()
    .from(executionProfile)
    .where(
      and(
        eq(executionProfile.provider, provider),
        eq(executionProfile.tier, tier),
        eq(executionProfile.configHash, configHash),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * The newest evidence row per capability of a profile, expired or not: the
 * policy, not this query, decides what an expired row means (it names
 * `evidence_expired` instead of silently treating the capability as absent).
 */
export async function getCurrentProfileEvidence({
  db,
  profileId,
}: {
  db: DB;
  profileId: string;
}): Promise<ProfileEvidence[]> {
  return db
    .selectDistinctOn([profileEvidence.capability])
    .from(profileEvidence)
    .where(eq(profileEvidence.profileId, profileId))
    .orderBy(
      asc(profileEvidence.capability),
      desc(profileEvidence.measuredAt),
      desc(profileEvidence.createdAt),
    );
}

/**
 * The profile as the policy reads it. One evidence summary for the whole
 * profile, as in the spike: the EARLIEST expiry and measurement among the
 * current rows, and source `conformance` only when every row is one, so a
 * single stale or non-conformance capability is named rather than averaged
 * away. No rows: no evidence (the policy denies `evidence_missing`).
 */
export function profileRecordForPolicy(
  profile: ExecutionProfile,
  evidence: ProfileEvidence[],
  overlay: { capabilities?: Record<string, unknown> } = {},
): { profile: CellPolicyProfile; evidenceIds: string[] } {
  const capabilities: Record<string, unknown> = {};
  for (const row of evidence) {
    capabilities[row.capability] = row.result?.value;
  }
  Object.assign(capabilities, overlay.capabilities);

  let summary: CellPolicyProfile["evidence"];
  if (evidence.length > 0) {
    const earliest = (dates: Date[]) =>
      new Date(Math.min(...dates.map((d) => d.getTime()))).toISOString();
    const foreign = evidence.find((row) => row.source !== "conformance");
    summary = {
      source: foreign ? foreign.source : "conformance",
      measured_at: earliest(evidence.map((row) => row.measuredAt)),
      expires_at: earliest(evidence.map((row) => row.expiresAt)),
    };
  }
  return {
    profile: {
      id: profile.id,
      provider: profile.provider,
      tier: profile.tier,
      configuration: profile.configuration,
      capabilities,
      ...(summary ? { evidence: summary } : {}),
    },
    evidenceIds: evidence.map((row) => row.id).sort(),
  };
}

export async function insertCellDecision({
  db,
  decision,
}: {
  db: DB;
  decision: CellDecisionInsert;
}): Promise<void> {
  await db.insert(cellDecision).values(decision);
}

export async function getCellDecisionsForThread({
  db,
  threadId,
}: {
  db: DB;
  threadId: string;
}) {
  return db
    .select()
    .from(cellDecision)
    .where(eq(cellDecision.threadId, threadId))
    .orderBy(asc(cellDecision.decidedAt));
}

/** Catalog write (operator scripts, tests). Idempotent on `id`. */
export async function upsertExecutionProfile({
  db,
  id,
  provider,
  tier,
  configuration,
}: {
  db: DB;
  id: string;
  provider: string;
  tier: ExecutionProfile["tier"];
  configuration: Record<string, unknown>;
}): Promise<ExecutionProfile> {
  const configHash = await executionProfileConfigHash(configuration);
  const [row] = await db
    .insert(executionProfile)
    .values({ id, provider, tier, configuration, configHash })
    .onConflictDoUpdate({
      target: executionProfile.id,
      set: { provider, tier, configuration, configHash },
    })
    .returning();
  return row!;
}

/** Evidence write (probes, operator scripts, tests). Append-only. */
export async function insertProfileEvidence({
  db,
  evidence,
}: {
  db: DB;
  evidence: {
    profileId: string;
    capability: string;
    measuredAt: Date;
    source: string;
    result: { value: unknown } & Record<string, unknown>;
    artifactDigest?: string | null;
    platformSha?: string | null;
  };
}): Promise<ProfileEvidence> {
  const [row] = await db.insert(profileEvidence).values(evidence).returning();
  return row!;
}

/**
 * Several evidence rows in one statement, so a renewal is all or nothing:
 * a profile never ends up with half its capabilities re-measured.
 */
export async function insertProfileEvidenceRows({
  db,
  rows,
}: {
  db: DB;
  rows: Array<{
    profileId: string;
    capability: string;
    measuredAt: Date;
    source: string;
    result: { value: unknown } & Record<string, unknown>;
    artifactDigest?: string | null;
    platformSha?: string | null;
  }>;
}): Promise<ProfileEvidence[]> {
  if (rows.length === 0) return [];
  return db.insert(profileEvidence).values(rows).returning();
}

export async function listExecutionProfiles({
  db,
}: {
  db: DB;
}): Promise<ExecutionProfile[]> {
  return db.select().from(executionProfile).orderBy(asc(executionProfile.id));
}

export async function getExecutionProfile({
  db,
  id,
}: {
  db: DB;
  id: string;
}): Promise<ExecutionProfile | undefined> {
  const rows = await db
    .select()
    .from(executionProfile)
    .where(eq(executionProfile.id, id))
    .limit(1);
  return rows[0];
}
