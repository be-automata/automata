import { and, asc, eq, gte } from "drizzle-orm";

import {
  repoPinTarget,
  repoRelativePath,
  type ReconcileContextReady,
  type WireClaim,
  type WireSidecar,
} from "@terragon/knowledge/reconcile-wire";

import type { DB } from "../db";
import {
  knowledgeClaim,
  knowledgeIntent,
  knowledgePin,
  organizationReviewSettings,
} from "../db/schema";
import { getKnowledgeCursor } from "./knowledge";
import { getKnowledgeGateReason } from "./knowledge-controls";
import { loadLatestKnowledgeRejections } from "./knowledge-store";

/**
 * Database side of the reconcile `context` and `publish` endpoints. SYSTEM
 * path: imported only by the two internal reconcile routes (enforced by the
 * static guard, assertion 7 in knowledge-access.static.test.ts). Org and repo
 * always come from the intent row, never from a request. Never logs; errors
 * carry field names only, never partner content.
 *
 * Runs in the www Workers bundle: it imports only the fs-free
 * `@terragon/knowledge/reconcile-wire`, never claims.ts or the node entry.
 */

/** Largest claim set one reconcile loads; above it the context refuses. */
export const KNOWLEDGE_RECONCILE_MAX_CLAIMS = 5000;
const PURGED_WINDOW_MS = 30 * 24 * 60 * 60_000;
const PURGED_LIMIT = 100;

export class KnowledgeReconcileTooLargeError extends Error {
  constructor() {
    super("knowledge reconcile claim set exceeds the cap");
    this.name = "KnowledgeReconcileTooLargeError";
  }
}

export class KnowledgeReconcileInvalidError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`invalid knowledge reconcile request: ${field}`);
    this.name = "KnowledgeReconcileInvalidError";
    this.field = field;
  }
}

export type KnowledgeReconcileContext =
  | Omit<ReconcileContextReady, "installationToken">
  | {
      status: "gated" | "done" | "not_found";
      purgedOrganizationIds: string[];
    };

async function loadPurgedOrganizationIds(db: DB, now: Date): Promise<string[]> {
  const rows = await db
    .select({ id: organizationReviewSettings.organizationId })
    .from(organizationReviewSettings)
    .where(
      gte(
        organizationReviewSettings.knowledgePurgedAt,
        new Date(now.getTime() - PURGED_WINDOW_MS),
      ),
    )
    .orderBy(asc(organizationReviewSettings.organizationId))
    .limit(PURGED_LIMIT);
  return rows.map((r) => r.id);
}

/**
 * Everything a reconcile needs for one claimed intent, minus the installation
 * token (the route adds it). A row that is not `processing` yields `done`: the
 * worker no-ops and the sweep owns any re-dispatch.
 */
export async function loadKnowledgeReconcileContext({
  db,
  intentId,
  now,
}: {
  db: DB;
  intentId: string;
  now: Date;
}): Promise<KnowledgeReconcileContext> {
  const purgedOrganizationIds = await loadPurgedOrganizationIds(db, now);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [intent] = await tx
      .select()
      .from(knowledgeIntent)
      .where(eq(knowledgeIntent.id, intentId))
      .for("update");
    if (!intent) return { status: "not_found", purgedOrganizationIds };
    if (intent.state !== "processing") {
      return { status: "done", purgedOrganizationIds };
    }

    const organizationId = intent.organizationId;
    const gate = await getKnowledgeGateReason({ db: tx, organizationId });
    if (gate !== null) {
      await tx
        .update(knowledgeIntent)
        .set({ state: "pending", nextAttemptAt: now, updatedAt: now })
        .where(eq(knowledgeIntent.id, intent.id));
      return { status: "gated", purgedOrganizationIds };
    }

    const cursor = await getKnowledgeCursor({
      db: tx,
      organizationId,
      repoFullName: intent.repoFullName,
    });

    const claims = await tx
      .select()
      .from(knowledgeClaim)
      .where(
        and(
          eq(knowledgeClaim.organizationId, organizationId),
          eq(knowledgeClaim.repoFullName, intent.repoFullName),
        ),
      )
      .orderBy(asc(knowledgeClaim.page), asc(knowledgeClaim.id))
      .limit(KNOWLEDGE_RECONCILE_MAX_CLAIMS + 1);
    if (claims.length > KNOWLEDGE_RECONCILE_MAX_CLAIMS) {
      throw new KnowledgeReconcileTooLargeError();
    }

    const pins =
      claims.length === 0
        ? []
        : await tx
            .select({
              claimId: knowledgePin.claimId,
              uri: knowledgePin.uri,
              hash: knowledgePin.hash,
            })
            .from(knowledgePin)
            .innerJoin(
              knowledgeClaim,
              eq(knowledgeClaim.id, knowledgePin.claimId),
            )
            .where(
              and(
                eq(knowledgePin.organizationId, organizationId),
                eq(knowledgeClaim.organizationId, organizationId),
                eq(knowledgeClaim.repoFullName, intent.repoFullName),
              ),
            )
            .orderBy(asc(knowledgePin.claimId), asc(knowledgePin.uri));
    const pinsByClaim = new Map<string, { uri: string; hash: string }[]>();
    for (const pin of pins) {
      const list = pinsByClaim.get(pin.claimId) ?? [];
      list.push({ uri: pin.uri, hash: pin.hash });
      pinsByClaim.set(pin.claimId, list);
    }

    // PD-21: admit only claims the worker can check without trusting stored
    // paths. Everything else is counted, never described.
    const pages = new Map<string, WireClaim[]>();
    const admitted: string[] = [];
    let excludedClaims = 0;
    for (const claim of claims) {
      const page = repoRelativePath(claim.page);
      const evidence = pinsByClaim.get(claim.id) ?? [];
      if (
        page === null ||
        evidence.some((e) => repoPinTarget(e.uri) === null)
      ) {
        excludedClaims += 1;
        continue;
      }
      const list = pages.get(page) ?? [];
      list.push({
        id: claim.id,
        statement: claim.statement,
        version: claim.version,
        evidence,
      });
      pages.set(page, list);
      admitted.push(claim.id);
    }
    const sidecars: WireSidecar[] = [...pages.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([page, list]) => ({ page, claims: list }));

    const rejected = await loadLatestKnowledgeRejections({
      db: tx,
      organizationId,
      claimIds: admitted,
    });

    return {
      status: "ready",
      intent: {
        id: intent.id,
        organizationId,
        repoFullName: intent.repoFullName,
        defaultBranch: intent.defaultBranch,
        targetSha: intent.targetSha,
      },
      cursor: { lastSha: cursor?.lastSha ?? null },
      sidecars,
      rejected,
      purgedOrganizationIds,
      excludedClaims,
    };
  });
}
