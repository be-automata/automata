import { and, eq } from "drizzle-orm";

import type { DB } from "@terragon/shared/db";
import { auditRuns } from "@terragon/shared/db/schema";
import {
  countOpenFindingIssues,
  insertFinding,
  listFindingsForRepo,
  updateFinding,
  type AuditEffectRow,
  type AuditFindingInsert,
  type AuditFindingRow,
} from "@terragon/shared/model/audit-findings";
import {
  enqueueEffects,
  listPendingCreateFingerprints,
  type EffectInput,
} from "@terragon/shared/model/self-heal-outbox";
import { withSelfHealTx } from "@terragon/shared/model/self-heal-tx";

/**
 * The executor's view of the Postgres ledger. `persist` is the one fast DB step
 * of OUTBOX-01: every finding insert and patch, the outbox rows for every
 * GitHub effect and the run's decision list commit in ONE timeout-bounded
 * transaction, before any GitHub call is made.
 */

export type FindingInsertInput = Omit<
  AuditFindingInsert,
  "organizationId" | "id"
> & { repoFullName: string };

export type FindingPatch = Partial<
  Omit<AuditFindingInsert, "id" | "organizationId" | "repoFullName">
>;

export interface RunDecision {
  fingerprint: string;
  action: string;
  reason: string;
}

export interface LedgerBatch {
  inserts: FindingInsertInput[];
  patches: Array<{ findingId: string; patch: FindingPatch }>;
  /** `findingId` may be omitted for a fingerprint inserted in this batch. */
  effects: EffectInput[];
  runDecisions: RunDecision[];
}

export interface AuditLedger {
  list(): Promise<AuditFindingRow[]>;
  pendingCreateFingerprints(): Promise<Set<string>>;
  countOpenIssues(): Promise<number>;
  persist(batch: LedgerBatch): Promise<{ effectsEnqueued: number }>;
  /** The applier's `onIssueCreated`: stamps the new issue on the finding. */
  markIssueCreated(
    effect: AuditEffectRow,
    issueNumber: number,
    now: Date,
  ): Promise<void>;
  /** The applier's `issueNumberFor`: the issue an effect's finding holds. */
  issueNumberFor(effect: AuditEffectRow): Promise<number | null>;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

export function createDbAuditLedger({
  db,
  organizationId,
  repoFullName,
  runId,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  runId: string;
}): AuditLedger {
  async function findRow(
    effect: Pick<AuditEffectRow, "findingId" | "fingerprint">,
  ): Promise<AuditFindingRow | null> {
    const rows = await listFindingsForRepo({
      db,
      organizationId,
      repoFullName,
    });
    return (
      rows.find((r) =>
        effect.findingId
          ? r.id === effect.findingId
          : r.fingerprint === effect.fingerprint,
      ) ?? null
    );
  }

  return {
    list: () => listFindingsForRepo({ db, organizationId, repoFullName }),

    pendingCreateFingerprints: () =>
      listPendingCreateFingerprints({ db, organizationId, repoFullName }),

    countOpenIssues: () =>
      countOpenFindingIssues({ db, organizationId, repoFullName }),

    async persist(batch) {
      return withSelfHealTx(db, async (tx) => {
        // A drizzle transaction handle is a database for these helpers; their
        // own withSelfHealTx nests as a savepoint, so everything stays atomic.
        const txDb = tx as unknown as DB;
        const idByFingerprint = new Map<string, string>();
        for (const finding of batch.inserts) {
          const row = await insertFinding({
            db: txDb,
            organizationId,
            finding,
          });
          idByFingerprint.set(row.fingerprint, row.id);
        }
        for (const { findingId, patch } of batch.patches) {
          await updateFinding({
            db: txDb,
            organizationId,
            id: findingId,
            patch,
          });
        }
        const effects = batch.effects.map((e) => ({
          ...e,
          findingId: e.findingId ?? idByFingerprint.get(e.fingerprint) ?? null,
        }));
        const effectsEnqueued = await enqueueEffects({
          db: txDb,
          organizationId,
          repoFullName,
          runId,
          effects,
        });
        await tx
          .update(auditRuns)
          .set({ decisions: batch.runDecisions })
          .where(
            and(
              eq(auditRuns.id, runId),
              eq(auditRuns.organizationId, organizationId),
            ),
          );
        return { effectsEnqueued };
      });
    },

    async markIssueCreated(effect, issueNumber, now) {
      const row = await findRow(effect);
      if (!row) {
        throw new Error("markIssueCreated: finding row not found");
      }
      const payload = asRecord(effect.payload);
      const autoFix = payload.autoFix === true;
      const status = payload.status === "needs_human" ? "needs_human" : "open";
      const planHash =
        typeof payload.planHash === "string" ? payload.planHash : undefined;
      await updateFinding({
        db,
        organizationId,
        id: row.id,
        patch: {
          issueNumber,
          status,
          autoFixLabeled: autoFix,
          fixReadyAt: autoFix ? now : null,
          lastDecision: "create",
          lastDecisionReason: "consensus_met",
          ...(planHash !== undefined ? { planHash } : {}),
        },
      });
    },

    async issueNumberFor(effect) {
      const row = await findRow(effect);
      return row?.issueNumber ?? null;
    },
  };
}
