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
        updateKnowledgeControls({ ...scope, ...a }),
      offboard: (a: Bound<typeof offboardKnowledge>) =>
        offboardKnowledge({ ...scope, ...a }),
      clearOffboard: (a: Bound<typeof clearKnowledgeOffboard>) =>
        clearKnowledgeOffboard({ ...scope, ...a }),
    },
    store: {
      insertClaim: (a: Bound<typeof insertKnowledgeClaim>) =>
        gated(() => insertKnowledgeClaim({ ...scope, ...a })),
      insertPins: (a: Bound<typeof insertKnowledgePins>) =>
        gated(() => insertKnowledgePins({ ...scope, ...a })),
      insertOp: (a: Bound<typeof insertKnowledgeOp>) =>
        gated(() => insertKnowledgeOp({ ...scope, ...a })),
      getClaim: (a: Bound<typeof getKnowledgeClaim>) =>
        gated(() => getKnowledgeClaim({ ...scope, ...a })),
      listClaims: (a: Bound<typeof listKnowledgeClaims>) =>
        gated(() => listKnowledgeClaims({ ...scope, ...a })),
      listOpenOps: (a: Bound<typeof listOpenKnowledgeOps> = {}) =>
        gated(() => listOpenKnowledgeOps({ ...scope, ...a })),
      loadLatestRejections: (a: Bound<typeof loadLatestKnowledgeRejections>) =>
        gated(() => loadLatestKnowledgeRejections({ ...scope, ...a })),
      insertIntent: (a: Bound<typeof insertKnowledgeIntent>) =>
        gated(() => insertKnowledgeIntent({ ...scope, ...a })),
      listPendingIntents: (a: Bound<typeof listPendingKnowledgeIntents> = {}) =>
        gated(() => listPendingKnowledgeIntents({ ...scope, ...a })),
      decideOp: (a: Bound<typeof decideKnowledgeOp>) =>
        gated(async () => {
          if (a.claimPatch?.statement !== undefined)
            assertStatement(a.claimPatch.statement, "claimPatch.statement");
          return decideKnowledgeOp({ ...scope, ...a });
        }),
      advanceCursor: (a: Bound<typeof advanceKnowledgeCursor>) =>
        gated(async () => {
          assertCursorFields(a.repoFullName, a.defaultBranch, a.toSha);
          if (a.fromSha !== null)
            assertCursorFields(a.repoFullName, a.defaultBranch, a.fromSha);
          return advanceKnowledgeCursor({ ...scope, ...a });
        }),
      observeHead: (a: Bound<typeof observeKnowledgeHead>) =>
        gated(async () => {
          assertCursorFields(a.repoFullName, a.defaultBranch, a.headSha);
          return observeKnowledgeHead({ ...scope, ...a });
        }),
      getCursor: (a: Bound<typeof getKnowledgeCursor>) =>
        gated(() => getKnowledgeCursor({ ...scope, ...a })),
    },
    budget: {
      // Already gated inside: returns the gate reason itself.
      reserve: (a: Bound<typeof reserveKnowledgeBudget>) =>
        reserveKnowledgeBudget({ ...scope, ...a }),
      // Never gated: an Off org must still release its reservations.
      settle: (a: Bound<typeof settleKnowledgeBudget>) =>
        settleKnowledgeBudget({ ...scope, ...a }),
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
