import type { DB } from "../db";
import {
  advanceKnowledgeCursor,
  decideKnowledgeOp,
  getKnowledgeCursor,
  knowledgeGateReason,
  observeKnowledgeHead,
  reserveKnowledgeBudget,
  settleKnowledgeBudget,
  type KnowledgeGateReason,
} from "./knowledge";
import { listKnowledgeAdminActions } from "./knowledge-admin-log";
import {
  clearKnowledgeOffboard,
  getKnowledgeControls,
  getKnowledgeSpend,
  offboardKnowledge,
  updateKnowledgeControls,
} from "./knowledge-controls";
import { assertIntentFields, assertStatement } from "./knowledge-minimize";
import {
  getKnowledgeClaim,
  insertKnowledgeClaim,
  insertKnowledgeIntent,
  insertKnowledgeOp,
  insertKnowledgePins,
  listKnowledgeClaims,
  listOpenKnowledgeOps,
  listPendingKnowledgeIntents,
  loadLatestKnowledgeRejections,
} from "./knowledge-store";

export type KnowledgeGated<T> =
  | { ok: true; value: T }
  | { ok: false; reason: KnowledgeGateReason };

/** A model function's arguments minus the db and org the accessor binds. */
type Bound<F extends (arg: never) => unknown> = Omit<
  Parameters<F>[0],
  "db" | "organizationId"
>;

/**
 * Org-scoped knowledge accessor (ADR-001 sibling of `forTenant`).
 *
 * This is the only allowed entry to knowledge data and model spend outside
 * `model/knowledge*.ts` (a static test enforces it). `store.*` and
 * `budget.reserve` read the org's kill switch live on every call (one primary
 * key read, no cache) and return `{ ok: false, reason }` without touching
 * knowledge tables when the engine is Off or the org is offboarded.
 *
 * Contract for Phases 13-17 (OPS-02): check at job start AND immediately
 * before the publish step (cursor advance, decision apply). Off means "stop
 * starting work", not "kill a running transaction". Off never deletes data or
 * the cursor; turning On resumes from the cursor. `admin.*` and
 * `budget.settle` are never gated, so an Off org stays administrable and its
 * reservations are always released. Purge is a system path (knowledge-purge,
 * called only by the hourly sweep), not part of this accessor.
 */
export function forKnowledge({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}) {
  async function gated<T>(run: () => Promise<T>): Promise<KnowledgeGated<T>> {
    const controls = await getKnowledgeControls({ db, organizationId });
    const reason = knowledgeGateReason({
      knowledgeEngine: controls.engine,
      knowledgeOffboardedAt: controls.offboardedAt,
      knowledgeBudgetMicroUsd: controls.budgetMicroUsd,
    });
    if (reason) return { ok: false, reason };
    return { ok: true, value: await run() };
  }

  const scope = { db, organizationId };

  return {
    admin: {
      getControls: () => getKnowledgeControls(scope),
      getSpend: (now?: Date) => getKnowledgeSpend({ ...scope, now }),
      listActions: (limit?: number) =>
        listKnowledgeAdminActions({ ...scope, limit }),
      updateControls: (a: Bound<typeof updateKnowledgeControls>) =>
        updateKnowledgeControls({ ...a, ...scope }),
      offboard: (a: Bound<typeof offboardKnowledge>) =>
        offboardKnowledge({ ...a, ...scope }),
      clearOffboard: (a: Bound<typeof clearKnowledgeOffboard>) =>
        clearKnowledgeOffboard({ ...a, ...scope }),
    },
    store: {
      insertClaim: (a: Bound<typeof insertKnowledgeClaim>) =>
        gated(() => insertKnowledgeClaim({ ...a, ...scope })),
      insertPins: (a: Bound<typeof insertKnowledgePins>) =>
        gated(() => insertKnowledgePins({ ...a, ...scope })),
      insertOp: (a: Bound<typeof insertKnowledgeOp>) =>
        gated(() => insertKnowledgeOp({ ...a, ...scope })),
      getClaim: (a: Bound<typeof getKnowledgeClaim>) =>
        gated(() => getKnowledgeClaim({ ...a, ...scope })),
      listClaims: (a: Bound<typeof listKnowledgeClaims>) =>
        gated(() => listKnowledgeClaims({ ...a, ...scope })),
      listOpenOps: (a: Bound<typeof listOpenKnowledgeOps> = {}) =>
        gated(() => listOpenKnowledgeOps({ ...a, ...scope })),
      loadLatestRejections: (a: Bound<typeof loadLatestKnowledgeRejections>) =>
        gated(() => loadLatestKnowledgeRejections({ ...a, ...scope })),
      insertIntent: (a: Bound<typeof insertKnowledgeIntent>) =>
        gated(() => insertKnowledgeIntent({ ...a, ...scope })),
      listPendingIntents: (a: Bound<typeof listPendingKnowledgeIntents> = {}) =>
        gated(() => listPendingKnowledgeIntents({ ...a, ...scope })),
      decideOp: (a: Bound<typeof decideKnowledgeOp>) =>
        gated(async () => {
          if (a.claimPatch?.statement !== undefined)
            assertStatement(a.claimPatch.statement, "claimPatch.statement");
          return decideKnowledgeOp({ ...a, ...scope });
        }),
      advanceCursor: (a: Bound<typeof advanceKnowledgeCursor>) =>
        gated(async () => {
          assertCursorFields(a.repoFullName, a.defaultBranch, a.toSha);
          if (a.fromSha !== null)
            assertCursorFields(a.repoFullName, a.defaultBranch, a.fromSha);
          return advanceKnowledgeCursor({ ...a, ...scope });
        }),
      observeHead: (a: Bound<typeof observeKnowledgeHead>) =>
        gated(async () => {
          assertCursorFields(a.repoFullName, a.defaultBranch, a.headSha);
          return observeKnowledgeHead({ ...a, ...scope });
        }),
      getCursor: (a: Bound<typeof getKnowledgeCursor>) =>
        gated(() => getKnowledgeCursor({ ...a, ...scope })),
    },
    budget: {
      // Already gated inside: returns the gate reason itself.
      reserve: (a: Bound<typeof reserveKnowledgeBudget>) =>
        reserveKnowledgeBudget({ ...a, ...scope }),
      // Never gated: an Off org must still release its reservations.
      settle: (a: Bound<typeof settleKnowledgeBudget>) =>
        settleKnowledgeBudget({ ...a, ...scope }),
    },
  };
}

/** Reuses the intent shape rules (owner/name, branch, hex sha). */
function assertCursorFields(
  repoFullName: string,
  defaultBranch: string,
  sha: string,
): void {
  assertIntentFields({ repoFullName, defaultBranch, targetSha: sha });
}
